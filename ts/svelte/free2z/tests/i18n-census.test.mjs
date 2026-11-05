import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  writeFileSync,
  unlinkSync,
  readFileSync,
  mkdtempSync,
  cpSync,
  rmSync,
} from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";

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

test("aliases and translator escapes fail closed", () => {
  try {
    for (const [source, marker] of [
      ['import { t as tr } from "$lib/i18n"; tr("unknownAlias");', "missing"],
      [
        'import { t } from "$lib/i18n"; const tr = t; tr("unknownAlias");',
        "missing",
      ],
      [
        'import { t } from "$lib/i18n"; function leak() { return t; }',
        "escapeAdded",
      ],
      [
        'function call(translator: TranslationFunction) { return translator("unknownAlias"); }',
        "missing",
      ],
    ]) {
      writeFileSync(probe, source);
      const result = run();
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, new RegExp(marker));
    }
  } finally {
    try {
      unlinkSync(probe);
    } catch {}
  }
});

test("missing source keys and placeholder drift fail their gates", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "free2z-i18n-"));
  cpSync("src/lib/locales", temp, { recursive: true });
  const enPath = path.join(temp, "en.json");
  const frPath = path.join(temp, "fr.json");
  const enOriginal = readFileSync(enPath, "utf8");
  const frOriginal = readFileSync(frPath, "utf8");
  try {
    const en = JSON.parse(enOriginal);
    delete en.trending.pageOf;
    writeFileSync(enPath, JSON.stringify(en));
    const missing = spawnSync(process.execPath, ["scripts/i18n-census.mjs"], {
      encoding: "utf8",
      env: { ...process.env, I18N_CENSUS_ENGLISH: enPath },
    });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /trending/);
    assert.match(missing.stderr, /missing/);
    writeFileSync(enPath, enOriginal);
    const fr = JSON.parse(frOriginal);
    fr.trending.pageOf = "Page {page} sur {wrong}";
    writeFileSync(frPath, JSON.stringify(fr));
    const drift = spawnSync(
      process.execPath,
      [
        "--test",
        "--test-name-pattern=translation catalogs match",
        "tests/locale.test.mjs",
      ],
      {
        encoding: "utf8",
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              ([key]) => key !== "NODE_TEST_CONTEXT",
            ),
          ),
          I18N_TEST_LOCALES: temp,
        },
      },
    );
    assert.equal(drift.status, 1);
    assert.match(
      drift.stdout + drift.stderr,
      /fr\.json placeholder mismatch for trending\.pageOf/,
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
