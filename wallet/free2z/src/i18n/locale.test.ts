import { describe, expect, it } from "vitest";
import { normalizeLocale, resolveLocaleSelection } from "./locale";

describe("normalizeLocale", () => {
  it("accepts a supported language with a region", () => {
    expect(normalizeLocale("es-MX")).toBe("es");
  });

  it("rejects an unsupported language and malformed input", () => {
    expect(normalizeLocale("de")).toBeNull();
    expect(normalizeLocale("")).toBeNull();
    expect(normalizeLocale(42)).toBeNull();
  });
});

describe("resolveLocaleSelection", () => {
  it("prefers the saved locale and keeps its region for formatting", () => {
    expect(
      resolveLocaleSelection({ savedLocale: "fr-CA", browserLocale: "es-ES" }),
    ).toEqual({ catalogLocale: "fr", formattingLocale: "fr-CA" });
  });

  it("falls back to the browser locale, then to English", () => {
    expect(
      resolveLocaleSelection({ savedLocale: "de", browserLocale: "es-ES" }),
    ).toEqual({ catalogLocale: "es", formattingLocale: "es-ES" });
    expect(resolveLocaleSelection({})).toEqual({
      catalogLocale: "en",
      formattingLocale: "en",
    });
  });
});
