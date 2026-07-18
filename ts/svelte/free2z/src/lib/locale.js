export const DEFAULT_LOCALE = "en";
export const SUPPORTED_LOCALES = ["en", "es", "fr"];
export const LOCALE_STORAGE_KEY = "free2z-locale";

/**
 * Normalize a browser or persisted locale to a language supported by Free2Z.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeLocale(value) {
  if (typeof value !== "string" || value.trim() === "") return null;

  const language = value.trim().split("-")[0].toLowerCase();
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
