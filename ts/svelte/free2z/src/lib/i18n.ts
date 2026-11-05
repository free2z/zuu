import { browser } from "$app/env";
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
  LOCALE_REGISTRY,
  LOCALE_STORAGE_KEY,
  SUPPORTED_LOCALES,
  normalizeLocale,
} from "./locale.js";
import { catalogLoader } from "./catalog-loader.js";
import { formatIcuMessage, ICU_MESSAGE_KEYS } from "./icu-message.js";
import { getRequestLocale } from "./request-locale.js";
import { requestScopedStore } from "./request-scoped-store.js";

export type SupportedLocale = (typeof LOCALE_REGISTRY)[number]["code"];
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

// Dictionaries are immutable module data; the selected locale remains request scoped.
const translations: Record<string, unknown> = {};
export async function prepareLocale(next: string): Promise<void> {
  const normalized = normalizeLocale(next);
  if (!normalized) throw new Error(`Unsupported locale: ${next}`);
  const [english, selected] = await Promise.all([
    translations[DEFAULT_LOCALE] ?? catalogLoader.load(DEFAULT_LOCALE),
    translations[normalized] ?? catalogLoader.load(normalized),
  ]);
  translations[DEFAULT_LOCALE] = english;
  translations[normalized] = selected;
}
export function getPreparedCatalogs(next: string): Record<string, unknown> {
  return {
    [DEFAULT_LOCALE]: translations[DEFAULT_LOCALE],
    [next]: translations[next],
  };
}
export function hydrateLocale(
  next: string,
  catalogs: Record<string, unknown>,
): void {
  if (!browser) return;
  const normalized = normalizeLocale(next) as SupportedLocale | null;
  if (!normalized || !catalogs[normalized] || !catalogs[DEFAULT_LOCALE]) return;
  Object.assign(translations, catalogs);
  localeStore.set(normalized);
}

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
  catalogs: Record<string, unknown> = translations,
  icuKeys: readonly string[] = ICU_MESSAGE_KEYS,
): string | undefined {
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
      const result = lookupTranslation(catalogs[sourceLocale], candidateKey);
      if (result !== undefined) {
        if (icuKeys.includes(candidateKey)) {
          try {
            return formatIcuMessage(result, sourceLocale, params);
          } catch (error) {
            console.error(
              `Invalid ICU message ${candidateKey} (${sourceLocale})`,
              error,
            );
            continue;
          }
        }
        return interpolate(result, params);
      }
    }
  }

  return undefined;
}

// Create stores
//
// `localeStore` is module-scoped, which is correct in the browser (one process,
// one user) and wrong on the server, where every concurrent request shares this
// module. On the server the active locale therefore comes from the per-request
// AsyncLocalStorage bound by `hooks.server.ts`; `localeStore` is only the
// fallback for contexts with no request scope. See issue.
const localeStore = writable<SupportedLocale>(DEFAULT_LOCALE);

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
  value: number | bigint,
  requestedLocale: string = getCurrentLocale(),
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(
    resolveSupportedLocale(requestedLocale) ?? defaultLocale,
    options,
  ).format(value);
}

export function formatLocalizedList(
  values: readonly string[],
  requestedLocale: string = getCurrentLocale(),
  options?: Intl.ListFormatOptions,
): string {
  return new Intl.ListFormat(
    resolveSupportedLocale(requestedLocale) ?? defaultLocale,
    options,
  ).format(values);
}

export function compareLocalized(
  left: string,
  right: string,
  requestedLocale: string = getCurrentLocale(),
  options?: Intl.CollatorOptions,
): number {
  return new Intl.Collator(
    resolveSupportedLocale(requestedLocale) ?? defaultLocale,
    options,
  ).compare(left, right);
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

// The same resolution path can be exercised with isolated catalogs in tests.
export function translateWithCatalogs(
  catalogs: Record<string, unknown>,
  icuKeys: readonly string[],
  currentLocale: SupportedLocale,
  key: string,
  fallback?: string,
  params?: TranslationParams,
): string {
  return (
    getTranslation(key, currentLocale, params, catalogs, icuKeys) ??
    interpolate(fallback || key, params)
  );
}

export function translate(
  currentLocale: SupportedLocale,
  key: string,
  fallback?: string,
  params?: TranslationParams,
): string {
  const translation = getTranslation(key, currentLocale, params);
  return translation ?? interpolate(fallback || key, params);
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
  document.documentElement.dir =
    LOCALE_REGISTRY.find((entry) => entry.code === getCurrentLocale())
      ?.direction ?? "ltr";
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

let switchSequence = 0;
export const localeLoadError = writable<string | null>(null);
export async function setLocale(nextLocale: string): Promise<boolean> {
  const normalized = normalizeLocale(nextLocale) as SupportedLocale | null;
  if (!normalized) return false;
  if (!browser) return false;
  const sequence = ++switchSequence;
  loading.set(true);
  localeLoadError.set(null);
  try {
    await prepareLocale(normalized);
    if (sequence !== switchSequence) return false;
    localeStore.set(normalized);
    applyDocumentLanguage();
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, normalized);
    } catch {
      /* unavailable */
    }
    document.cookie = `${LOCALE_STORAGE_KEY}=${encodeURIComponent(normalized)}; Path=/; Max-Age=31536000; SameSite=Lax`;
    return true;
  } catch {
    if (sequence === switchSequence) localeLoadError.set(normalized);
    return false;
  } finally {
    if (sequence === switchSequence) loading.set(false);
  }
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

export { DEFAULT_LOCALE, LOCALE_STORAGE_KEY, SUPPORTED_LOCALES };
