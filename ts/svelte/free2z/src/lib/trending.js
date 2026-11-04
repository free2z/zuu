// Pure helpers for the /trending discovery view.
//
// Deliberately NOT under $lib/server: `trendingHref` is used by the page
// component (and by the homepage entry points), which is bundled for the
// browser, and SvelteKit refuses to ship $lib/server modules to the client.
// Kept as plain JS with no SvelteKit imports so it can be unit-tested directly
// by `npm test` (node --test), the same way src/lib/locale.js is.

/** Page size for the trending grid. 12 divides evenly into 2/3/4 columns. */
export const TRENDING_PAGE_SIZE = 12;

/**
 * The only sorts we expose. Both map to a `homeSort` the backend implements
 * (py/dj/apps/g12f/views/zpage.py) and both are paginatable, so a page number
 * is meaningful for either.
 *
 * - `updated`  — most recently updated first; matches the homepage "Community
 *                Favorites" grid, which is what "Explore All Trending" opens.
 * - `popular`  — recency-decayed f2z_score; matches the homepage
 *                "Popular Reads" list, which is what its "View More" opens.
 */
export const TRENDING_SORTS = ["updated", "popular"];

export const DEFAULT_TRENDING_SORT = "updated";

/**
 * Parse and clamp the /trending query string. Anything unrecognised falls back
 * to the defaults rather than erroring: this is a discovery page reached from
 * marketing links, and a malformed URL should still show content.
 *
 * @param {URLSearchParams} searchParams
 * @returns {{ sort: string, page: number }}
 */
export function parseTrendingParams(searchParams) {
  const rawSort = searchParams?.get?.("sort") ?? "";
  const sort = TRENDING_SORTS.includes(rawSort)
    ? rawSort
    : DEFAULT_TRENDING_SORT;

  const rawPage = Number.parseInt(searchParams?.get?.("page") ?? "", 10);
  // Cap the page number so a crawler following a hand-edited `?page=1e9` can't
  // make us issue an expensive OFFSET query against the backend.
  const page =
    Number.isFinite(rawPage) && rawPage > 0 ? Math.min(rawPage, 1000) : 1;

  return { sort, page };
}

/**
 * Build the canonical href for a trending page/sort combination. `page=1` and
 * the default sort are omitted so the entry-point link and page 1 of the
 * paginator share one URL (and one cache entry, and one canonical for SEO).
 *
 * @param {{ sort?: string, page?: number }} params
 * @returns {string}
 */
export function trendingHref({ sort = DEFAULT_TRENDING_SORT, page = 1 } = {}) {
  const qs = new URLSearchParams();
  if (sort && sort !== DEFAULT_TRENDING_SORT) qs.set("sort", sort);
  if (page && page > 1) qs.set("page", String(page));
  const suffix = qs.toString();
  return suffix ? `/trending?${suffix}` : "/trending";
}

/**
 * Total number of pages available for `count` results, floored at 1 so the
 * paginator renders sensibly for an empty result set.
 *
 * @param {number} count
 * @param {number} [pageSize]
 * @returns {number}
 */
export function totalPages(count, pageSize = TRENDING_PAGE_SIZE) {
  const n = Number(count);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.max(1, Math.ceil(n / pageSize));
}
