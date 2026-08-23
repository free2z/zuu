import { describe, expect, it } from "vitest";
import { normalizeLocale, resolveLocale } from "./locale";

describe("locale resolution", () => {
  it.each([
    ["en", "en"],
    ["ES-mx", "es"],
    [" fr-CA ", "fr"],
  ] as const)("normalizes %s to %s", (input, expected) => {
    expect(normalizeLocale(input)).toBe(expected);
  });

  it.each([null, undefined, "", "de-DE", 42, {}, []])(
    "rejects unsupported or malformed locale %j",
    (input) => {
      expect(normalizeLocale(input)).toBeNull();
    },
  );

  it("prefers saved, then browser, then the English default", () => {
    expect(resolveLocale({ savedLocale: "fr-FR", browserLocale: "es-MX" })).toBe(
      "fr",
    );
    expect(resolveLocale({ savedLocale: "de", browserLocale: "es-MX" })).toBe(
      "es",
    );
    expect(resolveLocale({ savedLocale: "de", browserLocale: "ja" })).toBe(
      "en",
    );
  });
});
