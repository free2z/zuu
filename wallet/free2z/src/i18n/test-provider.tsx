import type { ReactNode } from "react";
import { createInstance } from "i18next";
import ICU from "i18next-icu";
import { I18nextProvider } from "react-i18next";
import en from "./locales/en.json";
import es from "./locales/es.json";
import fr from "./locales/fr.json";
import type { SupportedLocale } from "./locale";

const catalogs = { en, es, fr } as const;

type TestCatalog = Readonly<Record<string, unknown>>;

export function createTestI18n(
  locale: SupportedLocale = "en",
  catalog: TestCatalog = catalogs[locale],
) {
  const instance = createInstance().use(
    new ICU({
      parseErrorHandler(error, key) {
        throw new Error(`invalid ICU message for ${key}: ${error.message}`);
      },
    }),
  );
  void instance.init({
    fallbackLng: false,
    initAsync: false,
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

export function TestI18nProvider({
  catalog,
  children,
  locale = "en",
}: {
  catalog?: TestCatalog;
  children: ReactNode;
  locale?: SupportedLocale;
}) {
  const instance = createTestI18n(locale, catalog ?? catalogs[locale]);
  return <I18nextProvider i18n={instance}>{children}</I18nextProvider>;
}
