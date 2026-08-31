export const DEFAULT_LOCALE = "en";
export const SUPPORTED_LOCALES = ["en", "es", "fr"] as const;
export const LOCALE_STORAGE_KEY = "free2z-locale";

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export interface LocaleSelection {
  catalogLocale: SupportedLocale;
  formattingLocale: string;
}

function canonicalLocale(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    return Intl.getCanonicalLocales(value.trim())[0] ?? null;
  } catch {
    return null;
  }
}

/** Normalize a browser or persisted locale to a language supported by Free2Z. */
export function normalizeLocale(value: unknown): SupportedLocale | null {
  const canonical = canonicalLocale(value);
  if (!canonical) return null;
  const language = new Intl.Locale(canonical).language.toLowerCase();
  return SUPPORTED_LOCALES.includes(language as SupportedLocale)
    ? (language as SupportedLocale)
    : null;
}

/**
 * Select a supported catalog without discarding the chosen locale's region
 * and extensions from Intl date/relative-time formatting.
 */
export function resolveLocaleSelection({
  savedLocale,
  browserLocale,
}: {
  savedLocale?: unknown;
  browserLocale?: unknown;
}): LocaleSelection {
  const savedCatalog = normalizeLocale(savedLocale);
  const browserCatalog = normalizeLocale(browserLocale);
  const catalogLocale = savedCatalog ?? browserCatalog ?? DEFAULT_LOCALE;
  const savedTag = canonicalLocale(savedLocale);
  const browserTag = canonicalLocale(browserLocale);

  if (savedCatalog === catalogLocale && savedTag !== catalogLocale) {
    return { catalogLocale, formattingLocale: savedTag ?? catalogLocale };
  }
  if (browserCatalog === catalogLocale && browserTag) {
    return { catalogLocale, formattingLocale: browserTag };
  }
  return { catalogLocale, formattingLocale: catalogLocale };
}

/** Prefer an explicit user selection, then browser preference, then English. */
export function resolveLocale({
  savedLocale,
  browserLocale,
}: {
  savedLocale?: unknown;
  browserLocale?: unknown;
}): SupportedLocale {
  return resolveLocaleSelection({ savedLocale, browserLocale }).catalogLocale;
}
