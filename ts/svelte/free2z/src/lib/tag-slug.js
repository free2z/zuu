/**
 * The JavaScript half of the ONE tag-slug derivation.
 *
 * The Python half is `py/dj/apps/tagging/slugs.py`, and its module docstring is
 * the specification — read that before changing a rule here. These are two
 * implementations because they run in two runtimes, NOT because the rules
 * differ: the browser computes the `href` on every tag chip and Django answers
 * the URL that href points at, so a disagreement is a dead link on a page we
 * are asking Google to index.
 *
 * The golden table both suites assert against:
 *
 *     py/dj/apps/tagging/testdata/tag_slug_parity.json
 *       asserted by py/dj/apps/tagging/test_tag_slugs.py
 *       asserted by ts/svelte/free2z/tests/tag-slug.test.mjs
 *
 * Change one side without the other and both suites go red. That is the point.
 *
 * Plain JS rather than TypeScript so `tests/tag-slug.test.mjs` can import it
 * directly under `node --test`, the same reason `tags.js` and `trending.js` are.
 */

/**
 * Bound on a slug, in CODE POINTS — `"".length` counts UTF-16 units and would
 * cut an astral character in half, and cut it at a different place than Python
 * does. Mirrors `TAG_SLUG_MAX_LENGTH` in `slugs.py`, whose comment explains
 * why 200 rather than a prettier 80: the bound sits ABOVE the longest slug any
 * storable tag can produce (`Tag.name` is 100 characters and lowercasing
 * lengthens by at most 2x), so the truncation branch is unreachable for real
 * data. At 80 an over-long tag produced a slug its own name could never match,
 * and every chip for it pointed at a 404.
 */
export const TAG_SLUG_MAX_LENGTH = 200;

/**
 * Unicode letters, numbers and combining marks — everything else becomes a
 * separator. Python spells this `unicodedata.category(c)[0] in "LNM"`.
 */
const KEEP_RE = /[\p{L}\p{N}\p{M}]/u;

const DASH_RUN_RE = /-{2,}/g;
const TRIM_DASH_RE = /^-+|-+$/g;

/**
 * `toLowerCase()`, never `toLocaleLowerCase()`. The locale-aware variant maps
 * `I` to `ı` under a Turkish locale, which would make the same tag produce two
 * different URLs depending on the visitor's browser settings — and neither of
 * them the one Django answers. `tagKey()` in `tags.js` may stay locale-aware
 * because it only ever compares strings inside one runtime; a slug is a
 * cross-runtime identity.
 *
 * @param {string} name
 * @returns {string} the canonical slug, or `""` when the tag has none.
 */
export function slugifyTag(name) {
  // No whitespace-collapse step, deliberately — see `slugs.py`. Every
  // whitespace character is non-`KEEP_RE` and therefore becomes `-`, and the
  // run-collapse below merges it, so collapsing first would be a no-op that
  // imported a real cross-runtime divergence: Python's `str.split()` treats
  // U+0085 as whitespace and JavaScript's `\s` does not, while `\s` treats
  // U+FEFF as whitespace and Python does not.
  const text = (name || "").normalize("NFC").toLowerCase().normalize("NFC");

  let slug = Array.from(text)
    .map((character) => (KEEP_RE.test(character) ? character : "-"))
    .join("")
    .replace(DASH_RUN_RE, "-")
    .replace(TRIM_DASH_RE, "");

  const points = Array.from(slug);
  if (points.length > TAG_SLUG_MAX_LENGTH) {
    slug = points.slice(0, TAG_SLUG_MAX_LENGTH).join("");
    const boundary = slug.lastIndexOf("-");
    if (boundary > 0) slug = slug.slice(0, boundary);
    slug = slug.replace(TRIM_DASH_RE, "");
  }
  return slug;
}

/**
 * Whether `value` is a slug `slugifyTag` could have produced.
 *
 * The function IS the predicate: it is idempotent, so a value it does not
 * reproduce exactly is not one it could have emitted. Mirrors
 * `is_canonical_slug()`.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isCanonicalTagSlug(value) {
  if (!value || Array.from(value).length > TAG_SLUG_MAX_LENGTH) return false;
  return slugifyTag(value) === value;
}
