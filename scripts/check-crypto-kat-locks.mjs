#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCKFILES = [
  "rs/Cargo.lock",
  "wallet/plugins/tauri-plugin-f2zmsg/Cargo.lock",
  "wallet/zuuli/src-tauri/Cargo.lock",
];
// The prefix census catches a newly resolved family member, while this exact
// reviewed inventory makes removal just as visible. Keeping only a convenient
// KAT subset would let a shipping OpenMLS provider drift behind green vectors.
const MODERN_CRYPTO_PACKAGE = /^(?:libcrux(?:$|[-_])|hpke[-_]rs(?:$|[-_])|openmls(?:$|[-_]))/;
const EXPECTED_PACKAGES = new Set([
  "hpke-rs",
  "hpke-rs-crypto",
  "hpke-rs-libcrux",
  "hpke-rs-rust-crypto",
  "libcrux-aead",
  "libcrux-aes",
  "libcrux-chacha20poly1305",
  "libcrux-curve25519",
  "libcrux-ecdh",
  "libcrux-ed25519",
  "libcrux-hacl-rs",
  "libcrux-hkdf",
  "libcrux-hmac",
  "libcrux-hmac-drbg",
  "libcrux-intrinsics",
  "libcrux-kem",
  "libcrux-macros",
  "libcrux-ml-kem",
  "libcrux-p256",
  "libcrux-platform",
  "libcrux-poly1305",
  "libcrux-secrets",
  "libcrux-sha2",
  "libcrux-sha3",
  "libcrux-traits",
  "openmls",
  "openmls_basic_credential",
  "openmls_libcrux_crypto",
  "openmls_memory_storage",
  "openmls_rust_crypto",
  "openmls_serialization_helpers",
  "openmls_sqlite_storage",
  "openmls_test",
  "openmls_traits",
]);
// Independent of the mutable Set above: removing a reviewed name must change
// this digest before any lock is parsed. A deliberate graph update therefore
// has an explicit re-review point instead of laundering a coordinated
// EXPECTED_PACKAGES + three-lock deletion through a green parity check.
const REVIEWED_PACKAGE_COUNT = 34;
const REVIEWED_PACKAGE_NAMES_SHA256 =
  "6489c1c586603d66a599b5a232c4d980b6d71617b7d5d3c6e15fb0afcd8317b2";
const PACKAGE_FAMILIES = [
  ["libcrux", "libcrux-kem", "libcrux-self-test-added"],
  ["hpke-rs", "hpke-rs", "hpke-rs-self-test-added"],
  ["openmls", "openmls", "openmls_self_test_added"],
];
const FAMILY_NAME_VARIANTS = [
  ["libcrux exact name", "libcrux-kem", "libcrux"],
  ["libcrux underscore member", "libcrux-kem", "libcrux_new_backend"],
  ["hpke underscore root", "hpke-rs", "hpke_rs"],
  ["hpke underscore member", "hpke-rs", "hpke_rs_crypto"],
  ["openmls hyphen member", "openmls", "openmls-test-helper"],
];
const UNRELATED_PREFIX_NEIGHBORS = ["libcruxial", "hpke-rstream", "openmlstream"];

function inventoryNamesSha256(packages) {
  return createHash("sha256")
    .update([...packages].sort().join("\n"))
    .digest("hex");
}

function validateAuthoritativeInventory(packages) {
  if (
    packages.size !== REVIEWED_PACKAGE_COUNT
    || inventoryNamesSha256(packages) !== REVIEWED_PACKAGE_NAMES_SHA256
  ) {
    throw new Error(
      "authoritative modern-crypto inventory differs from the independently reviewed exact name set",
    );
  }
}

function packageField(block, name) {
  return block.match(new RegExp(`^${name} = "([^"]+)"$`, "m"))?.[1];
}

function cryptoPackages(
  source,
  relativeFile,
  includePackage = (name) => MODERN_CRYPTO_PACKAGE.test(name),
  expectedPackages = EXPECTED_PACKAGES,
) {
  const packages = new Map();
  for (const block of source.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const name = packageField(block, "name");
    if (!name || !includePackage(name)) continue;
    if (!expectedPackages.has(name)) {
      throw new Error(
        `${relativeFile}: unregistered modern-crypto package ${name}; review and update the authoritative inventory`,
      );
    }
    const version = packageField(block, "version");
    const packageSource = packageField(block, "source");
    const checksum = packageField(block, "checksum");
    if (!version || !packageSource || !checksum) {
      throw new Error(
        `${relativeFile}: ${name} must retain version, registry source, and checksum identity`,
      );
    }
    if (packages.has(name)) {
      throw new Error(`${relativeFile}: duplicate modern-crypto package ${name}`);
    }
    packages.set(name, `${version} ${packageSource} ${checksum}`);
  }
  const missing = [...expectedPackages].filter((name) => !packages.has(name));
  if (missing.length > 0) {
    throw new Error(
      `${relativeFile}: authoritative modern-crypto inventory is missing ${missing.join(", ")}`,
    );
  }
  return packages;
}

function parityFailures(
  sources,
  { includePackage, expectedPackages = EXPECTED_PACKAGES } = {},
) {
  if (LOCKFILES.length !== 3 || new Set(LOCKFILES).size !== 3) {
    return ["crypto lock policy must cover exactly the three independent shipping locks"];
  }
  try {
    validateAuthoritativeInventory(expectedPackages);
  } catch (error) {
    return [error.message];
  }
  const parsed = new Map();
  for (const relativeFile of LOCKFILES) {
    try {
      const source =
        sources?.get(relativeFile) ??
        fs.readFileSync(path.join(REPO_ROOT, relativeFile), "utf8");
      parsed.set(
        relativeFile,
        cryptoPackages(source, relativeFile, includePackage, expectedPackages),
      );
    } catch (error) {
      return [error.message];
    }
  }

  const reference = parsed.get(LOCKFILES[0]);
  const failures = [];
  for (const relativeFile of LOCKFILES.slice(1)) {
    const actual = parsed.get(relativeFile);
    for (const [name, identity] of reference) {
      if (actual.get(name) !== identity) {
        failures.push(
          `${relativeFile}: crypto identity for ${name} differs from ${LOCKFILES[0]}`,
        );
      }
    }
  }
  return failures;
}

function packageBlock(source, name) {
  const markers = [...source.matchAll(/^\[\[package\]\]\s*$/gm)];
  for (const [index, marker] of markers.entries()) {
    const start = marker.index;
    const end = markers[index + 1]?.index ?? source.length;
    const block = source.slice(start, end);
    if (packageField(block, "name") === name) return { block, start, end };
  }
  throw new Error(`self-test cannot find package ${name}`);
}

function replacePackageBlock(source, name, mutate) {
  const { block, start, end } = packageBlock(source, name);
  const replacement = mutate(block);
  if (replacement === block) {
    throw new Error(`self-test mutation did not change package ${name}`);
  }
  return `${source.slice(0, start)}${replacement}${source.slice(end)}`;
}

function appendRenamedPackage(source, representative, added) {
  const { block } = packageBlock(source, representative);
  return `${source.trimEnd()}\n\n${block
    .replace(`name = \"${representative}\"`, `name = \"${added}\"`)
    .trimStart()}`;
}

function requireRejected(label, baseline, relativeFile, changed, packageName) {
  const sources = new Map(baseline);
  sources.set(relativeFile, changed);
  const failures = parityFailures(sources);
  if (
    failures.length === 0 ||
    !failures.some((failure) => failure.includes(packageName))
  ) {
    throw new Error(
      `${relativeFile}: ${label} for ${packageName} escaped parity: ${failures.join("; ") || "success"}`,
    );
  }
}

function runSelfTest() {
  const baseline = new Map(
    LOCKFILES.map((relativeFile) => [
      relativeFile,
      fs.readFileSync(path.join(REPO_ROOT, relativeFile), "utf8"),
    ]),
  );
  const liveFailures = parityFailures(baseline);
  if (liveFailures.length) {
    throw new Error(`live locks are not a valid mutation base: ${liveFailures.join("; ")}`);
  }

  const narrowedFailures = parityFailures(baseline, {
    includePackage: (name) => name === "libcrux-kem",
  });
  if (
    !narrowedFailures.some((failure) =>
      failure.includes("authoritative modern-crypto inventory"),
    )
  ) {
    throw new Error(
      `narrowed modern-crypto inventory escaped parity: ${narrowedFailures.join("; ") || "success"}`,
    );
  }
  console.log("crypto lock self-test: narrowed package inventory was rejected");

  const removedName = "libcrux-aead";
  const narrowedExpected = new Set(EXPECTED_PACKAGES);
  narrowedExpected.delete(removedName);
  const coordinatedRemoval = new Map(
    [...baseline].map(([relativeFile, source]) => [
      relativeFile,
      replacePackageBlock(source, removedName, () => ""),
    ]),
  );
  const coordinatedRemovalFailures = parityFailures(coordinatedRemoval, {
    expectedPackages: narrowedExpected,
  });
  if (
    !coordinatedRemovalFailures.some((failure) =>
      failure.includes("independently reviewed exact name set"),
    )
  ) {
    throw new Error(
      `coordinated authoritative-inventory and all-lock removal escaped parity: ${coordinatedRemovalFailures.join("; ") || "success"}`,
    );
  }
  console.log(
    "crypto lock self-test: coordinated authoritative-inventory and all-lock removal was rejected",
  );
  const substitutedExpected = new Set(EXPECTED_PACKAGES);
  substitutedExpected.delete(removedName);
  substitutedExpected.add("libcrux-reviewed-name-substitution");
  const substitutedInventoryFailures = parityFailures(baseline, {
    expectedPackages: substitutedExpected,
  });
  if (
    !substitutedInventoryFailures.some((failure) =>
      failure.includes("independently reviewed exact name set"),
    )
  ) {
    throw new Error(
      `same-size authoritative name substitution escaped its digest: ${substitutedInventoryFailures.join("; ") || "success"}`,
    );
  }
  console.log("crypto lock self-test: same-size authoritative name substitution was rejected");

  for (const relativeFile of LOCKFILES) {
    const source = baseline.get(relativeFile);
    for (const [family, representative, added] of PACKAGE_FAMILIES) {
      for (const [field, replacement] of [
        ["version", "999.0.0-self-test"],
        ["source", "registry+https://example.invalid/self-test-index"],
        ["checksum", "0".repeat(64)],
      ]) {
        requireRejected(
          `${field} drift`,
          baseline,
          relativeFile,
          replacePackageBlock(source, representative, (value) =>
            value.replace(
              new RegExp(`^${field} = \"[^\"]+\"$`, "m"),
              `${field} = \"${replacement}\"`,
            ),
          ),
          representative,
        );
      }
      requireRejected(
        "package removal",
        baseline,
        relativeFile,
        replacePackageBlock(source, representative, () => ""),
        representative,
      );
      requireRejected(
        "package addition",
        baseline,
        relativeFile,
        appendRenamedPackage(source, representative, added),
        added,
      );
      console.log(
        `crypto lock self-test: ${relativeFile} rejected ${family} version/source/checksum/add/remove drift`,
      );
    }
  }

  const variantSource = baseline.get(LOCKFILES[0]);
  for (const [label, representative, added] of FAMILY_NAME_VARIANTS) {
    requireRejected(
      label,
      baseline,
      LOCKFILES[0],
      appendRenamedPackage(variantSource, representative, added),
      added,
    );
    console.log(`crypto lock self-test: rejected ${label} ${added}`);
  }

  let unrelatedSource = variantSource;
  for (const added of UNRELATED_PREFIX_NEIGHBORS) {
    unrelatedSource = appendRenamedPackage(unrelatedSource, "libcrux-kem", added);
  }
  const unrelatedFailures = parityFailures(new Map(baseline).set(LOCKFILES[0], unrelatedSource));
  if (unrelatedFailures.length > 0) {
    throw new Error(
      `unrelated prefix neighbors were swept into the crypto family: ${unrelatedFailures.join("; ")}`,
    );
  }
  console.log("crypto lock self-test: unrelated prefix neighbors remained outside the family census");
}

const mode = process.argv[2];
if (process.argv.length > 3 || (mode && mode !== "--self-test")) {
  console.error("Usage: scripts/check-crypto-kat-locks.mjs [--self-test]");
  process.exit(2);
}

if (mode === "--self-test") {
  runSelfTest();
} else {
  const failures = parityFailures();
  if (failures.length) {
    for (const failure of failures) console.error(`crypto lock parity: ${failure}`);
    process.exit(1);
  }
  console.log(
    `crypto lock parity: all three shipping graphs use the same ${EXPECTED_PACKAGES.size}-package OpenMLS/libcrux/HPKE inventory and identities`,
  );
}
