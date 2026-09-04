// The locale kernel ZUULI uses, restated for this surface.
//
// Deliberately a copy rather than an import: `wallet/zuuli/scripts/
// project-boundary.mjs` forbids one wallet application from importing another,
// and `@free2z/wallet-shared` currently exports only the sensitive-entry
// session — a wallet concern that neither of the delegated surfaces holds. When
// the i18n kernel is promoted into the shared package (#906 follow-up), these
// three files are what moves.

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

/** Normalize a browser or persisted locale to a language this surface ships. */
export function normalizeLocale(value: unknown): SupportedLocale | null {
  const canonical = canonicalLocale(value);
  if (!canonical) return null;
  const language = new Intl.Locale(canonical).language.toLowerCase();
  return SUPPORTED_LOCALES.includes(language as SupportedLocale)
    ? (language as SupportedLocale)
    : null;
}

/**
 * Select a supported catalog without discarding the chosen locale's region and
 * extensions from Intl date/number formatting.
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
  if (browserCatalog === catalogLocale && browserTag !== catalogLocale) {
    return { catalogLocale, formattingLocale: browserTag ?? catalogLocale };
  }
  return { catalogLocale, formattingLocale: catalogLocale };
}
