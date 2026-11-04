/**
 * The vanity the editor derives from a zPage title.
 *
 * Kept free of `$lib`/`$env` imports so `tests/zpage-vanity.test.mjs` can load
 * it straight into node.
 */

/** `zPage.vanity` is a 128-character column (`py/dj/apps/g12f/models/zpage.py`). */
export const VANITY_MAX_LENGTH = 128;

/**
 * The vanity the editor proposes for a title: ASCII `[a-z0-9-]` only, or `""`.
 *
 * Vanities are ASCII by owner decision (;  is the history of
 * non-Latin URLs breaking redirects), and the API refuses a letter or digit
 * outside a-z/0-9 rather than silently dropping it. The editor used to derive
 * the vanity with the Unicode-preserving `slugify` in
 * `components/mdEditor/utils.ts`, so an Arabic title produced
 * `مرحبا-بالعالم` and every autosave came back 400 until the creator
 * hand-typed an ASCII slug.
 *
 * Accents fold (`Café` -> `cafe`: NFKD, then the marks go, as Django's
 * `slugify` does); any other non-ASCII character is dropped, so a mixed title
 * keeps its Latin words (`Zcash 한국어 digest` -> `zcash-digest`). A title with
 * nothing ASCII left yields `""`: the page saves without a vanity and its URL
 * falls back to the page's address until the creator picks one in the
 * publish sheet.
 *
 * @param {string | null | undefined} title
 * @returns {string}
 */
export function vanityFromTitle(title) {
  if (!title) {
    return "";
  }

  const slug = title
    .normalize("NFKD")
    .replace(/[^\p{ASCII}]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug.slice(0, VANITY_MAX_LENGTH).replace(/-+$/, "");
}
