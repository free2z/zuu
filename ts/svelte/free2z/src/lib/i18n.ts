import { browser } from "$app/env";
import i18n from "@sveltekit-i18n/base";
import parser from "@sveltekit-i18n/parser-default";
import {
  writable,
  derived,
  get,
  type Readable,
  type Writable,
} from "svelte/store";
import {
  DEFAULT_LOCALE,
  LANGUAGE_OPTIONS,
  LOCALE_STORAGE_KEY,
  SUPPORTED_LOCALES,
  normalizeLocale,
  resolveLocale,
} from "./locale.js";
import { getRequestLocale } from "./request-locale.js";
import { requestScopedStore } from "./request-scoped-store.js";

export type SupportedLocale = "en" | "es" | "fr" | "pt-BR";
export type TranslationParams = Record<string, string | number>;
export type TranslationFunction = (
  key: string,
  fallback?: string,
  params?: TranslationParams,
) => string;

// The table itself lives in `locale.js` so plain-JS modules (and the node
// test runner, which cannot import TypeScript) can look a language name up
// without pulling in the whole i18n runtime. This stays the name every
// component already imports.
export const languageOptions: ReadonlyArray<{
  code: SupportedLocale;
  label: string;
}> = LANGUAGE_OPTIONS;

function getInitialLocale(): SupportedLocale {
  if (!browser) return DEFAULT_LOCALE;

  let savedLocale: string | null = null;
  try {
    savedLocale = window.localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    // Storage can be unavailable in privacy-focused browser modes.
  }

  return resolveLocale({
    savedLocale,
    browserLocale: window.navigator.languages?.[0] || window.navigator.language,
  }) as SupportedLocale;
}

// Load translations statically for SSR
import enTranslations from "./locales/en.json";
import esTranslations from "./locales/es.json";
import frTranslations from "./locales/fr.json";
import ptBRTranslations from "./locales/pt-BR.json";

const translations = {
  en: enTranslations,
  es: esTranslations,
  fr: frTranslations,
  "pt-BR": ptBRTranslations,
} as const;

function lookupTranslation(source: unknown, key: string): string | undefined {
  let result = source;

  for (const segment of key.split(".")) {
    if (!result || typeof result !== "object") return undefined;
    result = (result as Record<string, unknown>)[segment];
  }

  return typeof result === "string" ? result : undefined;
}

function interpolate(value: string, params?: TranslationParams): string {
  if (!params) return value;

  return value.replace(/\{([^{}]+)\}/g, (placeholder, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name)
      ? String(params[name])
      : placeholder,
  );
}

// Simple translation function that works in SSR. Exact keys take precedence,
// while older `common.` call sites retain their existing root-key fallback.
function getTranslation(
  key: string,
  currentLocale: string = DEFAULT_LOCALE,
  params?: TranslationParams,
): string {
  const requestedLocale = normalizeLocale(
    currentLocale,
  ) as SupportedLocale | null;
  const resolvedLocale = requestedLocale ?? DEFAULT_LOCALE;
  const candidateKeys = [key];

  if (key.startsWith("common.")) {
    candidateKeys.push(key.slice("common.".length));
  }

  for (const sourceLocale of [resolvedLocale, DEFAULT_LOCALE] as const) {
    for (const candidateKey of candidateKeys) {
      const result = lookupTranslation(
        translations[sourceLocale],
        candidateKey,
      );
      if (result !== undefined) return interpolate(result, params);
    }
  }

  return key;
}

/** @type {import('@sveltekit-i18n/parser-default').Config} */
const config = {
  parser: parser(),
  loaders: [
    // English
    {
      locale: "en",
      key: "",
      loader: async () => translations.en,
    },
    // Spanish
    {
      locale: "es",
      key: "",
      loader: async () => translations.es,
    },
    // French
    {
      locale: "fr",
      key: "",
      loader: async () => translations.fr,
    },
    // Brazilian Portuguese
    {
      locale: "pt-BR",
      key: "",
      loader: async () => translations["pt-BR"],
    },
  ],
  fallbackLocale: DEFAULT_LOCALE,
  initialLocale: getInitialLocale(),
};

const i18nInstance = new i18n(config);

// Create stores
//
// `localeStore` is module-scoped, which is correct in the browser (one process,
// one user) and wrong on the server, where every concurrent request shares this
// module. On the server the active locale therefore comes from the per-request
// AsyncLocalStorage bound by `hooks.server.ts`; `localeStore` is only the
// fallback for contexts with no request scope. See issue.
const localeStore = writable<SupportedLocale>(getInitialLocale());

/** The locale of the in-flight server request, or null (browser / no scope). */
function activeRequestLocale(): SupportedLocale | null {
  if (browser) return null;
  return normalizeLocale(getRequestLocale()) as SupportedLocale | null;
}

/**
 * The active locale. Same `Writable` contract as before — `$locale` and
 * `get(locale)` keep working — but on the server a subscriber sees the locale
 * of *its own* request rather than whatever the previous request left behind.
 *
 * Never build a Svelte `derived` on top of this store: a derived caches its
 * value across concurrent subscribers and would defeat the isolation. Wrap the
 * module-global with `requestScopedStore` instead, as `tStore` does.
 */
export const locale: Writable<SupportedLocale> = {
  ...requestScopedStore<SupportedLocale>(localeStore, activeRequestLocale),
  set: localeStore.set,
  update: localeStore.update,
};

export const loading = writable(false);

export const defaultLocale = DEFAULT_LOCALE as SupportedLocale;
export const supportedLocales = SUPPORTED_LOCALES as readonly SupportedLocale[];

export function resolveSupportedLocale(value: unknown): SupportedLocale | null {
  return normalizeLocale(value) as SupportedLocale | null;
}

export function getCurrentLocale(): SupportedLocale {
  return activeRequestLocale() ?? get(localeStore);
}

export function formatLocalizedNumber(
  value: number,
  requestedLocale: string = getCurrentLocale(),
): string {
  return new Intl.NumberFormat(
    resolveSupportedLocale(requestedLocale) ?? defaultLocale,
  ).format(value);
}

export function isSingularCount(
  value: number,
  requestedLocale: string = getCurrentLocale(),
): boolean {
  return (
    new Intl.PluralRules(
      resolveSupportedLocale(requestedLocale) ?? defaultLocale,
    ).select(value) === "one"
  );
}

export function translate(
  currentLocale: SupportedLocale,
  key: string,
  fallback?: string,
  params?: TranslationParams,
): string {
  const translation = getTranslation(key, currentLocale, params);
  return translation !== key
    ? translation
    : interpolate(fallback || key, params);
}

/**
 * The CONTENT language of the document currently on screen, or null.
 *
 * `<html lang>` is served by `hooks.server.ts` as the article variant's own
 * language on a content-language route. On the client it has to be
 * maintained by the same rule, because `setLocale` writes that attribute too
 * and runs on hydration: without this, a published Chinese article's document
 * language reverted to the reader's UI locale the moment the page hydrated —
 * SSR right, hydrated wrong, which is the hardest version to notice.
 *
 * Module-global, and written only in the browser, where there is exactly one
 * document — so no concurrent SSR render can observe another's value.
 */
let documentContentLanguage: string | null = null;

function applyDocumentLanguage(): void {
  if (!browser) return;
  document.documentElement.lang =
    documentContentLanguage || getCurrentLocale() || DEFAULT_LOCALE;
}

/**
 * Declare (or, with null, withdraw) the content language of the document.
 *
 * Called by the reader route with the variant it is showing, and with null when
 * that page goes away, so the chrome's locale takes the attribute back.
 *
 * @param tag a canonical content-language tag, or null
 */
export function setDocumentContentLanguage(tag: string | null): void {
  // Browser only, and not merely as an optimization: the module global is
  // shared by every concurrent SSR render, and the server's answer is
  // already rendered by `hooks.server.ts` from request-scoped state.
  if (!browser) return;
  documentContentLanguage = tag || null;
  applyDocumentLanguage();
}

export function setLocale(nextLocale: string): void {
  const normalizedLocale = normalizeLocale(
    nextLocale,
  ) as SupportedLocale | null;
  if (!normalizedLocale) return;

  // On the server the request scope already carries this request's locale (and
  // is the only thing read back), so writing the shared module-global would do
  // nothing but leak into whichever request runs next. Outside a request scope
  // prerendering, scripts — the global is still the only place to put it.
  if (browser || !activeRequestLocale()) {
    localeStore.set(normalizedLocale);
  }

  if (!browser) return;

  // NOT a direct write: a content language, when one is on screen, outranks the
  // UI locale for `<html lang>`. `applyDocumentLanguage` is the one place that
  // decides, so the two can never race each other on hydration.
  applyDocumentLanguage();
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, normalizedLocale);
  } catch {
    // The in-memory selection still works when persistence is unavailable.
  }
  document.cookie = `${LOCALE_STORAGE_KEY}=${encodeURIComponent(normalizedLocale)}; Path=/; Max-Age=31536000; SameSite=Lax`;
}

// Create a simple t function that works in SSR and client
export function t(
  key: string,
  fallback?: string,
  params?: TranslationParams,
): string {
  return translate(getCurrentLocale(), key, fallback, params);
}

function translatorFor(currentLocale: SupportedLocale): TranslationFunction {
  return (key, fallback, params) =>
    translate(currentLocale, key, fallback, params);
}

// The browser store: a normal derived over the module-global locale, so the
// language switcher still re-renders the live page.
const globalTStore = derived(localeStore, ($locale) => translatorFor($locale));

// Also export as a store for reactive usage.
//
// Deliberately not a Svelte `derived` over the request-scoped locale: a derived
// caches its computed value for as long as any subscriber is alive, so under
// overlapping SSR the first request's translator would be handed to every
// request that subscribes while it is suspended. `$t` is the single most-used
// read in the app, so that path has to sample the request scope per
// subscription. See `$lib/request-scoped-store`.
export const tStore: Readable<TranslationFunction> = requestScopedStore(
  globalTStore,
  () => {
    const requestLocale = activeRequestLocale();
    return requestLocale ? translatorFor(requestLocale) : null;
  },
);

// Export other functions
export const locales = i18nInstance.locales;
export const loadTranslations = i18nInstance.loadTranslations;

if (browser) {
  const currentLocale = get(localeStore);
  document.documentElement.lang = currentLocale;
  loading.set(true);

  console.log("Initializing i18n with locale:", currentLocale);

  // Since we're using static imports, we don't need to load translations
  loading.set(false);
}

export { DEFAULT_LOCALE, LOCALE_STORAGE_KEY, SUPPORTED_LOCALES };
