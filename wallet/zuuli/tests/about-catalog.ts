import { readFileSync } from "node:fs";
import { createInstance } from "i18next";
import ICU from "i18next-icu";
import { initReactI18next } from "react-i18next";

// Playwright's Node loader needs a filesystem JSON read; Vite's test provider
// intentionally uses static imports for Vitest/browser bundling instead.
export function installAboutTestLocale(locale: "en" | "fr") {
  const catalog: Record<string, unknown> = JSON.parse(
    readFileSync(
      new URL(`../src/i18n/locales/${locale}.json`, import.meta.url),
      "utf8",
    ),
  );
  const instance = createInstance().use(ICU).use(initReactI18next);
  void instance.init({
    lng: locale,
    fallbackLng: false,
    initAsync: false,
    resources: { [locale]: { translation: catalog } },
  });
}
