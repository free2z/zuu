/**
 * First-party content cards for markdown the BROWSER renders:
 * comments, converse replies and later feed pages, and the author-side
 * previews (zPage editor, bio editor, comment/converse composers).
 *
 * This is the browser half of the ONE resolver in
 * `$lib/utils/first-party-embed-resolve.ts` — same planner/ledger, same
 * request builder, same bounded reader, same card builders as the SSR path.
 * What it adds is only what a browser needs:
 *
 *  - **The viewer's credentials, by construction.** Requests go to our own
 *    API (`PUBLIC_API_BASE_URL`, empty = same origin in production) with
 *    `credentials: "same-origin"` (`"include"` only for a configured API
 *    origin of our own, as the app's API client does), `redirect: "manual"` and
 *    `cache: "no-store"`: the viewer's own cookie, never anyone else's, no
 *    redirect followed, nothing kept in the HTTP cache. The path is always
 *    `firstPartyCardRequestPath` (exactly `/api/zpage/<segment>/` or
 *    `/api/comments/<uuid>/`), so an author cannot steer the request.
 *
 *  - **A page-level budget.** A page resolver (`provideFirstPartyCards` in
 *    the root layout) owns ONE ledger per page view: every body on the page
 *    plans into it, a call is made once however many bodies need it, and at
 *    most `MAX_PAGE_FIRST_PARTY_CARD_CALLS` calls are made in total — the
 *    server seed's calls included. It resets on navigation and when the
 *    signed-in identity changes, so a card resolved for one reader, or one
 *    page, never renders for another.
 *
 *  - **Debounced, per-session previews.** A preview resolver
 *    (`createFirstPartyPreviewResolver`) waits until the author stops typing,
 *    and keeps what it resolved for the life of the editor (per API path +
 *    language), so re-rendering, toggling preview or typing elsewhere costs
 *    nothing. Its cards live ONLY in this in-memory store: nothing here
 *    writes storage, and nothing sends a card anywhere — the editor saves
 *    markdown, and every other reader resolves that markdown as themselves.
 *
 * On the server a resolver never fetches (`enabled: false`); it only carries
 * the seed a server loader resolved, so SSR and hydration render the same
 * markup, and the browser then resolves whatever the server did not.
 */
import { getContext, setContext } from "svelte";
import { browser } from "$app/env";
import * as publicEnv from "$app/env/public";
import { getCurrentLocale, locale } from "$lib/i18n";
import { firstPartyCardHost } from "$lib/utils/first-party-embed-cards";
import { derived, writable, type Readable } from "svelte/store";
import { createAbortSignalWithTimeout } from "$lib/abort-signal.js";
import { authStore } from "$lib/stores/auth";
import type { FirstPartyCardMap } from "$lib/utils/first-party-embed-cards";
import { collectFirstPartyContentEmbeds } from "$lib/utils/markdown";
import { firstPartyContentKey } from "$lib/utils/first-party-embed-cards";
import {
  createFirstPartyCardLedger,
  firstPartyContentHash,
  firstPartyCardRequestPath,
  MAX_PAGE_FIRST_PARTY_CARD_CALLS,
  readFirstPartyCardBody,
  type FirstPartyCardCall,
  type FirstPartyCardLedger,
  type FirstPartyCardSeed,
} from "$lib/utils/first-party-embed-resolve";

/** A card call the browser gives up on (then: the neutral card). */
export const FIRST_PARTY_CARD_CLIENT_TIMEOUT_MS = 8_000;
/** Card calls one resolver has in flight at once. */
export const FIRST_PARTY_CARD_CLIENT_CONCURRENCY = 4;
/** How long an author must stop typing before a preview resolves. */
export const FIRST_PARTY_PREVIEW_DEBOUNCE_MS = 600;
/** Distinct calls one editor session may make (its own budget). */
export const MAX_PREVIEW_FIRST_PARTY_CARD_CALLS = 32;

export type FirstPartyCardState = {
  /** Bumped on every reset: a body re-requests when it changes. */
  generation: number;
  cards: FirstPartyCardMap;
};

export type FirstPartyCardResolver = Readable<FirstPartyCardState> & {
  /**
   * Resolve (eventually) the cards `content` embeds. Idempotent and cheap to
   * call from a reactive statement. `source` names the body when successive
   * contents replace each other (an editor): only the latest is resolved.
   * `generation` is ignored: a component passes `$resolver.generation` so its
   * reactive statement re-runs — and re-requests — after a reset.
   */
  request(
    content: string | null | undefined,
    source?: string,
    generation?: number,
  ): void;
  /** Adopt a server loader's seed as a new page view. */
  seed(seed: FirstPartyCardSeed | null | undefined): void;
  /**
   * A string that changes exactly when one of THIS body's cards changes.
   * A body renders from `cardsFor` behind this signature, so a card landing
   * in one comment does not re-render every other body on the page.
   * `state` is ignored: pass `$resolver` so the call re-runs on a publish.
   */
  signature(content: string | null | undefined, state?: unknown): string;
  /** This body's cards only (a selection of the page's). */
  cardsFor(
    content: string | null | undefined,
    signature?: string,
  ): FirstPartyCardMap;
  /** Forget everything: a new page view. */
  reset(): void;
  /**
   * A navigation is under way: forget everything now and ignore requests
   * until `resume` — the page being LEFT is still mounted and must not spend
   * the next page's budget. A seed arriving meanwhile is kept.
   */
  suspend(): void;
  /** The new page is mounted: every body on it re-requests. */
  resume(): void;
  destroy(): void;
};

export type FirstPartyCardResolverOptions = {
  /** Fetch at all? `false` on the server. */
  enabled: boolean;
  /** `firstPartyCardHost(url.hostname)` of the page being read. */
  host: string;
  /** The viewer's UI locale (the `lang` a card asks for by default). */
  locale: () => string | null | undefined;
  /** `PUBLIC_API_BASE_URL`, without a trailing slash. */
  apiBase?: string;
  fetch?: typeof fetch;
  maxCalls?: number;
  debounceMs?: number;
  timeoutMs?: number;
  concurrency?: number;
  /**
   * The signed-in identity; `null` while unknown. A change from one known
   * identity to another resets the resolver.
   */
  identity?: Readable<string | null>;
  /**
   * The viewer's UI locale as a store. A change is a new page view: a card
   * asked in the old language must not stay under a link that now opens
   * the new one.
   */
  localeStore?: Readable<unknown>;
};

function sanitizeSeed(
  seed: FirstPartyCardSeed | null | undefined,
): Pick<FirstPartyCardSeed, "cards" | "calls" | "keys"> {
  const cards =
    seed?.cards && typeof seed.cards === "object" && !Array.isArray(seed.cards)
      ? seed.cards
      : {};
  const calls = Array.isArray(seed?.calls)
    ? seed.calls.filter((key): key is string => typeof key === "string")
    : [];
  // Absent stays absent: a seed that does not list its keys never reopens.
  const keys = Array.isArray(seed?.keys)
    ? seed.keys.filter((key): key is string => typeof key === "string")
    : undefined;
  return { cards: { ...cards }, calls, ...(keys ? { keys } : {}) };
}

export function createFirstPartyCardResolver(
  options: FirstPartyCardResolverOptions,
): FirstPartyCardResolver {
  const maxCalls = options.maxCalls ?? MAX_PAGE_FIRST_PARTY_CARD_CALLS;
  const debounceMs = options.debounceMs ?? 0;
  const timeoutMs = options.timeoutMs ?? FIRST_PARTY_CARD_CLIENT_TIMEOUT_MS;
  const concurrency = Math.max(
    1,
    options.concurrency ?? FIRST_PARTY_CARD_CLIENT_CONCURRENCY,
  );
  const apiBase = (options.apiBase ?? "").replace(/\/$/, "");

  const state = writable<FirstPartyCardState>({ generation: 0, cards: {} });
  let generation = 0;
  let cards: FirstPartyCardMap = {};
  let ledger: FirstPartyCardLedger = createFirstPartyCardLedger({
    host: options.host,
    maxCalls,
  });
  // Aborted on reset/destroy: nothing from an old page view lands in a new one.
  let scope = new AbortController();
  let lastSeed: FirstPartyCardSeed | null = null;
  const pending = new Map<string, string>();
  const queue: { ledger: FirstPartyCardLedger; call: FirstPartyCardCall }[] =
    [];
  let active = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;
  // The first page view's seed is the one whose HTML is already on screen
  // (hydration). Until the first `afterNavigate` (`resume`, which also runs
  // on the initial "enter"), a seed is that one.
  let entered = false;
  // content hash -> the content keys that body can show (bounded).
  const bodyKeys = new Map<string, string[]>();
  const BODY_KEYS_MAX = 4096;
  let suspended = false;
  let suspendTimer: ReturnType<typeof setTimeout> | null = null;
  // A navigation that never completes must not leave the page unresolved.
  const SUSPEND_MAX_MS = 10_000;
  // The current scope's seed was made with a session cookie (see `revalidate`).
  let seededWith: "session" | "anonymous" | null = null;
  // While revalidating: the seeded cards kept on screen until the fresh
  // answers are in, so a correct card does not flash to neutral and back.
  let stale: FirstPartyCardMap | null = null;
  let staleFlushed = false;
  let staleTimer: ReturnType<typeof setTimeout> | null = null;

  function visible(): FirstPartyCardMap {
    return stale ? { ...stale, ...cards } : cards;
  }

  function publish(added: FirstPartyCardMap) {
    if (Object.keys(added).length === 0) return;
    cards = { ...cards, ...added };
    state.set({ generation, cards: visible() });
  }

  function dropStale() {
    if (staleTimer !== null) clearTimeout(staleTimer);
    staleTimer = null;
    if (!stale) return;
    stale = null;
    state.set({ generation, cards });
  }

  function maybeDropStale() {
    if (
      stale &&
      staleFlushed &&
      timer === null &&
      pending.size === 0 &&
      queue.length === 0 &&
      active === 0
    ) {
      dropStale();
    }
  }

  function newScope(
    seed: FirstPartyCardSeed | null,
    keep: FirstPartyCardMap | null = null,
    reserved = 0,
  ) {
    scope.abort();
    scope = new AbortController();
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pending.clear();
    queue.length = 0;
    generation += 1;
    if (staleTimer !== null) clearTimeout(staleTimer);
    staleTimer = null;
    stale = keep;
    staleFlushed = false;
    seededWith = seed
      ? seed.session === true
        ? "session"
        : "anonymous"
      : null;
    const clean = sanitizeSeed(seed);
    ledger = createFirstPartyCardLedger({
      host: options.host,
      maxCalls,
      seed: clean,
      reserved,
    });
    cards = clean.cards;
    state.set({ generation, cards: visible() });
  }

  async function run(job: {
    ledger: FirstPartyCardLedger;
    call: FirstPartyCardCall;
  }) {
    const requestPath = firstPartyCardRequestPath(job.call);
    const abort = createAbortSignalWithTimeout(scope.signal, timeoutMs);
    // The timeout bounds the whole call, not just what honours the signal:
    // a slot held forever would stall every card queued behind it.
    const aborted = new Promise<never>((_, reject) => {
      if (abort.signal.aborted) reject(abort.signal.reason);
      abort.signal.addEventListener(
        "abort",
        () => reject(abort.signal.reason),
        { once: true },
      );
    });
    aborted.catch(() => {});
    let body: unknown = null;
    try {
      if (requestPath) {
        body = await Promise.race([
          (async () => {
            const response = await (options.fetch ?? fetch)(
              `${apiBase}${requestPath}`,
              {
                headers: { accept: "application/json" },
                // Same origin in production (`PUBLIC_API_BASE_URL` empty). A
                // configured API origin of OUR OWN (env, never content) gets
                // the viewer's cookie the way the app's API client sends it.
                credentials: apiBase ? "include" : "same-origin",
                redirect: "manual",
                cache: "no-store",
                signal: abort.signal,
              },
            );
            return readFirstPartyCardBody(response, abort.signal);
          })(),
          aborted,
        ]);
      }
    } catch {
      body = null;
    } finally {
      abort.cleanup();
    }
    if (destroyed || job.ledger !== ledger) return;
    const settled = ledger.settle(job.call.key, body);
    // While re-checking a seed, a key this answer did NOT confirm is dropped
    // now — not when the whole batch is in (codex R2).
    if (stale) {
      let dropped = false;
      for (const key of ledger.keysOf(job.call.key)) {
        if (!(key in settled) && key in stale) {
          stale = { ...stale };
          delete stale[key];
          dropped = true;
        }
      }
      if (dropped && Object.keys(settled).length === 0) {
        state.set({ generation, cards: visible() });
      }
    }
    publish(settled);
  }

  function pump() {
    while (active < concurrency && queue.length > 0) {
      const job = queue.shift()!;
      if (job.ledger !== ledger) continue;
      active += 1;
      void run(job).finally(() => {
        active -= 1;
        pump();
        maybeDropStale();
      });
    }
  }

  function flush() {
    timer = null;
    if (destroyed) return;
    // Nothing is resolved before the viewer is known (codex R4): an answer
    // obtained under a cookie whose owner the page has not yet confirmed
    // would have to be thrown away — and its budget with it.
    if (deferUntilIdentity && lastIdentity === null) return;
    const contents = [...pending.values()];
    pending.clear();
    const locale = options.locale();
    const immediate: FirstPartyCardMap = {};
    for (const content of contents) {
      const plan = ledger.plan(content, locale);
      Object.assign(immediate, plan.cards);
      for (const call of plan.calls) queue.push({ ledger, call });
    }
    publish(immediate);
    pump();
    if (stale) {
      staleFlushed = true;
      maybeDropStale();
    }
  }

  /**
   * A seed made with a session cookie says what THAT cookie could open — and
   * a cookie is not an identity: another tab may have signed out or switched
   * accounts between the server render and this page's auth check (the
   * converse feed refuses its session-bearing server page for the same
   * reason). So once the identity is known, such a seed is resolved again as
   * the browser's own viewer. Its cards stay on screen meanwhile — they were
   * already in the server's HTML — and every one the fresh answers do not
   * confirm is dropped when they are in (or at the client timeout).
   */
  function revalidate() {
    // Every request this page view made — the server's AND the browser's
    // while the auth check was pending — stays spent, so re-checking cannot
    // exceed the page budget (codex R3).
    newScope(null, visible(), ledger.spent());
    staleTimer = setTimeout(dropStale, timeoutMs + 1_000);
  }

  function keysOf(content: string | null | undefined): string[] {
    if (!content) return [];
    const hash = firstPartyContentHash(content);
    let keys = bodyKeys.get(hash);
    if (!keys) {
      keys = collectFirstPartyContentEmbeds(content, options.host).map(
        firstPartyContentKey,
      );
      if (bodyKeys.size >= BODY_KEYS_MAX) {
        const oldest = bodyKeys.keys().next().value;
        if (oldest !== undefined) bodyKeys.delete(oldest);
      }
    } else {
      bodyKeys.delete(hash);
    }
    bodyKeys.set(hash, keys);
    return keys;
  }

  function resume() {
    entered = true;
    if (suspendTimer !== null) clearTimeout(suspendTimer);
    suspendTimer = null;
    if (!suspended || destroyed) return;
    suspended = false;
    generation += 1;
    state.set({ generation, cards: visible() });
  }

  let lastIdentity: string | null = null;
  const deferUntilIdentity = Boolean(options.enabled && options.identity);

  /**
   * May this page view keep a seed for this viewer? Only an ANONYMOUS
   * render for a viewer known to be anonymous: a session render was made
   * with a cookie, which is not an identity, and an anonymous render (a
   * route preloaded before an in-place login) says nothing about what a
   * signed-in viewer may open (codex R4).
   */
  function seedTrusted(identity: string) {
    return seededWith === "anonymous" && identity === "anonymous";
  }
  const unsubscribeIdentity =
    options.enabled && options.identity
      ? options.identity.subscribe((identity) => {
          if (identity === null) {
            // A KNOWN identity being lost (a credential exchange re-checks
            // who this is) must not leave the previous account's cards on
            // screen while the lookup runs, nor its requests in flight
            // (codex R3). The first answer after that is a fresh start.
            if (lastIdentity !== null) {
              lastIdentity = null;
              newScope(null);
            }
            return;
          }
          const first = lastIdentity === null;
          const changed = !first && identity !== lastIdentity;
          lastIdentity = identity;
          if (changed) newScope(null);
          else if (first && seededWith && !seedTrusted(identity)) revalidate();
          // Whatever was asked while the viewer was unknown goes now.
          if (first && pending.size > 0 && timer === null) {
            timer = setTimeout(flush, debounceMs);
          }
        })
      : () => {};

  let localeSeen = false;
  let lastLocale: unknown;
  const unsubscribeLocale =
    options.enabled && options.localeStore
      ? options.localeStore.subscribe((value) => {
          if (localeSeen && value !== lastLocale) newScope(null);
          localeSeen = true;
          lastLocale = value;
        })
      : () => {};

  return {
    subscribe: state.subscribe,

    request(content, source) {
      if (!options.enabled || destroyed || suspended || !content) return;
      const key = source ?? content;
      if (pending.get(key) === content) return;
      pending.set(key, content);
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(flush, debounceMs);
    },

    seed(seed) {
      if (!seed || seed === lastSeed) return;
      lastSeed = seed;
      const known = lastIdentity !== null && options.enabled;
      const trusted = seed.session !== true && lastIdentity === "anonymous";
      // The HYDRATION seed: its cards are already in the server's HTML on
      // screen. With the identity already known (a returning reader's auth
      // is rehydrated synchronously from its cache), an untrusted one is
      // re-checked like any other hydration seed — kept visible until the
      // fresh answers land — never dropped, which would flash every card to
      // neutral and back (security review F1).
      if (!entered) {
        newScope(seed);
        if (known && !trusted) revalidate();
        return;
      }
      // A seed arriving AFTER the first page view (a client-side navigation,
      // a preloaded route) is not shown at all when untrusted: the cookie
      // that made it may belong to an account this tab has since left
      // (codex R2), and nothing of it is on screen yet. Its calls stay
      // spent; the browser resolves as the known viewer.
      if (known && !trusted) {
        newScope(null, null, sanitizeSeed(seed).calls.length);
        return;
      }
      newScope(seed);
    },

    reset() {
      newScope(null);
    },

    signature(content) {
      const visibleCards = visible();
      let out = "";
      for (const key of keysOf(content)) {
        const card = visibleCards[key];
        out += card
          ? `${key}\u0001${card.href}\u0001${card.title}\u0001${card.excerpt}\u0001${card.author}\u0002`
          : `${key}\u0002`;
      }
      return out;
    },

    cardsFor(content) {
      const visibleCards = visible();
      const picked: FirstPartyCardMap = {};
      for (const key of keysOf(content)) {
        const card = visibleCards[key];
        if (card) picked[key] = card;
      }
      return picked;
    },

    suspend() {
      newScope(null);
      suspended = true;
      if (suspendTimer !== null) clearTimeout(suspendTimer);
      suspendTimer = setTimeout(resume, SUSPEND_MAX_MS);
    },

    resume,

    destroy() {
      destroyed = true;
      scope.abort();
      if (suspendTimer !== null) clearTimeout(suspendTimer);
      suspendTimer = null;
      if (staleTimer !== null) clearTimeout(staleTimer);
      staleTimer = null;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending.clear();
      queue.length = 0;
      unsubscribeIdentity();
      unsubscribeLocale();
    },
  };
}

/**
 * The signed-in identity as the resolver reads it: `null` while the auth
 * check has not answered, so settling on the first answer is never a reset.
 */
export const firstPartyCardIdentity: Readable<string | null> = derived(
  authStore,
  (auth) =>
    auth.status === "unknown"
      ? null
      : auth.status === "authenticated"
        ? // The creators this account subscribes to are part of what it may
          // open: buying a membership in place (no reload) must re-resolve
          // the cards that were neutral a moment ago (codex R3).
          `user:${auth.creator?.username ?? ""}|${[...(auth.creator?.stars ?? [])].sort().join(",")}`
        : "anonymous",
);

/**
 * An editor-session resolver (zPage editor, bio editor, composers): the
 * author's own credentials in their own browser, debounced
 * (`FIRST_PARTY_PREVIEW_DEBOUNCE_MS`), cached per API path + language for the
 * life of the component that created it, with its own budget
 * (`MAX_PREVIEW_FIRST_PARTY_CARD_CALLS`). The caller destroys it with the
 * component. An owner's draft previews as a card here because the AUTHOR can
 * open it — and it exists nowhere but in this in-memory store.
 */
export function createFirstPartyPreviewResolver(
  overrides: Partial<
    Omit<FirstPartyCardResolverOptions, "debounceMs" | "maxCalls">
  > = {},
): FirstPartyCardResolver {
  return createFirstPartyCardResolver({
    enabled: browser,
    host: firstPartyCardHost(browser ? window.location.hostname : null),
    locale: () => getCurrentLocale(),
    localeStore: locale,
    apiBase: publicEnv.PUBLIC_API_BASE_URL,
    identity: firstPartyCardIdentity,
    ...overrides,
    debounceMs: FIRST_PARTY_PREVIEW_DEBOUNCE_MS,
    maxCalls: MAX_PREVIEW_FIRST_PARTY_CARD_CALLS,
  });
}

const CONTEXT_KEY = Symbol("first-party-cards");

const INERT: FirstPartyCardResolver = {
  subscribe(run) {
    run({ generation: 0, cards: {} });
    return () => {};
  },
  request() {},
  seed() {},
  signature: () => "",
  cardsFor: () => ({}),
  reset() {},
  suspend() {},
  resume() {},
  destroy() {},
};

/** Make `resolver` the page resolver for this component subtree. */
export function provideFirstPartyCards(resolver: FirstPartyCardResolver) {
  setContext(CONTEXT_KEY, resolver);
  return resolver;
}

/**
 * The page resolver. Outside any provider it is inert: every content embed
 * renders as the neutral link card (fail closed), and nothing is fetched.
 */
export function useFirstPartyCards(): FirstPartyCardResolver {
  return getContext<FirstPartyCardResolver | undefined>(CONTEXT_KEY) ?? INERT;
}
