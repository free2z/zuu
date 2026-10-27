/**
 * Resolve the zPage/converse content cards server-rendered markdown embeds
 * ( part 2, ), on the server, AS THE READER.
 *
 * This is the server half of the ONE resolver in
 * `$lib/utils/first-party-embed-resolve.ts` (planner, request builder,
 * bounded reader, card builders). It adds only what is server-specific: the
 * private API base, the reader's forwarded cookie, and one deadline for the
 * whole batch. Security properties, each pinned by a test in
 * `tests/first-party-embed-cards.test.mjs` with a negative control:
 *
 *  - **The reader's credentials, and only theirs.** The one credential sent is
 *    the cookie header of the request being rendered — forwarded exactly the
 *    way the article fetch itself forwards it. An anonymous render (every
 *    crawler on the `$seobot` tier) sends no cookie and so can only ever
 *    receive public content. There is no service token and no author context.
 *
 *  - **The API, never the route.** A card is looked up by identifier —
 *    `GET /api/zpage/<identifier>/` and `GET /api/comments/<uuid>/`, the very
 *    calls the zPage and converse routes make — built by
 *    `firstPartyCardRequestPath`, which refuses anything else. The embedded
 *    URL is never fetched and a redirect is never followed
 *    (`redirect: "manual"`, and anything but a 200 is no card).
 *
 *  - **Bounded.** At most `maxCalls` distinct calls per render (default
 *    `MAX_FIRST_PARTY_CARDS`) across EVERY body the page server-renders — a
 *    converse feed's twelve posts share one budget — fetched in parallel,
 *    all under ONE deadline (`FIRST_PARTY_EMBED_TIMEOUT_MS`), each body
 *    capped in bytes. A page with no first-party content embed makes no call.
 *    A gated article (the reader got the redacted upsell) resolves nothing.
 *
 *  - **Nothing gated enters the page data.** Only cards the builders accept
 *    are returned; everything else is simply absent, so the serialized page
 *    data (which hydration ships to the browser) holds nothing the reader
 *    could not already open. The seed's `calls` are the call keys attempted —
 *    derived from markdown the reader already has — so the browser knows not
 *    to repeat them.
 *
 * Caching: every route calling this answers `private, no-cache` with
 * `Vary: Cookie` (`hooks.server.ts` enforces that on all HTML and
 * `__data.json`), and neither API path is in the new-ui nginx micro-cache
 * (which in any case bypasses and refuses to store a request with a cookie).
 * So a reader's card is never served to anyone else.
 */
import * as env from "$app/env/private";
import { createAbortSignalWithTimeout } from "$lib/abort-signal.js";
import { FIRST_PARTY_EMBED_TIMEOUT_MS } from "$lib/article-ssr-deadlines.js";
import {
  firstPartyCardApiPath,
  firstPartyCardHost,
  MAX_FIRST_PARTY_CARDS,
  type FirstPartyCardMap,
} from "$lib/utils/first-party-embed-cards";
import {
  createFirstPartyCardLedger,
  firstPartyCardRequestPath,
  readFirstPartyCardBody,
  MAX_FIRST_PARTY_CARD_RESPONSE_BYTES,
  type FirstPartyCardCall,
  type FirstPartyCardSeed,
} from "$lib/utils/first-party-embed-resolve";

export { MAX_FIRST_PARTY_CARD_RESPONSE_BYTES };
/** Re-exported for callers that imported it from here. */
export { firstPartyCardApiPath };

type Fetch = typeof fetch;

type CommonOptions = {
  /** The reader got the redacted upsell: resolve nothing. */
  gated?: boolean;
  /** SvelteKit's `event.fetch`. */
  fetch: Fetch;
  /** The reader's own `cookie` request header, or null when anonymous. */
  cookie: string | null | undefined;
  /**
   * The reader's UI locale: the `lang` a zPage card is asked for when the
   * embed itself named none (an embed's own validated `?lang=` wins).
   */
  locale?: string | null;
  /**
   * The hostname the reader asked for (`event.url.hostname`). Only embeds of
   * the host this deployment answers for are resolved (`firstPartyCardHost`).
   */
  requestHostname?: string | null;
  /** The request's own abort signal. */
  signal?: AbortSignal | null;
};

export type LoadFirstPartyCardsOptions = CommonOptions & {
  /** The article's markdown, as the reader received it. */
  content: string | null | undefined;
};

export type LoadFirstPartyCardSeedOptions = CommonOptions & {
  /**
   * Every markdown body this render shows, in page order (a bio; a converse
   * root; a feed page's posts). They share ONE budget and one deduped set of
   * calls.
   */
  contents: ReadonlyArray<string | null | undefined>;
  /** Distinct calls this render may make; default `MAX_FIRST_PARTY_CARDS`. */
  maxCalls?: number;
  /**
   * `event.isDataRequest` of a route whose seeded bodies the BROWSER can
   * resolve (bio, converse). A signed-in client-side navigation's seed is
   * never shown — the identity is already known, and a cookie is not an
   * identity — so resolving it would only delay `__data.json` by up to the
   * card deadline for work the browser throws away (review F2). Such a
   * request resolves nothing; the browser resolves as the known viewer.
   *
   * A session-bearing FULL render still resolves, deliberately: its cards
   * are in the HTML the reader sees first (and all a no-JS reader ever
   * sees), and hydration keeps them on screen while the browser re-checks
   * them (F1), so they are not thrown away — they are what prevents a flash.
   * The cost is the same bounded first-byte delay the article routes pay.
   * (The article routes never pass this: their body renders from its cards.)
   */
  browserResolvesDataRequest?: boolean;
};

function apiUrl(requestPath: string) {
  const base = env.PRIVATE_API_BASE_URL?.replace(/\/$/, "") || "";
  return `${base}${requestPath}`;
}

/** One API call: the (pruned) body of a 200, or null for anything else. */
async function fetchCardBody(
  call: FirstPartyCardCall,
  options: CommonOptions,
  signal: AbortSignal,
): Promise<unknown> {
  const requestPath = firstPartyCardRequestPath(call);
  if (!requestPath) return null;
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.cookie) headers.cookie = options.cookie;
  const response = await options.fetch(apiUrl(requestPath), {
    headers,
    signal,
    redirect: "manual",
  });
  return readFirstPartyCardBody(response, signal);
}

/**
 * The cards `contents` embed, as this reader may see them, plus the calls
 * attempted. Never throws: any failure is a missing card, which renders as
 * the neutral link card.
 */
export async function loadFirstPartyCardSeed(
  options: LoadFirstPartyCardSeedOptions,
): Promise<FirstPartyCardSeed> {
  const session = /(?:^|;)\s*sessionid=[^;\s]/.test(options.cookie ?? "");
  if (options.gated || (session && options.browserResolvesDataRequest)) {
    return { cards: {}, calls: [], keys: [], session };
  }
  const ledger = createFirstPartyCardLedger({
    host: firstPartyCardHost(options.requestHostname),
    maxCalls: options.maxCalls ?? MAX_FIRST_PARTY_CARDS,
  });
  const calls: FirstPartyCardCall[] = [];
  for (const content of options.contents) {
    calls.push(...ledger.plan(content, options.locale).calls);
  }
  if (calls.length === 0)
    return { cards: {}, calls: ledger.calls(), keys: ledger.keys(), session };

  const abort = createAbortSignalWithTimeout(
    options.signal ?? undefined,
    FIRST_PARTY_EMBED_TIMEOUT_MS,
  );
  // The deadline has to bound the WHOLE resolution, not each fetch: a fetch
  // that ignores its signal must not hold the page either.
  const deadline = new Promise<"timeout">((resolve) => {
    if (abort.signal.aborted) resolve("timeout");
    abort.signal.addEventListener("abort", () => resolve("timeout"), {
      once: true,
    });
  });
  // One call per distinct API path + language, fanned out by the ledger to
  // every key that needs it. `/alice/post`, `/ALICE/post?x` and
  // `/article/post` are one call; each key's own checks (username vs
  // creator, identifier vs page) still run on the shared answer.
  const cards: FirstPartyCardMap = {};
  try {
    await Promise.race([
      Promise.all(
        calls.map(async (call) => {
          try {
            const body = await fetchCardBody(call, options, abort.signal);
            if (abort.signal.aborted) return;
            Object.assign(cards, ledger.settle(call.key, body));
          } catch {
            // Timeout, network error: no card.
          }
        }),
      ),
      deadline,
    ]);
  } finally {
    abort.cleanup();
  }
  // A copy, so a fetch that settles after the deadline cannot add to the map
  // the page is already rendering from.
  return {
    cards: { ...cards },
    calls: ledger.calls(),
    keys: ledger.keys(),
    session,
  };
}

/** The cards one article body embeds (the two article routes). */
export async function loadFirstPartyCards(
  options: LoadFirstPartyCardsOptions,
): Promise<FirstPartyCardMap> {
  const { content, ...rest } = options;
  return (await loadFirstPartyCardSeed({ ...rest, contents: [content] })).cards;
}
