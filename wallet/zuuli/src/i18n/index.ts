import { createInstance, type i18n } from "i18next";
import ICU from "i18next-icu";
import { initReactI18next } from "react-i18next";
import { configureFormattingLocale } from "@/lib/format";
import { validateCatalog } from "./catalog-policy";
import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  resolveLocaleSelection,
  type SupportedLocale,
} from "./locale";
import { DECLARED_MESSAGE_KEYS, MESSAGE_KEYS } from "./messages";

type Catalog = Readonly<Record<string, unknown>>;

export const CATALOG_LOADERS: Readonly<
  Record<SupportedLocale, () => Promise<Catalog>>
> = Object.freeze({
  en: () => import("./locales/en.json").then((module) => module.default),
  es: () => import("./locales/es.json").then((module) => module.default),
  fr: () => import("./locales/fr.json").then((module) => module.default),
});

export async function loadCatalog(locale: SupportedLocale): Promise<Catalog> {
  const catalog = await CATALOG_LOADERS[locale]();
  validateCatalog(locale, catalog, DECLARED_MESSAGE_KEYS);
  return catalog;
}

export async function createAppI18n(locale: SupportedLocale): Promise<i18n> {
  const catalog = await loadCatalog(locale);
  const instance = createInstance();
  await instance
    .use(
      new ICU({
        parseErrorHandler(error, key) {
          throw new Error(`invalid ICU message for ${key}: ${error.message}`);
        },
      }),
    )
    .use(initReactI18next)
    .init({
      fallbackLng: false,
      initAsync: false,
      interpolation: { escapeValue: false },
      lng: locale,
      parseMissingKeyHandler(key) {
        throw new Error(`missing i18n message: ${key}`);
      },
      resources: { [locale]: { translation: catalog } },
      returnEmptyString: false,
      returnNull: false,
    });
  return instance;
}

function readSavedLocale(): unknown {
  try {
    return window.localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    // Storage may be unavailable in hardened/private webviews. Browser locale
    // remains a safe, deterministic fallback and no setting is mutated here.
    return null;
  }
}

interface InitializeAppI18nOptions {
  savedLocale?: unknown;
  browserLocale?: unknown;
  documentElement?: Pick<HTMLElement, "lang">;
}

export async function initializeAppI18n(
  options: InitializeAppI18nOptions = {},
): Promise<i18n> {
  const savedLocale = Object.prototype.hasOwnProperty.call(
    options,
    "savedLocale",
  )
    ? options.savedLocale
    : readSavedLocale();
  const browserLocale = Object.prototype.hasOwnProperty.call(
    options,
    "browserLocale",
  )
    ? options.browserLocale
    : window.navigator.language;
  const { catalogLocale, formattingLocale } = resolveLocaleSelection({
    savedLocale,
    browserLocale,
  });
  const instance = await createAppI18n(catalogLocale);
  configureFormattingLocale(
    formattingLocale,
    instance.t(MESSAGE_KEYS.commonPending),
  );
  const documentElement = options.documentElement ?? document.documentElement;
  documentElement.lang = instance.resolvedLanguage ?? DEFAULT_LOCALE;
  return instance;
}
