import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_LOCALE,
  normalizeLocale,
  resolveLocale,
} from "../src/lib/locale.js";

test("normalizes supported regional browser locales", () => {
  assert.equal(normalizeLocale("es-VE"), "es");
  assert.equal(normalizeLocale("FR-ca"), "fr");
  assert.equal(normalizeLocale("en-US"), "en");
});

test("rejects unsupported or invalid locales", () => {
  assert.equal(normalizeLocale("de-DE"), null);
  assert.equal(normalizeLocale(""), null);
  assert.equal(normalizeLocale(null), null);
});

test("prefers a saved selection over the browser locale", () => {
  assert.equal(
    resolveLocale({ savedLocale: "fr", browserLocale: "es-VE" }),
    "fr",
  );
});

test("uses the browser locale when there is no saved selection", () => {
  assert.equal(resolveLocale({ browserLocale: "es-MX" }), "es");
});

test("falls back to English when neither preference is supported", () => {
  assert.equal(resolveLocale({ browserLocale: "de-DE" }), DEFAULT_LOCALE);
});
