//  -- no ZEC exchange rate may live in a browser constant.
//
// The deployed crediting loop carried `TUZI_PER_ZEC: int = 2500`, which was
// roughly right in 2022 and, at a live rate of ~75,263 2Z/ZEC, credited every
// on-chain buyer 1/30th of what they paid. The rate has exactly one source --
// `dj.apps.pricing.service.current_tuzis_per_zec()`, served to the browser as
// `/api/pricing/` -- and the name is expunged.
//
// The Python suite (`py/free2z/dj/apps/g12f/test_zec_credit_integrity.py`) runs the
// same two scans repo-wide, but its job only runs when `py/` changes. This
// copy is what catches a reintroduction in a TypeScript-only PR, since the
// `ui` job runs for both `ts/svelte/free2z/*` and `ts/react/free2z/*`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../..");
const SELF = "ts/svelte/free2z/tests/zec-rate-constants.test.mjs";
// `.jsx`/`.cjs` already exist in these trees and were unscanned
// (codex adversarial review), so the stated guarantee was not true.
const SUFFIXES = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".svelte",
];

// The dead identifier, standing alone. Neither the derived, display-only
// `BOOTSTRAP_TUZIS_PER_ZEC` nor the lowercase `tuzis_per_zec` (the live
// pricing field) is caught -- those are the fix, not the bug.
const DEAD_NAME = /(?<![A-Z0-9_])TUZIS?_PER_ZEC(?![A-Z0-9_])/;

// Any uppercase `*_PER_ZEC` constant whose ENTIRE right-hand side is a number.
// Survives a rename: `FALLBACK_TUZI_PER_ZEC = 45000` is caught too.
const LITERAL_RATE =
  /^\s*(?:export\s+)?(?:const\s+|let\s+|var\s+)?[A-Z0-9_]*_PER_ZEC\b\s*(?::[^=]*)?=\s*[-+]?[0-9][0-9_]*(?:\.[0-9_]+)?(?:[eE][-+]?[0-9]+)?\s*[;,]?\s*(?:\/\/.*)?$/;

function scannedSources() {
  // `git ls-files` excludes node_modules, build output and untracked debris,
  // so the scan cannot be slowed down or fooled by a dirty checkout.
  const listing = execFileSync(
    "git",
    ["-C", REPO_ROOT, "ls-files", "-z", "ts"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return listing
    .split("\0")
    .filter(
      (name) =>
        name &&
        name !== SELF &&
        SUFFIXES.some((suffix) => name.endsWith(suffix)),
    )
    .map((name) => [name, readFileSync(path.join(REPO_ROOT, name), "utf8")]);
}

function offenders(pattern) {
  const found = [];
  for (const [name, text] of scannedSources()) {
    text.split("\n").forEach((line, i) => {
      if (pattern.test(line)) found.push(`${name}:${i + 1}: ${line.trim()}`);
    });
  }
  return found;
}

test("the name TUZI_PER_ZEC does not exist in the UI trees (#1402)", () => {
  assert.deepEqual(
    offenders(DEAD_NAME),
    [],
    "TUZI_PER_ZEC was expunged in #1402; the rate comes from /api/pricing/",
  );
});

test("no *_PER_ZEC constant is a bare number (#1402)", () => {
  assert.deepEqual(
    offenders(LITERAL_RATE),
    [],
    "a ZEC exchange rate is frozen into a numeric constant (#1402)",
  );
});

// Positive control. A scan test that matches nothing is green whether or not
// its regex works; these lines are ways  could ship again in TypeScript.
test("the scanners actually fire on every shape of the bug", () => {
  for (const line of [
    "export const TUZI_PER_ZEC = 2500;",
    "const TUZIS_PER_ZEC = 75263",
    "export const FALLBACK_TUZI_PER_ZEC = 45000;",
    "  const RATE_PER_ZEC = 2.5e3;",
    "export const TUZI_PER_ZEC: number = 2500;",
  ]) {
    assert.ok(
      DEAD_NAME.test(line) || LITERAL_RATE.test(line),
      `no scanner caught: ${line}`,
    );
  }
});

// Negative control. A guard that flags correct code gets deleted by whoever
// hits it next, and then it guards nothing.
test("the scanners do not fire on the live-pricing path", () => {
  for (const line of [
    "export const BOOTSTRAP_TUZIS_PER_ZEC = Math.round(BOOTSTRAP_ZEC_USD * 2);",
    "  $: liveTuzisPerZec = tuziPerZec(livePricing);",
    "  tuzis_per_zec: string;",
    "  const raw = Number(pricing?.tuzis_per_zec);",
  ]) {
    assert.ok(
      !DEAD_NAME.test(line) && !LITERAL_RATE.test(line),
      `a scanner flagged correct code: ${line}`,
    );
  }
});
