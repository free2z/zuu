import { beforeEach, describe, expect, it, vi } from "vitest";
import { PREFERENCES_KEY, readPreferenceLocale, savePreferenceLocale } from "./preferences";

describe("device locale preference", () => {
  const values = new Map<string, string>();
  beforeEach(() => {
    values.clear();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
  });
  it("reads the legacy key and preserves unrelated preferences when saving", () => {
    values.set("free2z-locale", "fr-CA");
    expect(readPreferenceLocale()).toBe("fr-CA");
    values.set(PREFERENCES_KEY, JSON.stringify({ theme: "dark" }));
    savePreferenceLocale("es");
    expect(JSON.parse(values.get(PREFERENCES_KEY)!)).toEqual({ theme: "dark", locale: "es" });
    expect(readPreferenceLocale()).toBe("es");
  });
  it.each(["{", "[]", "null", '"text"', '{"locale":"de"}', '{"locale":42}', '{}'])(
    "falls back to legacy when preferences are invalid: %s", (raw) => {
      values.set(PREFERENCES_KEY, raw);
      values.set("free2z-locale", "fr-CA");
      expect(readPreferenceLocale()).toBe("fr-CA");
    },
  );
  it("tolerates unavailable storage", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error(); } });
    expect(readPreferenceLocale()).toBeNull();
    expect(() => savePreferenceLocale("fr")).not.toThrow();
  });
});
