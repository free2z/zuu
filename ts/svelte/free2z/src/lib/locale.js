export const DEFAULT_LOCALE = "en";
export const SUPPORTED_LOCALES = ["en", "es", "fr", "pt-BR"];
export const LOCALE_STORAGE_KEY = "free2z-locale";

/**
 * The display name of every language we can name, written in that language.
 *
 * This is the ONLY place a language tag becomes user-facing prose. Anything
 * outside this table — `und`, `pt-PT`, a tag a future detector invents — has
 * no name here on purpose, so it can never be printed at a reader.
 *
 * @type {ReadonlyArray<{ code: "en" | "es" | "fr" | "pt-BR", label: string }>}
 */
export const LANGUAGE_OPTIONS = [
  { code: "en", label: "English" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
  { code: "pt-BR", label: "Português (Brasil)" },
];

/**
 * Routes where `?lang=` names the language of the *content* being read rather
 * than the product-UI locale.
 *
 * An article's language and the reader's UI language are unrelated concepts
 * ( §2 principle 8). On these routes `?lang=` is a shareable deep link to
 * one variant of one article, so following it must not re-skin the navbar,
 * the buttons and the footer — and must not write a locale cookie that keeps
 * the site in that language afterwards. Everywhere else `?lang=` keeps its
 * existing meaning as a UI-locale override; redesigning that knob is.
 *
 * @type {readonly string[]}
 */
export const CONTENT_LANGUAGE_ROUTE_IDS = Object.freeze([
  "/article/[id]",
  "/[username]/[vanity]",
  "/[username]/zpage/[slug]",
  "/edit",
]);

/**
 * @param {string | null | undefined} routeId
 * @returns {boolean}
 */
export function isContentLanguageRoute(routeId) {
  return (
    typeof routeId === "string" && CONTENT_LANGUAGE_ROUTE_IDS.includes(routeId)
  );
}

/**
 * The display name of a language, or null when we have no name for it.
 *
 * Returning null is the whole point: callers must render a name or render
 * nothing. A raw BCP-47 subtag in a sentence ("showing the und version") is
 * the exact defect that got the fallback banner removed in /.
 *
 * @param {unknown} code
 * @returns {string | null}
 */
export function languageLabel(code) {
  if (typeof code !== "string") return null;
  const option = LANGUAGE_OPTIONS.find((entry) => entry.code === code);
  return option ? option.label : null;
}

/**
 * Normalize a browser or persisted locale to a language supported by Free2Z.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeLocale(value) {
  if (typeof value !== "string" || value.trim() === "") return null;

  const normalizedValue = value.trim().replace("_", "-").toLowerCase();
  // Bare Portuguese is resolved to the one Portuguese locale we ship, but a
  // regional tag such as pt-PT must not be relabelled as Brazilian content.
  if (normalizedValue === "pt" || normalizedValue === "pt-br") {
    return "pt-BR";
  }

  const language = normalizedValue.split("-")[0];
  return SUPPORTED_LOCALES.includes(language) ? language : null;
}

/**
 * Prefer an explicit user selection, then browser preference, then English.
 *
 * @param {{ savedLocale?: unknown, browserLocale?: unknown }} preferences
 * @returns {string}
 */
export function resolveLocale({ savedLocale, browserLocale }) {
  return (
    normalizeLocale(savedLocale) ??
    normalizeLocale(browserLocale) ??
    DEFAULT_LOCALE
  );
}

/**
 * The product-UI locale for a single server request, and whether it reflects a
 * preference the visitor actually expressed.
 *
 * `persisted` is what tells the client layout it may adopt the server's locale
 * on hydration instead of re-deriving it from the browser.
 *
 * @param {{
 *   routeId?: string | null,
 *   queryLocale?: unknown,
 *   cookieLocale?: unknown,
 * }} request
 * @returns {{ locale: string, persisted: boolean }}
 */
export function resolveRequestLocale({ routeId, queryLocale, cookieLocale }) {
  const cookie = normalizeLocale(cookieLocale);
  // On an article or editor route `?lang=` selects the content variant, not
  // the product UI. The editor's language picker deep-links to `/edit?lang=`.
  const query = isContentLanguageRoute(routeId)
    ? null
    : normalizeLocale(queryLocale);

  return {
    locale: query ?? cookie ?? DEFAULT_LOCALE,
    persisted: Boolean(query || cookie),
  };
}

// ---------------------------------------------------------------------------
// `resolveArticleLanguage` and `resolveFallbackDisclosure` used to live here.
//
// They are CONTENT-language decisions, and having them in the UI-locale module
// is what made them use the UI-locale normalizer: `?lang=zh-Hans` normalized to
// `null`, so a published Simplified Chinese translation was fetched as English
// and its fallback was never even disclosed. They now live in
// `zpage-language.js`, next to `normalizeContentLanguage`, which is the
// normalizer a content language must go through.
//
// Nothing else belongs in this file that decides what to *fetch* or *render*
// for an article. This module answers exactly one question: which of the four
// locales the product UI is translated into is this visitor using?
// ---------------------------------------------------------------------------
