import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { validateVaultFixture, installVaultNativeFixture } from "./store-vault-fixture.mjs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CAPTURE_CONFIG_PATH,
  CAPTURE_FIXTURE_PATH,
  CAPTURE_SHOTS,
  CAPTURE_IMAGE,
  CAPTURE_INPUTS,
  CAPTURE_LOCAL_OVERRIDE_FILES,
  CAPTURE_NPM_CI_ARGUMENTS,
  CAPTURE_NPM_ENVIRONMENT,
  CAPTURE_RECORD_PATH,
  ScreenshotContractError,
  assertCaptureSourceCommit,
  assertNoLocalCaptureOverrides,
  computeCaptureContractDigest,
  computeCaptureSourceDigest,
  validateCaptureConfig,
  validateCaptureRecord,
} from "./store-screenshot-contract.mjs";
import {
  CAPTURE_PUBLIC_REQUESTS,
  assertCaptureInputsStable,
  assertReleaseSource,
  capturePublicRequestAllowed,
  commitCaptureArtifactSet,
  computeFeedCaptureScroll,
  markCaptureOwnerReviewRequired,
} from "./store-screenshot-capture.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const screenshotSets = JSON.parse(await readFile(resolve(projectRoot, "store/manifest.json"), "utf8")).screenshotSets;

async function fixture() {
  const parent = await mkdtemp(resolve(tmpdir(), "zuuli-screenshot-contract-"));
  const root = resolve(parent, "zuuli");
  await mkdir(root);
  for (const input of CAPTURE_INPUTS) {
    const destination = resolve(root, input);
    await mkdir(dirname(destination), { recursive: true });
    await cp(resolve(projectRoot, input), destination, { recursive: true });
  }
  await mkdir(dirname(resolve(root, CAPTURE_RECORD_PATH)), { recursive: true });
  await cp(resolve(projectRoot, CAPTURE_RECORD_PATH), resolve(root, CAPTURE_RECORD_PATH));
  return root;
}

async function json(root, path) {
  return JSON.parse(await readFile(resolve(root, path), "utf8"));
}

async function writeJson(root, path, value) {
  await writeFile(resolve(root, path), `${JSON.stringify(value, null, 2)}\n`);
}

async function rejectsCode(operation, code) {
  await assert.rejects(operation, (error) => error instanceof ScreenshotContractError && error.code === code);
}

// Keep every fixture `git` call strictly foreground. `git commit` otherwise runs
// `git maintenance run --auto --detach`, which git deliberately daemonizes: it
// outlives the child we await and then creates `.git/objects/maintenance.lock`
// — measured at ~23ms after `git commit` had already returned (Linux, git
// 2.43). The recursive teardown below is descending `.git/objects` at exactly
// that moment, so its closing rmdir finds the directory non-empty and fails
// ENOTEMPTY, reddening the required gate on a green change (issue #561).
// GIT_CONFIG_COUNT applies the guard with no config file and no repo state, so
// it covers `git init` before any repo exists. Do not simplify this env away.
const GIT_FIXTURE_ENV = Object.freeze({
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "gc.auto",
  GIT_CONFIG_VALUE_0: "0",
  GIT_CONFIG_KEY_1: "maintenance.auto",
  GIT_CONFIG_VALUE_1: "false",
});

// Backstop for the same failure class: `fs.rm` defaults to `maxRetries: 0`, and
// `force` suppresses ENOENT, not ENOTEMPTY. Retrying absorbs any future
// concurrent writer the env guard above does not already prevent.
async function removeGitFixture(root, { remove = rm, pause = wait } = {}) {
  if (root.endsWith("/zuuli")) root = dirname(root);
  let retries = 0;
  for (;;) {
    try {
      await remove(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error?.code !== "ENOTEMPTY" || retries >= 10) throw error;
      retries += 1;
      await pause(50 * retries);
    }
  }
}

async function git(root, args, baseEnv = process.env) {
  const output = [];
  await new Promise((accept, reject) => {
    const child = spawn("git", args, { cwd: root, env: { ...baseEnv, ...GIT_FIXTURE_ENV } });
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? accept() : reject(new Error(`git ${args[0]} failed`)));
  });
  return Buffer.concat(output).toString("utf8").trim();
}

test("fixture git children disable automatic gc and maintenance", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "zuuli-git-config-contract-"));
  t.after(() => removeGitFixture(root));
  const emptyGlobalConfig = resolve(root, "empty-global-gitconfig");
  await writeFile(emptyGlobalConfig, "");
  const isolatedEnv = {
    ...process.env,
    GIT_CONFIG_COUNT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: emptyGlobalConfig,
  };

  await git(root, ["init", "-q"], isolatedEnv);
  assert.equal(await git(root, ["config", "--default", "missing", "--get", "gc.auto"], isolatedEnv), "0");
  assert.equal(await git(root, ["config", "--default", "missing", "--get", "maintenance.auto"], isolatedEnv), "false");
});

test("git fixture teardown exhausts deterministic ENOTEMPTY races before succeeding", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "zuuli-git-remove-contract-"));
  await writeFile(resolve(root, "fixture"), "present\n");
  let attempts = 0;
  const pauses = [];

  await removeGitFixture(root, {
    remove: async (...args) => {
      attempts += 1;
      if (attempts <= 10) {
        const error = new Error(`injected directory race on attempt ${attempts}`);
        error.code = "ENOTEMPTY";
        throw error;
      }
      await rm(...args);
    },
    pause: async (milliseconds) => pauses.push(milliseconds),
  });

  assert.equal(attempts, 11);
  assert.deepEqual(pauses, [50, 100, 150, 200, 250, 300, 350, 400, 450, 500]);
  await assert.rejects(() => readFile(resolve(root, "fixture")), { code: "ENOENT" });
});

test("git fixture teardown rejects a non-ENOTEMPTY error immediately and unchanged", async () => {
  const injectedError = new Error("injected permission failure");
  injectedError.code = "EACCES";
  let attempts = 0;
  const pauses = [];

  await assert.rejects(
    () => removeGitFixture("unused", {
      remove: async () => {
        attempts += 1;
        throw injectedError;
      },
      pause: async (milliseconds) => pauses.push(milliseconds),
    }),
    (error) => {
      assert.equal(error, injectedError);
      return true;
    },
  );

  assert.equal(attempts, 1);
  assert.deepEqual(pauses, []);
});

test("git fixture teardown rejects the eleventh consecutive ENOTEMPTY after ten pauses", async () => {
  const injectedError = new Error("injected persistent directory race");
  injectedError.code = "ENOTEMPTY";
  let attempts = 0;
  const pauses = [];

  await assert.rejects(
    () => removeGitFixture("unused", {
      remove: async () => {
        attempts += 1;
        throw injectedError;
      },
      pause: async (milliseconds) => {
        pauses.push(milliseconds);
        assert.ok(pauses.length <= 10, "retry limit allowed an eleventh pause");
      },
    }),
    (error) => {
      assert.equal(error, injectedError);
      return true;
    },
  );

  assert.equal(attempts, 11);
  assert.deepEqual(pauses, [50, 100, 150, 200, 250, 300, 350, 400, 450, 500]);
});

async function preflight(env) {
  await new Promise((accept, reject) => {
    const child = spawn(process.execPath, ["scripts/store-screenshot-preflight.mjs"], {
      cwd: projectRoot,
      env: { ...process.env, ...env },
      stdio: "ignore",
    });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? accept() : reject(new Error("capture preflight failed")));
  });
}

test("repository capture plan, provenance, and exact entry matrix validate", async () => {
  const result = await validateCaptureRecord({ root: projectRoot, screenshotSets });
  assert.equal(result.record.entries.length, 20);
  assert.equal(new Set(result.record.entries.map(({ sha256 }) => sha256)).size, 20);
  assert.equal(result.record.entries.every(({ disclosureScan }) => disclosureScan === "passed"), true);
});

test("target dimensions and safe areas fail closed", async (t) => {
  const root = await fixture();
  t.after(() => rm(dirname(root), { recursive: true, force: true }));
  const config = await json(root, CAPTURE_CONFIG_PATH);
  config.targets[0].cssWidth += 1;
  await writeJson(root, CAPTURE_CONFIG_PATH, config);
  await rejectsCode(() => validateCaptureConfig({ root, screenshotSets }), "INVALID_CAPTURE_CONTRACT");

  const safeArea = await json(projectRoot, CAPTURE_CONFIG_PATH);
  safeArea.targets[0].safeArea.top = 400;
  await writeJson(root, CAPTURE_CONFIG_PATH, safeArea);
  await rejectsCode(() => validateCaptureConfig({ root, screenshotSets }), "INVALID_CAPTURE_CONTRACT");
});

test("declared browser version must match every Playwright manifest and lock entry", async (t) => {
  const root = await fixture();
  t.after(() => rm(dirname(root), { recursive: true, force: true }));
  const packageLock = await json(root, "package-lock.json");
  packageLock.packages["node_modules/playwright-core"].version = "1.62.0";
  await writeJson(root, "package-lock.json", packageLock);
  await rejectsCode(() => validateCaptureConfig({ root, screenshotSets }), "INVALID_CAPTURE_CONTRACT");
});

test("feed capture scroll is geometry-derived and keeps a required control unobscured", () => {
  assert.equal(computeFeedCaptureScroll({ currentScroll: 0, visibleTop: 60, visibleBottom: 580, controlTop: 240, contentBottom: 760, requireControl: true }), 180);
  assert.equal(computeFeedCaptureScroll({ currentScroll: 0, visibleTop: 60, visibleBottom: 900, controlTop: 240, contentBottom: 840, requireControl: true }), 0);
  assert.equal(computeFeedCaptureScroll({ currentScroll: 0, visibleTop: 60, visibleBottom: 580, controlTop: 240, contentBottom: 820, requireControl: false }), 240);
});

test("creator capture pins the authoritative first catalog page and rejects decorative pagination", () => {
  const creatorDetail = "GET https://free2z.cash/api/creator/example_editorial/";
  const firstPage = "GET https://free2z.cash/api/zpage/?ordering=-created_at&page=1&page_size=12&username=example_editorial";
  assert.deepEqual(CAPTURE_PUBLIC_REQUESTS["creator-profile"], [creatorDetail, firstPage]);
  assert.equal(capturePublicRequestAllowed("creator-profile", firstPage), true);
  for (const drifted of [
    "GET https://free2z.cash/api/zpage/?ordering=-created_at&page_size=12&username=example_editorial",
    "GET https://free2z.cash/api/zpage/?ordering=-created_at&page=2&page_size=12&username=example_editorial",
    "GET https://free2z.cash/api/zpage/?ordering=-created_at&page=1&page_size=24&username=example_editorial",
    "GET https://free2z.cash/api/zpage/?note=page%3D1&ordering=-created_at&page_size=12&username=example_editorial",
    "GET https://free2z.cash/api/creator/example_editorial/?page=1",
  ]) {
    assert.equal(capturePublicRequestAllowed("creator-profile", drifted), false);
  }
});

test("capture records reject stale source pixels and incomplete or duplicate entries", async (t) => {
  const root = await fixture();
  t.after(() => rm(dirname(root), { recursive: true, force: true }));
  await writeFile(resolve(root, "index.html"), `${await readFile(resolve(root, "index.html"), "utf8")}\n`);
  await rejectsCode(() => validateCaptureRecord({ root, screenshotSets, enforceCurrentSource: true }), "STALE_CAPTURE");

  const cleanRoot = await fixture();
  t.after(() => rm(dirname(cleanRoot), { recursive: true, force: true }));
  const missing = await json(cleanRoot, CAPTURE_RECORD_PATH);
  missing.entries.pop();
  await writeJson(cleanRoot, CAPTURE_RECORD_PATH, missing);
  await rejectsCode(() => validateCaptureRecord({ root: cleanRoot, screenshotSets }), "INCOMPLETE_CAPTURE");

  const duplicate = await json(projectRoot, CAPTURE_RECORD_PATH);
  duplicate.entries[1] = { ...duplicate.entries[0] };
  await writeJson(cleanRoot, CAPTURE_RECORD_PATH, duplicate);
  await rejectsCode(() => validateCaptureRecord({ root: cleanRoot, screenshotSets }), "INVALID_CAPTURE_RECORD");

  const duplicatePixels = await json(projectRoot, CAPTURE_RECORD_PATH);
  duplicatePixels.entries[1].sha256 = duplicatePixels.entries[0].sha256;
  await writeJson(cleanRoot, CAPTURE_RECORD_PATH, duplicatePixels);
  await rejectsCode(() => validateCaptureRecord({ root: cleanRoot, screenshotSets }), "INVALID_CAPTURE_RECORD");
});

test("ordinary validation rejects stale capture tooling without requiring a UI-source comparison", async (t) => {
  const root = await fixture();
  t.after(() => rm(dirname(root), { recursive: true, force: true }));
  const captureScript = resolve(root, "scripts/store-screenshot-capture.mjs");
  await writeFile(captureScript, `${await readFile(captureScript, "utf8")}\n`);
  await rejectsCode(() => validateCaptureRecord({ root, screenshotSets }), "STALE_CAPTURE");
});

test("record metadata cannot waive disclosure checks or alter routes", async (t) => {
  const root = await fixture();
  t.after(() => rm(dirname(root), { recursive: true, force: true }));
  const record = await json(root, CAPTURE_RECORD_PATH);
  record.entries[0].disclosureScan = "skipped";
  await writeJson(root, CAPTURE_RECORD_PATH, record);
  await rejectsCode(() => validateCaptureRecord({ root, screenshotSets }), "INVALID_CAPTURE_RECORD");

  record.entries[0].disclosureScan = "passed";
  record.entries[0].route = "/articles";
  await writeJson(root, CAPTURE_RECORD_PATH, record);
  await rejectsCode(() => validateCaptureRecord({ root, screenshotSets }), "INVALID_CAPTURE_RECORD");
});

test("vault fixture is a closed public empty identity, without sensitive or live data", async (t) => {
  const root = await fixture();
  t.after(() => rm(dirname(root), { recursive: true, force: true }));
  const clean = await json(root, CAPTURE_FIXTURE_PATH);
  validateVaultFixture(clean);
  for (const mutate of [
    (v) => { v.status.activeWalletId = "other"; },
    (v) => { v.wallets[0].name = "private-person@example.invalid"; },
    (v) => { v.balance.spendable = 1; },
    (v) => { v.transactions.push({ memo: "Debug capture" }); },
    (v) => { v.unifiedAddress = "u1" + "a".repeat(140); },
    (v) => { v.seedPhrase = "never allowed"; },
    (v) => { v.sync.chainTip = 100; },
    (v) => { v.pendingSend = {}; },
  ]) {
    const changed = structuredClone(clean); mutate(changed);
    await writeJson(root, CAPTURE_FIXTURE_PATH, changed);
    await assert.rejects(() => validateCaptureConfig({ root, screenshotSets }), /reviewed public empty snapshot/);
  }
});

test("capture inputs cannot be symlinks", async (t) => {
  const root = await fixture();
  t.after(() => rm(dirname(root), { recursive: true, force: true }));
  await rm(resolve(root, "vite.config.ts"));
  await symlink(resolve(root, "index.html"), resolve(root, "vite.config.ts"));
  await rejectsCode(() => validateCaptureConfig({ root, screenshotSets }), "UNSAFE_CAPTURE_INPUT");
});

test("capture rejects every local Vite or npm override, including ignored npm config", async (t) => {
  const root = await fixture();
  t.after(() => removeGitFixture(root));
  await assertNoLocalCaptureOverrides(root);
  const cleanDigest = await computeCaptureSourceDigest(root);
  await git(root, ["init", "-q"]);
  await writeFile(resolve(root, ".gitignore"), ".npmrc\n");
  for (const path of CAPTURE_LOCAL_OVERRIDE_FILES) {
    await writeFile(resolve(root, path), "VITE_MOCK=1\n");
    if (path === ".npmrc") {
      assert.equal(await git(root, ["check-ignore", path]), path);
      assert.equal(await computeCaptureSourceDigest(root), cleanDigest);
    }
    await assert.rejects(() => assertNoLocalCaptureOverrides(root), /refuses local Vite or npm configuration/);
    await rm(resolve(root, path));
  }
});

test("capture npm install has one canonical config-free invocation", () => {
  assert.deepEqual(CAPTURE_NPM_ENVIRONMENT, {
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_GLOBALCONFIG: "/tmp/zuuli-empty-global-npmrc",
    NPM_CONFIG_IGNORE_SCRIPTS: "true",
    NPM_CONFIG_USERCONFIG: "/tmp/zuuli-empty-user-npmrc",
  });
  assert.deepEqual(CAPTURE_NPM_CI_ARGUMENTS, ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--userconfig=/tmp/zuuli-empty-user-npmrc", "--globalconfig=/tmp/zuuli-empty-global-npmrc"]);
});

test("capture input digest brackets reject source or contract drift", async (t) => {
  const root = await fixture();
  t.after(() => rm(dirname(root), { recursive: true, force: true }));
  const expected = {
    sourceDigest: (await validateCaptureConfig({ root, screenshotSets })).sourceDigest,
    contractDigest: await computeCaptureContractDigest(root),
  };
  await assertCaptureInputsStable(expected, root);
  await writeFile(resolve(root, "index.html"), `${await readFile(resolve(root, "index.html"), "utf8")}\n`);
  await assert.rejects(() => assertCaptureInputsStable(expected, root), /capture inputs changed/);
});

test("recapture revokes prior copy and classification approval", async () => {
  const manifest = JSON.parse(await readFile(resolve(projectRoot, "store/manifest.json"), "utf8"));
  manifest.phase = "ready";
  manifest.publicationReady = true;
  for (const locale of manifest.locales) locale.copyStatus = "approved";
  manifest.classification.reviewStatus = "approved";
  manifest.capturePolicy.status = "approved";
  manifest.capturePolicy.blockedByIssues = [];
  markCaptureOwnerReviewRequired(manifest, {
    sourceSha: "a".repeat(40),
    sourceDigest: "b".repeat(64),
    contractDigest: "c".repeat(64),
    entries: [],
  });
  assert.equal(manifest.phase, "captured");
  assert.equal(manifest.publicationReady, false);
  assert.equal(manifest.locales.every(({ copyStatus }) => copyStatus === "proposed-owner-legal-review-required"), true);
  assert.equal(manifest.classification.reviewStatus, "proposed-owner-store-review-required");
  assert.deepEqual(manifest.capturePolicy.blockedByIssues, [371, 373]);
});

test("capture artifact commit rolls every output back when a replacement fails", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "zuuli-capture-commit-"));
  const stagedRoot = await mkdtemp(resolve(root, ".staged-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = ["store/media/shot.png", "store/capture-record.json", "store/manifest.json"];
  for (const path of paths) {
    await mkdir(dirname(resolve(root, path)), { recursive: true });
    await writeFile(resolve(root, path), `old:${path}`);
    await mkdir(dirname(resolve(stagedRoot, path)), { recursive: true });
    await writeFile(resolve(stagedRoot, path), `new:${path}`);
  }
  await assert.rejects(
    () => commitCaptureArtifactSet({
      root,
      stagedRoot,
      afterStep: async (step) => {
        if (step === "installed:store/media") throw new Error("injected replacement failure");
      },
    }),
    /injected replacement failure/,
  );
  for (const path of paths) assert.equal(await readFile(resolve(root, path), "utf8"), `old:${path}`);
});

test("capture artifact commit preserves a concurrent manifest edit", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "zuuli-capture-manifest-race-"));
  const stagedRoot = await mkdtemp(resolve(root, ".staged-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const oldManifest = "old:store/manifest.json";
  const expectedManifestDigest = createHash("sha256").update(oldManifest).digest("hex");
  for (const path of ["store/media/shot.png", "store/capture-record.json", "store/manifest.json"]) {
    await mkdir(dirname(resolve(root, path)), { recursive: true });
    await writeFile(resolve(root, path), `old:${path}`);
    await mkdir(dirname(resolve(stagedRoot, path)), { recursive: true });
    await writeFile(resolve(stagedRoot, path), `new:${path}`);
  }
  const concurrentManifest = "concurrent owner edit";
  await writeFile(resolve(root, "store/manifest.json"), concurrentManifest);
  await assert.rejects(
    () => commitCaptureArtifactSet({ root, stagedRoot, expectedManifestDigest }),
    /store manifest changed/,
  );
  assert.equal(await readFile(resolve(root, "store/media/shot.png"), "utf8"), "old:store/media/shot.png");
  assert.equal(await readFile(resolve(root, "store/capture-record.json"), "utf8"), "old:store/capture-record.json");
  assert.equal(await readFile(resolve(root, "store/manifest.json"), "utf8"), concurrentManifest);
});

test("source comparison includes untracked render inputs", async (t) => {
  const root = await fixture();
  t.after(() => removeGitFixture(root));
  await git(dirname(root), ["init", "-q"]);
  await git(root, ["config", "user.name", "Capture Contract"]);
  await git(root, ["config", "user.email", "capture-contract@example.invalid"]);
  await git(dirname(root), ["add", "."]);
  await git(root, ["commit", "-qm", "capture source"]);
  const sourceSha = await git(root, ["rev-parse", "HEAD"]);
  await assertReleaseSource({ sourceSha }, root);
  await writeFile(resolve(root, "src/untracked-render-input.ts"), "export {};\n");
  await assert.rejects(() => assertReleaseSource({ sourceSha }, root), /rendered product source differs.*untracked-render-input/);
});

test("publication provenance rejects an unavailable source commit", async () => {
  await rejectsCode(() => assertCaptureSourceCommit("f".repeat(40), projectRoot), "INVALID_CAPTURE_SOURCE");
});

test("dependency-free preflight requires the exact host digests", async () => {
  const env = {
    ZUULI_STORE_EXPECTED_SOURCE_DIGEST: await computeCaptureSourceDigest(projectRoot),
    ZUULI_STORE_EXPECTED_CONTRACT_DIGEST: await computeCaptureContractDigest(projectRoot),
  };
  await preflight(env);
  await assert.rejects(() => preflight({ ...env, ZUULI_STORE_EXPECTED_SOURCE_DIGEST: "0".repeat(64) }), /capture preflight failed/);
});

// Exercise the trust-data guard alongside the capture contract.
import "./capture-tls.node-test.mjs";

test("vault shots correspond to the production route mounts and never the retired surfaces", async () => {
  const app = await readFile(resolve(projectRoot, "src/App.tsx"), "utf8");
  const routes = await readFile(resolve(projectRoot, "src/lib/routes.ts"), "utf8");
  const wallet = await readFile(resolve(projectRoot, "src/features/wallet/index.tsx"), "utf8");
  assert(app.includes("<HomeFeature />") && app.includes("<AboutFeature />") && app.includes("<WalletFeature />"));
  assert(routes.includes('"/about"') && routes.includes('"/wallet/*"'));
  assert(wallet.includes('<Route path="send" element={<Send />} />') && wallet.includes('<Route path="history" element={<History />} />'));
  assert.deepEqual([...CAPTURE_SHOTS.values()].map((v) => v.route), ["/", "/wallet/send", "/wallet/history", "/about"]);
  const root = await fixture();
  try {
    const config = await json(root, CAPTURE_CONFIG_PATH);
    for (const route of ["/articles", "/wallet/receive", "/creator/example_editorial"]) {
      config.shots[0].route = route;
      await writeJson(root, CAPTURE_CONFIG_PATH, config);
      await rejectsCode(() => validateCaptureConfig({ root, screenshotSets }), "INVALID_CAPTURE_CONTRACT");
    }
  } finally { await rm(dirname(root), { recursive: true, force: true }); }
});

test("capture pins the combined image and wallet-root mount without shipping a fixture", async (t) => {
  const root = await fixture();
  t.after(() => rm(dirname(root), { recursive: true, force: true }));
  const config = await json(root, CAPTURE_CONFIG_PATH);
  assert.equal(config.browser.containerImage, CAPTURE_IMAGE);
  config.browser.containerImage = "mcr.microsoft.com/playwright:latest";
  await writeJson(root, CAPTURE_CONFIG_PATH, config);
  await rejectsCode(() => validateCaptureConfig({ root, screenshotSets }), "INVALID_CAPTURE_CONTRACT");
  const runner = await readFile(resolve(projectRoot, "scripts/store-screenshot-capture.mjs"), "utf8");
  assert(runner.includes('`${resolve(projectRoot, "..")}:/work`'));
  assert(runner.includes('"--workdir", "/work/zuuli"'));
  assert(runner.includes('/usr/local/bin/verify-zuuli-store-capture-image'));
  const { captureInputFiles } = await import("./store-screenshot-contract.mjs");
  for (const path of await captureInputFiles(projectRoot, ["src"])) {
    assert(!/store-vault-fixture|__STORE_VAULT_AUDIT__/.test(await readFile(resolve(projectRoot, path), "utf8")), path);
  }
});

test("native fixture permits exact empty reads and refuses all other bridge authority", async () => {
  const fixture = await json(projectRoot, CAPTURE_FIXTURE_PATH);
  const window = {};
  runInNewContext(`(${installVaultNativeFixture.toString()})({fixture, action: "wallet-send"})`, { window, fixture, structuredClone });
  const invoke = window.__TAURI_INTERNALS__.invoke;
  assert.deepEqual(await invoke("plugin:zcash|get_wallet_status"), fixture.status);
  assert.equal(await invoke("plugin:zcash|get_pending_send"), null);
  await assert.rejects(() => invoke("plugin:zcash|start_sync"), /unavailable/);
  const bridge = await readFile(resolve(projectRoot, "src/lib/wallet/bridge.ts"), "utf8");
  const allowed = ["get_wallet_status", "list_wallets", "get_sync_status", "get_pending_send", "get_account_balance", "get_unified_address", "start_sync"];
  const commands = [...bridge.matchAll(/invoke\("([a-z_]+)"/g)].map((v) => v[1]);
  assert(commands.includes("get_seed_phrase") && commands.includes("execute_send"));
  for (const cmd of commands.filter((cmd) => !allowed.includes(cmd))) {
    await assert.rejects(() => invoke(`plugin:zcash|${cmd}`), /refused/);
  }
  for (const [cmd, args] of [
    ["free2z_session_sync", { args: { token: "identity" } }],
    ["plugin:zcash|get_account_balance", { args: { accountIndex: 1 } }],
    ["plugin:zcash|get_wallet_status", { args: { seed: true } }],
    ["plugin:zcash|get_unified_address", { args: { accountIndex: 0, extra: true } }],
    ["plugin:http|fetch", {}],
  ]) await assert.rejects(() => invoke(cmd, args), /refused/);
  assert(window.__STORE_VAULT_AUDIT__.refused.length > 20);
});

test("vault network allowlist refuses account, external, write and websocket traffic", async () => {
  const { vaultStaticRequestAllowed } = await import("./store-screenshot-capture.mjs");
  const origin = "http://127.0.0.1:12345";
  assert(vaultStaticRequestAllowed(origin, `${origin}/wallet/send`, "GET", "/wallet/send"));
  assert(vaultStaticRequestAllowed(origin, `${origin}/assets/app-123.js`, "GET", "/wallet/send", new Set(["/assets/app-123.js"])));
  for (const [path, method] of [["/api/auth/user/", "GET"], ["/assets/app.js?token=private", "GET"], ["/wallet/send", "POST"], ["/wallet/receive", "GET"], ["/assets/unregistered.js", "GET"]]) {
    assert(!vaultStaticRequestAllowed(origin, origin + path, method, "/wallet/send"));
  }
  assert(!vaultStaticRequestAllowed(origin, "https://free2z.cash/api/zpage/", "GET", "/"));
});

test("disclosure scan rejects private identities and permits only About's public support contact", async () => {
  const { vaultDisclosureScanPassed } = await import("./store-screenshot-capture.mjs");
  assert(vaultDisclosureScanPassed("No transactions yet", "wallet-history"));
  assert(vaultDisclosureScanPassed("Opens a draft to help@free2z.com.", "about"));
  for (const text of ["mock mode", "debug", "seed phrase", "private key", "tester@example.com", "help@free2z.com.attacker.example", "xhelp@free2z.com", "u1" + "a".repeat(100)]) {
    assert(!vaultDisclosureScanPassed(text, "about"), text);
  }
  assert(!vaultDisclosureScanPassed("help@free2z.com", "wallet-send"));
});

test("capture framing preserves app chrome by scrolling only the production viewport", async () => {
  const runner = await readFile(resolve(projectRoot, "scripts/store-screenshot-capture.mjs"), "utf8");
  assert(!runner.includes("await focus.scrollIntoViewIfNeeded()"));
  assert(runner.includes("viewport.scrollTop +="));
  assert(runner.includes("topBar.top >= -1"));
});


test("full CI history restores a historical capture source without changing checked-out renderer", async (t) => {
  const source = await fixture();
  const checkout = await mkdtemp(resolve(tmpdir(), "zuuli-capture-history-"));
  t.after(() => removeGitFixture(source));
  t.after(() => removeGitFixture(checkout));
  await git(dirname(source), ["init", "-q"]);
  await git(source, ["config", "user.name", "Capture Contract"]);
  await git(source, ["config", "user.email", "capture-contract@example.invalid"]);
  await git(dirname(source), ["add", "."]);
  await git(source, ["commit", "-qm", "reviewed renderer"]);
  const sourceSha = await git(source, ["rev-parse", "HEAD"]);
  await writeFile(resolve(dirname(source), "history-only.txt"), "Later commit, unchanged renderer.\n");
  await git(dirname(source), ["add", "history-only.txt"]);
  await git(source, ["commit", "-qm", "later source history"]);
  const currentHead = await git(source, ["rev-parse", "HEAD"]);
  const sourceUrl = pathToFileURL(dirname(source)).href;
  await git(checkout, ["init", "-q"]);
  await git(checkout, ["fetch", "--depth=1", sourceUrl, "HEAD"]);
  await git(checkout, ["checkout", "--detach", "FETCH_HEAD"]);
  assert.equal(await git(checkout, ["rev-parse", "--is-shallow-repository"]), "true");
  await rejectsCode(() => assertCaptureSourceCommit(sourceSha, resolve(checkout, "zuuli")), "INVALID_CAPTURE_SOURCE");
  await git(checkout, ["fetch", "--unshallow", sourceUrl, "HEAD"]);
  assert.equal(await git(checkout, ["rev-parse", "--is-shallow-repository"]), "false");
  assert.equal(await git(checkout, ["rev-parse", "HEAD"]), currentHead);
  await assertCaptureSourceCommit(sourceSha, resolve(checkout, "zuuli"));
});
