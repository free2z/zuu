import { describe, expect, it } from "vitest";
import { CATALOG_LOADERS, loadCatalog } from "./index";
import { flattenCatalog, validateCatalog } from "./catalog-policy";
import { SUPPORTED_LOCALES } from "./locale";
import { DECLARED_MESSAGE_KEYS, MESSAGE_KEYS } from "./messages";

describe("shipped catalogs", () => {
  it("ships exactly one loader per supported locale", () => {
    expect(Object.keys(CATALOG_LOADERS).sort()).toEqual(
      [...SUPPORTED_LOCALES].sort(),
    );
  });

  for (const locale of SUPPORTED_LOCALES) {
    it(`${locale} declares exactly the message keys the screens read`, async () => {
      const catalog = await loadCatalog(locale);
      expect([...flattenCatalog(catalog)].sort()).toEqual([...MESSAGE_KEYS].sort());
    });
  }
});

describe("validateCatalog", () => {
  it("rejects a catalog missing a declared key", () => {
    expect(() => validateCatalog("en", {}, DECLARED_MESSAGE_KEYS)).toThrow(
      /is missing/,
    );
  });

  it("rejects a catalog carrying a key no screen reads", () => {
    const catalog = Object.fromEntries(
      MESSAGE_KEYS.map((key) => [key, "x"]),
    ) as Record<string, unknown>;
    catalog["stale.key"] = "x";
    expect(() => validateCatalog("en", catalog, DECLARED_MESSAGE_KEYS)).toThrow(
      /unknown keys/,
    );
  });
});
