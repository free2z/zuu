// Binding alarms complement compiled IPC/browser tests; they are not a runtime
// enforcement oracle. Mutations prove that removing production wiring is caught.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
function bindings(source) {
  return [
    /purchase_bridge::restrict\(\s*tauri_plugin_http::init\(\),\s*cfg!\(target_os = "android"\)/.test(source.native),
    /purchase_bridge::restrict\(\s*tauri_plugin_opener::init\(\),\s*cfg!\(target_os = "android"\)/.test(source.native),
    source.native.includes("__FREE2Z_ANDROID_PURCHASES_UNAVAILABLE__") && source.native.includes("writable: false, configurable: false"),
    source.vite.includes('"import.meta.env.TAURI_ENV_PLATFORM": JSON.stringify(process.env.TAURI_ENV_PLATFORM'),
    source.build.includes('include_str!("../src/lib/purchases/policy.json")'),
    source.release.includes("Android digital purchases are unavailable pending release-owner policy review and signed-device acceptance"),
  ].every(Boolean);
}
const source = {
  native: read("src-tauri/src/lib.rs"), vite: read("vite.config.ts"),
  build: read("src-tauri/build.rs"), release: read("scripts/store-identity.mjs"),
};
test("shipping Android bindings are present and removal mutations fail", () => {
  assert.equal(bindings(source), true);
  for (const [file, needle, replacement] of [
    ["native", "tauri_plugin_http::init()", "unrestricted_http()"],
    ["native", "tauri_plugin_opener::init()", "unrestricted_opener()"],
    ["native", 'cfg!(target_os = "android")', 'false'],
    ["native", "writable: false, configurable: false", "writable: true, configurable: true"],
    ["vite", "JSON.stringify(process.env.TAURI_ENV_PLATFORM", 'JSON.stringify(""'],
    ["build", 'include_str!("../src/lib/purchases/policy.json")', '"{}"'],
    ["release", "Android digital purchases are unavailable pending release-owner policy review and signed-device acceptance", "ready"],
  ]) {
    assert.ok(source[file].includes(needle));
    assert.equal(bindings({ ...source, [file]: source[file].replace(needle, replacement) }), false, `${file}: ${needle}`);
  }
});
test("decision is explicitly pending and Android release preflight independently blocks", () => {
  const record = JSON.parse(read("android-purchase-decision.json"));
  assert.equal(record.policyId, JSON.parse(read("src/lib/purchases/policy.json")).id);
  assert.equal(record.proposedDefault, "unavailable");
  assert.equal(record.approvedIntegrationOrException, null);
  assert.equal(record.releaseOwnerDecision, null);
  assert.equal(record.signedDeviceAcceptance, null);
  assert.equal(record.publicAndroidDistribution, "blocked");
  assert.throws(() => execFileSync(process.execPath, [new URL("scripts/store-identity.mjs", root).pathname, "--require=android"], { stdio: "pipe" }), (error) => {
    assert.equal(error.status, 78);
    assert.match(error.stderr.toString(), /release-owner policy review and signed-device acceptance/);
    return true;
  });
});

test("purchase browser specs and production asset check stay in the gated test population", () => {
  const config = read("playwright.config.ts");
  const pkg = JSON.parse(read("package.json"));
  const covered = (scripts, browser) => scripts.test.includes("playwright test") &&
    scripts.test.includes("npm run test:android-purchase-assets") &&
    scripts["test:android-purchase-assets"].includes("TAURI_ENV_PLATFORM=android npm run build") &&
    scripts["test:android-purchase-assets"].includes("tests/android-purchase-assets.pw.ts") &&
    browser.includes('testDir: "./tests"') && browser.includes('testMatch: "**/*.pw.ts"');
  assert.equal(covered(pkg.scripts, config), true);
  assert.equal(covered({ ...pkg.scripts, test: "vitest run" }, config), false);
  assert.equal(covered(pkg.scripts, config.replace('testMatch: "**/*.pw.ts"', 'testMatch: "old-tests/*.pw.ts"')), false);
  assert.ok(read("tests/android-purchase-availability.pw.ts"));
  assert.ok(read("tests/android-purchase-assets.pw.ts"));
});
