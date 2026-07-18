import { browser } from "$app/environment";
import i18n from "@sveltekit-i18n/base";
import parser from "@sveltekit-i18n/parser-default";
import { writable, derived, get } from "svelte/store";
import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  SUPPORTED_LOCALES,
  normalizeLocale,
  resolveLocale,
} from "./locale.js";

export type SupportedLocale = "en" | "es" | "fr";

export const languageOptions: ReadonlyArray<{
  code: SupportedLocale;
  label: string;
}> = [
  { code: "en", label: "English" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
];

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

const translations = {
  en: enTranslations,
  es: esTranslations,
  fr: frTranslations,
} as const;

// Simple translation function that works in SSR
function getTranslation(
  key: string,
  currentLocale: string = DEFAULT_LOCALE,
): string {
  try {
    const keys = key.replace("common.", "").split(".");
    let result: any =
      translations[currentLocale as keyof typeof translations] ||
      translations[DEFAULT_LOCALE as keyof typeof translations];

    for (const k of keys) {
      result = result?.[k];
    }

    return typeof result === "string" ? result : key;
  } catch {
    return key;
  }
}

function interpolate(template: string, args: any[]) {
  const values = args.find(
    (value) => value && typeof value === 'object' && !Array.isArray(value)
  ) as Record<string, unknown> | undefined;
  if (!values) return template;

  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key: string) => {
    const value = values[key];
    return value === undefined || value === null ? match : String(value);
  });
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
  ],
  fallbackLocale: DEFAULT_LOCALE,
  initialLocale: getInitialLocale(),
};

const i18nInstance = new i18n(config);

// Create stores
export const locale = writable<SupportedLocale>(getInitialLocale());
export const loading = writable(false);

export function setLocale(nextLocale: string): void {
  const normalizedLocale = normalizeLocale(
    nextLocale,
  ) as SupportedLocale | null;
  if (!normalizedLocale) return;

  locale.set(normalizedLocale);

  if (!browser) return;

  document.documentElement.lang = normalizedLocale;
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, normalizedLocale);
  } catch {
    // The in-memory selection still works when persistence is unavailable.
  }
}

// Create a simple t function that works in SSR and client
export function t(key: string, fallback?: string, ...args: any[]): string {
  const translation = getTranslation(key, get(locale));
  return interpolate(translation !== key ? translation : fallback || key, args);
}

// Also export as a store for reactive usage
export const tStore = derived(locale, ($locale) => {
  return (key: string, fallback?: string, ...args: any[]) => {
    const translation = getTranslation(key, $locale);
    return interpolate(translation !== key ? translation : fallback || key, args);
  };
});

// Export other functions
export const locales = i18nInstance.locales;
export const loadTranslations = i18nInstance.loadTranslations;

if (browser) {
  const currentLocale = get(locale);
  document.documentElement.lang = currentLocale;
  loading.set(true);

  console.log("Initializing i18n with locale:", currentLocale);

  // Since we're using static imports, we don't need to load translations
  loading.set(false);
}

export { DEFAULT_LOCALE, LOCALE_STORAGE_KEY, SUPPORTED_LOCALES };
