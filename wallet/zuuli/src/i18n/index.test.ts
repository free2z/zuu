import { describe, expect, it } from "vitest";
import {
  CATALOG_LOADERS,
  createAppI18n,
  initializeAppI18n,
  loadCatalog,
} from "./index";
import { SUPPORTED_LOCALES } from "./locale";
import { MESSAGE_KEYS } from "./messages";
import { configureFormattingLocale, formatDate } from "@/lib/format";
import en from "./locales/en.json";
import es from "./locales/es.json";
import fr from "./locales/fr.json";

const EXPECTED_CATALOGS = { en, es, fr } as const;

describe("i18n runtime", () => {
  it("keeps every locale behind its own lazy loader", async () => {
    expect(Object.isFrozen(CATALOG_LOADERS)).toBe(true);
    expect(Object.keys(CATALOG_LOADERS).sort()).toEqual(
      [...SUPPORTED_LOCALES].sort(),
    );
    for (const locale of SUPPORTED_LOCALES) {
      expect(typeof CATALOG_LOADERS[locale]).toBe("function");
      await expect(loadCatalog(locale)).resolves.toEqual(
        EXPECTED_CATALOGS[locale],
      );
    }
  });

  it("does not permit runtime replacement of a reviewed catalog loader", () => {
    const loaders = CATALOG_LOADERS as Record<
      "en" | "es" | "fr",
      () => Promise<Readonly<Record<string, unknown>>>
    >;
    const original = loaders.en;

    expect(() => {
      loaders.en = async () => ({ common: { loading: "Chargement" } });
    }).toThrow(TypeError);
    expect(loaders.en).toBe(original);
  });

  it("validates the catalog returned by the runtime loader before initialization", async () => {
    const mutableCatalog = en as Record<string, unknown>;
    const original = mutableCatalog.common;
    mutableCatalog.common = { loading: "Loading" };
    try {
      await expect(loadCatalog("en")).rejects.toThrow(
        /en catalog key mismatch; missing=/,
      );
    } finally {
      mutableCatalog.common = original;
    }
  });

  it.each([
    ["en", 1, "1 additional destination", 3, "3 additional destinations"],
    ["es", 1, "1 destino adicional", 3, "3 destinos adicionales"],
    [
      "fr",
      1,
      "1 destination supplémentaire",
      3,
      "3 destinations supplémentaires",
    ],
  ] as const)(
    "formats ICU plural categories for %s",
    async (locale, one, oneExpected, many, manyExpected) => {
      const instance = await createAppI18n(locale);
      expect(instance.t(MESSAGE_KEYS.navMoreDescription, { count: one })).toBe(
        oneExpected,
      );
      expect(instance.t(MESSAGE_KEYS.navMoreDescription, { count: many })).toBe(
        manyExpected,
      );
    },
  );

  it("throws instead of rendering a missing key", async () => {
    const instance = await createAppI18n("en");
    expect(() => instance.t("common.notDeclared")).toThrow(
      "missing i18n message: common.notDeclared",
    );
  });

  it("uses the full selected BCP-47 tag for bootstrapped Intl formatting", async () => {
    const documentElement = { lang: "" };
    try {
      await initializeAppI18n({
        savedLocale: null,
        browserLocale: "en-GB",
        documentElement,
      });
      expect(documentElement.lang).toBe("en");
      const formatted = formatDate(Date.parse("2025-01-31T12:00:00Z") / 1000);
      expect(formatted.slice(0, "31 Jan 2025".length)).toBe("31 Jan 2025");
    } finally {
      configureFormattingLocale("en-US", "Pending");
    }
  });

  it.each([
    ["es", "Pendiente"],
    ["fr", "En attente"],
  ] as const)(
    "binds pending date output to the selected %s catalog",
    async (browserLocale, expected) => {
      try {
        await initializeAppI18n({
          savedLocale: null,
          browserLocale,
          documentElement: { lang: "" },
        });
        expect(formatDate(null)).toBe(expected);
      } finally {
        configureFormattingLocale("en-US", "Pending");
      }
    },
  );
});
