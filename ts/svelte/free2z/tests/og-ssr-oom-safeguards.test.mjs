// The  safeguards this file pins, and what each one stops:
//
//   1. STREAMING BYTE CAP — fetchCoverImage used to buffer
//      `await response.arrayBuffer()` BEFORE comparing against
//      MAX_IMAGE_BYTES, so an oversized (or endless chunked) cover was fully
//      resident in this 512Mi SSR process by the time the check ran. The cap
//      is now enforced DURING the read: an offending chunk is never retained
//      and the stream is cancelled mid-flight.
//
//   2. RENDER ADMISSION — nginx's og_rasterizer limit_req bounds ARRIVALS per
//      client, not CONCURRENCY per pod; burst=10 nodelay could put ten cold
//      renders (~30MB of cover bytes + base64 + SVG each) inside one process.
//      The handler admits through $lib/server/og-render-gate before any of
//      that memory exists. Both saturation modes reject retryably: a FULL
//      wait queue immediately (the queue itself is bounded, so live requests
//      cannot pile up without limit), a waiter past its deadline after the
//      bounded wait.
//
//   3. EXPLICIT HEAP SIZE — limits.memory=512Mi with no NODE_OPTIONS let Node
//      self-cap old-space at ~half the cgroup limit (~257MB, the exact number
//      in the prod fatals), dying while half the granted memory went unused
//      and — because 257MB < 512Mi — without ever producing an OOMKilled
//      event anything alerts on.
//
// Negative controls are built in where practical: the streaming tests prove
// the producer is cut off after ~the cap (they run to completion against the
// old buffering code), and the admission test proves concurrent in-flight
// requests never exceed the limit (they all do, unbounded, without the gate).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, test } from "node:test";
import { createServer } from "vite";

const ZPAGE_ID = "0f7e1a2b-3c4d-5e6f-7a8b-9c0d1e2f3a4b";
const ORIGIN = "https://free2z.cash";

let viteCover;
let viteHandler;
let fetchCoverImage;
let MAX_IMAGE_BYTES;
let Semaphore;
let SemaphoreTimeoutError;
let SemaphoreFullError;
let resetOgRenderRateLimiterForTest;
let resetOgArticleLookupLimiterForTest;

// Saved so teardown can restore rather than clobber: node:test may run this
// file alongside others in the same process with pre-existing values.
const previousEnv = {
  OG_MAX_CONCURRENT_RENDERS: process.env.OG_MAX_CONCURRENT_RENDERS,
  OG_RENDER_QUEUE_TIMEOUT_MS: process.env.OG_RENDER_QUEUE_TIMEOUT_MS,
  OG_MAX_QUEUE: process.env.OG_MAX_QUEUE,
};
const previousConsoleLog = console.log;

before(async () => {
  // One vite server per module-under-test: each snapshot of
  // $env/dynamic/private is taken at first import, and the gate/handler
  // tests need a deliberately tiny gate that must NOT leak into other suites.
  // The queue bound is deliberately BELOW the number of concurrent requests
  // fired later, and the wait timeout deliberately LONG, so overflow is
  // provably rejected by the QUEUE bound immediately rather than by timeout.
  process.env.OG_MAX_CONCURRENT_RENDERS = "2";
  // The wait budget sits AT the module's own hard ceiling (5000ms — overrides
  // are tighten-only, so this is the longest any configuration allows), still
  // orders of magnitude longer than the test's waits.
  process.env.OG_RENDER_QUEUE_TIMEOUT_MS = "5000";
  process.env.OG_MAX_QUEUE = "2";

  viteHandler = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  await viteHandler.ssrLoadModule("/src/routes/og/zpage/[id].png/+server.ts");
  const gate = await viteHandler.ssrLoadModule(
    "/src/lib/server/og-render-gate.ts",
  );
  ({
    Semaphore,
    SemaphoreTimeoutError,
    SemaphoreFullError,
    resetOgRenderRateLimiterForTest,
    resetOgArticleLookupLimiterForTest,
  } = gate);

  viteCover = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  ({ fetchCoverImage, MAX_IMAGE_BYTES } = await viteCover.ssrLoadModule(
    "/src/lib/server/og-image.ts",
  ));

  // Silence the gate's saturation log lines during the tests below.
  console.log = () => {};
});

after(async () => {
  console.log = previousConsoleLog;
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await viteCover?.close();
  await viteHandler?.close();
});

// ---------------------------------------------------------------------------
// Streaming byte cap
// ---------------------------------------------------------------------------

/** A Response-like whose body streams lazily from a generator function. */
function streamingResponse(
  makeChunks,
  { type = "image/png", declaredLength } = {},
) {
  const stats = { pulled: 0, cancelled: false };
  const iterator = makeChunks()[Symbol.iterator]();
  const body = new ReadableStream({
    pull(controller) {
      const next = iterator.next();
      if (next.done) {
        controller.close();
        return;
      }
      stats.pulled += 1;
      controller.enqueue(next.value);
    },
    cancel() {
      stats.cancelled = true;
    },
  });
  const headers = new Headers({ "content-type": type });
  if (declaredLength !== undefined) {
    headers.set("content-length", String(declaredLength));
  }
  return { response: { ok: true, status: 200, headers, body }, stats };
}

async function fetchOnlyCover(response) {
  return fetchCoverImage(
    async () => response,
    "/media/cover.png",
    new URL(`${ORIGIN}/`),
  );
}

describe("streaming byte cap", () => {
  const MIB = 1024 * 1024;

  test("an oversized chunked body is cut off at the cap, not buffered", async () => {
    // 20 x 1MiB chunks with NO content-length header. The old code buffered
    // every chunk (all 20MiB) before checking; the `pulled` assertion is the
    // negative control — against the unfixed implementation the generator
    // runs to completion and the test fails.
    const { response, stats } = streamingResponse(function* () {
      for (let i = 0; i < 20; i++) yield new Uint8Array(MIB);
    });

    const result = await fetchOnlyCover(response);

    assert.equal(result.outcome, "permanent");
    assert.equal(result.reason, "byte_budget_exceeded");
    assert.ok(
      // A ReadableStream keeps its queue filled to the high-water mark (one
      // chunk) ahead of the consumer, hence the +2 rather than +1.
      stats.pulled <= MAX_IMAGE_BYTES / MIB + 2,
      `read ${stats.pulled} chunks for an ${MAX_IMAGE_BYTES / MIB}MiB cap — ` +
        "the whole body was buffered before the budget was enforced (#1105)",
    );
    assert.ok(stats.cancelled, "the abandoned transfer must be cancelled");
  });

  test("a single chunk larger than the whole cap is rejected and not retained", async () => {
    // The offending chunk would exceed the budget ON ITS OWN. The cap fires
    // before it is pushed onto the accumulator, so nothing oversized is ever
    // held — the rejection below is the observable half; retention is a
    // code-shape property asserted by review of readBodyCapped.
    //
    // A second (never-delivered) chunk keeps the stream OPEN: a one-chunk
    // generator closes the stream itself, closing is not cancelling, and the
    // assertion below would be about the wrong thing.
    const { response, stats } = streamingResponse(function* () {
      yield new Uint8Array(MAX_IMAGE_BYTES * 2);
      yield new Uint8Array(MIB);
    });

    const result = await fetchOnlyCover(response);

    assert.equal(result.outcome, "permanent");
    assert.equal(result.reason, "byte_budget_exceeded");
    assert.ok(stats.cancelled);
  });

  test("chunk boundaries cannot smuggle bytes past the cap", async () => {
    // Two halves summing to exactly the cap PASS the budget. A zero-filled
    // payload is not an image, which is the point: it must fail LATER than
    // the cap — at header parsing — proving exactly-cap totals are admitted.
    const exact = streamingResponse(function* () {
      yield new Uint8Array(MAX_IMAGE_BYTES / 2);
      yield new Uint8Array(MAX_IMAGE_BYTES / 2);
    });
    const okResult = await fetchOnlyCover(exact.response);
    assert.equal(okResult.outcome, "permanent");
    assert.notEqual(
      okResult.reason,
      "byte_budget_exceeded",
      "a total of exactly MAX_IMAGE_BYTES was rejected — off-by-one at the cap",
    );
    assert.equal(okResult.reason, "undecodable_header");

    //...but one extra byte split into a third chunk breaches it across
    // chunks.
    const over = streamingResponse(function* () {
      yield new Uint8Array(MAX_IMAGE_BYTES / 2);
      yield new Uint8Array(MAX_IMAGE_BYTES / 2 - 1);
      yield new Uint8Array(2);
    });
    const overResult = await fetchOnlyCover(over.response);
    assert.equal(overResult.outcome, "permanent");
    assert.equal(overResult.reason, "byte_budget_exceeded");
  });

  test("a body exactly at the byte cap still renders", async () => {
    // Guards the guard: the cap must reject >MAX, not >=MAX, or ordinary
    // large-but-legal covers go coverless.
    const { Resvg } = await import("@resvg/resvg-js");
    const realPng = new Uint8Array(
      new Resvg(
        '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="630">' +
          '<rect width="800" height="630" fill="#ff00aa"/></svg>',
      )
        .render()
        .asPng(),
    );
    // Pad AFTER IEND so the image stays structurally complete.
    const bytes = new Uint8Array(MAX_IMAGE_BYTES);
    bytes.set(realPng, 0);
    const { response } = streamingResponse(function* () {
      yield bytes;
    });

    const result = await fetchOnlyCover(response);

    assert.equal(result.outcome, "ok", result.reason);
    assert.equal(
      result.dataUri,
      `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`,
    );
  });

  test("one byte over the cap is rejected even when chunked", async () => {
    const { response } = streamingResponse(function* () {
      yield new Uint8Array(MAX_IMAGE_BYTES + 1);
    });
    const result = await fetchOnlyCover(response);
    assert.equal(result.outcome, "permanent");
    assert.equal(result.reason, "byte_budget_exceeded");
  });

  test("a declared oversize length is still rejected before a single byte moves", async () => {
    // Cancel the abandoned transfer without acquiring a reader or consuming
    // bytes. Reading the body property itself is required to cancel it.
    let readerAcquired = false;
    let cancelled = false;
    const result = await fetchOnlyCover({
      ok: true,
      status: 200,
      headers: new Headers({
        "content-type": "image/png",
        "content-length": String(MAX_IMAGE_BYTES + 1),
      }),
      body: {
        getReader() {
          readerAcquired = true;
          throw new Error("oversize body must not be read");
        },
        async cancel() {
          cancelled = true;
        },
      },
    });

    assert.equal(result.outcome, "permanent");
    assert.equal(result.reason, "declared_length_rejected");
    assert.equal(
      readerAcquired,
      false,
      "bytes moved despite the pre-flight rejection",
    );
    assert.equal(cancelled, true, "oversize transfer must release its socket");
  });

  test("a stream that errors mid-flight stays a retryable transfer failure", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(64));
        controller.error(new Error("terminated"));
      },
    });
    const result = await fetchOnlyCover({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "image/png" }),
      body,
    });

    // Same classification as the pre-streaming code gave an aborted
    // arrayBuffer(): transient, so nothing is pinned at the success TTL.
    assert.equal(result.outcome, "transient");
    assert.equal(result.reason, "body_read_failed");
  });
});

// ---------------------------------------------------------------------------
// Render admission (Semaphore unit + handler behaviour)
// ---------------------------------------------------------------------------

describe("og render gate", () => {
  test("the handler caps concurrent renders and rejects overflow with 503", async () => {
    // Six simultaneous cold renders against a limit of 2 running + 2 queued.
    // The article LOOKUP resolves immediately (admission is taken AFTER it,
    // so lookups stay ungated); each request then parks inside response.json()
    // the first post-admission step, before any cover memory exists. Without
    // the gate all six would be counted in flight at once — that is the
    // negative control: maxInFlight <= 2 fails on unfixed code.
    const { GET } = await viteHandler.ssrLoadModule(
      "/src/routes/og/zpage/[id].png/+server.ts",
    );
    let inFlight = 0;
    let maxInFlight = 0;
    const parked = [];

    const fetchStub = async (input) => {
      const href = typeof input === "string" ? input : input.href;
      assert.ok(href.includes("/api/zpage/"));
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: () =>
          new Promise((resolve) => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            parked.push(() => {
              inFlight -= 1;
              // `free2zaddr` is what the handler checks to confirm this
              // 200 is actually a zPage; without it the request is
              // refused as an unrecognized payload and never reaches the
              // rasterizer this test is gating.
              resolve({
                free2zaddr: ZPAGE_ID,
                title: "t",
                creator: { username: "u" },
              });
            });
          }),
      };
    };

    const request = () => {
      resetOgArticleLookupLimiterForTest();
      return GET({
        params: { id: ZPAGE_ID },
        fetch: fetchStub,
        url: new URL(`${ORIGIN}/og/zpage/${ZPAGE_ID}.png`),
        setHeaders: () => {},
      }).then(
        (response) => ({ status: response.status }),
        (cause) => ({ status: cause?.status ?? cause?.code ?? "thrown" }),
      );
    };

    const promises = [
      request(),
      request(),
      request(),
      request(),
      request(),
      request(),
    ];
    // Far shorter than the 5s wait budget: the two requests beyond the
    // queue bound must already have been refused when we resume — refusal
    // came from the BOUND (immediate), not from the deadline.
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Release in rounds: freeing a slot grants it to a queued waiter, whose
    // own json() then parks — so keep sweeping until nobody is parked, or the
    // last granted request would deadlock Promise.all below.
    while (parked.length > 0) {
      for (const release of parked.splice(0)) release();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const results = await Promise.all(promises);

    assert.deepEqual(
      results.map((r) => r.status).sort(),
      // The bounded queue admits its first two requests and two waiters. The
      // render budget admits a two-card burst, then returns 503s without
      // sending more work into Resvg.
      [200, 200, 503, 503, 503, 503],
      "the bounded queue and rate budget refuse excess uncached work",
    );
    assert.ok(
      maxInFlight <= 2,
      `${maxInFlight} renders were in flight against a limit of 2 — ` +
        "the rasterizer admission did not bound concurrency (#1105)",
    );
    assert.equal(
      maxInFlight,
      2,
      "admitted requests should have run in parallel",
    );
  });

  test("a nonexistent ZPage never consumes a slot, even with the gate saturated", async () => {
    resetOgRenderRateLimiterForTest();
    // Admission sits AFTER Django's answer, so random-id sweeps that 404
    // cannot fill the wait queue and starve real cards. Proof: hold both
    // slots parked on real renders, fire junk ids, and require them to
    // resolve as their OWN 404 — under the old pre-article placement they
    // would have hit the full queue instead and come back 503.
    const { GET } = await viteHandler.ssrLoadModule(
      "/src/routes/og/zpage/[id].png/+server.ts",
    );
    const parked = [];

    let seenJunkLookup = false;
    const fetchStub = async (input) => {
      const href = typeof input === "string" ? input : input.href;
      if (href.includes("/junk-")) {
        seenJunkLookup = true;
        return {
          ok: false,
          status: 404,
          headers: new Headers(),
          json: async () => {
            throw new Error("404 body must never be read");
          },
        };
      }
      assert.ok(href.includes("/api/zpage/"));
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: () =>
          new Promise((resolve) => {
            parked.push(resolve);
          }),
      };
    };

    const real = (id) => {
      resetOgArticleLookupLimiterForTest();
      return GET({
        params: { id },
        fetch: fetchStub,
        url: new URL(`${ORIGIN}/og/zpage/${id}.png`),
        setHeaders: () => {},
      }).then(
        (response) => response.status,
        (cause) => cause?.status ?? cause?.code ?? "thrown",
      );
    };
    const holders = [real(ZPAGE_ID), real(ZPAGE_ID)];
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(parked.length, 2, "both slots should be held by real renders");

    // Only NOW — with saturation confirmed — start the junk request. Started
    // earlier, its 404 could complete before the slots filled and the test
    // would prove nothing about the saturated case.
    const junk = real("junk-does-not-exist");
    const verdict = await junk;
    assert.ok(seenJunkLookup, "the junk lookup should have reached Django");
    assert.equal(
      verdict,
      404,
      "a 404 page consumed or waited on a rasterizer slot",
    );

    // Cleanup: drain the two holders so nothing leaks into other tests.
    for (const resolve of parked.splice(0)) {
      resolve({ free2zaddr: ZPAGE_ID, title: "t", creator: { username: "u" } });
    }
    await Promise.all(holders);
  });

  test("Semaphore rejects beyond the queue bound immediately, not after waiting", async () => {
    const sem = new Semaphore(1, 2); // 1 slot, room for 2 waiters
    let r1;
    let r2;
    const holder = await sem.acquire(60_000);
    const w1 = sem.acquire(60_000).then(
      (release) => {
        r1 = release;
        return "granted";
      },
      () => "rejected",
    );
    const w2 = sem.acquire(60_000).then(
      (release) => {
        r2 = release;
        return "granted";
      },
      () => "rejected",
    );

    // Queue full: this must fail NOW — deterministically, not against a wall
    // clock. acquire rejects without awaiting anything, i.e. in a MICROTASK,
    // which always precedes setImmediate (a macrotask). Racing the two makes
    // "immediate" an event-loop-ORDER property: contended CI may slow wall
    // clocks all it likes, but if acquire ever truly waits, setImmediate wins
    // the race and fails this test.
    const verdict = await Promise.race([
      sem.acquire(60_000).then(
        () => "granted",
        (cause) => `rejected:${cause.name}`,
      ),
      new Promise((_, reject) =>
        setImmediate(() =>
          reject(
            new Error(
              "queue-full acquire did not reject within its own microtask turn",
            ),
          ),
        ),
      ),
    ]);
    assert.equal(verdict, "rejected:SemaphoreFullError");
    assert.equal(
      sem.size,
      3,
      "size is slots held plus bounded waiters, never more",
    );

    // Drain: FIFO order, then fully idle again.
    holder();
    assert.equal(await w1, "granted");
    r1();
    assert.equal(await w2, "granted");
    r2();
    assert.equal(sem.size, 0);
  });

  test("Semaphore grants FIFO and never leaks a slot past a timeout", async () => {
    const sem = new Semaphore(1, 5);
    const order = [];
    const first = await sem.acquire(10_000);
    const second = sem.acquire(50).then(
      () => order.push("granted"),
      (cause) => {
        order.push(`timeout:${cause.name}`);
        throw cause;
      },
    );
    const third = sem.acquire(10_000).then((release) => {
      order.push("third");
      return release;
    });

    await assert.rejects(second, SemaphoreTimeoutError);
    assert.equal(sem.size, 2, "the timed-out waiter left the queue");

    // The slot is still healthy: release hands it to the remaining waiter,
    // and FIFO means the third request — queued behind the timed-out one —
    // is the one that gets it.
    first();
    const thirdRelease = await third;
    assert.deepEqual(order, ["timeout:SemaphoreTimeoutError", "third"]);
    assert.equal(sem.size, 1);

    // And back to fully idle, reusable as ever.
    thirdRelease();
    assert.equal(sem.size, 0);
    const again = await sem.acquire(10_000);
    again();
    assert.equal(sem.size, 0);
  });

  test("release is idempotent: a double release cannot steal another holder's slot", async () => {
    const sem = new Semaphore(1, 5);
    const first = await sem.acquire(10_000);

    let secondRelease;
    const second = sem.acquire(10_000).then(
      (release) => {
        secondRelease = release;
        return "granted";
      },
      () => "rejected",
    );

    // First release HANDS the slot over to `second` (FIFO grant); the count
    // stays at the limit. An accidental second release of the SAME token must
    // be a no-op — on a non-idempotent implementation it decrements the count
    // again, leaving `second` holding a phantom slot and letting the next
    // acquire run CONCURRENTLY on a semaphore of one.
    first();
    first();

    let leaked = false;
    const racer = sem.acquire(80).then(
      () => {
        leaked = true;
      },
      () => "timeout",
    );

    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(await second, "granted");
    assert.equal(
      leaked,
      false,
      "double release handed a second slot out on a semaphore of one",
    );

    // Cleanup drains cleanly: the real holder releases, the timed-out racer
    // already left the queue.
    secondRelease();
    assert.equal(
      await racer,
      "timeout",
      "racer timed out against ONE real slot",
    );
    assert.equal(sem.size, 0, "no accounting residue after the timeout");
  });

  test("a granted slot races its own timeout exactly once", async () => {
    const sem = new Semaphore(1, 5);
    const first = await sem.acquire(10_000);
    // Waiter whose timer fires right as a slot would free up.
    const slowWaiter = sem
      .acquire(30)
      .catch((cause) => `rejected:${cause.name}`);
    setTimeout(() => first(), 60);
    assert.equal(await slowWaiter, "rejected:SemaphoreTimeoutError");

    const next = await sem.acquire(10_000);
    assert.equal(typeof next, "function", "semaphore still grantable");
    next();
    assert.equal(sem.size, 0);
  });

  test("an expired waiter is rejected at dequeue even when starved timers have not fired", async () => {
    // Resvg renders SYNCHRONOUSLY, so releaseOne can run while OVERDUE timer
    // callbacks sit queued behind the blocked event loop. Expiry must be
    // enforced at DEQUEUE against an absolute deadline: granting the head
    // waiter without checking its deadline hands a slot to a request that
    // already gave up, whose later-firing timer then sees it dequeued and
    // does nothing. Deterministic starvation: spin the single thread past
    // the waiter's deadline — no timer callback can run mid-spin — then
    // release synchronously, so the dequeue happens BEFORE any timer ran.
    const sem = new Semaphore(1, 5);
    const first = await sem.acquire(10_000);

    const expired = sem.acquire(10).then(
      () => "granted",
      (cause) => `rejected:${cause.name}`,
    );
    // A LIVE waiter directly behind the expired one: FIFO among live waiters
    // must survive skipping past the lapsed head.
    let liveRelease;
    const live = sem.acquire(10_000).then((release) => {
      liveRelease = release;
      return "granted-live";
    });

    const start = Date.now();
    while (Date.now() - start < 50) {}

    first();
    assert.equal(
      await expired,
      "rejected:SemaphoreTimeoutError",
      "a slot was granted to a waiter whose deadline had already lapsed",
    );
    assert.equal(
      await live,
      "granted-live",
      "the live waiter behind the expired one lost its turn",
    );
    liveRelease();
    assert.equal(
      sem.size,
      0,
      "the dequeued-and-rejected waiter leaked capacity",
    );

    // And the semaphore is healthy afterwards.
    const again = await sem.acquire(10_000);
    again();
    assert.equal(sem.size, 0);
  });
});

// ---------------------------------------------------------------------------
// Fail-closed gate configuration
// ---------------------------------------------------------------------------

describe("gate configuration is fail-closed", () => {
  const DEFAULTS = { concurrency: 2, queue: 8, timeoutMs: 5_000 };

  /**
   * Load a FRESH copy of the gate module under the given OG_* env values —
   * the constants snapshot process.env at first import, so each scenario
   * needs its own module instance (and its own vite server).
   */
  async function loadGateWithEnv(values) {
    const saved = {};
    for (const [key, value] of Object.entries(values)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
    const server = await createServer({
      appType: "custom",
      logLevel: "silent",
      server: { middlewareMode: true },
    });
    try {
      const gate = await server.ssrLoadModule(
        "/src/lib/server/og-render-gate.ts",
      );
      return {
        concurrency: gate.OG_MAX_CONCURRENT_RENDERS,
        queue: gate.OG_MAX_QUEUE,
        timeoutMs: gate.OG_RENDER_QUEUE_TIMEOUT_MS,
      };
    } finally {
      await server.close();
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  test("zero values fall back to the reviewed defaults", async () => {
    // Zero would reject every request forever — it must never be configurable.
    assert.deepEqual(
      await loadGateWithEnv({
        OG_MAX_CONCURRENT_RENDERS: "0",
        OG_MAX_QUEUE: "0",
        OG_RENDER_QUEUE_TIMEOUT_MS: "0",
      }),
      DEFAULTS,
    );
  });

  test("malformed values fall back to the reviewed defaults", async () => {
    assert.deepEqual(
      await loadGateWithEnv({
        OG_MAX_CONCURRENT_RENDERS: "abc",
        OG_MAX_QUEUE: "-3",
        OG_RENDER_QUEUE_TIMEOUT_MS: "2.5",
      }),
      DEFAULTS,
    );
  });

  test("oversized values above the reviewed ceilings cannot weaken the limits", async () => {
    // The whole point of the bound is that it is BOUNDED, and the ceilings
    // EQUAL the defaults: overrides may only tighten. These values are each
    // one step above its ceiling — perfectly good positive safe integers that
    // would loosen the reviewed posture — so they must all fall back.
    assert.deepEqual(
      await loadGateWithEnv({
        OG_MAX_CONCURRENT_RENDERS: "3",
        OG_MAX_QUEUE: "9",
        OG_RENDER_QUEUE_TIMEOUT_MS: "5001",
      }),
      DEFAULTS,
    );
    //...and so, a fortiori, would absurd ones.
    assert.deepEqual(
      await loadGateWithEnv({
        OG_MAX_CONCURRENT_RENDERS: "999999",
        OG_MAX_QUEUE: "999999",
        OG_RENDER_QUEUE_TIMEOUT_MS: "999999",
      }),
      DEFAULTS,
    );
  });

  test("a valid override at or inside the ceilings is still respected", async () => {
    // Guards the guard: tighten-only parsing must not make the config path
    // dead — operators need to be able to run STRICTER than the default.
    assert.deepEqual(
      await loadGateWithEnv({
        OG_MAX_CONCURRENT_RENDERS: "1",
        OG_MAX_QUEUE: "4",
        OG_RENDER_QUEUE_TIMEOUT_MS: "4000",
      }),
      { concurrency: 1, queue: 4, timeoutMs: 4000 },
    );
  });
});

// ---------------------------------------------------------------------------
// Explicit heap size (deployment config)
// ---------------------------------------------------------------------------
