#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const config = JSON.parse(read("mobile-oauth-links.json"));
const tauri = JSON.parse(read("src-tauri/tauri.conf.json"));
const manifest = read("src-tauri/gen/android/app/src/main/AndroidManifest.xml");
const entitlements = read("src-tauri/gen/apple/zuuli_iOS/zuuli_iOS.entitlements");
const rust = read("src-tauri/src/oauth.rs");
const protocol = read("src/lib/oauth/protocol.ts");
const failures = [];
const publicRelease = process.argv.includes("--public-release");
const sourceShaArgument = process.argv.find((value) => value.startsWith("--source-sha="));
const sourceSha = sourceShaArgument?.slice("--source-sha=".length);
const androidGeneratedMarker = "<!-- DEEP LINK PLUGIN. AUTO-GENERATED. DO NOT REMOVE. -->";
const androidGeneratedParts = manifest.split(androidGeneratedMarker);
const androidGenerated = androidGeneratedParts.length === 3 ? androidGeneratedParts[1] : "";
if (androidGeneratedParts.length !== 3) {
  failures.push("Android deep-link generated block must have exactly two boundary markers");
}

const exact = {
  schemaVersion: 1,
  privateRedirectUri: "cash.free2z.zuuli://oauth/callback",
  claimedRedirectUri: "https://free2z.com/oauth/callback",
  applicationId: "F9AV5HKF6N.cash.free2z.zuuli",
  associatedDomain: "applinks:free2z.com",
  packageName: "cash.free2z.zuuli",
};
function expect(label, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function count(text, needle) {
  return text.split(needle).length - 1;
}
function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]),
    );
  }
  return value;
}

function parseUnambiguousJson(bytes, label) {
  if (bytes.byteLength > 65_536) throw new Error(`${label} JSON is unexpectedly large`);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let offset = 0;
  const whitespace = () => {
    while (/[\t\n\r ]/.test(text[offset] ?? "")) offset += 1;
  };
  const consume = (expected) => {
    whitespace();
    if (text[offset] !== expected) throw new Error(`${label} is invalid JSON`);
    offset += 1;
  };
  const string = () => {
    whitespace();
    if (text[offset] !== '"') throw new Error(`${label} is invalid JSON`);
    const start = offset;
    offset += 1;
    while (offset < text.length) {
      if (text[offset] === "\\") {
        offset += 2;
        continue;
      }
      if (text[offset] === '"') {
        offset += 1;
        return JSON.parse(text.slice(start, offset));
      }
      offset += 1;
    }
    throw new Error(`${label} is invalid JSON`);
  };
  const value = () => {
    whitespace();
    if (text[offset] === "{") return object();
    if (text[offset] === "[") return array();
    if (text[offset] === '"') return string();
    const remainder = text.slice(offset);
    const token = remainder.match(
      /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/,
    )?.[0];
    if (!token) throw new Error(`${label} is invalid JSON`);
    offset += token.length;
    return JSON.parse(token);
  };
  const array = () => {
    consume("[");
    const result = [];
    whitespace();
    if (text[offset] === "]") {
      offset += 1;
      return result;
    }
    while (true) {
      result.push(value());
      whitespace();
      if (text[offset] === "]") {
        offset += 1;
        return result;
      }
      consume(",");
    }
  };
  const object = () => {
    consume("{");
    const result = Object.create(null);
    const keys = new Set();
    whitespace();
    if (text[offset] === "}") {
      offset += 1;
      return result;
    }
    while (true) {
      const key = string();
      if (keys.has(key)) throw new Error(`${label} repeats JSON key ${JSON.stringify(key)}`);
      keys.add(key);
      consume(":");
      result[key] = value();
      whitespace();
      if (text[offset] === "}") {
        offset += 1;
        return result;
      }
      consume(",");
    }
  };
  const parsed = value();
  whitespace();
  if (offset !== text.length) throw new Error(`${label} is invalid JSON`);
  return parsed;
}

expect("schema version", config.schemaVersion, exact.schemaVersion);
expect("private redirect", config.privateRedirectUri, exact.privateRedirectUri);
expect("claimed redirect", config.claimedRedirectUri, exact.claimedRedirectUri);
expect("Apple application ID", config.apple?.applicationId, exact.applicationId);
expect("Apple associated domain", config.apple?.associatedDomain, exact.associatedDomain);
expect("Android package", config.android?.packageName, exact.packageName);
if (!["private-transition", "claimed"].includes(config.rollout)) {
  failures.push(`rollout must be private-transition or claimed, got ${JSON.stringify(config.rollout)}`);
}
const expectedActiveRedirect = config.rollout === "claimed"
  ? exact.claimedRedirectUri
  : exact.privateRedirectUri;
const expectedActiveConstant = config.rollout === "claimed"
  ? "CLAIMED_MOBILE_REDIRECT_URI"
  : "PRIVATE_MOBILE_REDIRECT_URI";
expect("active redirect", config.activeRedirectUri, expectedActiveRedirect);
const fingerprints = config.android?.playAppSigningSha256CertFingerprints;
if (!Array.isArray(fingerprints)) failures.push("Android fingerprints must be an array");
else {
  if (new Set(fingerprints).size !== fingerprints.length) failures.push("Android fingerprints repeat");
  for (const fingerprint of fingerprints) {
    if (!/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(fingerprint)) {
      failures.push(`invalid Play App Signing SHA-256 fingerprint: ${JSON.stringify(fingerprint)}`);
    }
  }
}

const mobile = tauri.plugins?.["deep-link"]?.mobile;
expect("Tauri mobile deep-link count", mobile?.length, 2);
expect("Tauri private deep link", mobile?.[0], {
  scheme: ["cash.free2z.zuuli"], host: "oauth", path: ["/callback"], appLink: false,
});
expect("Tauri claimed deep link", mobile?.[1], {
  scheme: ["https"], host: "free2z.com", path: ["/oauth/callback"], appLink: true,
});
for (const [label, needle, expectedCount] of [
  ["Android autoVerify", 'android:autoVerify="true"', 1],
  ["Android claimed scheme", 'android:scheme="https"', 1],
  ["Android claimed host", 'android:host="free2z.com"', 1],
  ["Android claimed path", 'android:path="/oauth/callback"', 1],
  ["iOS associated-domain entitlement", "<key>com.apple.developer.associated-domains</key>", 1],
  ["iOS associated domain", "<string>applinks:free2z.com</string>", 1],
  ["Rust private callback", `pub const PRIVATE_MOBILE_REDIRECT_URI: &str = "${exact.privateRedirectUri}";`, 1],
  ["Rust claimed callback", `pub const CLAIMED_MOBILE_REDIRECT_URI: &str = "${exact.claimedRedirectUri}";`, 1],
  ["Rust active callback", `pub const MOBILE_REDIRECT_URI: &str = ${expectedActiveConstant};`, 1],
  ["TypeScript private callback", `export const PRIVATE_MOBILE_REDIRECT_URI = "${exact.privateRedirectUri}";`, 1],
  ["TypeScript claimed callback", `export const CLAIMED_MOBILE_REDIRECT_URI = "${exact.claimedRedirectUri}";`, 1],
  ["TypeScript active callback", `export const MOBILE_REDIRECT_URI = ${expectedActiveConstant};`, 1],
]) {
  expect(label, count(label.startsWith("Android") ? androidGenerated : label.startsWith("iOS") ? entitlements : label.startsWith("Rust") ? rust : protocol, needle), expectedCount);
}

if (publicRelease) {
  if (!/^[0-9a-f]{40}$/.test(sourceSha ?? "")) {
    failures.push("public release requires --source-sha=<exact 40-character lowercase app commit>");
  }
  try {
    const checkoutSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (sourceSha !== checkoutSha) {
      failures.push("--source-sha does not match the checked-out app commit");
    }
    try {
      execFileSync("git", ["diff", "--quiet", "HEAD", "--"], {
        cwd: root, stdio: "ignore",
      });
      execFileSync("git", ["diff", "--cached", "--quiet", "HEAD", "--"], {
        cwd: root, stdio: "ignore",
      });
    } catch {
      failures.push("public release requires a clean tracked source tree and index");
    }
  } catch {
    failures.push("public release requires a readable Git source checkout");
  }
  if (config.rollout !== "claimed") failures.push("public release requires rollout=claimed");
  if (!Array.isArray(fingerprints) || fingerprints.length === 0) {
    failures.push("public release requires at least one Google Play App Signing SHA-256 fingerprint");
  }
  const evidencePath = process.env.ZUULI_OAUTH_DEVICE_EVIDENCE;
  let evidence;
  if (!evidencePath) {
    failures.push("public release requires ZUULI_OAUTH_DEVICE_EVIDENCE with signed iOS/Android cold+warm proof metadata");
  } else {
    try {
      evidence = JSON.parse(readFileSync(resolve(evidencePath), "utf8"));
    } catch {
      failures.push("ZUULI_OAUTH_DEVICE_EVIDENCE must name readable JSON");
    }
  }
  if (evidence) {
    if (evidence.claimedRedirectUri !== exact.claimedRedirectUri) failures.push("device evidence claimed URI mismatch");
    if (evidence.apple?.applicationId !== exact.applicationId) failures.push("device evidence Apple identity mismatch");
    if (evidence.apple?.cold !== true || evidence.apple?.warm !== true) failures.push("device evidence must prove iOS cold and warm links");
    if (!fingerprints.includes(evidence.android?.signingCertSha256)) failures.push("device evidence Android certificate is not configured");
    if (evidence.android?.cold !== true || evidence.android?.warm !== true) failures.push("device evidence must prove Android cold and warm links");
    if (evidence.userInitiatedHandoff !== true) failures.push("device evidence must prove the reviewed user-initiated claimed-link handoff");
    for (const value of [evidence.appCommit, evidence.backendCommit]) {
      if (!/^[0-9a-f]{40}$/.test(value ?? "")) failures.push("device evidence requires exact app and backend commit SHAs");
    }
    if (sourceSha && evidence.appCommit !== sourceSha) {
      failures.push("device evidence app commit does not match --source-sha");
    }
  }
  if (failures.length === 0) {
    const expectedAasa = { applinks: { details: [{
      appIDs: [exact.applicationId], components: [{ "/": "/oauth/callback" }],
    }] } };
    const expectedAssetlinks = [{
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: exact.packageName,
        sha256_cert_fingerprints: fingerprints,
      },
      relation_extensions: {
        "delegate_permission/common.handle_all_urls": {
          dynamic_app_link_components: [{ "/": "/oauth/callback" }],
        },
      },
    }];
    for (const [url, expected] of [
      ["https://free2z.com/.well-known/apple-app-site-association", expectedAasa],
      ["https://free2z.com/.well-known/assetlinks.json", expectedAssetlinks],
    ]) {
      try {
        const response = await fetch(url, {
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.timeout(10_000),
        });
        if (response.status !== 200 || response.url !== url) failures.push(`${url} must return direct HTTP 200`);
        const mediaType = (response.headers.get("content-type") ?? "")
          .split(";", 1)[0].trim().toLowerCase();
        if (mediaType !== "application/json") failures.push(`${url} must use application/json`);
        const body = parseUnambiguousJson(
          new Uint8Array(await response.arrayBuffer()),
          url,
        );
        if (JSON.stringify(canonicalJson(body)) !== JSON.stringify(canonicalJson(expected))) failures.push(`${url} is broader than the reviewed exact association`);
      } catch {
        failures.push(`${url} could not be fetched without redirects or contained invalid or ambiguous JSON`);
      }
    }
  }
}

if (failures.length) {
  console.error(`ZUULI mobile OAuth link verification failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`ZUULI mobile OAuth links are repo-consistent (${config.rollout}).`);
