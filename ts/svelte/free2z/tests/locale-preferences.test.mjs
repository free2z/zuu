import assert from "node:assert/strict";
import test from "node:test";
import {
  firstSupportedLocale,
  parseAcceptLanguage,
} from "../src/lib/locale.js";

test("weighted preferences preserve ties and skip disabled and invalid entries", () => {
  const preferences = parseAcceptLanguage(
    "de;q=1, pt-PT;q=0.9, es-MX;q=0.8, fr;q=0.8, en;q=0, es;q=1.001, *;q=1",
  );
  assert.deepEqual(preferences, ["de", "pt-PT", "es-MX", "fr"]);
  assert.equal(firstSupportedLocale(preferences), "es");
  assert.equal(firstSupportedLocale(["pt-PT", "fr-CA"]), "fr");
  assert.equal(firstSupportedLocale(["pt-PT"]), null);
});
