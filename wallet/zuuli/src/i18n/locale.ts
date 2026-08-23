export const DEFAULT_LOCALE = "en";
export const SUPPORTED_LOCALES = ["en", "es", "fr"] as const;
export const LOCALE_STORAGE_KEY = "free2z-locale";

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/** Normalize a browser or persisted locale to a language supported by Free2Z. */
export function normalizeLocale(value: unknown): SupportedLocale | null {
  if (typeof value !== "string" || value.trim() === "") return null;

  const language = value.trim().split("-")[0].toLowerCase();
  return SUPPORTED_LOCALES.includes(language as SupportedLocale)
    ? (language as SupportedLocale)
    : null;
}

/** Prefer an explicit user selection, then browser preference, then English. */
export function resolveLocale({
  savedLocale,
  browserLocale,
}: {
  savedLocale?: unknown;
  browserLocale?: unknown;
}): SupportedLocale {
  return (
    normalizeLocale(savedLocale) ??
    normalizeLocale(browserLocale) ??
    DEFAULT_LOCALE
  );
}
