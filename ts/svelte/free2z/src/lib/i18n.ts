import { browser } from '$app/environment';
import i18n from '@sveltekit-i18n/base';
import parser from '@sveltekit-i18n/parser-default';
import { writable, derived } from 'svelte/store';

const defaultLocale = 'en';

// Get browser locale with fallback
function getBrowserLocale(): string {
  if (!browser) return defaultLocale;

  // Get the browser's preferred language
  const browserLang =
    window.navigator.language || window.navigator.languages?.[0];

  if (!browserLang) return defaultLocale;

  // Extract just the language code (e.g., 'en' from 'en-US')
  const langCode = browserLang.split('-')[0].toLowerCase();

  // Check if we support this language
  const supportedLocales = ['en', 'es', 'fr'];
  return supportedLocales.includes(langCode) ? langCode : defaultLocale;
}

// Load translations statically for SSR
import enTranslations from './locales/en.json';
import esTranslations from './locales/es.json';
import frTranslations from './locales/fr.json';

const translations = {
  en: enTranslations,
  es: esTranslations,
  fr: frTranslations,
} as const;

// Simple translation function that works in SSR
function getTranslation(
  key: string,
  currentLocale: string = defaultLocale
): string {
  try {
    const keys = key.replace('common.', '').split('.');
    let result: any =
      translations[currentLocale as keyof typeof translations] ||
      translations[defaultLocale as keyof typeof translations];

    for (const k of keys) {
      result = result?.[k];
    }

    return typeof result === 'string' ? result : key;
  } catch {
    return key;
  }
}

/** @type {import('@sveltekit-i18n/parser-default').Config} */
const config = {
  parser: parser(),
  loaders: [
    // English
    {
      locale: 'en',
      key: '',
      loader: async () => translations.en,
    },
    // Spanish
    {
      locale: 'es',
      key: '',
      loader: async () => translations.es,
    },
    // French
    {
      locale: 'fr',
      key: '',
      loader: async () => translations.fr,
    },
  ],
  fallbackLocale: defaultLocale,
  initialLocale: getBrowserLocale(),
};

const i18nInstance = new i18n(config);

// Create stores
export const locale = writable(defaultLocale);
export const loading = writable(false);

// Create a simple t function that works in SSR and client
export function t(key: string, fallback?: string, ...args: any[]): string {
  const currentLocale = browser ? getBrowserLocale() : defaultLocale;
  const translation = getTranslation(key, currentLocale);
  return translation !== key ? translation : fallback || key;
}

// Also export as a store for reactive usage
export const tStore = derived(locale, ($locale) => {
  return (key: string, fallback?: string, ...args: any[]) => {
    const translation = getTranslation(key, $locale);
    return translation !== key ? translation : fallback || key;
  };
});

// Export other functions
export const locales = i18nInstance.locales;
export const loadTranslations = i18nInstance.loadTranslations;

if (browser) {
  const currentLocale = getBrowserLocale();
  locale.set(currentLocale);
  loading.set(true);

  console.log('Initializing i18n with locale:', currentLocale);

  // Since we're using static imports, we don't need to load translations
  loading.set(false);
}
