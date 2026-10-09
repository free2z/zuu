#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCKFILES = [
  "rs/Cargo.lock",
  "wallet/plugins/tauri-plugin-f2zmsg/Cargo.lock",
  "wallet/zuuli/src-tauri/Cargo.lock",
  "wallet/e2e2z/src-tauri/Cargo.lock",
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
  "libcrux-p384",
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
// EXPECTED_PACKAGES + all-lock deletion through a green parity check.
const REVIEWED_PACKAGE_COUNT = 35;
const REVIEWED_PACKAGE_NAMES_SHA256 =
  "357c73690c71771f24956ace617f5e70fad664c5a7d40846455f48545d76c9f5";
// Exact multi-version identities retained by the two provider closures: OpenMLS optional
// rust_crypto 0.7 and selected libcrux 0.8, including their non-unified libcrux crates.
const EXPECTED_MULTIPLE_IDENTITIES = new Map([
  ["hpke-rs", ["0.7.0 registry+https://github.com/rust-lang/crates.io-index 812de62ab573b876c6c40d7553bae9402ae3bad95b64af06f964388eecb9b7b1", "0.8.0 registry+https://github.com/rust-lang/crates.io-index deb74477a6c7f6e8e9c68de06fe928db79b3b8b9e04c900bfb729bf096df7d22"]],
  ["hpke-rs-crypto", ["0.7.0 registry+https://github.com/rust-lang/crates.io-index d2c461da2e0c9c93d875b597f0c78214fb0d2d5c57834b2ef2a2fa057fa20e24", "0.8.0 registry+https://github.com/rust-lang/crates.io-index 72ae5655535eadbe2c8091ccc4c1913768b795dc04d1b85c821d5c41fe49d828"]],
  ["hpke-rs-libcrux", ["0.7.0 registry+https://github.com/rust-lang/crates.io-index 4c1ace95ef11fbbd84527eada5fc1304f66720fc4c008db30d888d62d3c52613", "0.8.0 registry+https://github.com/rust-lang/crates.io-index 651d0e6fce0fc35a53150f163ffff703a54a94b095fd0f67c8eee55bb95172bf"]],
  ["hpke-rs-rust-crypto", ["0.7.0 registry+https://github.com/rust-lang/crates.io-index 3a606ac19851da841862ef5f39d26d6227bfcfb4047417801a66c1f6e6652d71", "0.8.0 registry+https://github.com/rust-lang/crates.io-index 2ed2ce2a3de9b4b7f4d829d3e45e40c19daea7ff0246e7f22b9c7d6b00d1b517"]],
  ["libcrux-aead", ["0.0.10 registry+https://github.com/rust-lang/crates.io-index 4f5f7c2e54c871be25920dd3a0a8cbac1552d7ab8e294967a71199ca14588304", "0.0.9 registry+https://github.com/rust-lang/crates.io-index 22acbe68be84b7b41aaba6e39b87036fc4324dee628d94773750bf3d7e906d69"]],
  ["libcrux-aes", ["0.0.10 registry+https://github.com/rust-lang/crates.io-index cd415025511a0bd8731cae34ae2d5e07c1b3f0443d5c12bd199c9e9b2f1fd4d5", "0.0.9 registry+https://github.com/rust-lang/crates.io-index 57cc95b11dbc797b1e169467b1fc4205c4e6ee2ce516a035ad7342ce5f6ae971"]],
  ["libcrux-chacha20poly1305", ["0.0.10 registry+https://github.com/rust-lang/crates.io-index 2ae27cbc4917bfd7759d7db19ea6dcf0279f195431942b59ff113aa34a2140a3", "0.0.9 registry+https://github.com/rust-lang/crates.io-index 537e6eee5cdc9a980014d058784b0be09614f0596df789b114f7833aa9f35d75"]],
  ["libcrux-curve25519", ["0.0.8 registry+https://github.com/rust-lang/crates.io-index e4f3cfd5e31cb9745e290ee061222c380ec42884654b09fc7d12a5b0ed63e028", "0.0.9 registry+https://github.com/rust-lang/crates.io-index 5e78d0f36b23bcf258792dcc3a948fc628cb195950afa7b9a954250714688cfd"]],
  ["libcrux-ecdh", ["0.0.8 registry+https://github.com/rust-lang/crates.io-index 4a227590b89ff55ce7cd97b5a7468c82d231db8f3b890bb4d4fb6d271e7524d7", "0.0.9 registry+https://github.com/rust-lang/crates.io-index 50abafa35c0caade2f358504b7da0a438a7382dc1262f855aa479e89578301b6"]],
  ["libcrux-hacl-rs", ["0.0.5 registry+https://github.com/rust-lang/crates.io-index 66106db376ae249af86911aee048cf73ea1f394d6653026fc988dd22cf2a4ace", "0.0.6 registry+https://github.com/rust-lang/crates.io-index 27ce64ead37fc67c1039fdbcf1e8c97044e6a644cb3d1f79060b5c9ac8fdfe0a"]],
  ["libcrux-hkdf", ["0.0.8 registry+https://github.com/rust-lang/crates.io-index dc94e651dca4d47edbcdd88bb2428ce16a2bd86b7a4e7170da87b505478f9839", "0.0.9 registry+https://github.com/rust-lang/crates.io-index 5d061b72fb31bcb77940e379b3df170389c5f372a604f755c097fac9a870cc43"]],
  ["libcrux-hmac", ["0.0.8 registry+https://github.com/rust-lang/crates.io-index 500ad9b32c715161b594172ca1fb11503a1c033b393ff4c0c33505ce51c1943c", "0.0.9 registry+https://github.com/rust-lang/crates.io-index 1b454775ca55f79559f4dbc03b9896d46d929f11041d1c71c14501f0c1b97d75"]],
  ["libcrux-intrinsics", ["0.0.8 registry+https://github.com/rust-lang/crates.io-index 98a0c574d4eb81d0814bc2b91e4a433d7e0b35851b1d62eb5dd95c064f1f76d0", "0.0.9 registry+https://github.com/rust-lang/crates.io-index de82722c9c7419a311e84ee902e9643a15e39a6fcaade87f21e94f8d0f30fa70"]],
  ["libcrux-kem", ["0.0.10 registry+https://github.com/rust-lang/crates.io-index 31bf62e2a587002bf2ccc022015daeb8457e1e09269b3544aeec12243a3e9b74", "0.0.9 registry+https://github.com/rust-lang/crates.io-index 541a7377fb35060892e0620982e224e47419f10da8c212453bf642dafe529691"]],
  ["libcrux-macros", ["0.0.3 registry+https://github.com/rust-lang/crates.io-index ffd6aa2dcd5be681662001b81d493f1569c6d49a32361f470b0c955465cd0338", "0.0.4 registry+https://github.com/rust-lang/crates.io-index 2afdd4da30d6e23f76bd6f3ad61be5c773720349eef3e791f8b79cfea3fe1436"]],
  ["libcrux-ml-kem", ["0.0.10 registry+https://github.com/rust-lang/crates.io-index 1d8160f7d64fd2716b4fd05cc886a042f8dcda18d9206c0d506e2c67bdf97daa", "0.0.11 registry+https://github.com/rust-lang/crates.io-index 4ceed00367748ec0b545bc4a7b0521f8c9fd476d02484340f0a95b0f45f828cd"]],
  ["libcrux-p256", ["0.0.8 registry+https://github.com/rust-lang/crates.io-index 3400732702d578be622257b98cec85e9b0cd34a67f1f06d3ebe9ae34963cdf02", "0.0.9 registry+https://github.com/rust-lang/crates.io-index 7489aa205be22524e2f6ddbe006c0c4ff5f1dfc7c17b783e3d02f1cb2a01c605"]],
  ["libcrux-platform", ["0.0.3 registry+https://github.com/rust-lang/crates.io-index 1d9e21d7ed31a92ac539bd69a8c970b183ee883872d2d19ce27036e24cb8ecc4", "0.0.4 registry+https://github.com/rust-lang/crates.io-index 8bf8bee8c35d34867a3762d6ee7b74e8523a882855c3cfce30484e9554342206"]],
  ["libcrux-poly1305", ["0.0.6 registry+https://github.com/rust-lang/crates.io-index 76a9144949845813a0b8787d08cbba47baabe59c83f3043e558e6e92385c40cc", "0.0.7 registry+https://github.com/rust-lang/crates.io-index d727ee28ee0d5d2661daa5f2f47965cd3489a0ac9130f3410e95632a98b12e49"]],
  ["libcrux-secrets", ["0.0.6 registry+https://github.com/rust-lang/crates.io-index 79054fc9037cb70d6a546cf094cea7d7df06af5e49d230ba24103d27ccc886f1", "0.0.7 registry+https://github.com/rust-lang/crates.io-index 03c4ba47b3596f2771213ff162c792e9b93ddc0cdd178a2e407e00bb8ae4afcd"]],
  ["libcrux-sha2", ["0.0.8 registry+https://github.com/rust-lang/crates.io-index 960e46e1be0b77098cc6ce82137864936ecad3a1b9fd4303dd51202ca140dd1e", "0.0.9 registry+https://github.com/rust-lang/crates.io-index 86aa35d8fc9576a41df34af4d95d1f11186c1f65cd6c829329748915ea556d71"]],
  ["libcrux-sha3", ["0.0.10 registry+https://github.com/rust-lang/crates.io-index c09f5c39afae0528e1f70a3c1e3c6ee649ec1f19dda26fc9b6ea91108fb879ef", "0.0.11 registry+https://github.com/rust-lang/crates.io-index 2c8117e86e1f03417d8ebe50ed298c6ee0b05557783a75697d0c59a2ef2dcfc6"]],
  ["libcrux-traits", ["0.0.8 registry+https://github.com/rust-lang/crates.io-index 3fa7a21e8c2e8baa8b40f0b176740f2ca4baadd79d1b00e48d6b1e363c42085a", "0.0.9 registry+https://github.com/rust-lang/crates.io-index 8958bb5c3780eb7c3355aeeb051629b830e47bfefd36befed93c81b53366bbc4"]],
]);
const BRIDGE_PACKAGE = "openmls_libcrux_crypto";
const BRIDGE_VERSION = "0.4.1";
const BRIDGE_DIR = "rs/crates/openmls-libcrux-crypto-bridge";
const BRIDGE_TREE_SHA256 = "c9110a03f34e6d7c93daf82fbfc13d917ddc3c086cc0f594d456142f19f3df24";
const BRIDGE_PATCH = 'openmls_libcrux_crypto = { path = "crates/openmls-libcrux-crypto-bridge" }';
const BRIDGE_FILES = [
  ".cargo_vcs_info.json", "BRIDGE.md", "CHANGELOG.md", "Cargo.toml",
  "Cargo.toml.orig", "LICENSE", "README.md", "src/crypto.rs", "src/ff1.rs",
  "src/lib.rs", "src/rand.rs", "tests/strict_verification.rs",
];
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

function bridgeTreeDigest(files) {
  const hash = createHash("sha256");
  for (const name of [...files.keys()].sort()) {
    hash.update(name).update("\0").update(files.get(name)).update("\0");
  }
  return hash.digest("hex");
}

function readBridgeFiles() {
  const tracked = execFileSync("git", ["ls-files", "-z", "--", BRIDGE_DIR], { cwd: REPO_ROOT })
    .toString().split("\0").filter(Boolean).map((file) => file.slice(`${BRIDGE_DIR}/`.length)).sort();
  if (JSON.stringify(tracked) !== JSON.stringify([...BRIDGE_FILES].sort())) {
    throw new Error(`${BRIDGE_DIR}: tracked bridge file inventory differs from its reviewed canonical file set`);
  }
  return new Map(BRIDGE_FILES.map((name) => [
    name,
    fs.readFileSync(path.join(REPO_ROOT, BRIDGE_DIR, name), "utf8"),
  ]));
}

function cryptoPackages(
  source,
  relativeFile,
  includePackage = (name) => MODERN_CRYPTO_PACKAGE.test(name),
  expectedPackages = EXPECTED_PACKAGES,
  bridgeFiles,
) {
  const packages = new Map([...expectedPackages].map((name) => [name, []]));
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
    if (name === BRIDGE_PACKAGE) {
      if (version !== BRIDGE_VERSION || packageSource || checksum) {
        throw new Error(`${relativeFile}: ${BRIDGE_PACKAGE} must be the authenticated tracked ${BRIDGE_VERSION} path bridge without registry identity`);
      }
      packages.get(name).push(`${version} tracked:${BRIDGE_TREE_SHA256}`);
      continue;
    }
    if (!version || !packageSource || !checksum) {
      throw new Error(
        `${relativeFile}: ${name} must retain version, registry source, and checksum identity`,
      );
    }
    packages.get(name).push(`${version} ${packageSource} ${checksum}`);
  }
  for (const identities of packages.values()) identities.sort();
  for (const [name, expected] of EXPECTED_MULTIPLE_IDENTITIES) {
    const actual = packages.get(name);
    if (expectedPackages.has(name) && includePackage(name) && actual && JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
      throw new Error(`${relativeFile}: ${name} identities differ from the exact reviewed multi-version set`);
    }
  }
  const missing = [...expectedPackages].filter((name) => packages.get(name).length === 0);
  if (missing.length > 0) {
    throw new Error(
      `${relativeFile}: authoritative modern-crypto inventory is missing ${missing.join(", ")}`,
    );
  }
  for (const [name, identities] of packages) {
    const expectedMultiplicity = EXPECTED_MULTIPLE_IDENTITIES.has(name) ? 2 : 1;
    if (identities.length !== expectedMultiplicity) {
      throw new Error(`${relativeFile}: ${name} has ${identities.length} identities; expected ${expectedMultiplicity}`);
    }
  }
  return packages;
}

function parityFailures(
  sources,
  { includePackage, expectedPackages = EXPECTED_PACKAGES, bridgeFiles, manifests } = {},
) {
  if (LOCKFILES.length !== 4 || new Set(LOCKFILES).size !== 4) {
    return ["crypto lock policy must cover exactly the four independent shipping locks"];
  }
  try {
    const files = bridgeFiles ?? readBridgeFiles();
    if (bridgeTreeDigest(files) !== BRIDGE_TREE_SHA256) throw new Error("tracked bridge source digest differs from reviewed identity");
    const rootManifest = manifests?.get("rs/Cargo.toml") ?? fs.readFileSync(path.join(REPO_ROOT, "rs/Cargo.toml"), "utf8");
    if (!rootManifest.includes(BRIDGE_PATCH)) throw new Error("rs/Cargo.toml does not apply the bridge at its canonical path");
  } catch (error) {
    return [`tracked provider bridge identity failed: ${error.message}`];
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
        cryptoPackages(source, relativeFile, includePackage, expectedPackages, bridgeFiles),
      );
    } catch (error) {
      return [error.message];
    }
  }

  const reference = parsed.get(LOCKFILES[0]);
  const failures = [];
  for (const relativeFile of LOCKFILES.slice(1)) {
    const actual = parsed.get(relativeFile);
    for (const [name, identities] of reference) {
      if (JSON.stringify(actual.get(name)) !== JSON.stringify(identities)) {
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

function appendPackage(source, name) {
  const { block } = packageBlock(source, name);
  return `${source.trimEnd()}\n\n${block.trimStart()}`;
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
  console.log("crypto lock self-test: reviewed four-lock baseline with dual HPKE identities and authenticated path bridge passed");

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

  const bridgeBlock = packageBlock(variantSource, BRIDGE_PACKAGE).block;
  for (const [label, mutate] of [
    ["bridge version", (block) => block.replace(`version = "${BRIDGE_VERSION}"`, 'version = "0.4.0"')],
    ["bridge registry source", (block) => `${block}source = "registry+https://github.com/rust-lang/crates.io-index"\n`],
    ["bridge checksum", (block) => `${block}checksum = "${"0".repeat(64)}"\n`],
  ]) {
    requireRejected(label, baseline, LOCKFILES[0], replacePackageBlock(variantSource, BRIDGE_PACKAGE, mutate), BRIDGE_PACKAGE);
    console.log(`crypto lock self-test: rejected ${label}`);
  }
  requireRejected(
    "unreviewed registry package missing checksum",
    baseline,
    LOCKFILES[0],
    replacePackageBlock(variantSource, "libcrux-kem", (block) => block.replace(/^checksum = "[^"]+"\n/m, "")),
    "libcrux-kem",
  );
  console.log("crypto lock self-test: rejected arbitrary registry identity without checksum");
  requireRejected(
    "unreviewed duplicate HPKE identity",
    baseline,
    LOCKFILES[0],
    appendPackage(variantSource, "hpke-rs"),
    "hpke-rs",
  );
  const skewedHpke = replacePackageBlock(variantSource, "hpke-rs", (block) =>
    block.replace(/^version = "0\.7\.0"$/m, 'version = "0.7.1"'),
  );
  requireRejected("reviewed HPKE source/version skew", baseline, LOCKFILES[0], skewedHpke, "hpke-rs");
  console.log("crypto lock self-test: rejected third HPKE identity and skewed reviewed identity");

  const bridgeFiles = readBridgeFiles();
  const changedBridgeFiles = new Map(bridgeFiles);
  changedBridgeFiles.set("Cargo.toml", `${changedBridgeFiles.get("Cargo.toml")}\n# unreviewed mutation\n`);
  const changedSourceFailures = parityFailures(baseline, { bridgeFiles: changedBridgeFiles });
  if (!changedSourceFailures.some((failure) => failure.includes("bridge source digest"))) {
    throw new Error(`unreviewed bridge source mutation escaped: ${changedSourceFailures.join("; ") || "success"}`);
  }
  const changedManifestFailures = parityFailures(baseline, {
    manifests: new Map([["rs/Cargo.toml", fs.readFileSync(path.join(REPO_ROOT, "rs/Cargo.toml"), "utf8").replace(BRIDGE_PATCH, 'openmls_libcrux_crypto = { path = "../unreviewed" }')]]),
  });
  if (!changedManifestFailures.some((failure) => failure.includes("canonical path"))) {
    throw new Error(`unreviewed bridge patch path escaped: ${changedManifestFailures.join("; ") || "success"}`);
  }
  console.log("crypto lock self-test: rejected altered canonical bridge source and patch path");
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
      `crypto lock parity: all four shipping graphs use the same ${EXPECTED_PACKAGES.size}-package OpenMLS/libcrux/HPKE inventory and identities`,
  );
}
