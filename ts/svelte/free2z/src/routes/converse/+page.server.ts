import * as env from "$app/env/private";
import type { PageServerLoad } from "./$types";
import { CANONICAL_CONTENT_URL_HEADERS } from "$lib/api/canonical-content-url";
import type { PaginatedCommentListList } from "$lib/api/f2z.schemas";
import { getSessionCookie } from "$lib/server/backend";
import {
  isServerRenderedStream,
  parseConverseFilters,
} from "$lib/converse/feed-filters";
import { createHomepageUpstreamSignal } from "$lib/server/homepage.js";
import { loadFirstPartyCardSeed } from "$lib/server/first-party-embed-cards";

/**
 * Server-renders page one of the Converse stream so `/converse` opens on
 * content, not on a skeleton. `/` and `/converse/[uuid]` both SSR;
 * this was the one public feed that handed crawlers an empty shell.
 *
 * Deliberately page one ONLY, and deliberately the UNFILTERED stream: the
 * default filter state is unfiltered, and the client re-derives its own
 * filter state from the URL. Any non-default URL -- `?tags=`, `?sort=hot`,
 * `?view=threads`, `?posts=1` -- loads client-side exactly as before, and
 * this loader does not fetch at all for one: the payload would be discarded
 * by `isServerRenderedStream` on the page, so fetching it only blocks the
 * render for up to UPSTREAM_TIMEOUT_MS and buys a full visibility-scoped
 * `count()` nobody reads. The SAME predicate gates both sides.
 *
 * The session cookie IS forwarded. `scope_comments_to_visible_parents` widens
 * the queryset for an authenticated caller (their own drafts' threads, their
 * own private AI conversations), so page one must be rendered for whoever
 * the cookie belongs to -- and the response must be declared per-visitor.
 * Same header contract as `converse/[uuid]/+page.server.ts`.
 *
 * Fail-open by design: an upstream failure returns `null` and the client
 * fetches page one itself, rather than 500ing the platform's main public
 * feed. The homepage's shared-deadline pattern  bounds the single
 * upstream request so a slow backend cannot hold the render hostage.
 *
 * `ssrHadSession` reports cookie presence, not creator identity. The page
 * conservatively refreshes session-bearing SSR once identity resolves, since
 * another tab may have changed accounts after this request was sent.
 */

// Keep in sync with CommentStreamCursorPagination's default page_size (and
// Free2zPagination's), so SSR page one and client page two are the same size.
const STREAM_PAGE_SIZE = 12;

// Same bound as the homepage's core upstream calls.
const UPSTREAM_TIMEOUT_MS = 3_500;

export const load: PageServerLoad = async ({
  request,
  fetch,
  cookies,
  setHeaders,
  url,
  locals,
  isDataRequest,
}) => {
  const cookie = request?.headers?.get("cookie");
  // Whether Django could authenticate this render AT ALL. Not whether it
  // succeeded -- the loader deliberately does not spend a round trip finding
  // out -- but EXACTLY the signal `hasSession` uses, via the same helper.
  //
  // It has to be the `sessionid` cookie specifically, never `Boolean(cookie)`:
  // an anonymous visitor carrying nothing but `free2z-locale=es` or a
  // `csrftoken` has a cookie header, and treating that as a session would make
  // every such visitor's own hydration declare an identity mismatch against
  // its own correct anonymous render -- throwing away a perfectly good
  // server-rendered feed and replacing it with a request that can stall or
  // fail. That is a regression of the SSR this loader exists for, aimed at the
  // majority of anonymous traffic.
  const ssrHadSession = Boolean(getSessionCookie(cookies));
  setHeaders(
    cookie
      ? { "cache-control": "private, no-cache", vary: "Cookie" }
      : { vary: "Cookie" },
  );

  // The page adopts this payload ONLY for the bare, unfiltered stream
  // (`isServerRenderedStream`), so on any other URL the fetch is work whose
  // result is thrown away: `?tags=zcash`, `?posts=1`, `?sort=hot` and
  // `?view=threads` would each block the render for up to UPSTREAM_TIMEOUT_MS
  // waiting for a page the component discards, and pay for a full
  // visibility-scoped `count()` and sort to do it. The SAME predicate decides
  // here and there -- one function, so the loader cannot drift into fetching a
  // page the page will not take, or into skipping one it needs.
  if (!isServerRenderedStream(parseConverseFilters(url.searchParams))) {
    return { initialPage: null, ssrHadSession };
  }

  try {
    const apiBase = env.PRIVATE_API_BASE_URL || "";
    const headers = {
      ...CANONICAL_CONTENT_URL_HEADERS,
      ...(cookie ? { cookie } : {}),
    };
    const upstreamSignal = createHomepageUpstreamSignal(
      request?.signal,
      UPSTREAM_TIMEOUT_MS,
    );
    const response = await fetch(
      `${apiBase}/api/comments/?pagination=cursor&ordering=-created_at&page_size=${STREAM_PAGE_SIZE}`,
      { headers, signal: upstreamSignal },
    );
    if (!response.ok) {
      return { initialPage: null, ssrHadSession };
    }
    const initialPage = (await response.json()) as PaginatedCommentListList;
    // `::embed[]` cards in page one's posts, as THIS reader. The
    // twelve posts share ONE server budget (`MAX_FIRST_PARTY_CARDS` calls)
    // and one deduped set of calls; everything past it — and every later
    // page and reply — resolves in the browser inside the page budget.
    const firstPartyCardSeed = await loadFirstPartyCardSeed({
      contents: (initialPage?.results ?? []).map((post) => post?.content),
      browserResolvesDataRequest: isDataRequest,
      fetch,
      cookie,
      locale: locals?.locale,
      signal: request?.signal,
      requestHostname: url.hostname,
    });
    return { initialPage, firstPartyCardSeed, ssrHadSession };
  } catch (error) {
    // A timed-out or failed SSR fetch is not an authoritative empty feed.
    console.error("Failed to load converse stream page one", error);
    return { initialPage: null, ssrHadSession };
  }
};
