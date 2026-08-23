import { describe, expect, it } from "vitest";
import { CATALOG_LOADERS, createAppI18n, loadCatalog } from "./index";
import { SUPPORTED_LOCALES } from "./locale";
import { MESSAGE_KEYS } from "./messages";

describe("i18n runtime", () => {
  it("keeps every locale behind its own lazy loader", async () => {
    expect(Object.keys(CATALOG_LOADERS).sort()).toEqual(
      [...SUPPORTED_LOCALES].sort(),
    );
    for (const locale of SUPPORTED_LOCALES) {
      expect(typeof CATALOG_LOADERS[locale]).toBe("function");
      await expect(loadCatalog(locale)).resolves.toBeTypeOf("object");
    }
  });

  it.each([
    ["en", 1, "1 additional destination", 3, "3 additional destinations"],
    ["es", 1, "1 destino adicional", 3, "3 destinos adicionales"],
    ["fr", 1, "1 destination supplémentaire", 3, "3 destinations supplémentaires"],
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
});
