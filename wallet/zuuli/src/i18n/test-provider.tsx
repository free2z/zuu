import type { ReactNode } from "react";
import { createInstance } from "i18next";
import ICU from "i18next-icu";
import { I18nextProvider } from "react-i18next";
import en from "./locales/en.json";
import es from "./locales/es.json";
import fr from "./locales/fr.json";
import type { SupportedLocale } from "./locale";

const catalogs = { en, es, fr } as const;

export function TestI18nProvider({
  children,
  locale = "en",
}: {
  children: ReactNode;
  locale?: SupportedLocale;
}) {
  const instance = createInstance().use(new ICU());
  void instance.init({
    fallbackLng: false,
    initAsync: false,
    lng: locale,
    resources: { [locale]: { translation: catalogs[locale] } },
  });
  return <I18nextProvider i18n={instance}>{children}</I18nextProvider>;
}
