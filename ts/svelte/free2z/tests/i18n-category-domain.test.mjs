import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CATEGORY_LABELS,
  translateCategory,
} from "../src/lib/components/mdEditor/categoryNames.ts";

function missingCategoryKeys(labels, catalog) {
  return Object.values(labels)
    .map(({ key }) => `editor.categoryNames.${key}`)
    .filter(
      (key) =>
        typeof key
          .split(".")
          .reduce((value, part) => value?.[part], catalog) !== "string",
    );
}

test("category translator's finite domain is present in each shipped catalog", () => {
  for (const locale of ["en", "es", "fr", "pt-BR"]) {
    const catalog = JSON.parse(
      readFileSync(
        new URL(`../src/lib/locales/${locale}.json`, import.meta.url),
      ),
    );
    assert.deepEqual(missingCategoryKeys(CATEGORY_LABELS, catalog), [], locale);
    assert.deepEqual(
      missingCategoryKeys(
        { ...CATEGORY_LABELS, INVALID: { key: "unknownDomainKey" } },
        catalog,
      ),
      ["editor.categoryNames.unknownDomainKey"],
    );
  }
});

test("unknown creator category is preserved without translator call", () => {
  assert.equal(
    translateCategory("unknown creator tag", () => {
      throw new Error("unexpected translation");
    }),
    "unknown creator tag",
  );
});
