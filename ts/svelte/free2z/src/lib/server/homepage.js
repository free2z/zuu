// Pure helpers for the homepage SSR load (src/routes/+page.server.ts).
//
// Kept as plain JS with no SvelteKit imports so it can be unit-tested
// directly by `npm test` (node --test), the same way src/lib/locale.js is.

/**
 * ISO date (YYYY-MM-DD) for one week before `now`.
 *
 * @param {Date} [now]
 * @returns {string}
 */
export function oneWeekAgo(now = new Date()) {
  const d = new Date(now);
  d.setDate(d.getDate() - 7);
  return d.toISOString().split("T")[0];
}

/**
 * Best-effort SSR hint for whether the request will render the mobile feed.
 * Desktop requests skip the fifth upstream call; if a desktop browser is
 * later narrowed, MobileFeed starts at page 1 on the client instead.
 *
 * @param {string | null | undefined} userAgent
 * @returns {boolean}
 */
export function isLikelyMobileUserAgent(userAgent) {
  return /android|webos|iphone|ipad|ipod|blackberry|iemobile|opera mini|mobile/i.test(
    userAgent || "",
  );
}

/**
 * Request options for homepage data that must stay on the anonymous dataset.
 * Kept separate from the cookie-bearing options used by personalized panels.
 *
 * @param {string} baseURL
 * @returns {{baseURL: string, credentials: "omit"}}
 */
export function createPublicApiOptions(baseURL) {
  return { baseURL, credentials: "omit" };
}

/**
 * Give every homepage upstream call one shared hard deadline, while also
 * stopping work when the incoming request is cancelled.
 *
 * @param {AbortSignal | null | undefined} requestSignal
 * @param {number} timeoutMs
 * @returns {AbortSignal}
 */
export function createHomepageUpstreamSignal(requestSignal, timeoutMs) {
  // This module is SSR-only and never enters the browser bundle. Node 24
  // provides both native signal helpers, so keep the server's existing
  // shared-deadline behavior intact.
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return requestSignal
    ? AbortSignal.any([requestSignal, timeoutSignal])
    : timeoutSignal;
}

/**
 * Total upstream failure is not proof that the catalogue is empty. Keep the
 * mobile pager recoverable and preserve the request locale, while returning
 * no desktop sections. `liveNow` is deliberately absent: the browser must
 * distinguish unavailable discovery from a successful empty response so
 * creator cards can retain their ordinary live-status fallback polling.
 * Callers deliberately return this before cache writes.
 *
 * @param {string} locale
 */
export function createDegradedHomepageData(locale) {
  return {
    heroStory: null,
    trending: [],
    trendingHasMore: true,
    trendingNext: null,
    popular: [],
    creators: [],
    latest: [],
    latestHasMore: true,
    latestNext: null,
    latestLang: locale,
  };
}

/**
 * A rejected optional feed must not turn otherwise usable homepage data into
 * a cache miss. MobileFeed can recover page 1 in the browser when `hasMore`
 * remains true.
 *
 * @param {boolean} wantsMobileFeed
 * @param {PromiseSettledResult<any> | undefined} outcome
 * @returns {{ latest: any[], latestHasMore: boolean }}
 */
export function resolveLatestFeed(wantsMobileFeed, outcome) {
  if (wantsMobileFeed && outcome?.status === "fulfilled") {
    return {
      latest: outcome.value?.results || [],
      latestHasMore: Boolean(outcome.value?.next),
    };
  }

  return { latest: [], latestHasMore: true };
}

/**
 * @param {PromiseSettledResult<any>[]} coreOutcomes
 * @param {boolean} wantsMobileFeed
 * @param {PromiseSettledResult<any> | undefined} latestOutcome
 * @returns {boolean}
 */
export function hasUsableHomepageData(
  coreOutcomes,
  wantsMobileFeed,
  latestOutcome,
) {
  return (
    coreOutcomes.some((outcome) => outcome.status === "fulfilled") ||
    (wantsMobileFeed && latestOutcome?.status === "fulfilled")
  );
}

/**
 * Cache any usable anonymous payload, including healthy core data paired with
 * a degraded optional feed. This puts a TTL bound on repeated SSR retries
 * while preserving client recovery through `latestHasMore: true`.
 *
 * @template T
 * @param {{ set(next: T): T }} cache
 * @param {T} data
 * @param {{ authenticated: boolean, usable: boolean }} state
 * @returns {T}
 */
export function cacheAnonymousHomepage(cache, data, state) {
  if (!state.authenticated && state.usable) cache.set(data);
  return data;
}

/**
 * @param {any} article
 * @returns {boolean}
 */
function hasFeaturedImage(article) {
  const img = article && article.featured_image;
  return Boolean(img && (img.url || img.thumbnail));
}

/**
 * Pick the hero story: the highest-scoring image-bearing page from the last
 * week, falling back to the newest image-bearing pages overall when the week
 * was quiet.
 *
 * NOTE: /api/zpage/ has no date filterset — params like created_at__gte are
 * silently IGNORED by DRF, so recency has to be applied here.
 *
 * @param {any[] | undefined | null} candidates
 * @param {string} cutoff YYYY-MM-DD
 * @returns {any | null}
 */
export function pickHeroStory(candidates, cutoff) {
  const pool = Array.isArray(candidates) ? candidates : [];
  // ISO strings compare lexicographically, so >= works on created_at vs
  // YYYY-MM-DD.
  const recent = pool.filter((a) => (a.created_at || "") >= cutoff);
  const scoped = recent.length > 0 ? recent : pool;

  return (
    scoped
      .filter(hasFeaturedImage)
      .sort((a, b) => Number(b.f2z_score || 0) - Number(a.f2z_score || 0))[0] ||
    null
  );
}

/**
 * Minimal single-value TTL cache for a hot SSR payload.
 *
 * The homepage's trending/popular/creator lists do not need to be
 * per-request fresh, and the render sits on the critical path of every cold
 * visit. `now` is injectable so the TTL is testable without timers.
 *
 * @template T
 * @param {number} ttlMs
 */
export function createTtlCache(ttlMs) {
  /** @type {T | undefined} */
  let value;
  let expiresAt = 0;

  return {
    /**
     * @param {number} [now]
     * @returns {T | undefined}
     */
    get(now = Date.now()) {
      return now < expiresAt ? value : undefined;
    },
    /**
     * @param {T} next
     * @param {number} [now]
     * @returns {T}
     */
    set(next, now = Date.now()) {
      value = next;
      expiresAt = now + ttlMs;
      return next;
    },
    clear() {
      value = undefined;
      expiresAt = 0;
    },
  };
}
