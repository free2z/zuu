#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { dirname, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const config = JSON.parse(read("mobile-oauth-links.json"));
const tauri = JSON.parse(read("src-tauri/tauri.conf.json"));
const manifest = read("src-tauri/gen/android/app/src/main/AndroidManifest.xml");
const entitlements = read(
  "src-tauri/gen/apple/zuuli_iOS/zuuli_iOS.entitlements",
);
const rust = read("src-tauri/src/oauth.rs");
const protocol = read("src/lib/oauth/protocol.ts");
const failures = [];
const publicRelease = process.argv.includes("--public-release");
const sourceShaArgument = process.argv.find((value) =>
  value.startsWith("--source-sha="),
);
const sourceSha = sourceShaArgument?.slice("--source-sha=".length);
const androidGeneratedMarker =
  "<!-- DEEP LINK PLUGIN. AUTO-GENERATED. DO NOT REMOVE. -->";
const androidGeneratedParts = manifest.split(androidGeneratedMarker);
const androidGenerated =
  androidGeneratedParts.length === 3 ? androidGeneratedParts[1] : "";
if (androidGeneratedParts.length !== 3) {
  failures.push(
    "Android deep-link generated block must have exactly two boundary markers",
  );
}

const exact = {
  schemaVersion: 1,
  privateRedirectUri: "cash.free2z.zuuli://oauth/callback",
  claimedRedirectUri: "https://free2z.com/oauth/callback",
  applicationId: "F9AV5HKF6N.cash.free2z.zuuli",
  associatedDomain: "applinks:free2z.com",
  packageName: "cash.free2z.zuuli",
};
const evidenceScenarios = [
  "ios-cold",
  "ios-warm",
  "android-cold",
  "android-warm",
  "handoff",
];
function expect(label, actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}
function count(text, needle) {
  return text.split(needle).length - 1;
}
function exactKeys(label, value, keys) {
  if (
    value === null ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify([...keys].sort())
  ) {
    failures.push(`${label} must contain exactly: ${keys.join(", ")}`);
    return false;
  }
  return true;
}
function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalJson(value[key])]),
    );
  }
  return value;
}

function parseUnambiguousJson(bytes, label) {
  if (bytes.byteLength > 65_536)
    throw new Error(`${label} JSON is unexpectedly large`);
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
      if (keys.has(key))
        throw new Error(`${label} repeats JSON key ${JSON.stringify(key)}`);
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
expect(
  "Apple application ID",
  config.apple?.applicationId,
  exact.applicationId,
);
expect(
  "Apple associated domain",
  config.apple?.associatedDomain,
  exact.associatedDomain,
);
expect("Android package", config.android?.packageName, exact.packageName);
if (typeof config.deviceEvidenceEd25519PublicKeyPem !== "string") {
  failures.push("deviceEvidenceEd25519PublicKeyPem must be a string");
}
if (!["private-transition", "claimed"].includes(config.rollout)) {
  failures.push(
    `rollout must be private-transition or claimed, got ${JSON.stringify(config.rollout)}`,
  );
}
const expectedActiveRedirect =
  config.rollout === "claimed"
    ? exact.claimedRedirectUri
    : exact.privateRedirectUri;
const expectedActiveConstant =
  config.rollout === "claimed"
    ? "CLAIMED_MOBILE_REDIRECT_URI"
    : "PRIVATE_MOBILE_REDIRECT_URI";
expect("active redirect", config.activeRedirectUri, expectedActiveRedirect);
const fingerprints = config.android?.playAppSigningSha256CertFingerprints;
if (!Array.isArray(fingerprints))
  failures.push("Android fingerprints must be an array");
else {
  if (new Set(fingerprints).size !== fingerprints.length)
    failures.push("Android fingerprints repeat");
  for (const fingerprint of fingerprints) {
    if (!/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(fingerprint)) {
      failures.push(
        `invalid Play App Signing SHA-256 fingerprint: ${JSON.stringify(fingerprint)}`,
      );
    }
  }
}

const mobile = tauri.plugins?.["deep-link"]?.mobile;
expect("Tauri mobile deep-link count", mobile?.length, 2);
expect("Tauri private deep link", mobile?.[0], {
  scheme: ["cash.free2z.zuuli"],
  host: "oauth",
  path: ["/callback"],
  appLink: false,
});
expect("Tauri claimed deep link", mobile?.[1], {
  scheme: ["https"],
  host: "free2z.com",
  path: ["/oauth/callback"],
  appLink: true,
});
for (const [label, needle, expectedCount] of [
  ["Android autoVerify", 'android:autoVerify="true"', 1],
  ["Android claimed scheme", 'android:scheme="https"', 1],
  ["Android claimed host", 'android:host="free2z.com"', 1],
  ["Android claimed path", 'android:path="/oauth/callback"', 1],
  [
    "iOS associated-domain entitlement",
    "<key>com.apple.developer.associated-domains</key>",
    1,
  ],
  ["iOS associated domain", "<string>applinks:free2z.com</string>", 1],
  [
    "Rust private callback",
    `pub const PRIVATE_MOBILE_REDIRECT_URI: &str = "${exact.privateRedirectUri}";`,
    1,
  ],
  [
    "Rust claimed callback",
    `pub const CLAIMED_MOBILE_REDIRECT_URI: &str = "${exact.claimedRedirectUri}";`,
    1,
  ],
  [
    "Rust active callback",
    `pub const MOBILE_REDIRECT_URI: &str = ${expectedActiveConstant};`,
    1,
  ],
  [
    "TypeScript private callback",
    `export const PRIVATE_MOBILE_REDIRECT_URI = "${exact.privateRedirectUri}";`,
    1,
  ],
  [
    "TypeScript claimed callback",
    `export const CLAIMED_MOBILE_REDIRECT_URI = "${exact.claimedRedirectUri}";`,
    1,
  ],
  [
    "TypeScript active callback",
    `export const MOBILE_REDIRECT_URI = ${expectedActiveConstant};`,
    1,
  ],
]) {
  expect(
    label,
    count(
      label.startsWith("Android")
        ? androidGenerated
        : label.startsWith("iOS")
          ? entitlements
          : label.startsWith("Rust")
            ? rust
            : protocol,
      needle,
    ),
    expectedCount,
  );
}

if (publicRelease) {
  if (!/^[0-9a-f]{40}$/.test(sourceSha ?? "")) {
    failures.push(
      "public release requires --source-sha=<exact 40-character lowercase app commit>",
    );
  }
  try {
    const checkoutSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (sourceSha !== checkoutSha) {
      failures.push("--source-sha does not match the checked-out app commit");
    }
    try {
      execFileSync("git", ["diff", "--quiet", "HEAD", "--"], {
        cwd: root,
        stdio: "ignore",
      });
      execFileSync("git", ["diff", "--cached", "--quiet", "HEAD", "--"], {
        cwd: root,
        stdio: "ignore",
      });
    } catch {
      failures.push(
        "public release requires a clean tracked source tree and index",
      );
    }
  } catch {
    failures.push("public release requires a readable Git source checkout");
  }
  if (config.rollout !== "claimed")
    failures.push("public release requires rollout=claimed");
  if (!Array.isArray(fingerprints) || fingerprints.length === 0) {
    failures.push(
      "public release requires at least one Google Play App Signing SHA-256 fingerprint",
    );
  }
  let evidencePublicKey;
  try {
    evidencePublicKey = createPublicKey(
      config.deviceEvidenceEd25519PublicKeyPem ?? "",
    );
    if (evidencePublicKey.asymmetricKeyType !== "ed25519")
      throw new Error("wrong key type");
  } catch {
    failures.push(
      "public release requires the reviewed Ed25519 device-evidence public key",
    );
  }
  const evidencePath = process.env.ZUULI_OAUTH_DEVICE_EVIDENCE;
  let evidenceEnvelope;
  let evidence;
  if (!evidencePath) {
    failures.push(
      "public release requires ZUULI_OAUTH_DEVICE_EVIDENCE with a signed physical-device evidence bundle",
    );
  } else {
    try {
      evidenceEnvelope = parseUnambiguousJson(
        new Uint8Array(readFileSync(resolve(evidencePath))),
        "device evidence",
      );
    } catch {
      failures.push(
        "ZUULI_OAUTH_DEVICE_EVIDENCE must name readable, unambiguous JSON",
      );
    }
  }
  if (
    evidenceEnvelope &&
    exactKeys("device evidence envelope", evidenceEnvelope, [
      "statement",
      "signature",
    ])
  ) {
    evidence = evidenceEnvelope.statement;
    const signature = evidenceEnvelope.signature;
    let signatureBytes;
    if (
      typeof signature === "string" &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(signature)
    ) {
      signatureBytes = Buffer.from(signature, "base64");
      if (signatureBytes.toString("base64") !== signature)
        signatureBytes = undefined;
    }
    if (
      !signatureBytes ||
      !evidencePublicKey ||
      !verify(
        null,
        Buffer.from(JSON.stringify(canonicalJson(evidence)), "utf8"),
        evidencePublicKey,
        signatureBytes,
      )
    ) {
      failures.push("device evidence signature is absent or invalid");
    }
  }
  if (
    evidence &&
    exactKeys("device evidence statement", evidence, [
      "schemaVersion",
      "appCommit",
      "backendCommit",
      "claimedRedirectUri",
      "apple",
      "android",
      "artifacts",
    ])
  ) {
    if (evidence.schemaVersion !== 1)
      failures.push("device evidence schema version mismatch");
    if (evidence.claimedRedirectUri !== exact.claimedRedirectUri)
      failures.push("device evidence claimed URI mismatch");
    if (
      !exactKeys("device evidence Apple identity", evidence.apple, [
        "applicationId",
      ]) ||
      evidence.apple?.applicationId !== exact.applicationId
    )
      failures.push("device evidence Apple identity mismatch");
    if (
      !exactKeys("device evidence Android identity", evidence.android, [
        "packageName",
        "signingCertSha256",
      ]) ||
      evidence.android?.packageName !== exact.packageName ||
      !fingerprints.includes(evidence.android?.signingCertSha256)
    )
      failures.push("device evidence Android identity is not configured");
    for (const value of [evidence.appCommit, evidence.backendCommit]) {
      if (!/^[0-9a-f]{40}$/.test(value ?? ""))
        failures.push(
          "device evidence requires exact app and backend commit SHAs",
        );
    }
    if (sourceSha && evidence.appCommit !== sourceSha) {
      failures.push("device evidence app commit does not match --source-sha");
    }
    if (
      exactKeys(
        "device evidence artifacts",
        evidence.artifacts,
        evidenceScenarios,
      )
    ) {
      for (const scenario of evidenceScenarios) {
        const descriptor = evidence.artifacts[scenario];
        if (
          !exactKeys(`${scenario} evidence descriptor`, descriptor, [
            "contentBase64",
            "sha256",
          ])
        )
          continue;
        if (
          typeof descriptor.contentBase64 !== "string" ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(descriptor.contentBase64) ||
          typeof descriptor.sha256 !== "string" ||
          !/^[0-9a-f]{64}$/.test(descriptor.sha256)
        ) {
          failures.push(`${scenario} evidence descriptor is malformed`);
          continue;
        }
        try {
          const artifact = Buffer.from(descriptor.contentBase64, "base64");
          if (artifact.toString("base64") !== descriptor.contentBase64) {
            throw new Error("encoding");
          }
          // The signed envelope is stored as one GitHub environment secret,
          // whose encoded value is capped at 48 KiB. Five independently
          // encoded captures must stay small enough for the outer envelope's
          // second base64 layer and JSON/signature overhead.
          if (artifact.byteLength === 0 || artifact.byteLength > 4_096) {
            throw new Error("size");
          }
          const digest = createHash("sha256").update(artifact).digest("hex");
          if (digest !== descriptor.sha256) throw new Error("digest");
          const text = new TextDecoder("utf-8", { fatal: true }).decode(
            artifact,
          );
          for (const token of [
            scenario,
            evidence.appCommit,
            evidence.backendCommit,
            exact.claimedRedirectUri,
          ]) {
            if (!text.includes(token)) throw new Error("binding");
          }
        } catch {
          failures.push(
            `${scenario} evidence artifact is invalid, changed, oversized, or not bound to this release`,
          );
        }
      }
    }
  }
  if (failures.length === 0) {
    const expectedAasa = {
      applinks: {
        details: [
          {
            appIDs: [exact.applicationId],
            components: [{ "/": "/oauth/callback" }],
          },
        ],
      },
    };
    const expectedAssetlinks = [
      {
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
      },
    ];
    for (const [url, expected] of [
      [
        "https://free2z.com/.well-known/apple-app-site-association",
        expectedAasa,
      ],
      [
        "https://app-site-association.cdn-apple.com/a/v1/free2z.com",
        expectedAasa,
      ],
      ["https://free2z.com/.well-known/assetlinks.json", expectedAssetlinks],
    ]) {
      try {
        const response = await fetch(url, {
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.timeout(10_000),
        });
        if (response.status !== 200 || response.url !== url)
          failures.push(`${url} must return direct HTTP 200`);
        const mediaType = (response.headers.get("content-type") ?? "")
          .split(";", 1)[0]
          .trim()
          .toLowerCase();
        if (mediaType !== "application/json")
          failures.push(`${url} must use application/json`);
        const body = parseUnambiguousJson(
          new Uint8Array(await response.arrayBuffer()),
          url,
        );
        if (
          JSON.stringify(canonicalJson(body)) !==
          JSON.stringify(canonicalJson(expected))
        )
          failures.push(
            `${url} is broader than the reviewed exact association`,
          );
      } catch {
        failures.push(
          `${url} could not be fetched without redirects or contained invalid or ambiguous JSON`,
        );
      }
    }
    const callbackUrl = new URL(exact.claimedRedirectUri);
    const callbackCode = "zuuli-public-gate-code-must-not-appear";
    const callbackState = "zuuli-public-gate-state-must-not-appear";
    callbackUrl.searchParams.set("code", callbackCode);
    callbackUrl.searchParams.set("state", callbackState);
    try {
      const response = await fetch(callbackUrl, {
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      const body = new TextDecoder("utf-8", { fatal: true }).decode(
        new Uint8Array(await response.arrayBuffer()),
      );
      if (response.status !== 200 || response.url !== callbackUrl.toString()) {
        failures.push(
          "the claimed callback browser fallback must return direct HTTP 200",
        );
      }
      if (
        (response.headers.get("content-type") ?? "")
          .split(";", 1)[0]
          .trim()
          .toLowerCase() !== "text/plain"
      ) {
        failures.push(
          "the claimed callback browser fallback must use text/plain",
        );
      }
      for (const [name, expected] of [
        ["cache-control", "no-store"],
        ["pragma", "no-cache"],
        ["referrer-policy", "no-referrer"],
        ["x-content-type-options", "nosniff"],
      ]) {
        if (response.headers.get(name) !== expected) {
          failures.push(
            `the claimed callback browser fallback must set ${name}: ${expected}`,
          );
        }
      }
      if (
        response.headers.get("x-zuuli-oauth-build-sha") !==
        evidence.backendCommit
      ) {
        failures.push(
          "the claimed callback fallback is not the attested callback-tier build",
        );
      }
      if (
        body !==
          "Sign-in could not return to ZUULI. Reopen the app and try again." ||
        body.includes(callbackCode) ||
        body.includes(callbackState)
      ) {
        failures.push(
          "the claimed callback fallback reflects OAuth material or is not inert",
        );
      }
    } catch {
      failures.push(
        "the claimed callback browser fallback could not be verified",
      );
    }
    const capabilitiesUrl = "https://free2z.cash/api/zuuli/capabilities/";
    try {
      const response = await fetch(capabilitiesUrl, {
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status !== 200 || response.url !== capabilitiesUrl) {
        failures.push(`${capabilitiesUrl} must return direct HTTP 200`);
      }
      if (
        (response.headers.get("content-type") ?? "")
          .split(";", 1)[0]
          .trim()
          .toLowerCase() !== "application/json"
      )
        failures.push(
          "live callback-tier capabilities must use application/json",
        );
      const body = parseUnambiguousJson(
        new Uint8Array(await response.arrayBuffer()),
        capabilitiesUrl,
      );
      if (body?.capabilities?.auth?.social !== true) {
        failures.push(
          "the live callback tier does not advertise social OAuth ready",
        );
      }
      if (
        response.headers.get("x-zuuli-oauth-build-sha") !==
        evidence.backendCommit
      ) {
        failures.push(
          "device evidence backend commit is not the live callback-tier build",
        );
      }
      if (
        (response.headers.get("cache-control") ?? "").toLowerCase() !==
        "no-store"
      ) {
        failures.push("live callback-tier capabilities must be no-store");
      }
    } catch {
      failures.push("live callback-tier capabilities could not be verified");
    }
    const startUrl = new URL(
      "https://free2z.cash/api/auth/social/google/mobile-start",
    );
    startUrl.searchParams.set("redirect_uri", exact.claimedRedirectUri);
    startUrl.searchParams.set("code_challenge", "invalid");
    try {
      const response = await fetch(startUrl, {
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      const body = parseUnambiguousJson(
        new Uint8Array(await response.arrayBuffer()),
        startUrl.toString(),
      );
      if (
        response.status !== 400 ||
        response.url !== startUrl.toString() ||
        body?.detail !== "mobile OAuth requires a valid PKCE S256 challenge."
      ) {
        failures.push("the live isolated mobile-start contract is not ready");
      }
      if (
        (response.headers.get("content-type") ?? "")
          .split(";", 1)[0]
          .trim()
          .toLowerCase() !== "application/json"
      )
        failures.push("live mobile-start must use application/json");
      if (
        response.headers.get("x-zuuli-oauth-build-sha") !==
        evidence.backendCommit
      ) {
        failures.push(
          "mobile-start is not served by the attested callback-tier build",
        );
      }
    } catch {
      failures.push(
        "the live isolated mobile-start contract could not be verified",
      );
    }
  }
}

if (failures.length) {
  console.error(
    `ZUULI mobile OAuth link verification failed:\n- ${failures.join("\n- ")}`,
  );
  process.exit(1);
}
console.log(
  `ZUULI mobile OAuth links are repo-consistent (${config.rollout}).`,
);
