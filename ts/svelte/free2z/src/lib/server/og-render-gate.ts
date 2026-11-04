import * as env from "$app/env/private";

/**
 * In-process admission control for the OG rasterizer.
 *
 * The upstream `limit_req_zone og_rasterizer` (k8s/free2z/nginx.conf, )
 * bounds ARRIVALS per client — and it does so PER NGINX POD: the zone is
 * shared memory inside each of the five free2z nginx replicas, so burst=10
 * nodelay admits roughly 11 one-off requests per client per nginx pod (the
 * burst plus the one request the 2r/s rate covers), and there are five such
 * buckets in front of THREE new-ui/Svelte pods reached through a Service.
 * Nothing about that arithmetic bounds how many cold renders land on any one
 * Svelte process: bucket state lives in nginx pods, scheduling lives in the
 * Service, and this gate lives in each Svelte pod. A crawler sweeping a
 * creator's back catalogue can therefore put many simultaneous cold renders
 * into ONE process — each holding a cover fetch (≤8 MiB), its base64 data URI
 * (+33%) and the SVG string embedding it (+33% again), ~30MB of heap apiece
 * against the old-space ceiling. Nine concurrent cold renders was enough to
 * fatal the process.
 *
 * This gate bounds how many requests hold rasterizer state SIMULTANEOUSLY,
 * regardless of who asked or which path they took through nginx. The handler
 * acquires a slot AFTER Django has answered OK — so sweeps of nonexistent ids
 * 404 without ever touching a slot and cannot fill the queue with junk — but
 * BEFORE response.json() materializes the article, because the memory is held
 * by everything from there to the rendered PNG (cover download, base64 data
 * URI, SVG string, Resvg), and a semaphore squeezed around `new Resvg()` alone
 * would still let N-wide buffers pile up in front of it.
 *
 * Two further bounds keep the gate itself from becoming the hazard:
 *
 * - The WAIT QUEUE is bounded. A semaphore that queues without limit holds
 *   arbitrarily many live SvelteKit requests (each a socket, a promise chain
 *   and request context on this same process) for up to the wait budget — a
 *   memory and file-descriptor liability that distributed clients can grow
 *   at will no matter what the nginx buckets do. Past the bound, requests are
 *   rejected IMMEDIATELY, not after waiting.
 * - Every rejection is retryable by contract: the caller maps both failure
 *   modes onto SvelteKit's error(503), which the /og/zpage nginx location
 *   intercepts into @seo_unavailable — the same retryable, no-store response
 *   a crashed SSR pod already produces. Nothing new is cached at any TTL, so
 *   the next unfurl retries.
 */

/**
 * Reviewed hard ceilings for the runtime overrides below. They exist because
 * "positive integer" alone is not fail-closed: OG_MAX_QUEUE=999999999 parses
 * fine and removes exactly the bound this module exists to enforce.
 *
 * Each ceiling EQUALS its reviewed default: these values were sized for this
 * container (512Mi, cpu 500m) and its deadline stack, and no larger setting
 * has a memory or timing budget behind it. Overrides may therefore only
 * TIGHTEN the posture — anything unset, malformed, zero, negative,
 * non-integer, or above the ceiling takes the reviewed default. No
 * configuration path can loosen a limit past what was reviewed here.
 */
const HARD_MAX_CONCURRENT_RENDERS = 2;
const HARD_MAX_QUEUE = 8;
const HARD_MAX_TIMEOUT_MS = 5_000;

/** Trusted clients get a two-request burst, then one fresh lookup/second. */
export const OG_ARTICLE_LOOKUP_MIN_INTERVAL_MS = 1_000;
/** Aggregate upstream bound remains in front of the shared Django backend. */
export const OG_GLOBAL_ARTICLE_LOOKUP_MIN_INTERVAL_MS = 500;
export const OG_MAX_IN_FLIGHT_ARTICLE_LOOKUPS = 2;
export const OG_MAX_IN_FLIGHT_ARTICLE_LOOKUPS_PER_CLIENT = 1;
const MAX_TRACKED_ARTICLE_LOOKUP_CLIENTS = 10_000;

type ArticleLookupClientBucket = { tokens: number; updatedAt: number };

export class OgArticleLookupLimiter {
  private globalTokens = OG_MAX_IN_FLIGHT_ARTICLE_LOOKUPS;
  private lastGlobalRefillAt = 0;
  private active = 0;
  private readonly activeByClient = new Map<string, number>();
  private readonly clients = new Map<string, ArticleLookupClientBucket>();

  tryAcquire(
    clientKey: string,
    now = performance.now(),
  ):
    | { admitted: true; release: () => void }
    | {
        admitted: false;
        reason:
          | "lookup_busy"
          | "client_lookup_busy"
          | "lookup_rate_limited"
          | "client_lookup_rate_limited";
        retryAfterMs: number;
      } {
    if (
      (this.activeByClient.get(clientKey) ?? 0) >=
      OG_MAX_IN_FLIGHT_ARTICLE_LOOKUPS_PER_CLIENT
    ) {
      return {
        admitted: false,
        reason: "client_lookup_busy",
        retryAfterMs: OG_ARTICLE_LOOKUP_MIN_INTERVAL_MS,
      };
    }

    if (this.active >= OG_MAX_IN_FLIGHT_ARTICLE_LOOKUPS) {
      return {
        admitted: false,
        reason: "lookup_busy",
        retryAfterMs: OG_ARTICLE_LOOKUP_MIN_INTERVAL_MS,
      };
    }

    const existingClient = this.clients.get(clientKey);
    const clientElapsed = existingClient
      ? Math.max(0, now - existingClient.updatedAt)
      : 0;
    const clientTokens = existingClient
      ? Math.min(
          OG_MAX_IN_FLIGHT_ARTICLE_LOOKUPS,
          existingClient.tokens +
            clientElapsed / OG_ARTICLE_LOOKUP_MIN_INTERVAL_MS,
        )
      : OG_MAX_IN_FLIGHT_ARTICLE_LOOKUPS;
    if (clientTokens < 1) {
      this.rememberClient(clientKey, {
        tokens: clientTokens,
        updatedAt: now,
      });
      return {
        admitted: false,
        reason: "client_lookup_rate_limited",
        retryAfterMs: Math.ceil(
          (1 - clientTokens) * OG_ARTICLE_LOOKUP_MIN_INTERVAL_MS,
        ),
      };
    }

    const globalElapsed = Math.max(0, now - this.lastGlobalRefillAt);
    const globalTokens = Math.min(
      OG_MAX_IN_FLIGHT_ARTICLE_LOOKUPS,
      this.globalTokens +
        globalElapsed / OG_GLOBAL_ARTICLE_LOOKUP_MIN_INTERVAL_MS,
    );
    if (globalTokens < 1) {
      this.globalTokens = globalTokens;
      this.lastGlobalRefillAt = now;
      this.rememberClient(clientKey, {
        tokens: clientTokens,
        updatedAt: now,
      });
      return {
        admitted: false,
        reason: "lookup_rate_limited",
        retryAfterMs: Math.ceil(
          (1 - globalTokens) * OG_GLOBAL_ARTICLE_LOOKUP_MIN_INTERVAL_MS,
        ),
      };
    }

    this.globalTokens = globalTokens - 1;
    this.lastGlobalRefillAt = now;
    this.rememberClient(clientKey, {
      tokens: clientTokens - 1,
      updatedAt: now,
    });
    this.active += 1;
    this.activeByClient.set(clientKey, 1);
    let released = false;
    return {
      admitted: true,
      release: () => {
        if (released) return;
        released = true;
        this.active -= 1;
        this.activeByClient.delete(clientKey);
      },
    };
  }

  /** Reset the isolated instance between repeated handler fixtures. */
  resetForTest() {
    this.globalTokens = OG_MAX_IN_FLIGHT_ARTICLE_LOOKUPS;
    this.lastGlobalRefillAt = 0;
    this.active = 0;
    this.activeByClient.clear();
    this.clients.clear();
  }

  private rememberClient(key: string, bucket: ArticleLookupClientBucket) {
    this.clients.delete(key);
    while (this.clients.size >= MAX_TRACKED_ARTICLE_LOOKUP_CLIENTS) {
      const oldest = this.clients.keys().next().value;
      if (oldest === undefined) break;
      this.clients.delete(oldest);
    }
    this.clients.set(key, bucket);
  }
}

const articleLookupLimiter = new OgArticleLookupLimiter();
let suppressedLookupLogs = 0;
let lastLookupLogAt = 0;

/** Bound database-facing article lookups before a request reaches Django. */
export function tryAdmitOgArticleLookup(clientKey: string) {
  return articleLookupLimiter.tryAcquire(clientKey);
}

/** Per-process rasterizer CPU budget, charged after the render work finishes. */
export class OgRenderRateLimiter {
  private nextAdmissionAt = 0;
  private tokens = HARD_MAX_CONCURRENT_RENDERS;
  private active = 0;
  private batchCpuMs = 0;

  tryAcquire(now = performance.now()):
    | {
        admitted: true;
        complete: (cpuMs: number, finishedAt?: number) => void;
      }
    | { admitted: false; retryAfterMs: number } {
    if (this.active >= HARD_MAX_CONCURRENT_RENDERS) {
      return {
        admitted: false,
        retryAfterMs: Math.max(1_000, Math.ceil(this.nextAdmissionAt - now)),
      };
    }
    if (this.active === 0 && now >= this.nextAdmissionAt) {
      this.tokens = HARD_MAX_CONCURRENT_RENDERS;
    }
    if (this.tokens < 1) {
      return {
        admitted: false,
        retryAfterMs: Math.max(1, Math.ceil(this.nextAdmissionAt - now)),
      };
    }
    if (now < this.nextAdmissionAt) {
      return {
        admitted: false,
        retryAfterMs: Math.ceil(this.nextAdmissionAt - now),
      };
    }

    this.tokens -= 1;
    this.active += 1;
    let completed = false;
    return {
      admitted: true,
      complete: (cpuMs, completedAt = performance.now()) => {
        if (completed) return;
        completed = true;
        this.active -= 1;
        this.batchCpuMs += Math.max(0, cpuMs);
        if (this.active !== 0) return;
        // Measure process CPU over cover-read/render/encode work. Cool it for
        // four times that CPU duration, keeping this path at or below 20% of
        // one CPU over time. Measuring after completion means a slow render
        // cannot consume its own cooldown while blocking timers; other SSR
        // work during async cover/encode is charged too, conservatively.
        this.nextAdmissionAt = Math.max(
          this.nextAdmissionAt,
          completedAt + this.batchCpuMs * 4,
        );
        this.batchCpuMs = 0;
      },
    };
  }

  /** Reset the isolated instance between repeated handler fixtures. */
  resetForTest() {
    this.nextAdmissionAt = 0;
    this.tokens = HARD_MAX_CONCURRENT_RENDERS;
    this.active = 0;
    this.batchCpuMs = 0;
  }
}

const renderRateLimiter = new OgRenderRateLimiter();
let suppressedRenderLogs = 0;
let lastRenderLogAt = 0;

/** Return whether another uncached card render may start in this process. */
export function tryAdmitOgRender() {
  return renderRateLimiter.tryAcquire();
}

/** Test-only seam; production code must never reset either process budget. */
export function resetOgRenderRateLimiterForTest() {
  resetOgArticleLookupLimiterForTest();
  renderRateLimiter.resetForTest();
}

/** Test-only seam for exercising the render semaphore beyond lookup budget. */
export function resetOgArticleLookupLimiterForTest() {
  articleLookupLimiter.resetForTest();
}

function logOgAdmissionLimit(
  reason: string,
  retryAfterMs: number,
  counters: { suppressed: number; lastLogAt: number },
) {
  counters.suppressed += 1;
  const now = Date.now();
  if (counters.lastLogAt !== 0 && now - counters.lastLogAt < 1_000) return;

  const rejected = counters.suppressed;
  counters.suppressed = 0;
  counters.lastLogAt = now;
  console.log(
    JSON.stringify({
      severity: "WARNING",
      message: "OG capacity budget exhausted; rejecting without queueing.",
      event: "og_gate",
      reason,
      rejected,
      retry_after_ms: retryAfterMs,
    }),
  );
}

export function logOgArticleLookupLimit(
  reason:
    | "lookup_busy"
    | "client_lookup_busy"
    | "lookup_rate_limited"
    | "client_lookup_rate_limited",
  retryAfterMs: number,
) {
  logOgAdmissionLimit(reason, retryAfterMs, {
    get suppressed() {
      return suppressedLookupLogs;
    },
    set suppressed(value: number) {
      suppressedLookupLogs = value;
    },
    get lastLogAt() {
      return lastLookupLogAt;
    },
    set lastLogAt(value: number) {
      lastLookupLogAt = value;
    },
  });
}

export function logOgRenderRateLimit(retryAfterMs: number) {
  logOgAdmissionLimit("render_cpu_budget", retryAfterMs, {
    get suppressed() {
      return suppressedRenderLogs;
    },
    set suppressed(value: number) {
      suppressedRenderLogs = value;
    },
    get lastLogAt() {
      return lastRenderLogAt;
    },
    set lastLogAt(value: number) {
      lastRenderLogAt = value;
    },
  });
}

function positiveIntBounded(
  value: string | undefined,
  fallback: number,
  hardMax: number,
): number {
  if (!value) return fallback;
  const parsed = Number(value);
  const acceptable =
    Number.isSafeInteger(parsed) && parsed > 0 && parsed <= hardMax;
  return acceptable ? parsed : fallback;
}

/**
 * Two concurrent renders per Svelte pod — the default IS the maximum. Sized
 * to this container's memory and CPU budgets:
 *
 * - Worst case per admitted request is ~30MB of V8 strings/buffers plus
 *   Resvg's native decode of a ≤2M-pixel raster (~8MB RGBA off-heap). Two
 *   admissions bound that at well under the old-space ceiling instead of
 *   gambling the process on arrival shape; no larger setting has a
 *   memory-budget proof behind it, so none is configurable.
 * - The container has cpu: 500m. Resvg's render is synchronous CPU-bound
 *   work; more than a couple of concurrent cold renders cannot go faster,
 *   they just co-schedule slower and hold their buffers longer.
 *
 * FIFO grants preserve arrival order but cannot identify intent — a crawler
 * and a live reader wait in the same queue — so the protection here is the
 * BOUND, not prioritisation: whatever queues behind an abuser fails fast
 * (retryable 503) instead of piling up unboundedly.
 *
 * Overridable via OG_MAX_CONCURRENT_RENDERS up to 2 (tighten-only).
 */
export const OG_MAX_CONCURRENT_RENDERS = positiveIntBounded(
  env.OG_MAX_CONCURRENT_RENDERS,
  2,
  HARD_MAX_CONCURRENT_RENDERS,
);

/**
 * How many requests may WAIT for a slot before new arrivals are rejected
 * immediately — a per-Svelte-PROCESS cap on live OG requests. Eight is an
 * order of magnitude comparable to what ONE nginx pod's bucket can legally
 * forward in a single burst (~11 one-off requests); it is NOT an absorption
 * of that burst — five nginx pods mean several bursts can land across the
 * three Svelte pods concurrently, and Service load-balancing decides where
 * they go. What matters is that THIS process's worst-case exposure (sockets +
 * request contexts held waiting, before any cover memory exists) is capped at
 * a number someone chose, and cannot be configured higher than it. Arrivals
 * beyond the bound get their 503 at once.
 *
 * Overridable via OG_MAX_QUEUE up to 8 (tighten-only).
 */
export const OG_MAX_QUEUE = positiveIntBounded(
  env.OG_MAX_QUEUE,
  8,
  HARD_MAX_QUEUE,
);

/**
 * How long a request may WAIT for a slot before being rejected. Sized against
 * the whole deadline stack, because a granted request still has all of its own
 * deadlines ahead of it:
 *
 *   article fetch  ≤10s  (ARTICLE_TIMEOUT_MS)
 *   cover fetch    ≤8s   (COVER_FETCH_TIMEOUT_MS)
 *   render         ~1-2s synchronous CPU work
 *   edge budget    30s   (nginx proxy_read_timeout — which also governs the
 *                         time to FIRST byte, i.e. the header wait)
 *
 * Five seconds is the default AND the hard ceiling. The original 10s wait
 * left only ~2s of slack against the 30s edge budget in the worst case — a
 * granted request could be abandoned by nginx mid-render, spending pod
 * resources on a response nobody receives — so a ceiling above 5s would let
 * configuration reintroduce exactly that unsafe window. At 5s the worst case
 * is ~25s end-to-end with real headroom; overrides may shorten the wait, not
 * lengthen it.
 *
 * Overridable via OG_RENDER_QUEUE_TIMEOUT_MS up to 5000ms (tighten-only).
 */
export const OG_RENDER_QUEUE_TIMEOUT_MS = positiveIntBounded(
  env.OG_RENDER_QUEUE_TIMEOUT_MS,
  5_000,
  HARD_MAX_TIMEOUT_MS,
);

/** Base class for every "the gate refused this" outcome. */
export class GateSaturationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GateSaturationError";
  }
}

/** Thrown when a waiter's deadline expires before a slot frees up. */
export class SemaphoreTimeoutError extends GateSaturationError {
  constructor(timeoutMs: number) {
    super(`Semaphore acquisition exceeded ${timeoutMs}ms`);
    this.name = "SemaphoreTimeoutError";
  }
}

/** Thrown immediately when the wait queue is already at its bound. */
export class SemaphoreFullError extends GateSaturationError {
  constructor(maxWaiting: number) {
    super(`Semaphore wait queue is full (${maxWaiting} waiting)`);
    this.name = "SemaphoreFullError";
  }
}

type Waiter = {
  /** Absolute wall-clock deadline; enforced at DEQUEUE, not only by the timer. */
  readonly deadline: number;
  readonly timeoutMs: number;
  resolve: (release: () => void) => void;
  reject: (cause: SemaphoreTimeoutError) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * A FIFO counting semaphore with a bounded queue and a bounded-wait acquire.
 *
 * Grant order is strictly FIFO so a burst cannot starve the request that
 * arrived first (that request is likely the one a live user is staring at;
 * crawlers retry). Timed-out waiters leave the queue without taking a slot —
 * expiry is enforced at DEQUEUE against an absolute deadline too, so a
 * synchronous render that starves the event loop past a waiter's timer cannot
 * hand that waiter a lapsed slot — a grant that races a timeout resolves
 * exactly once, and every returned release function is IDEMPOTENT: an
 * accidental double release is a no-op instead of handing a second slot out
 * (or driving the count negative).
 */
export class Semaphore {
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(
    readonly limit: number,
    readonly maxWaiting: number = Number.MAX_SAFE_INTEGER,
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error(
        `Semaphore limit must be a positive integer, got ${limit}`,
      );
    }
    if (!Number.isSafeInteger(maxWaiting) || maxWaiting < 1) {
      throw new Error(
        `Semaphore maxWaiting must be a positive integer, got ${maxWaiting}`,
      );
    }
  }

  /** Requests currently holding or waiting for a slot. For tests/metrics. */
  get size() {
    return this.active + this.waiters.length;
  }

  /**
   * Reserve a slot, waiting at most `timeoutMs` for one.
   * Returns an idempotent release function; call it in a `finally`.
   *
   * Rejects with {@link SemaphoreFullError} immediately if the wait queue is
   * at `maxWaiting`, and with {@link SemaphoreTimeoutError} if the deadline
   * expires first.
   */
  async acquire(timeoutMs: number): Promise<() => void> {
    if (this.active < this.limit && this.waiters.length === 0) {
      this.active += 1;
      return this.makeRelease();
    }
    if (this.waiters.length >= this.maxWaiting) {
      // Refuse BEFORE enqueueing: the caller keeps its resources (socket,
      // request context) and the queue — and therefore worst-case wait and
      // memory — stays capped no matter what arrives next.
      throw new SemaphoreFullError(this.maxWaiting);
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        deadline: Date.now() + timeoutMs,
        timeoutMs,
        resolve: (release) => {
          clearTimeout(waiter.timer);
          resolve(release);
        },
        reject: (cause) => {
          clearTimeout(waiter.timer);
          reject(cause);
        },
        timer: undefined as unknown as Waiter["timer"],
      };
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) {
          // Still queued: give up without consuming a slot.
          this.waiters.splice(index, 1);
          waiter.reject(new SemaphoreTimeoutError(timeoutMs));
        }
        // Not queued any more: a slot was granted concurrently or the
        // deadline was enforced at dequeue; either way this timeout is moot.
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.releaseOne();
    };
  }

  private releaseOne() {
    while (this.waiters.length > 0) {
      const next = this.waiters.shift() as Waiter;
      if (next.deadline > Date.now()) {
        // Hand the slot straight over; `active` stays at the limit.
        next.resolve(this.makeRelease());
        return;
      }
      // The deadline lapsed while a synchronous render starved the event
      // loop, so this waiter's own timer has not run yet. Enforce expiry
      // HERE: granting it would hand a slot to a request that already gave
      // up, and its later-firing timer would see it dequeued and do nothing.
      next.reject(new SemaphoreTimeoutError(next.timeoutMs));
      // Capacity is not consumed by the rejected waiter — keep draining for
      // the first waiter still inside its deadline, preserving FIFO among
      // live waiters.
    }
    if (this.active > 0) {
      this.active -= 1;
    }
  }
}

const gate = new Semaphore(OG_MAX_CONCURRENT_RENDERS, OG_MAX_QUEUE);

/**
 * Acquire the OG renderer's single shared gate.
 *
 * Rejections are logged once as a bare JSON line (`event: "og_gate"`,
 * distinct from the `og_card` failure metric so a saturation event cannot
 * inflate the cover-failure count) and the caller turns them into a 503,
 * which nginx maps to @seo_unavailable: retryable, no-store, nothing cached.
 */
export async function acquireOgRenderSlot(): Promise<() => void> {
  try {
    return await gate.acquire(OG_RENDER_QUEUE_TIMEOUT_MS);
  } catch (cause) {
    if (cause instanceof GateSaturationError) {
      console.log(
        JSON.stringify({
          severity: "WARNING",
          message:
            cause instanceof SemaphoreFullError
              ? "OG render wait queue full; rejecting immediately."
              : "OG render concurrency saturated; rejecting until slots free up.",
          event: "og_gate",
          reason:
            cause instanceof SemaphoreFullError ? "queue_full" : "wait_timeout",
          max_concurrent: OG_MAX_CONCURRENT_RENDERS,
          max_queue: OG_MAX_QUEUE,
          waited_ms:
            cause instanceof SemaphoreFullError
              ? 0
              : OG_RENDER_QUEUE_TIMEOUT_MS,
        }),
      );
    }
    throw cause;
  }
}
