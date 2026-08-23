import { describe, expect, it } from "vitest";
import en from "./locales/en.json";
import es from "./locales/es.json";
import fr from "./locales/fr.json";
import { validateCatalog } from "./catalog-policy";
import { DECLARED_MESSAGE_KEYS } from "./messages";

const catalogs = { en, es, fr } as const;

function cloneCatalog() {
  return structuredClone(en) as Record<string, unknown>;
}

describe("catalog policy", () => {
  it("requires exact key parity in every supported locale", () => {
    for (const [locale, catalog] of Object.entries(catalogs)) {
      expect(() =>
        validateCatalog(
          locale as keyof typeof catalogs,
          catalog,
          DECLARED_MESSAGE_KEYS,
        ),
      ).not.toThrow();
    }
  });

  it("fails closed when a declared message is missing", () => {
    const catalog = cloneCatalog();
    delete (catalog.common as Record<string, unknown>).loading;
    expect(() => validateCatalog("en", catalog, DECLARED_MESSAGE_KEYS)).toThrow(
      /missing=\[common\.loading\]/,
    );
  });

  it("fails closed when a catalog message is orphaned", () => {
    const catalog = cloneCatalog();
    (catalog.common as Record<string, unknown>).orphan = "unused";
    expect(() => validateCatalog("en", catalog, DECLARED_MESSAGE_KEYS)).toThrow(
      /orphaned=\[common\.orphan\]/,
    );
  });

  it("kills an invalid catalog-key mutant", () => {
    const invalidKey = cloneCatalog();
    (invalidKey.common as Record<string, unknown>)["bad-key"] = "bad";
    expect(() =>
      validateCatalog("en", invalidKey, DECLARED_MESSAGE_KEYS),
    ).toThrow(/invalid message-key segment/);
  });

  it("kills an empty catalog-leaf mutant", () => {
    const invalidValue = cloneCatalog();
    (invalidValue.common as Record<string, unknown>).loading = "";
    expect(() =>
      validateCatalog("en", invalidValue, DECLARED_MESSAGE_KEYS),
    ).toThrow(/message must not be empty/);
  });

  it("kills an invalid ICU-message mutant", () => {
    const invalidIcu = cloneCatalog();
    (invalidIcu.navigation as Record<string, unknown>).moreDescription =
      "{count, plural, one {one}";
    expect(() =>
      validateCatalog("en", invalidIcu, DECLARED_MESSAGE_KEYS),
    ).toThrow(/catalog contains invalid ICU message/);
  });

  it("rejects invalid and duplicate declared keys", () => {
    expect(() => validateCatalog("en", en, ["bad-key"])).toThrow(
      /invalid declared message key/,
    );
    expect(() =>
      validateCatalog("en", en, ["common.loading", "common.loading"]),
    ).toThrow(/declared message keys must be unique/);
  });
});
