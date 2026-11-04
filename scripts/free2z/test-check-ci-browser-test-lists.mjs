#!/usr/bin/env node

// Exercise the real checker with a tiny fake Playwright CLI. The fixtures make
// the coverage contract deterministic without adding permanent browser specs
// or maintaining a second implementation of the checker.

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const checker = join(repoRoot, "scripts/free2z/check-ci-browser-test-lists.mjs");
const appCwd = join(repoRoot, "ts/svelte/free2z");
const fixtureRoot = mkdtempSync(join(tmpdir(), "browser-shard-contract-"));
const appDir = join(fixtureRoot, "fixture app [α]");
const listDir = join(appDir, "tests/browser/ci-shards");
const playwright = join(appDir, "node_modules/.bin/playwright");

const selectors = [
  "plain-1.spec.ts",
  "plain-2.spec.ts",
  "plain-3.spec.ts",
  "plain-4.spec.ts",
  "plain-5.spec.ts",
  "plain-6.spec.ts",
  "plain-7.spec.ts",
  "plain-8.spec.ts",
  "unicode [β]-雪.spec.ts › title [α] — café",
];
const entries = selectors.map((selector) => ({
  id: selector,
  projectId: "chromium",
}));
const unexpected = {
  id: "newly-enumerated-[γ]-🧪.spec.ts › title [δ] — naïve",
  projectId: "chromium",
};

function fail(message) {
  throw new Error(message);
}

function writeFixture() {
  mkdirSync(join(appDir, "node_modules/.bin"), { recursive: true });
  mkdirSync(listDir, { recursive: true });
  writeFileSync(
    playwright,
    `#!/usr/bin/env node
import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] !== "test" || !args.includes("--list") || !args.includes("--reporter=json")) {
  process.stderr.write("fixture only supports Playwright test --list --reporter=json\\n");
  process.exit(2);
}
const tests = ${JSON.stringify(entries)};
const newlyEnumerated = ${JSON.stringify(unexpected)};
const listArg = args.find((arg) => arg.startsWith("--test-list="));
const selected = listArg
  ? readFileSync(listArg.slice("--test-list=".length), "utf8")
      .split(/\\r?\\n/).filter(Boolean)
      .map((selector) => tests.find((test) => test.id === selector) ??
        (selector === newlyEnumerated.id ? newlyEnumerated : null))
      .filter(Boolean)
  : (process.env.FIXTURE_ADD_NEW_TEST === "1" ? [...tests, newlyEnumerated] : tests);
process.stdout.write(JSON.stringify({ suites: selected.map(({ id, projectId }) => ({
  id, specs: [{ id, tests: [{ projectId }] }], suites: []
})) }));
`,
  );
  chmodSync(playwright, 0o755);
  selectors.slice(0, 7).forEach((selector, index) => {
    writeFileSync(join(listDir, `shard-${index + 1}.list`), `${selector}\n`);
  });
  writeFileSync(
    join(listDir, "shard-8.list"),
    `${selectors[7]}\n${selectors[8]}\n`,
  );
}

function invoke({ cwd, env = {}, expectedFailure, message }) {
  try {
    const stdout = execFileSync(process.execPath, [checker, appDir], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (expectedFailure)
      fail(`${message}: checker unexpectedly passed (${stdout.trim()})`);
    return stdout;
  } catch (error) {
    if (!expectedFailure) {
      throw new Error(
        `${message}: checker failed unexpectedly\n${error.stderr ?? error}`,
      );
    }
    const stderr = error.stderr ?? "";
    if (!stderr.includes(expectedFailure)) {
      throw new Error(
        `${message}: expected failure containing ${JSON.stringify(expectedFailure)}, got:\n${stderr}`,
      );
    }
    return stderr;
  }
}

try {
  writeFixture();

  const rootPass = invoke({
    cwd: repoRoot,
    message: "checker from repository root",
  });
  if (
    !rootPass.includes(
      "PASS: 9 Playwright tests assigned exactly once across 8 shards",
    )
  ) {
    fail(
      `root invocation did not confirm exact-once coverage: ${rootPass.trim()}`,
    );
  }
  const appPass = invoke({
    cwd: appCwd,
    message: "checker from app working directory",
  });
  if (
    !appPass.includes(
      "PASS: 9 Playwright tests assigned exactly once across 8 shards",
    )
  ) {
    fail(
      `app invocation did not confirm exact-once coverage: ${appPass.trim()}`,
    );
  }

  // Removing one assignment must fail closed.
  writeFileSync(join(listDir, "shard-8.list"), "");
  invoke({
    cwd: appCwd,
    expectedFailure: "shard 8/8 is empty",
    message: "empty shard list negative control",
  });
  writeFileSync(join(listDir, "shard-8.list"), `${selectors[7]}\n`);
  invoke({
    cwd: appCwd,
    expectedFailure: "1 missing",
    message: "missing assignment negative control",
  });

  // The same test assigned to two shard lists must fail with a duplicate.
  writeFileSync(join(listDir, "shard-8.list"), `${selectors[7]}\n`);
  writeFileSync(
    join(listDir, "shard-2.list"),
    `${selectors[1]}\n${selectors[0]}\n`,
  );
  invoke({
    cwd: appCwd,
    expectedFailure: "1 duplicated",
    message: "cross-shard duplicate negative control",
  });

  // A test that appears in fresh full-suite enumeration but in no shard list
  // must be reported as missing, without adding a permanent Playwright test.
  writeFileSync(
    join(listDir, "shard-8.list"),
    `${selectors[7]}\n${selectors[8]}\n`,
  );
  writeFileSync(join(listDir, "shard-2.list"), `${selectors[1]}\n`);
  invoke({
    cwd: appCwd,
    env: { FIXTURE_ADD_NEW_TEST: "1" },
    expectedFailure: "1 missing",
    message: "newly enumerated unassigned test negative control",
  });

  // Check the extra-ID path too: a stale selector unknown to full enumeration
  // cannot be accepted as coverage.
  writeFileSync(
    join(listDir, "shard-2.list"),
    `${selectors[1]}\n${unexpected.id}\n`,
  );
  invoke({
    cwd: appCwd,
    expectedFailure: "1 extra",
    message: "extra selector negative control",
  });

  process.stdout.write(
    "PASS: checker contract accepts exact coverage and rejects empty, missing, duplicated, newly enumerated unassigned, and extra tests (root and app cwd)\n",
  );
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
