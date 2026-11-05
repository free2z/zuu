/** @param {"expand" | "accent" | "rtl"} mode */
async function loadPseudo(mode) {
  const [{ default: english }, { pseudoCatalog }] = await Promise.all([
    import("./locales/en.json"),
    import("./pseudo-locales.js"),
  ]);
  return { default: pseudoCatalog(english, mode) };
}
export const DEFAULT_LOCALE = "en";
// Availability controls exposure; it does not itself establish review approval.
/** @type {readonly {code: "en" | "es" | "fr" | "pt-BR" | "en-XA" | "en-XB" | "ar-XB" | "ar" | "pl" | "ja" | "hi" | "de", label: string, script: string, direction: "ltr" | "rtl", formattingLocale: string, fallback: string | null, availability: "stable" | "beta" | "disabled" | "test", loadCatalog: () => Promise<{default: unknown}>, loadRtk?: () => Promise<{default: unknown}>}[]} */
export const LOCALE_REGISTRY = Object.freeze([
  {
    code: "en",
    label: "English",
    script: "Latn",
    direction: "ltr",
    formattingLocale: "en",
    fallback: null,
    availability: "stable",
    loadCatalog: () => import("./locales/en.json"),
  },
  {
    code: "es",
    label: "Español",
    script: "Latn",
    direction: "ltr",
    formattingLocale: "es",
    fallback: "en",
    availability: "beta",
    loadCatalog: () => import("./locales/es.json"),
    loadRtk: () => import("./locales/rtk/es.json"),
  },
  {
    code: "fr",
    label: "Français",
    script: "Latn",
    direction: "ltr",
    formattingLocale: "fr",
    fallback: "en",
    availability: "beta",
    loadCatalog: () => import("./locales/fr.json"),
    loadRtk: () => import("./locales/rtk/fr.json"),
  },
  {
    code: "pt-BR",
    label: "Português (Brasil)",
    script: "Latn",
    direction: "ltr",
    formattingLocale: "pt-BR",
    fallback: "en",
    availability: "beta",
    loadCatalog: () => import("./locales/pt-BR.json"),
    loadRtk: () => import("./locales/rtk/pt-BR.json"),
  },
  ...(typeof __PILOT_LOCALES__ !== "undefined" && __PILOT_LOCALES__
    ? /** @type {const} */ ([
        {
          code: "ar",
          label: "العربية (draft)",
          script: "Arab",
          direction: "rtl",
          formattingLocale: "ar",
          fallback: "en",
          availability: "test",
          loadCatalog: () => import("./locales/pilot/ar.json"),
        },
        {
          code: "pl",
          label: "Polski (draft)",
          script: "Latn",
          direction: "ltr",
          formattingLocale: "pl",
          fallback: "en",
          availability: "test",
          loadCatalog: () => import("./locales/pilot/pl.json"),
        },
        {
          code: "ja",
          label: "日本語 (draft)",
          script: "Jpan",
          direction: "ltr",
          formattingLocale: "ja",
          fallback: "en",
          availability: "test",
          loadCatalog: () => import("./locales/pilot/ja.json"),
        },
        {
          code: "hi",
          label: "हिन्दी (draft)",
          script: "Deva",
          direction: "ltr",
          formattingLocale: "hi",
          fallback: "en",
          availability: "test",
          loadCatalog: () => import("./locales/pilot/hi.json"),
        },
        {
          code: "de",
          label: "Deutsch (draft)",
          script: "Latn",
          direction: "ltr",
          formattingLocale: "de",
          fallback: "en",
          availability: "test",
          loadCatalog: () => import("./locales/pilot/de.json"),
        },
      ])
    : []),
  ...(typeof __PSEUDO_LOCALES__ !== "undefined" && __PSEUDO_LOCALES__
    ? /** @type {const} */ ([
        {
          code: "en-XA",
          label: "Expansion test",
          script: "Latn",
          direction: "ltr",
          formattingLocale: "en",
          fallback: "en",
          availability: "test",
          loadCatalog: () => loadPseudo("expand"),
        },
        {
          code: "en-XB",
          label: "Accent test",
          script: "Latn",
          direction: "ltr",
          formattingLocale: "en",
          fallback: "en",
          availability: "test",
          loadCatalog: () => loadPseudo("accent"),
        },
        {
          code: "ar-XB",
          label: "RTL test",
          script: "Arab",
          direction: "rtl",
          formattingLocale: "en",
          fallback: "en",
          availability: "test",
          loadCatalog: () => loadPseudo("rtl"),
        },
      ])
    : []),
]);
export const SUPPORTED_LOCALES = LOCALE_REGISTRY.map(({ code }) => code);
export const LOCALE_STORAGE_KEY = "free2z-locale";
export const LOCALE_RETRY_KEY = "free2z-locale-retry";
export const LANGUAGE_OPTIONS = LOCALE_REGISTRY.filter(
  ({ availability }) => availability === "stable" || availability === "beta",
).map(({ code, label }) => ({
  code,
  label,
}));

/** Effective availability combines the registry with deployment policy.
 * @param {string} code
 * @param {readonly string[]} disabled
 * @returns {"stable" | "beta" | "disabled" | "test"}
 */
export function localeAvailability(code, disabled = []) {
  if (disabled.includes(code)) return "disabled";
  return (
    LOCALE_REGISTRY.find((entry) => entry.code === code)?.availability ??
    "disabled"
  );
}

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

/** Preserve arbitrary content locales while mapping test pseudo tags to English.
 * @param {string | string[] | undefined} locales
 * @returns {string | string[] | undefined}
 */
export function formattingLocales(locales) {
  const map = (/** @type {string} */ value) => {
    const testLocale = LOCALE_REGISTRY.find(
      (entry) =>
        entry.availability === "test" &&
        entry.code.toLowerCase() === value.toLowerCase(),
    );
    return testLocale?.formattingLocale ?? value;
  };
  return Array.isArray(locales)
    ? locales.map(map)
    : typeof locales === "string"
      ? map(locales)
      : undefined;
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

/** @param {readonly unknown[]} values
 * @param {readonly string[]} disabled
 */
export function firstSupportedLocale(values, disabled = []) {
  for (const value of values) {
    const locale = normalizeLocale(value);
    if (locale && localeAvailability(locale, disabled) !== "disabled")
      return locale;
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
 *   acceptLanguage?: unknown,
 *   disabled?: readonly string[],
 * }} request
 * @returns {{ locale: string, persisted: boolean }}
 */
export function resolveRequestLocale({
  routeId,
  queryLocale,
  cookieLocale,
  acceptLanguage,
  disabled = [],
}) {
  const allowed = (/** @type {unknown} */ value) => {
    const locale = normalizeLocale(value);
    return locale && localeAvailability(locale, disabled) !== "disabled"
      ? locale
      : null;
  };
  const cookie = allowed(cookieLocale);
  // On an article or editor route `?lang=` selects the content variant, not
  // the product UI. The editor's language picker deep-links to `/edit?lang=`.
  const query = isContentLanguageRoute(routeId) ? null : allowed(queryLocale);

  return {
    locale:
      query ??
      cookie ??
      firstSupportedLocale(parseAcceptLanguage(acceptLanguage), disabled) ??
      firstSupportedLocale(
        LANGUAGE_OPTIONS.map(({ code }) => code),
        disabled,
      ) ??
      DEFAULT_LOCALE,
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

/** Deployment may disable translated locales without rebuilding. English is the
 * source fallback remains available internally even if English UI is disabled.
 * Unknown tags are ignored.
 * @param {unknown} value
 * @returns {string[]}
 */
export function disabledLocales(value) {
  if (typeof value !== "string") return [];
  /** @type {Set<string>} */
  const result = new Set();
  for (const item of value.split(",")) {
    const locale = normalizeLocale(item);
    if (locale) result.add(locale);
  }
  return [...result];
}
