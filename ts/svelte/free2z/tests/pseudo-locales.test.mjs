import assert from "node:assert/strict";
import test from "node:test";
import { formatIcuMessage } from "../src/lib/icu-message.js";
import { pseudoCatalog, pseudoMessage } from "../src/lib/pseudo-locales.js";
import { LOCALE_REGISTRY, normalizeLocale } from "../src/lib/locale.js";

test("pseudo transforms retain arguments, nested ICU and product brands", () => {
  const value =
    "Free2Z pays {name}: {count, plural, one {one 2Z} other {{count} ZEC}} with Zcash";
  for (const mode of ["expand", "accent", "rtl"]) {
    const result = pseudoMessage(value, mode);
    assert.ok(result.includes("Free2Z"));
    assert.ok(result.includes("Zcash"));
    assert.ok(result.includes("{name}"));
    assert.ok(
      result.includes("{count, plural, one {one 2Z} other {{count} ZEC}}"),
    );
    assert.notEqual(result, value);
    assert.ok(
      formatIcuMessage(result, "en", { name: "Ada", count: 2 }).includes("Ada"),
    );
    if (mode === "rtl") assert.match(result, /[\u0590-\u05ff]/u);
  }
  assert.deepEqual(
    pseudoCatalog({ greeting: "Hi {name}", count: 1 }, "expand"),
    { greeting: "[Hii {name}]", count: 1 },
  );
});

test("pseudo locales are unavailable without the test build flag", () => {
  for (const tag of ["en-XA", "en-XB", "ar-XB"]) {
    assert.equal(
      LOCALE_REGISTRY.some((entry) => entry.code === tag),
      false,
    );
    // Unsupported regional English falls back to en; pseudo output remains disabled.
    assert.notEqual(normalizeLocale(tag), tag);
  }
});
