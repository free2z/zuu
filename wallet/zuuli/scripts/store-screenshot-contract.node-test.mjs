import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CAPTURE_CONFIG_PATH,
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
  const root = await mkdtemp(resolve(tmpdir(), "zuuli-screenshot-contract-"));
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
function removeGitFixture(root) {
  return rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

async function git(root, args) {
  const output = [];
  await new Promise((accept, reject) => {
    const child = spawn("git", args, { cwd: root, env: { ...process.env, ...GIT_FIXTURE_ENV } });
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? accept() : reject(new Error(`git ${args[0]} failed`)));
  });
  return Buffer.concat(output).toString("utf8").trim();
}

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
  t.after(() => rm(root, { recursive: true, force: true }));
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
  t.after(() => rm(root, { recursive: true, force: true }));
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

test("creator capture pins the authoritative first catalog page and rejects pagination drift", () => {
  const creatorDetail = "GET https://free2z.cash/api/creator/example_editorial/";
  const firstPage = "GET https://free2z.cash/api/zpage/?ordering=-created_at&page=1&page_size=12&username=example_editorial";
  assert.deepEqual(CAPTURE_PUBLIC_REQUESTS["creator-profile"], [creatorDetail, firstPage]);
  assert.equal(capturePublicRequestAllowed("creator-profile", firstPage), true);
  for (const drifted of [
    "GET https://free2z.cash/api/zpage/?ordering=-created_at&page_size=12&username=example_editorial",
    "GET https://free2z.cash/api/zpage/?ordering=-created_at&page=2&page_size=12&username=example_editorial",
    "GET https://free2z.cash/api/zpage/?ordering=-created_at&page=1&page_size=24&username=example_editorial",
  ]) {
    assert.equal(capturePublicRequestAllowed("creator-profile", drifted), false);
  }
});

test("capture records reject stale source pixels and incomplete or duplicate entries", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(resolve(root, "index.html"), `${await readFile(resolve(root, "index.html"), "utf8")}\n`);
  await rejectsCode(() => validateCaptureRecord({ root, screenshotSets, enforceCurrentSource: true }), "STALE_CAPTURE");

  const cleanRoot = await fixture();
  t.after(() => rm(cleanRoot, { recursive: true, force: true }));
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
  t.after(() => rm(root, { recursive: true, force: true }));
  const captureScript = resolve(root, "scripts/store-screenshot-capture.mjs");
  await writeFile(captureScript, `${await readFile(captureScript, "utf8")}\n`);
  await rejectsCode(() => validateCaptureRecord({ root, screenshotSets }), "STALE_CAPTURE");
});

test("record metadata cannot waive disclosure checks or alter routes", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const record = await json(root, CAPTURE_RECORD_PATH);
  record.entries[0].disclosureScan = "skipped";
  await writeJson(root, CAPTURE_RECORD_PATH, record);
  await rejectsCode(() => validateCaptureRecord({ root, screenshotSets }), "INVALID_CAPTURE_RECORD");

  record.entries[0].disclosureScan = "passed";
  record.entries[0].route = "/wallet";
  await writeJson(root, CAPTURE_RECORD_PATH, record);
  await rejectsCode(() => validateCaptureRecord({ root, screenshotSets }), "INVALID_CAPTURE_RECORD");
});

test("fictional fixtures reject debug disclosures and private identities", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixturePath = "store/fixtures/en-US/articles.json";
  const value = await json(root, fixturePath);
  value.articles[0].title = "Debug capture";
  await writeJson(root, fixturePath, value);
  await rejectsCode(() => validateCaptureConfig({ root, screenshotSets }), "FORBIDDEN_CAPTURE_DISCLOSURE");

  value.articles[0].title = "Why Shielded Defaults Matter";
  value.articles[0].description = "Contact private-person@example.invalid";
  await writeJson(root, fixturePath, value);
  await rejectsCode(() => validateCaptureConfig({ root, screenshotSets }), "PRIVATE_CAPTURE_DATA");
});

test("capture inputs cannot be symlinks", async (t) => {
  const root = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
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
  t.after(() => rm(root, { recursive: true, force: true }));
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
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.name", "Capture Contract"]);
  await git(root, ["config", "user.email", "capture-contract@example.invalid"]);
  await git(root, ["add", "."]);
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
