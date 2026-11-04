import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  DEV_DEFINES_TIMEOUT_MS,
  devDefinesReadySource,
  devSourceModuleLoader,
} from "./browser/dev-source-module.ts";

// The browser specs that reach into the app's own module graph used to fail
// intermittently with `ReferenceError: __SVELTEKIT_APP_VERSION__ is not
// defined` -- a Vite dev-server property, unrelated to whatever branch was
// under test. tests/browser/dev-source-module.ts is the fix. These
// assertions run in the node suite (`npm test`) because the failure mode they
// guard is precisely a browser spec that cannot be trusted.

const browserDir = fileURLToPath(new URL("./browser/", import.meta.url));

/**
 * Execute the REAL wait source with its clock under our control.
 *
 * `setTimeout` and `Date` are passed as parameters, so inside the generated
 * function they shadow the globals: virtual time advances by exactly the delay
 * the code asks for, and the whole wait completes in zero real time.
 *
 * `maxPolls` is what makes a broken wait FAIL rather than HANG. A wait whose
 * deadline check was removed would otherwise park the node:test process
 * forever -- red for an unrelated reason, with no message, which is the exact
 * shape this change exists to eliminate.
 */
function runWait(
  timeoutMs,
  { installAfterPolls = null, maxPolls = 10_000 } = {},
) {
  let now = 0;
  let polls = 0;
  const clock = { now: () => now };
  const timer = (callback, delay) => {
    polls += 1;
    if (polls > maxPolls) {
      throw new Error(
        `the dev-defines wait polled ${polls} times without terminating: it is not bounded`,
      );
    }
    now += delay;
    if (installAfterPolls !== null && polls >= installAfterPolls) {
      globalThis.__SVELTEKIT_APP_VERSION__ = "installed-late";
    }
    queueMicrotask(callback);
  };
  const body = `${devDefinesReadySource(timeoutMs)}
    return { defines: typeof __SVELTEKIT_APP_VERSION__, elapsed: Date.now() };`;
  // eslint-disable-next-line no-new-func
  const run = new Function(
    "setTimeout",
    "Date",
    `return (async () => {${body}})()`,
  );
  return run(timer, clock);
}

test("the wait resolves immediately once the dev defines are installed", async () => {
  globalThis.__SVELTEKIT_APP_VERSION__ = "test";
  try {
    const { defines, elapsed } = await runWait(5_000);
    assert.equal(defines, "string");
    assert.equal(elapsed, 0, "it waited even though the global was present");
  } finally {
    delete globalThis.__SVELTEKIT_APP_VERSION__;
  }
});

test("the wait blocks until the dev defines arrive", async () => {
  delete globalThis.__SVELTEKIT_APP_VERSION__;
  try {
    // Stand in for /@vite/env executing in a freshly reloaded document, five
    // polls after the import was requested.
    const { defines, elapsed } = await runWait(5_000, { installAfterPolls: 5 });
    assert.equal(defines, "string");
    assert.ok(elapsed > 0, "the loader did not wait for the global at all");
    assert.ok(elapsed < 5_000, "the loader waited for its whole deadline");
  } finally {
    delete globalThis.__SVELTEKIT_APP_VERSION__;
  }
});

test("the wait is bounded, so a missing global stays a ReferenceError and never a hang", async () => {
  delete globalThis.__SVELTEKIT_APP_VERSION__;
  // The global never arrives. The wait must give up at its deadline and let
  // the import proceed, so the spec fails with the original, nameable
  // ReferenceError instead of timing out with no message.
  const { defines, elapsed } = await runWait(200);
  assert.equal(defines, "undefined");
  assert.ok(elapsed >= 200, `gave up before its deadline, at ${elapsed}ms`);
  assert.ok(elapsed < 1_000, `overshot its deadline: ${elapsed}ms`);
});

test("the loader waits BEFORE it imports, not after", async () => {
  const source = devSourceModuleLoader("/src/lib/stores/privacy.ts");
  const waitAt = source.indexOf("__SVELTEKIT_APP_VERSION__");
  const importAt = source.indexOf("import(");
  assert.ok(waitAt >= 0, "the loader does not wait for the dev defines at all");
  assert.ok(importAt >= 0, "the loader does not import anything");
  assert.ok(
    waitAt < importAt,
    "the loader imports the module before waiting for the dev defines",
  );
  assert.ok(source.includes('"/src/lib/stores/privacy.ts"'));
  assert.equal(typeof DEV_DEFINES_TIMEOUT_MS, "number");
});

test("no browser spec imports an app source module the unguarded way", async () => {
  // The whole point is that the guarded loader is the ONLY way in. A spec that
  // re-adds a bare `import('/src/...')` gets the old intermittent
  // ReferenceError back, and nothing else in CI would notice -- it fails on
  // some other branch, weeks later, as ambient noise.
  const files = (await readdir(browserDir)).filter((name) =>
    /\.(spec|test)\.ts$/.test(name),
  );
  assert.ok(files.length > 30, `only found ${files.length} browser specs`);

  const offenders = [];
  for (const name of files) {
    const source = await readFile(
      new URL(name, `file://${browserDir}`),
      "utf8",
    );
    if (/import\s*\(\s*['"`]\/src\//.test(source)) offenders.push(name);
  }
  assert.deepEqual(
    offenders,
    [],
    `these specs import an app source module without waiting for Vite's dev defines; ` +
      `use the loaders in tests/browser/dev-source-module.ts instead: ${offenders.join(", ")}`,
  );
});
