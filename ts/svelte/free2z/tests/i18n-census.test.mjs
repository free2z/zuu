import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import test from "node:test";

const probe = "src/__i18n_census_probe.ts";
const run = () =>
  spawnSync(process.execPath, ["scripts/i18n-census.mjs"], {
    encoding: "utf8",
  });

test("AST census detects new dotted, nondotted and dynamic calls", () => {
  assert.equal(run().status, 0);
  try {
    for (const argument of [
      '"unknown.dotted.key"',
      '"unknownBareKey"',
      "key",
    ]) {
      writeFileSync(
        probe,
        `import { t } from "$lib/i18n"; const key = "x"; t(${argument});`,
      );
      const result = run();
      assert.equal(result.status, 1, `${argument}: ${result.stderr}`);
      assert.match(result.stderr, /added/);
    }
  } finally {
    try {
      unlinkSync(probe);
    } catch {
      /* absent */
    }
  }
  execFileSync(process.execPath, ["scripts/i18n-census.mjs"]);
});
