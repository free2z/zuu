import { createInstance, type i18n } from "i18next";
import ICU from "i18next-icu";
import { initReactI18next } from "react-i18next";
import { configureFormattingLocale } from "@/lib/format";
import { validateCatalog } from "./catalog-policy";
import {
  DEFAULT_LOCALE,
  resolveLocaleSelection,
  type SupportedLocale,
} from "./locale";
import { readPreferenceLocale, savePreferenceLocale } from "./preferences";
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
    : readPreferenceLocale();
  const browserLocale = Object.prototype.hasOwnProperty.call(
    options,
    "browserLocale",
  )
    ? options.browserLocale
    : window.navigator.languages?.[0] ?? window.navigator.language;
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

type LocaleChangeDependencies = {
  load: typeof loadCatalog;
  apply: (locale: SupportedLocale, pending: string) => void;
  save: typeof savePreferenceLocale;
};

/** Each instance serializes transitions; superseded loads never change it. */
export function createLocaleChanger(deps: LocaleChangeDependencies) {
  const states = new WeakMap<i18n, { sequence: number; tail: Promise<void> }>();
  return (instance: i18n, locale: SupportedLocale): Promise<void> => {
    let state = states.get(instance);
    if (!state) {
      state = { sequence: 0, tail: Promise.resolve() };
      states.set(instance, state);
    }
    const current = state;
    const sequence = ++current.sequence;
    const operation = current.tail.then(async () => {
      if (sequence !== current.sequence) return;
      let catalog: Catalog;
      try {
        catalog = await deps.load(locale);
      } catch (error) {
        if (sequence !== current.sequence) return;
        throw error;
      }
      if (sequence !== current.sequence) return;
      instance.addResourceBundle(locale, "translation", catalog, true, true);
      const previous = instance.resolvedLanguage as SupportedLocale;
      try {
        await instance.changeLanguage(locale);
      } catch (error) {
        if (previous && instance.resolvedLanguage !== previous) {
          await instance.changeLanguage(previous);
        }
        throw error;
      }
      // Commit all side effects together even if a later request arrived while
      // changeLanguage was pending. The queued request will then supersede it.
      deps.apply(locale, instance.t(MESSAGE_KEYS.commonPending));
      deps.save(locale);
    });
    current.tail = operation.catch(() => {});
    return operation;
  };
}

export const changeAppLocale = createLocaleChanger({
  load: loadCatalog,
  apply(locale, pending) {
    configureFormattingLocale(locale, pending);
    document.documentElement.lang = locale;
  },
  save: savePreferenceLocale,
});
