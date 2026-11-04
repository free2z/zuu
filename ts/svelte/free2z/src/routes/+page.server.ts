import { zpageList } from "$lib/api/zpage/zpage";
import { creatorList } from "$lib/api/creator/creator";
import * as env from "$app/env/private";
import {
  cacheAnonymousHomepage,
  createHomepageUpstreamSignal,
  createDegradedHomepageData,
  createTtlCache,
  createPublicApiOptions,
  hasUsableHomepageData,
  isLikelyMobileUserAgent,
  oneWeekAgo,
  pickHeroStory,
  resolveLatestFeed,
} from "$lib/server/homepage.js";

type HomepageData = {
  authenticated: boolean;
  heroStory: any | null;
  trending: any[];
  trendingHasMore: boolean;
  trendingNext: string | null;
  popular: any[];
  creators: any[];
  // Mobile feed (below md): a plain reverse-chronological list. Rendered
  // server-side so the first screen is content, not a spinner; the client
  // appends further pages on scroll.
  latest: any[];
  latestHasMore: boolean;
  latestNext: string | null;
  // The locale the server actually resolved. MobileFeed pages with this exact
  // value rather than re-deriving one client-side, so page 2 cannot come back
  // in a different language than page 1.
  latestLang: string;
};

// Keep in sync with the client-side pager in MobileFeed.svelte.
const LATEST_PAGE_SIZE = 20;
const HOMEPAGE_TIMEOUT_MS = 3_500;

// The homepage lists are the same for every anonymous visitor and are not
// per-request fresh by nature, so one upstream round of fetches per minute is
// plenty. Signed-in requests (which forward a cookie and can get personalized
// results) bypass the cache entirely.
const HOMEPAGE_TTL_MS = 60_000;
const caches = new Map<string, ReturnType<typeof createTtlCache>>();

function localeCache(locale: string) {
  let cache = caches.get(locale);
  if (!cache) {
    cache = createTtlCache(HOMEPAGE_TTL_MS);
    caches.set(locale, cache);
  }
  return cache;
}

function results(response: any): any[] {
  if (Array.isArray(response)) return response;
  return Array.isArray(response?.results) ? response.results : [];
}

function relativeApiPath(next: unknown): string | null {
  if (typeof next !== "string" || !next) return null;
  try {
    const parsed = new URL(next, "http://free2z.invalid");
    if (parsed.pathname !== "/api/zpage/") return null;
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

// server-side load receives an event; forward incoming cookies so backend
// can authenticate the request if the user has a session cookie or token.
export async function load(event) {
  const cookie = event.request?.headers?.get("cookie");
  const authenticated = Boolean(cookie && /(?:^|;\s*)sessionid=/.test(cookie));
  const locale = event.locals.locale || "en";
  const wantsMobileFeed = isLikelyMobileUserAgent(
    event.request?.headers?.get("user-agent"),
  );
  const cache = localeCache(
    `${locale}:${wantsMobileFeed ? "mobile" : "desktop"}`,
  );

  // Until  the forwarded cookie was silently dropped by the API client, so
  // `/` rendered identically for everyone. Now that a session actually reaches
  // the backend, an authenticated render can include the viewer's own
  // unpublished pages (zPage.get_queryset ORs `is_published` with `creator=me`),
  // which makes this response per-visitor. Declare that to every cache between
  // here and the browser — the in-process TTL cache below is guarded by
  // `authenticated`, but an HTTP-level cache has no way to know that.
  event.setHeaders(
    authenticated
      ? { "cache-control": "private, no-cache", vary: "Cookie" }
      : { vary: "Cookie" },
  );

  if (!authenticated) {
    const cached = cache.get();
    if (cached) return cached as HomepageData;
  }

  const apiBase = env.PRIVATE_API_BASE_URL || "";
  const options = {
    headers: authenticated && cookie ? { cookie } : undefined,
    baseURL: apiBase,
  };
  // The infinite feed is always public. Forwarding a signed-in visitor's
  // session here would include their drafts on page 1 while client page 2+
  // deliberately uses credentials:"omit", shifting the pagination dataset.
  const publicOptions = createPublicApiOptions(apiBase);
  const upstreamSignal = createHomepageUpstreamSignal(
    event.request?.signal,
    HOMEPAGE_TIMEOUT_MS,
  );

  // Don't put a fifth upstream request on every desktop render. Mobile UAs
  // receive page 1 in SSR; a desktop browser narrowed later starts at page 1
  // from MobileFeed's client sentinel. The shared upstream deadline below
  // keeps this optional query and every core query off the render path after
  // the same fixed bound.
  const latestRequest = wantsMobileFeed
    ? zpageList(
        {
          ordering: "-published_at,-id",
          pagination: "cursor",
          page_size: LATEST_PAGE_SIZE,
          lang: locale,
        } as any,
        publicOptions,
        upstreamSignal,
      )
    : Promise.resolve(null);

  // The four core calls and optional mobile-feed call are independent, so
  // they run concurrently.
  // Previously they were sequential `await`s, which serialized four round
  // trips onto the critical path of every homepage render.
  //
  // Hero: the newest pages that have a featured image. Any homeSort value
  // makes the backend exclude imageless pages, and the DRF `ordering` param
  // is applied after it, so this combo means "newest-first, images only".
  const [heroRes, trendingRes, popularRes, creatorsRes, latestRes] =
    await Promise.allSettled([
      zpageList(
        {
          homeSort: "score",
          ordering: "-created_at",
          page: 1,
          page_size: 20,
          lang: locale,
        } as any,
        options,
        upstreamSignal,
      ),
      zpageList(
        {
          homeSort: "updated",
          pagination: "cursor",
          page_size: 20,
          lang: locale,
        } as any,
        // Trending continues in MobileFeed with credentials omitted, so its
        // SSR page must use the same public dataset. Otherwise an owner's
        // drafts can shift the cursor boundary for every following page.
        publicOptions,
        upstreamSignal,
      ),
      // Popular Reads: recency-decayed popularity  rather than all-time
      // f2z_score, so the front page doesn't get permanently owned by 2022
      // content. homeSort=popular also drops imageless pages (cards need art).
      zpageList(
        { homeSort: "popular", page: 1, lang: locale } as any,
        options,
        upstreamSignal,
      ),
      // Use the broad updated directory for the mobile rail. The default
      // creator endpoint is a deliberately strict "creators to watch" list,
      // which can be as small as three qualified profiles even when the
      // directory has more creators available.
      creatorList(
        { homeSort: "updated", page: 1, page_size: 20 } as any,
        options,
        upstreamSignal,
      ),
      // Deliberately NO homeSort: chronological feeds include imageless posts.
      latestRequest,
    ]);

  const outcomes = [
    ["hero", heroRes],
    ["trending", trendingRes],
    ["popular", popularRes],
    ["creators", creatorsRes],
    ["latest", latestRes],
  ] as const;

  for (const [name, outcome] of outcomes) {
    if (outcome.status === "rejected") {
      console.error(`Homepage: ${name} fetch failed`, outcome.reason);
    }
  }

  const coreOutcomes = [heroRes, trendingRes, popularRes, creatorsRes];
  const usable = hasUsableHomepageData(
    coreOutcomes,
    wantsMobileFeed,
    latestRes,
  );

  if (!usable) {
    // A correlated outage is not an authoritative empty catalogue. Return
    // before the cache write, but leave page 1 recoverable on mobile (and if a
    // desktop viewport is later narrowed) with the request's actual locale.
    return { ...createDegradedHomepageData(locale), authenticated };
  }

  const latestState = resolveLatestFeed(wantsMobileFeed, latestRes);

  const heroStory =
    heroRes.status === "fulfilled"
      ? pickHeroStory(results(heroRes.value), oneWeekAgo())
      : null;

  const data: HomepageData = {
    authenticated,
    heroStory,
    // Filter out the hero story from trending to avoid duplication.
    trending:
      trendingRes.status === "fulfilled"
        ? results(trendingRes.value).filter(
            (article: any) =>
              !heroStory || article.free2zaddr !== heroStory.free2zaddr,
          )
        : [],
    // A failed SSR request is not an authoritative end-of-feed. Keep the
    // client sentinel alive so it can retry cursor page 1 after a transient
    // timeout, including when this partially degraded payload is cached.
    trendingHasMore:
      trendingRes.status === "fulfilled"
        ? Boolean(trendingRes.value?.next)
        : true,
    trendingNext:
      trendingRes.status === "fulfilled"
        ? relativeApiPath(trendingRes.value?.next)
        : null,
    // Top 4 by recency-decayed popularity.
    popular:
      popularRes.status === "fulfilled"
        ? results(popularRes.value).slice(0, 4)
        : [],
    creators:
      creatorsRes.status === "fulfilled" ? results(creatorsRes.value) : [],
    latest: latestState.latest,
    // DRF gives us the absolute URL of the next page; the client only needs
    // to know whether to keep paging.
    //
    // On FAILURE this stays true. The feed is the only content on mobile, so a
    // transient upstream error must not render as a confident "nothing
    // published yet" with no way forward — leaving it true keeps the sentinel
    // mounted, and the client's first page fetch either recovers or shows
    // the retry button.
    latestHasMore: latestState.latestHasMore,
    latestNext:
      latestRes.status === "fulfilled"
        ? relativeApiPath(latestRes.value?.next)
        : null,
    latestLang: locale,
  };

  // Cache healthy core content even when the optional latest request timed
  // out. This bounds repeated SSR retries; `latestHasMore` keeps page-1 client
  // recovery available instead of presenting the empty state as authoritative.
  return cacheAnonymousHomepage(cache, data, { authenticated, usable });
}
