import { describe, expect, it } from "vitest";
import {
  normalizeLocale,
  resolveLocale,
  resolveLocaleSelection,
} from "./locale";

describe("locale resolution", () => {
  it.each([
    ["en", "en"],
    ["ES-mx", "es"],
    [" fr-CA ", "fr"],
  ] as const)("normalizes %s to %s", (input, expected) => {
    expect(normalizeLocale(input)).toBe(expected);
  });

  it.each([null, undefined, "", "de-DE", "en--US", 42, {}, []])(
    "rejects unsupported or malformed locale %j",
    (input) => {
      expect(normalizeLocale(input)).toBeNull();
    },
  );

  it("prefers saved, then browser, then the English default", () => {
    expect(
      resolveLocale({ savedLocale: "fr-FR", browserLocale: "es-MX" }),
    ).toBe("fr");
    expect(resolveLocale({ savedLocale: "de", browserLocale: "es-MX" })).toBe(
      "es",
    );
    expect(resolveLocale({ savedLocale: "de", browserLocale: "ja" })).toBe(
      "en",
    );
  });

  it("preserves the full canonical region tag only for the selected catalog candidate", () => {
    expect(
      resolveLocaleSelection({
        savedLocale: " fr-ca ",
        browserLocale: "es-MX",
      }),
    ).toEqual({ catalogLocale: "fr", formattingLocale: "fr-CA" });
    expect(
      resolveLocaleSelection({ savedLocale: "de-DE", browserLocale: "es-mx" }),
    ).toEqual({ catalogLocale: "es", formattingLocale: "es-MX" });
    expect(
      resolveLocaleSelection({ savedLocale: "de-DE", browserLocale: "ja-JP" }),
    ).toEqual({ catalogLocale: "en", formattingLocale: "en" });
  });

  it("uses the matching browser region when a saved choice is language-only", () => {
    expect(
      resolveLocaleSelection({ savedLocale: "fr", browserLocale: "fr-CA" }),
    ).toEqual({ catalogLocale: "fr", formattingLocale: "fr-CA" });
    expect(
      resolveLocaleSelection({ savedLocale: "fr", browserLocale: "es-MX" }),
    ).toEqual({ catalogLocale: "fr", formattingLocale: "fr" });
  });
});
