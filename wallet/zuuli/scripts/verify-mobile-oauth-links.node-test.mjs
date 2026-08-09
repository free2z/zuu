import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixturePaths = [
  "mobile-oauth-links.json",
  "scripts/verify-mobile-oauth-links.mjs",
  "src-tauri/tauri.conf.json",
  "src-tauri/gen/android/app/src/main/AndroidManifest.xml",
  "src-tauri/gen/apple/zuuli_iOS/zuuli_iOS.entitlements",
  "src-tauri/src/oauth.rs",
  "src/lib/oauth/protocol.ts",
];
const fingerprint = Array(32).fill("AA").join(":");

function copyFixture() {
  const fixture = mkdtempSync(join(tmpdir(), "zuuli-oauth-links-"));
  for (const path of fixturePaths) {
    const destination = resolve(fixture, path);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(resolve(root, path), destination);
  }
  return fixture;
}

function claimedFixture(values = {}) {
  const fixture = copyFixture();
  const contractPath = resolve(fixture, "mobile-oauth-links.json");
  const contract = JSON.parse(readFileSync(contractPath, "utf8"));
  contract.rollout = "claimed";
  contract.activeRedirectUri = contract.claimedRedirectUri;
  contract.android.playAppSigningSha256CertFingerprints = [fingerprint];
  writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
  for (const path of ["src-tauri/src/oauth.rs", "src/lib/oauth/protocol.ts"]) {
    const sourcePath = resolve(fixture, path);
    const source = readFileSync(sourcePath, "utf8").replace(
      "= PRIVATE_MOBILE_REDIRECT_URI;",
      "= CLAIMED_MOBILE_REDIRECT_URI;",
    );
    writeFileSync(sourcePath, source);
  }
  const preloadPath = resolve(fixture, "mock-fetch.mjs");
  writeFileSync(preloadPath, `
globalThis.fetch = async (url) => ({
  status: Number(process.env.MOCK_STATUS),
  url,
  headers: { get: () => process.env.MOCK_CONTENT_TYPE },
  json: async () => url.includes("apple-app-site-association")
    ? { applinks: { details: [{ components: [{ "/": "/oauth/callback" }], appIDs: ["F9AV5HKF6N.cash.free2z.zuuli"] }] } }
    : [{ target: { sha256_cert_fingerprints: [${JSON.stringify(fingerprint)}], package_name: "cash.free2z.zuuli", namespace: "android_app" }, relation: ["delegate_permission/common.handle_all_urls"] }],
});
`);
  execFileSync("git", ["init", "-q"], { cwd: fixture });
  execFileSync("git", ["add", "."], { cwd: fixture });
  execFileSync(
    "git",
    ["-c", "user.name=ZUULI Test", "-c", "user.email=zuuli-test@example.invalid", "commit", "-qm", "fixture"],
    { cwd: fixture },
  );
  const appCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: fixture, encoding: "utf8",
  }).trim();
  const evidencePath = resolve(fixture, "device-evidence.json");
  writeFileSync(evidencePath, JSON.stringify({
    appCommit,
    backendCommit: "b".repeat(40),
    claimedRedirectUri: contract.claimedRedirectUri,
    userInitiatedHandoff: values.USER_INITIATED_HANDOFF !== "false",
    apple: { applicationId: contract.apple.applicationId, cold: true, warm: true },
    android: { signingCertSha256: fingerprint, cold: true, warm: true },
  }));
  return { fixture, evidencePath, preloadPath, appCommit };
}

function runClaimedFixture(values = {}) {
  const { fixture, evidencePath, preloadPath, appCommit } = claimedFixture(values);
  return spawnSync(
    process.execPath,
    [
      "--import", preloadPath,
      "scripts/verify-mobile-oauth-links.mjs",
      "--public-release",
      `--source-sha=${values.SOURCE_SHA ?? appCommit}`,
    ],
    {
      cwd: fixture,
      encoding: "utf8",
      env: {
        ...process.env,
        ZUULI_OAUTH_DEVICE_EVIDENCE: evidencePath,
        MOCK_STATUS: "200",
        MOCK_CONTENT_TYPE: "application/json; charset=utf-8",
        ...Object.fromEntries(Object.entries(values).filter(
          ([key]) => !["SOURCE_SHA", "USER_INITIATED_HANDOFF"].includes(key),
        )),
      },
    },
  );
}

test("repository link contract is internally consistent", () => {
  const result = spawnSync(process.execPath, ["scripts/verify-mobile-oauth-links.mjs"], {
    cwd: root, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /private-transition/);
});

test("public release fails closed while external proof is absent", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/verify-mobile-oauth-links.mjs", "--public-release"],
    { cwd: root, encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /rollout=claimed/);
  assert.match(result.stderr, /Play App Signing/);
  assert.match(result.stderr, /ZUULI_OAUTH_DEVICE_EVIDENCE/);
});

test("claimed rollout cannot retain the private runtime callback", () => {
  const fixture = copyFixture();
  const contractPath = resolve(fixture, "mobile-oauth-links.json");
  const contract = JSON.parse(readFileSync(contractPath, "utf8"));
  contract.rollout = "claimed";
  writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`);

  const result = spawnSync(
    process.execPath,
    ["scripts/verify-mobile-oauth-links.mjs"],
    { cwd: fixture, encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /active redirect/);
  assert.match(result.stderr, /Rust active callback/);
  assert.match(result.stderr, /TypeScript active callback/);
});

test("public gate accepts reordered exact JSON with a parameterized JSON media type", () => {
  const result = runClaimedFixture();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /repo-consistent \(claimed\)/);
});

test("public gate rejects device evidence from a different app commit", () => {
  const result = runClaimedFixture({ SOURCE_SHA: "c".repeat(40) });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match the checked-out app commit/);
  assert.match(result.stderr, /app commit does not match --source-sha/);
});

test("public gate requires proof of the user-initiated claimed-link handoff", () => {
  const result = runClaimedFixture({ USER_INITIATED_HANDOFF: "false" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /user-initiated claimed-link handoff/);
});

test("public gate requires exact HTTP 200 and JSON media type", () => {
  const wrongStatus = runClaimedFixture({ MOCK_STATUS: "201" });
  assert.notEqual(wrongStatus.status, 0);
  assert.match(wrongStatus.stderr, /direct HTTP 200/);

  const wrongMediaType = runClaimedFixture({
    MOCK_CONTENT_TYPE: "application/jsonp",
  });
  assert.notEqual(wrongMediaType.status, 0);
  assert.match(wrongMediaType.stderr, /must use application\/json/);
});
