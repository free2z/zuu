/**
 * URL and pagination rules for the `/tag/<slug>` topic hubs.
 *
 * Plain JS, not TypeScript, and NOT under `$lib/server`: `tagHref()` in
 * `tags.js` calls into it to build every tag chip's href in the browser, and
 * `tests/tag.test.mjs` imports it directly under `node --test`. Same reasoning
 * as `trending.js`, which this deliberately mirrors.
 */

import { slugifyTag } from "./tag-slug.js";

/**
 * Results per hub page. 12 matches `Free2zPagination.page_size` on the API, so
 * the default request costs the backend no extra work, and it matches
 * `TRENDING_PAGE_SIZE` so the two list pages look the same.
 */
export const TAG_PAGE_SIZE = 12;

/**
 * Hard ceiling on `?page=`. The live corpus's biggest tag (`technology`) has
 * 1,913 published pages — 160 pages at this size — so 1,000 is far above any
 * real hub while still bounding what a crawler following a hand-edited
 * `?page=1e9` can make the backend do. Same rule, same reason, as
 * `parseTrendingParams`.
 */
export const TAG_MAX_PAGE = 1000;

/**
 * @param {URLSearchParams | null | undefined} searchParams
 * @returns {number} a 1-based page number, always within `[1, TAG_MAX_PAGE]`.
 */
export function parseTagPage(searchParams) {
  const raw = Number.parseInt(searchParams?.get?.("page") ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, TAG_MAX_PAGE) : 1;
}

/**
 * Where a hub lives.
 *
 * Page 1 is the bare path — never `?page=1`. That is what lets the entry-point
 * link, the sitemap `<loc>`, every tag chip and the canonical all be the same
 * string; a `?page=1` twin would be a second URL over one result set, which is
 * the exact duplicate-URL problem `/search?tag=` had.
 *
 * The slug is percent-encoded because tags are multilingual: `/tag/日本語` is a
 * real hub and the raw characters are not valid in a URL path.
 *
 * @param {{ slug: string, page?: number }} options
 * @returns {string}
 */
export function tagPageHref({ slug, page = 1 }) {
  const path = `/tag/${encodeURIComponent(slug)}`;
  return page > 1 ? `${path}?page=${page}` : path;
}

/**
 * The hub for a tag NAME, or `null` when the tag has no slug at all.
 *
 * `null` is a real answer, not an error: a tag of only emoji or only
 * punctuation reduces to an empty slug, and there is no `/tag/` URL for it.
 * The caller falls back to `/search?tag=` rather than emitting `/tag/`.
 *
 * @param {string} name
 * @returns {string | null}
 */
export function tagHubHref(name) {
  const slug = slugifyTag(name);
  return slug ? tagPageHref({ slug }) : null;
}

/**
 * @param {number} count
 * @param {number} [pageSize]
 * @returns {number} at least 1, so an empty list still has a "page 1 of 1".
 */
export function totalTagPages(count, pageSize = TAG_PAGE_SIZE) {
  const total = Math.ceil((Number(count) || 0) / pageSize);
  return Math.max(1, total);
}
