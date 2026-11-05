import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

function run(env = {}) {
  return spawnSync(
    process.execPath,
    ["scripts/check-formatting-inventory.mjs"],
    { encoding: "utf8", env: { ...process.env, ...env } },
  );
}
test("inventory rejects new hardcoded number, date and currency calls and changed exceptions", () => {
  const root = mkdtempSync(path.join(tmpdir(), "free2z-format-"));
  try {
    assert.equal(run().status, 0);
    const probe = path.join(root, "probe.ts");
    for (const [source, kind] of [
      ['new Intl.NumberFormat("en-US").format(10)', "Intl.NumberFormat"],
      [
        'new Intl.DateTimeFormat("en-US").format(new Date())',
        "Intl.DateTimeFormat",
      ],
      [
        'new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(10)',
        "Intl.NumberFormat",
      ],
      [
        'new Intl["DateTimeFormat"]("en-US").format(new Date())',
        "Intl.DateTimeFormat",
      ],
    ]) {
      writeFileSync(probe, source);
      const result = run({ FORMATTING_PROBE: probe });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /"added"/);
      assert.ok(result.stderr.includes(kind));
      assert.ok(result.stderr.includes("en-US"));
    }
    writeFileSync(probe, "const numberFormatter = Intl.NumberFormat;");
    const escape = run({ FORMATTING_PROBE: probe });
    assert.equal(escape.status, 1);
    assert.match(escape.stderr, /Intl.escape/);
    writeFileSync(probe, "const format = Number.prototype.toLocaleString;");
    const methodEscape = run({ FORMATTING_PROBE: probe });
    assert.equal(methodEscape.status, 1);
    assert.match(methodEscape.stderr, /format-method.escape/);
    writeFileSync(
      probe,
      '// new Intl.NumberFormat("en-US")\ntype Options = Intl.NumberFormatOptions;',
    );
    assert.equal(
      run({ FORMATTING_PROBE: probe }).status,
      0,
      "comments and type references are not executable calls",
    );
    const originalCall = 'new Intl.NumberFormat("en-US").format(10)';
    writeFileSync(probe, originalCall);
    const fixtureBaseline = JSON.parse(
      readFileSync("tests/formatting-inventory.json", "utf8"),
    );
    const context = 'new Intl.NumberFormat("en-US")';
    fixtureBaseline.push({
      file: probe,
      kind: "Intl.NumberFormat",
      context,
      fingerprint: createHash("sha256")
        .update(context)
        .digest("hex")
        .slice(0, 16),
      classification: "legacy",
      owner: "Free2Z UI",
      rationale:
        "Migrate Intl.NumberFormat at this exact call to a shared locale-aware helper; preserve its arguments, options and precision.",
    });
    const scopedBaseline = path.join(root, "scoped.json");
    writeFileSync(scopedBaseline, JSON.stringify(fixtureBaseline));
    assert.equal(
      run({ FORMATTING_PROBE: probe, FORMATTING_BASELINE: scopedBaseline })
        .status,
      0,
    );
    writeFileSync(probe, 'new Intl.NumberFormat("fr-FR").format(10)');
    const changedCall = run({
      FORMATTING_PROBE: probe,
      FORMATTING_BASELINE: scopedBaseline,
    });
    assert.equal(changedCall.status, 1);
    assert.match(changedCall.stderr, /"added"/);
    assert.match(changedCall.stderr, /"removed"/);
    assert.match(changedCall.stderr, /fr-FR/);
    const baseline = JSON.parse(
      readFileSync("tests/formatting-inventory.json", "utf8"),
    );
    baseline[0].context += " changed";
    const altered = path.join(root, "baseline.json");
    writeFileSync(altered, JSON.stringify(baseline));
    const changed = run({ FORMATTING_BASELINE: altered });
    assert.equal(changed.status, 1);
    assert.match(changed.stderr, /"added"/);
    assert.match(changed.stderr, /"removed"/);
    assert.ok(changed.stderr.includes(baseline[0].file));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
