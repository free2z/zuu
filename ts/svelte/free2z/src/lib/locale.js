export const DEFAULT_LOCALE = "en";
// Availability describes the existing shipped UI, not translation review approval.
/** @type {readonly {code: "en" | "es" | "fr" | "pt-BR", label: string, script: string, direction: "ltr" | "rtl", formattingLocale: string, fallback: string | null, availability: "shipped"}[]} */
export const LOCALE_REGISTRY = Object.freeze([
  {
    code: "en",
    label: "English",
    script: "Latn",
    direction: "ltr",
    formattingLocale: "en",
    fallback: null,
    availability: "shipped",
  },
  {
    code: "es",
    label: "Español",
    script: "Latn",
    direction: "ltr",
    formattingLocale: "es",
    fallback: "en",
    availability: "shipped",
  },
  {
    code: "fr",
    label: "Français",
    script: "Latn",
    direction: "ltr",
    formattingLocale: "fr",
    fallback: "en",
    availability: "shipped",
  },
  {
    code: "pt-BR",
    label: "Português (Brasil)",
    script: "Latn",
    direction: "ltr",
    formattingLocale: "pt-BR",
    fallback: "en",
    availability: "shipped",
  },
]);
export const SUPPORTED_LOCALES = LOCALE_REGISTRY.map(({ code }) => code);
export const LOCALE_STORAGE_KEY = "free2z-locale";
export const LANGUAGE_OPTIONS = LOCALE_REGISTRY.map(({ code, label }) => ({
  code,
  label,
}));

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

  let tag;
  try {
    [tag] = Intl.getCanonicalLocales(value.trim().replaceAll("_", "-"));
  } catch {
    return null;
  }
  if (tag === "pt" || tag === "pt-BR") return "pt-BR";
  const exact = LOCALE_REGISTRY.find((entry) => entry.code === tag);
  if (exact) return exact.code;
  const language = tag.split("-")[0];
  // Only language-level catalogs may accept regional variants. In particular,
  // pt-PT must never resolve to the regional pt-BR catalog.
  return LOCALE_REGISTRY.find((entry) => entry.code === language)?.code ?? null;
}

/** Parse ordered HTTP language preferences; invalid and zero-quality entries are ignored.
 * @param {unknown} header
 * @returns {string[]}
 */
export function parseAcceptLanguage(header) {
  if (typeof header !== "string") return [];
  return header
    .split(",")
    .map((part, index) => {
      const [tag, ...parameters] = part.trim().split(";");
      if (!tag || tag === "*") return null;
      let quality = 1;
      if (parameters.length) {
        if (parameters.length !== 1) return null;
        const match = /^\s*q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)\s*$/i.exec(
          parameters[0],
        );
        if (!match) return null;
        quality = Number(match[1]);
      }
      return quality > 0 ? { tag, quality, index } : null;
    })
    .filter((entry) => entry !== null)
    .sort((a, b) => b.quality - a.quality || a.index - b.index)
    .map(({ tag }) => tag);
}

/** @param {readonly unknown[]} values */
export function firstSupportedLocale(values) {
  for (const value of values) {
    const locale = normalizeLocale(value);
    if (locale) return locale;
  }
  return null;
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
