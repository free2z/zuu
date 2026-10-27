/**
 * Path segments that are a stringified *nothing*, not an identifier.
 *
 * `null` and `undefined` are what JavaScript writes when a missing value is
 * interpolated into a URL — `` `/${user}/${page.vanity}` `` with no vanity, or
 * `encodeURIComponent(null)` inside a generated API client's path. Whatever
 * produced the link, the resulting URL identifies nothing and can only 404.
 *
 *Meta's crawler requests `/{username}/null` on essentially every page
 * it visits (~300-400/day across prod and stage, 100% `meta-externalagent`),
 * and each one used to cost a full SSR render plus a `GET /api/zpage/null/`
 * round trip before the API's 404 came back — on an SSR process that already
 * heap-OOMs several times a day. Recognising the segment up front
 * turns that into an immediate 404.
 *
 * Deliberately NOT in this set:
 *
 *   `none`  — an ordinary English word and a perfectly plausible vanity or
 *             title slug. Django would write `None`, but nothing on the write
 *             path can produce it (`get_url()` falls back to `free2zaddr`,
 *             which is `null=False`), so the cost of shadowing a real page is
 *             not worth a failure mode we have never observed.
 *   `nan`, `[object object]` — never observed in the logs, and the same
 *             shadowing argument applies to `nan` (an ISO 639 language code
 *             and a common romanisation).
 *
 * The other half of this pair lives on the WRITE path: both values are in
 * `RESERVED_VANITIES` (`py/dj/apps/g12f/serializers/zpage.py`), so the API
 * cannot mint a page whose only URL this guard refuses to serve. That matters
 * because the editor derives a vanity by slugifying the TITLE — without the
 * reservation, an article called "Null" would be created unreachable.
 *
 * Matched case-insensitively and after trimming: `vanity` is a Django
 * `SlugField`, so a real page cannot hold surrounding whitespace, and neither
 * `NULL` nor `Undefined` is a plausible identifier either. Verified against
 * production before shipping: `/api/zpage/null/`, `/api/zpage/undefined/` and
 * `/api/zpage/None/` all 404, so no live page is shadowed by this guard.
 */
const NULLISH_SEGMENTS: ReadonlySet<string> = new Set(["null", "undefined"]);

/**
 * True when a route parameter carries no usable zPage identifier.
 *
 * Callers should answer 404 rather than passing the value to the API: a
 * literal `null` is not a slug we could ever resolve, and forwarding it only
 * turns one guaranteed-404 request into two.
 */
export function isNullishSlug(slug?: string | null): boolean {
  if (slug === null || slug === undefined) return true;
  const trimmed = slug.trim();
  if (trimmed === "") return true;
  return NULLISH_SEGMENTS.has(trimmed.toLowerCase());
}
