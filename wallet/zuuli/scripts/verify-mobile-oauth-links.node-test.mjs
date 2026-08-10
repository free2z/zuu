import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
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
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const contractPath = resolve(fixture, "mobile-oauth-links.json");
  const contract = JSON.parse(readFileSync(contractPath, "utf8"));
  contract.rollout = "claimed";
  contract.activeRedirectUri = contract.claimedRedirectUri;
  contract.android.playAppSigningSha256CertFingerprints = [fingerprint];
  const publicKeyPem = publicKey.export({
    type: "spki",
    format: "pem",
  });
  contract.deviceEvidenceEd25519PublicKeyPem =
    values.PRIVATE_KEY_AS_PUBLIC === "true"
      ? privateKey.export({ type: "pkcs8", format: "pem" })
      : values.TRAILING_PUBLIC_KEY === "true"
        ? `${publicKeyPem}${publicKeyPem}`
        : publicKeyPem;
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
  writeFileSync(
    preloadPath,
    `
const backendCommit = process.env.MOCK_BACKEND_COMMIT || "${"b".repeat(40)}";
const documents = (url) => url.includes("apple-app-site-association") || url.includes("app-site-association.cdn-apple.com")
  ? { applinks: { details: [{ components: [{ "/": "/oauth/callback" }], appIDs: ["F9AV5HKF6N.cash.free2z.zuuli"] }] } }
  : [{ target: { sha256_cert_fingerprints: [${JSON.stringify(fingerprint)}], package_name: "cash.free2z.zuuli", namespace: "android_app" }, relation: ["delegate_permission/common.handle_all_urls"], relation_extensions: { "delegate_permission/common.handle_all_urls": { dynamic_app_link_components: [{ "/": "/oauth/callback" }] } } }];
globalThis.fetch = async (input) => {
  const url = input.toString();
  let status = Number(process.env.MOCK_STATUS);
  let body = documents(url);
  const headers = new Map([["content-type", process.env.MOCK_CONTENT_TYPE]]);
  if (url.includes("app-site-association.cdn-apple.com") && process.env.MOCK_STALE_APPLE_CDN === "true") {
    body = { applinks: { details: [] } };
  } else if (url.includes("free2z.com/oauth/callback")) {
    headers.set("content-type", "text/plain; charset=utf-8");
    headers.set("cache-control", "no-store");
    headers.set("pragma", "no-cache");
    headers.set("referrer-policy", "no-referrer");
    headers.set("x-content-type-options", "nosniff");
    headers.set("x-zuuli-oauth-build-sha", backendCommit);
    body = process.env.MOCK_UNSAFE_FALLBACK === "true"
      ? "zuuli-public-gate-code-must-not-appear"
      : "Sign-in could not return to ZUULI. Reopen the app and try again.";
  } else if (url.includes("/api/zuuli/capabilities/")) {
    body = { capabilities: { auth: { social: true } } };
    headers.set("cache-control", "no-store");
    headers.set("x-zuuli-oauth-build-sha", backendCommit);
  } else if (url.includes("/api/auth/social/providers/")) {
    body = { providers: [
      { provider: "x", configured: process.env.MOCK_X_DISABLED !== "true" },
      { provider: "google", configured: true },
      { provider: "github", configured: false },
    ] };
    headers.set("cache-control", "no-store");
    headers.set("x-zuuli-oauth-build-sha", backendCommit);
  } else if (
    url.includes("/api/auth/social/x/mobile-start") ||
    url.includes("/api/auth/social/google/mobile-start")
  ) {
    const provider = url.includes("/x/") ? "x" : "google";
    status = process.env.MOCK_START_STATUS
      ? Number(process.env.MOCK_START_STATUS)
      : provider === "x" && process.env.MOCK_X_START_STATUS
        ? Number(process.env.MOCK_X_START_STATUS)
        : 200;
    const start = new URL(url);
    const challenge = start.searchParams.get("code_challenge");
    const authorizationState = "a".repeat(32);
    const completionState = "c".repeat(32);
    const providerRedirectUri = "https://free2z.cash/api/auth/social/mobile/callback";
    const authorizeUrl = new URL(
      provider === "x"
        ? "https://twitter.com/i/oauth2/authorize"
        : "https://accounts.google.com/o/oauth2/v2/auth",
    );
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("state", authorizationState);
    authorizeUrl.searchParams.set("redirect_uri", providerRedirectUri);
    authorizeUrl.searchParams.set("code_challenge", challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    body = {
      authorize_url: authorizeUrl.toString(),
      state: completionState,
      authorization_state: authorizationState,
      provider_redirect_uri: providerRedirectUri,
    };
    headers.set("cache-control", "no-store");
    headers.set("x-zuuli-oauth-build-sha", backendCommit);
  }
  const encoded = new TextEncoder().encode(
    url.includes("free2z.com/oauth/callback")
      ? body
      : process.env.MOCK_DUPLICATE === "true" && url.includes("apple-app-site-association")
      ? '{"applinks":{"details":[],"details":[{"components":[{"/":"/oauth/callback"}],"appIDs":["F9AV5HKF6N.cash.free2z.zuuli"]}]}}'
      : JSON.stringify(body),
  );
  return {
    status, url,
    headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
    arrayBuffer: async () => encoded.buffer,
  };
};
`,
  );
  execFileSync("git", ["init", "-q"], { cwd: fixture });
  execFileSync("git", ["add", "."], { cwd: fixture });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=ZUULI Test",
      "-c",
      "user.email=zuuli-test@example.invalid",
      "commit",
      "-qm",
      "fixture",
    ],
    { cwd: fixture },
  );
  const appCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: fixture,
    encoding: "utf8",
  }).trim();
  const backendCommit = "b".repeat(40);
  const artifacts = {};
  for (const scenario of [
    "ios-cold",
    "ios-warm",
    "android-cold",
    "android-warm",
    "handoff",
  ]) {
    const artifact =
      values.OVERSIZED_ARTIFACT === "true" && scenario === "ios-cold"
        ? `${scenario}\n${appCommit}\n${backendCommit}\n${contract.claimedRedirectUri}\n${"x".repeat(4096)}`
        : `${scenario}\n${appCommit}\n${backendCommit}\n${contract.claimedRedirectUri}\n`;
    artifacts[scenario] = {
      contentBase64: Buffer.from(artifact, "utf8").toString("base64"),
      sha256: createHash("sha256").update(artifact).digest("hex"),
    };
  }
  const statement = {
    schemaVersion: 1,
    appCommit,
    backendCommit,
    claimedRedirectUri: contract.claimedRedirectUri,
    apple: { applicationId: contract.apple.applicationId },
    android: {
      packageName: contract.android.packageName,
      signingCertSha256: fingerprint,
    },
    artifacts,
  };
  const canonical = (value) =>
    Array.isArray(value)
      ? value.map(canonical)
      : value !== null && typeof value === "object"
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, canonical(value[key])]),
          )
        : value;
  let signature = sign(
    null,
    Buffer.from(JSON.stringify(canonical(statement)), "utf8"),
    privateKey,
  ).toString("base64");
  if (values.TAMPER_SIGNATURE === "true")
    signature = `${signature.slice(0, -4)}AAAA`;
  const evidencePath = resolve(fixture, "device-evidence.json");
  writeFileSync(evidencePath, JSON.stringify({ statement, signature }));
  if (values.TAMPER_ARTIFACT === "true") {
    statement.artifacts["ios-cold"].contentBase64 = Buffer.from(
      "changed after signing\n",
      "utf8",
    ).toString("base64");
    writeFileSync(evidencePath, JSON.stringify({ statement, signature }));
  }
  return { fixture, evidencePath, preloadPath, appCommit };
}

function runClaimedFixture(values = {}) {
  const { fixture, evidencePath, preloadPath, appCommit } =
    claimedFixture(values);
  if (values.DIRTY_TRACKED === "true") {
    const contractPath = resolve(fixture, "mobile-oauth-links.json");
    writeFileSync(contractPath, `${readFileSync(contractPath, "utf8")}\n`);
  }
  return spawnSync(
    process.execPath,
    [
      "--import",
      preloadPath,
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
        ...Object.fromEntries(
          Object.entries(values).filter(
            ([key]) =>
              ![
                "SOURCE_SHA",
                "DIRTY_TRACKED",
                "TAMPER_SIGNATURE",
                "TAMPER_ARTIFACT",
                "OVERSIZED_ARTIFACT",
                "PRIVATE_KEY_AS_PUBLIC",
                "TRAILING_PUBLIC_KEY",
              ].includes(key),
          ),
        ),
      },
    },
  );
}

test("repository link contract is internally consistent", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/verify-mobile-oauth-links.mjs"],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
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

test("public gate rejects tracked edits not present in the claimed source commit", () => {
  const result = runClaimedFixture({ DIRTY_TRACKED: "true" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /clean tracked source tree and index/);
});

test("public gate rejects editable unsigned device evidence", () => {
  const result = runClaimedFixture({ TAMPER_SIGNATURE: "true" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /signature is absent or invalid/);
});

test("public gate accepts only canonical SPKI public-key material", () => {
  const privateKey = runClaimedFixture({ PRIVATE_KEY_AS_PUBLIC: "true" });
  assert.notEqual(privateKey.status, 0);
  assert.match(
    privateKey.stderr,
    /reviewed Ed25519 device-evidence public key/,
  );

  const trailingKey = runClaimedFixture({ TRAILING_PUBLIC_KEY: "true" });
  assert.notEqual(trailingKey.status, 0);
  assert.match(
    trailingKey.stderr,
    /reviewed Ed25519 device-evidence public key/,
  );
});

test("public gate rejects changed raw device evidence", () => {
  const result = runClaimedFixture({ TAMPER_ARTIFACT: "true" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /artifact is invalid, changed, oversized/);
});

test("public gate keeps the protected evidence envelope below the secret limit", () => {
  const result = runClaimedFixture({ OVERSIZED_ARTIFACT: "true" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /artifact is invalid, changed, oversized/);
});

test("public gate requires Apple's served association and the inert browser fallback", () => {
  const staleCdn = runClaimedFixture({ MOCK_STALE_APPLE_CDN: "true" });
  assert.notEqual(staleCdn.status, 0);
  assert.match(staleCdn.stderr, /broader than the reviewed exact association/);

  const unsafeFallback = runClaimedFixture({ MOCK_UNSAFE_FALLBACK: "true" });
  assert.notEqual(unsafeFallback.status, 0);
  assert.match(
    unsafeFallback.stderr,
    /reflects OAuth material or is not inert/,
  );
});

test("public gate binds evidence to the exact live callback build", () => {
  const result = runClaimedFixture({ MOCK_BACKEND_COMMIT: "c".repeat(40) });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not the live callback-tier build/);
  assert.match(result.stderr, /not served by the attested callback-tier build/);
});

test("public gate requires the isolated mobile-start route", () => {
  const result = runClaimedFixture({ MOCK_START_STATUS: "404" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /isolated .* mobile-start contract is not ready/);
});

test("public gate probes every enabled PKCE-capable mobile provider", () => {
  const brokenX = runClaimedFixture({ MOCK_X_START_STATUS: "404" });
  assert.notEqual(brokenX.status, 0);
  assert.match(brokenX.stderr, /isolated x mobile-start contract is not ready/);

  const disabledX = runClaimedFixture({
    MOCK_X_START_STATUS: "404",
    MOCK_X_DISABLED: "true",
  });
  assert.equal(disabledX.status, 0, disabledX.stderr);
});

test("public gate rejects a pre-validation mobile-start error", () => {
  const result = runClaimedFixture({ MOCK_START_STATUS: "400" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /isolated .* mobile-start contract is not ready/);
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

test("public gate rejects duplicate association keys before JSON comparison", () => {
  const result = runClaimedFixture({ MOCK_DUPLICATE: "true" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid or ambiguous JSON/);
});
