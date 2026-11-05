import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { load } from "../scripts/catalog-governance.mjs";
import { normalizeLocale, localeAvailability } from "../src/lib/locale.js";

test("pilot catalogs pass import validation and remain unavailable in production", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/check-pilot-drafts.mjs"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const fallback = Object.keys(load().source).length - 37;
  for (const locale of ["ar", "pl", "ja", "hi", "de"]) {
    assert.match(
      result.stdout,
      new RegExp(`${locale}: 37 draft, ${fallback} fallback, 0 reviewed`),
    );
    assert.equal(normalizeLocale(locale), null);
    assert.equal(localeAvailability(locale), "disabled");
  }
});
