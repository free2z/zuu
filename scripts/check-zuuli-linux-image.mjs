#!/usr/bin/env node

import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapStep } from "./ci-trust-bootstrap.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contextDir = ".github/containers/zuuli-linux";
const contextFiles = [
  "Dockerfile",
  "ca-certificates.pem",
  "CA-NOTICE.md",
  "install-tls-trust.sh",
  "verify-tls-network.sh",
  "packages.txt",
  "verify-inventory.sh",
  "verify-libxdo.sh",
];
const lockPath = `${contextDir}/image.lock`;
const workflowPath = ".github/workflows/zuuli-linux-image.yml";
const documentationPath = "docs/zuuli/build/ZUULI-LINUX-BUILD-IMAGE.md";
const consumerWorkflows = [
  ".github/workflows/zuuli.yml",
  ".github/workflows/zuuli-packaging.yml",
  ".github/workflows/zuuli-release.yml",
  ".github/workflows/zuuallet.yml",
];
const imageRepository = "ghcr.io/free2z/zuuli-linux-ci";
const lockedImageDigest = "sha256:bb07838e6e6c4a138943e1254a7f1613c4860e4bfabc87fd1e0d18073de1015f";
const lockedImageSourceHash = "c98652088f45faddf23634079a5661e016e20ede36f4a52f1c47dc7911bc70c6";
const lockedImageSourceCommit = "d3a2b6b502c4194a0336adf54088b8c21afb9fbb";
const lockedImagePublicationRun = "39693000496";
const lockedImageAttestation = "58431098";
const lockedImageRekorIndex = "3367845952";
const lockedImage = `${imageRepository}@${lockedImageDigest}`;
const expectedConsumerCount = 8;
const requiredConsumerJobs = new Set([
  ".github/workflows/zuuli.yml:rust_clippy",
  ".github/workflows/zuuli.yml:rust_plugin",
  ".github/workflows/zuuli.yml:rust_msg_plugin",
  ".github/workflows/zuuli.yml:rust_app",
  ".github/workflows/zuuli.yml:zuuallet_schema",
  ".github/workflows/zuuli-packaging.yml:desktop",
  ".github/workflows/zuuli-release.yml:linux",
  ".github/workflows/zuuallet.yml:rust",
]);
const phaseATriggerPaths = [
  ".github/containers/zuuli-linux",
  ".github/workflows/zuuli-linux-image.yml",
  ".github/workflows/zuuallet.yml",
  "docs/zuuli/build/ZUULI-LINUX-BUILD-IMAGE.md",
  "scripts/check-zuuli-linux-image.mjs",
];
const phaseASamplePaths = [
  ".github/containers/zuuli-linux/Dockerfile",
  ".github/workflows/zuuli-linux-image.yml",
  "docs/zuuli/build/ZUULI-LINUX-BUILD-IMAGE.md",
  "scripts/check-zuuli-linux-image.mjs",
];
const schemaGateSamplePaths = [
  "wallet/zuuallet/src-tauri/Cargo.toml",
  "wallet/plugins/tauri-plugin-zcash/build.rs",
  "rust-toolchain.toml",
  "scripts/check-rust-toolchain.sh",
  "scripts/check-tauri-plugin-permissions.mjs",
  "scripts/check-zuuli-linux-image.mjs",
  "z/zcash/librustzcash",
  ".gitmodules",
  ".github/containers/zuuli-linux/Dockerfile",
  ".github/workflows/zuuli.yml",
  ".github/workflows/zuuli-linux-image.yml",
  ".github/actions/zuuli-rust-cache/action.yml",
];
const pinnedActions = [
  "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
  "docker/setup-buildx-action@37fe631027851001ddb9b187196cc803df7f5f0e # v4.3.0",
  "docker/login-action@dbcb813823bdd20940b903addbd779551569679f # v4.6.0",
  "docker/build-push-action@53b7df96c91f9c12dcc8a07bcb9ccacbed38856a # v7.3.0",
  "actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6 # v4.2.2",
];
const pinnedZuualletToolchain =
  "dtolnay/rust-toolchain@032958afbdc797a9164d3bc0b56325c1308924a5 # 1.97.1";
const pinnedGenericToolchain =
  "dtolnay/rust-toolchain@4360b52568e2003a75bf9bc1d59f33a8e3fc893c # stable";
const pinnedRustCache =
  "Swatinem/rust-cache@6323deb102c322ba6fcbdcafc7e3dddab59af2b6 # v2.9.2";
const requiredPackages = [
  "bash",
  "binutils",
  "build-essential",
  "ca-certificates",
  "curl",
  "desktop-file-utils",
  "dpkg-dev",
  "fakeroot",
  "file",
  "git",
  "jq",
  "libayatana-appindicator3-dev",
  "libdbus-1-dev",
  "libfuse2t64",
  "libgtk-3-dev",
  "libjavascriptcoregtk-4.1-dev",
  "librsvg2-dev",
  "libsoup-3.0-dev",
  "libssl-dev",
  "libwebkit2gtk-4.1-dev",
  "libxdo-dev",
  "patchelf",
  "pkg-config",
  "python3",
  "rpm",
  "squashfs-tools",
  "tar",
  "wget",
  "xdg-utils",
  "xz-utils",
  "zsync",
];

function read(root, path) {
  return readFileSync(resolve(root, path), "utf8");
}

function parseLock(contents, failures) {
  const lock = new Map();
  for (const [index, rawLine] of contents.split("\n").entries()) {
    if (rawLine === "") continue;
    const match = rawLine.match(/^([a-z0-9_]+)=([^\s]+)$/);
    if (!match) {
      failures.push(`image.lock:${index + 1}: expected key=value without whitespace`);
      continue;
    }
    if (lock.has(match[1])) failures.push(`image.lock: duplicate key ${match[1]}`);
    lock.set(match[1], match[2]);
  }
  const requiredKeys = [
    "schema_version",
    "phase",
    "repository",
    "base_digest",
    "image_digest",
    "source_sha256",
  ];
  const allowedKeys = [...requiredKeys, "candidate_source_sha256"];
  for (const key of requiredKeys) {
    if (!lock.has(key)) failures.push(`image.lock: missing ${key}`);
  }
  for (const key of lock.keys()) {
    if (!allowedKeys.includes(key)) failures.push(`image.lock: unknown key ${key}`);
  }
  return lock;
}

function contextHash(root) {
  const hash = createHash("sha256");
  for (const file of contextFiles) {
    hash.update(`${file}\0`);
    hash.update(read(root, `${contextDir}/${file}`));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function shellPatternMatches(pattern, path) {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*")
    .replaceAll("?", ".");
  return new RegExp(`^${regex}$`).test(path);
}

function countOccurrences(contents, value) {
  return contents.split(value).length - 1;
}

function workflowJobs(contents, workflow) {
  const starts = [...contents.matchAll(/^  ([a-zA-Z0-9_-]+):\s*$/gm)];
  return starts.map((match, index) => ({
    name: `${workflow}:${match[1]}`,
    contents: contents.slice(match.index, starts[index + 1]?.index ?? contents.length),
  }));
}

function removeRequiredGateDependency(contents, dependency) {
  const jobStarts = [...contents.matchAll(/^  ([a-zA-Z0-9_-]+):\s*$/gm)];
  const gateIndexes = jobStarts
    .map((match, index) => ({ index, match }))
    .filter(({ match }) => match[1] === "gate");
  if (gateIndexes.length !== 1) {
    throw new Error(`expected exactly one gate job, found ${gateIndexes.length}`);
  }

  const [{ index, match }] = gateIndexes;
  const gateStart = match.index;
  const gateEnd = jobStarts[index + 1]?.index ?? contents.length;
  const gate = contents.slice(gateStart, gateEnd);
  const needsMatches = [...gate.matchAll(/^    needs: \[([^\n]*)\]$/gm)];
  if (needsMatches.length !== 1) {
    throw new Error(
      `expected exactly one inline gate needs list, found ${needsMatches.length}`,
    );
  }

  const [needsMatch] = needsMatches;
  const dependencies = needsMatch[1].split(",").map((value) => value.trim());
  if (dependencies.filter((value) => value === dependency).length !== 1) {
    throw new Error(`gate needs list does not contain exactly one ${dependency}`);
  }
  const replacement = `    needs: [${dependencies
    .filter((value) => value !== dependency)
    .join(", ")}]`;
  const mutatedGate =
    gate.slice(0, needsMatch.index) +
    replacement +
    gate.slice(needsMatch.index + needsMatch[0].length);
  if (mutatedGate === gate) {
    throw new Error(`failed to remove ${dependency} from the gate needs list`);
  }

  return contents.slice(0, gateStart) + mutatedGate + contents.slice(gateEnd);
}

function validateConsumerJob(job, failures) {
  const exactTrust = 'git config --global --add safe.directory "$GITHUB_WORKSPACE"';
  const steps = job.contents.match(/^    steps:\s*\n/m);
  const afterBootstrap = steps && job.contents.slice(steps.index + steps[0].length);
  if (!afterBootstrap?.startsWith(bootstrapStep) ||
      !afterBootstrap.slice(bootstrapStep.length).startsWith("      - name: Verify pinned Linux build image\n")) {
    failures.push(`${job.name}: image inventory and Bash smoke must be the first step after the immutable trust bootstrap`);
  }
  if (countOccurrences(job.contents, "working-directory: /") !== 1) {
    failures.push(`${job.name}: pre-checkout inventory must run from an existing absolute directory`);
  }
  if (countOccurrences(job.contents, "- name: Configure exact Git workspace trust") !== 1 ||
      countOccurrences(job.contents, exactTrust) !== 1 ||
      countOccurrences(job.contents, "safe.directory") !== 1) {
    failures.push(`${job.name}: require one narrow exact-workspace Git ownership trust step`);
    return;
  }

  const lines = job.contents.split("\n");
  const trustIndex = lines.findIndex((line) => line.trim() === "- name: Configure exact Git workspace trust");
  const stepIndent = lines[trustIndex].match(/^\s*/)[0];
  let previousStep = trustIndex - 1;
  while (previousStep >= 0 && !lines[previousStep].startsWith(`${stepIndent}- `)) previousStep -= 1;
  if (previousStep < 0 || !lines[previousStep].trim().startsWith("- uses: actions/checkout@")) {
    failures.push(`${job.name}: exact-workspace trust must immediately follow checkout`);
  }

  for (const [label, value] of [
    ["packages-read permission", "packages: read"],
    ["pull-time username", "username: ${{ github.actor }}"],
    ["pull-time credential", "password: ${{ secrets.GITHUB_TOKEN }}"],
    ["explicit Bash default", "shell: bash"],
    ["inventory invocation", "/usr/local/bin/verify-zuuli-linux-image"],
  ]) {
    if (countOccurrences(job.contents.replace(bootstrapStep, ""), value) !== 1) {
      failures.push(`${job.name}: require exactly one ${label}`);
    }
  }

  if (job.name === ".github/workflows/zuuallet.yml:rust") {
    for (const expected of [
      "persist-credentials: false",
      pinnedZuualletToolchain,
      pinnedRustCache,
      "cargo build --locked --manifest-path wallet/zuuallet/src-tauri/Cargo.toml",
      "cargo test --locked",
      "--manifest-path wallet/plugins/tauri-plugin-zcash/Cargo.toml",
    ]) {
      if (countOccurrences(job.contents, expected) !== 1) {
        failures.push(`${job.name}: locked build/test contract is missing ${expected}`);
      }
    }
  }
  if (job.name === ".github/workflows/zuuli.yml:zuuallet_schema") {
    for (const expected of [
      "persist-credentials: false",
      pinnedZuualletToolchain,
      pinnedRustCache,
      "cargo build --locked --manifest-path wallet/zuuallet/src-tauri/Cargo.toml",
      "TAURI_SCHEMA_GENERATION_NONCE",
      "git diff --exit-code",
      "git ls-files --others --exclude-standard",
    ]) {
      if (countOccurrences(job.contents, expected) !== 1) {
        failures.push(`${job.name}: required schema regeneration contract is missing ${expected}`);
      }
    }
  }
}

function validate(root) {
  const failures = [];
  const dockerfile = read(root, `${contextDir}/Dockerfile`);
  const packages = read(root, `${contextDir}/packages.txt`)
    .split("\n")
    .filter(Boolean);
  const inventory = read(root, `${contextDir}/verify-inventory.sh`);
  const workflow = read(root, workflowPath);
  const trustInstaller = read(root, `${contextDir}/install-tls-trust.sh`);
  const tlsNetwork = read(root, `${contextDir}/verify-tls-network.sh`);
  const caHash = "796f1389bfea13c0ed78f663b765baaff54a508e5483786bd6ece73c5e3e3cbe";
  if (createHash("sha256").update(read(root, `${contextDir}/ca-certificates.pem`)).digest("hex") !== caHash) {
    failures.push("TLS trust: public CA checksum mismatch");
  }
  const installCommand = "bash /usr/local/bin/install-zuuli-linux-tls-trust";
  if (countOccurrences(dockerfile, installCommand) !== 2 ||
      dockerfile.indexOf(installCommand) > dockerfile.indexOf("timeout 10m apt-get") ||
      dockerfile.lastIndexOf(installCommand) < dockerfile.indexOf("install -y --no-install-recommends")) {
    failures.push("TLS trust: clean store required before apt network and after package postinst");
  }
  for (const expected of [caHash, "sha256sum --check --status", "rm -rf /etc/ssl/certs /etc/ssl/verified-empty", 'install -m 0644 "$bundle" /etc/ssl/certs/ca-certificates.crt']) {
    if (!trustInstaller.includes(expected)) failures.push(`TLS trust: installer missing ${expected}`);
  }
  for (const expected of [
    "ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt",
    "ENV SSL_CERT_DIR=/etc/ssl/verified-empty",
    "ENV CURL_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt",
    "ENV GIT_SSL_CAINFO=/etc/ssl/certs/ca-certificates.crt",
    "ENV GIT_SSL_CAPATH=/etc/ssl/verified-empty",
    "ENV CARGO_HTTP_CAINFO=/etc/ssl/certs/ca-certificates.crt",
    "ENV RUSTUP_USE_CURL=1",
    "ENV NODE_OPTIONS=--use-openssl-ca",
  ]) {
    if (!dockerfile.includes(expected)) failures.push(`TLS trust: Dockerfile missing ${expected}`);
  }
  for (const expected of [caHash, "unexpected default CA fallback", "CA directory must be empty", "Node must select verified OpenSSL trust", "rustup must use the verified curl transport", "for variable in NODE_EXTRA_CA_CERTS NODE_USE_SYSTEM_CA NODE_TLS_REJECT_UNAUTHORIZED GIT_SSL_NO_VERIFY", '[[ -z "${!variable:-}" ]]']) {
    if (!inventory.includes(expected)) failures.push(`TLS trust: inventory missing ${expected}`);
  }
  for (const expected of ["for kind in dv ov ev", "for variant in g3b g3c", "for prefix in '' aaa-", '[[ "$status" == 60 ]]', "unable to get (local )?issuer certificate", "certificate revoked", "https://example.com/", "https://registry.k8s.io/v2/", "https://registry.k8s.io/v2/:401", "Unexpected valid-control HTTP response"]) {
    if (!tlsNetwork.includes(expected)) failures.push(`TLS network: missing ${expected}`);
  }
  if (countOccurrences(workflow, "/usr/local/bin/verify-zuuli-linux-tls-network") !== 2) {
    failures.push("TLS network: both candidate build and published digest require actual verification");
  }
  const libxdoVerifier = read(root, `${contextDir}/verify-libxdo.sh`);
  const lock = parseLock(read(root, lockPath), failures);
  const documentation = read(root, documentationPath);

  const promotionStart = documentation.indexOf("The current promoted image");
  const promotionEnd =
    promotionStart < 0 ? -1 : documentation.indexOf("\n\n", promotionStart);
  const promotionRecord =
    promotionStart < 0 || promotionEnd < 0
      ? ""
      : documentation.slice(promotionStart, promotionEnd);
  for (const evidence of [
    lockedImageSourceCommit,
    `actions/runs/${lockedImagePublicationRun}`,
    `attestations/${lockedImageAttestation}`,
    lockedImageDigest,
    `Rekor log index ${lockedImageRekorIndex}`,
  ]) {
    if (!promotionRecord.includes(evidence)) {
      failures.push(`documentation: current promotion evidence is missing ${evidence}`);
    }
  }

  if (lock.get("schema_version") !== "1") failures.push("image.lock: schema_version must be 1");
  const phase = lock.get("phase");
  if (phase !== "consumed" && phase !== "candidate") {
    failures.push("image.lock: phase must be consumed or candidate");
  }
  if (lock.get("repository") !== imageRepository) failures.push("image.lock: unexpected repository");
  if (lock.get("image_digest") !== lockedImageDigest) {
    failures.push("image.lock: image_digest must match the reviewed published digest");
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(lock.get("base_digest") ?? "")) {
    failures.push("image.lock: base_digest must be an immutable sha256 digest");
  }
  if (phase === "candidate") {
    if (lock.get("source_sha256") !== lockedImageSourceHash) {
      failures.push("image.lock: candidate must preserve the consumed source binding");
    }
    if (lock.get("candidate_source_sha256") !== contextHash(root)) {
      failures.push("image.lock: candidate_source_sha256 does not match candidate image context");
    }
  } else {
    if (lock.has("candidate_source_sha256")) {
      failures.push("image.lock: consumed phase must not retain a candidate source");
    }
    if (lock.get("source_sha256") !== lockedImageSourceHash) {
      failures.push("image.lock: consumed source must match the validator binding");
    }
    if (lock.get("source_sha256") !== contextHash(root)) {
      failures.push("image.lock: source_sha256 does not match reviewed image context");
    }
  }

  const from = dockerfile.match(/^FROM\s+ubuntu:24\.04@(sha256:[0-9a-f]{64})$/m);
  if (!from) failures.push("Dockerfile: base must be Ubuntu 24.04 pinned by sha256 digest");
  if (from && from[1] !== lock.get("base_digest")) {
    failures.push("Dockerfile: base digest differs from image.lock");
  }
  for (const [label, pattern] of [
    ["Rust installer/toolchain", /\b(rustup|rustc|cargo\s+install)\b/i],
    ["Node dependency state", /\b(node_modules|npm\s+(ci|install))\b/i],
    ["secret", /\b(GITHUB_TOKEN|password|credential)\b/i],
    ["cache mount", /--mount=type=cache/i],
    ["broad context copy", /^\s*(COPY|ADD)\s+\.\s/m],
  ]) {
    if (pattern.test(dockerfile)) failures.push(`Dockerfile: forbidden ${label}`);
  }
  if (/^\s*ADD\s/m.test(dockerfile)) failures.push("Dockerfile: ADD is forbidden");
  for (const expected of [
    "timeout 10m apt-get",
    "Acquire::Retries=5",
    "Acquire::http::Timeout=30",
    "Acquire::https::Timeout=30",
    "timeout 30m apt-get",
    "COPY verify-libxdo.sh /usr/local/bin/verify-zuuli-libxdo",
  ]) {
    if (!dockerfile.includes(expected)) failures.push(`Dockerfile: missing ${expected}`);
  }

  const sortedPackages = [...packages].sort();
  if (new Set(packages).size !== packages.length) failures.push("packages.txt: duplicate package");
  if (packages.join("\n") !== sortedPackages.join("\n")) {
    failures.push("packages.txt: packages must be sorted");
  }
  for (const packageName of requiredPackages) {
    if (!packages.includes(packageName)) failures.push(`packages.txt: missing ${packageName}`);
  }
  for (const packageName of packages) {
    if (!requiredPackages.includes(packageName)) failures.push(`packages.txt: unreviewed ${packageName}`);
  }

  for (const expected of [
    "pkg-config --exists",
    "webkit2gtk-4.1",
    "javascriptcoregtk-4.1",
    "ayatana-appindicator3-0.1",
    "/usr/include/xdo.h",
    "libxdo shared library",
    "desktop-file-validate",
    "dpkg-deb",
    "readelf",
    "python3",
    "rpm2archive",
    "rpmbuild",
    "timeout",
    "unsquashfs",
    "/var/lib/apt/lists",
    "APPIMAGE_EXTRACT_AND_RUN",
    "for forbidden in cargo rustc rustup",
  ]) {
    if (!inventory.includes(expected)) failures.push(`inventory: missing ${expected}`);
  }
  if (!inventory.includes("/usr/local/bin/verify-zuuli-libxdo")) {
    failures.push("inventory: libxdo check must use the complete-cache verifier");
  }
  for (const expected of [
    'linker_cache=$("$ldconfig_command" -p)',
    "readonly linker_cache",
    "grep -E 'libxdo\\.so([[:space:]]|$)'",
    '<<<"$linker_cache" >/dev/null',
  ]) {
    if (!libxdoVerifier.includes(expected)) {
      failures.push(`libxdo verifier: missing ${expected}`);
    }
  }
  if (/ldconfig[^\n]*\|[^\n]*grep\s+-q/.test(libxdoVerifier)) {
    failures.push("libxdo verifier: early-closing grep pipeline is forbidden");
  }

  for (const expected of [
    "pull_request:",
    "schedule:",
    "workflow_dispatch:",
    "platforms: linux/amd64",
    "sbom: true",
    "provenance: mode=max",
    "push-to-registry: true",
    "packages: write",
    "attestations: write",
    "artifact-metadata: write",
    "id-token: write",
    "/usr/local/bin/verify-zuuli-linux-image",
    "ubuntu-24.04-build-${{ github.run_id }}-${{ github.run_attempt }}",
    "subject-name: ${{ env.IMAGE_NAME }}",
    "subject-digest: ${{ steps.publish.outputs.digest }}",
  ]) {
    if (!workflow.includes(expected)) failures.push(`workflow: missing ${expected}`);
  }
  if (/\bapt(-get)?\b/.test(workflow)) failures.push("workflow: live apt commands are forbidden");
  for (const match of workflow.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)) {
    const reference = match[1];
    if (reference.startsWith("./")) continue;
    if (!/@[0-9a-f]{40}$/.test(reference)) {
      failures.push(`workflow: action is not commit-pinned: ${reference}`);
    }
  }
  for (const action of pinnedActions) {
    if (!workflow.includes(action)) failures.push(`workflow: missing reviewed action pin: ${action}`);
  }

  const requiredGate = read(root, consumerWorkflows[0]);
  const gatePatternMatch = requiredGate.match(/case "\$file" in\s*\n\s*([^\n]+)\)\s*\n\s*zuuli=true/);
  if (!gatePatternMatch) {
    failures.push("required gate: cannot parse the ZUULI change-detector patterns");
  } else {
    const gatePatterns = gatePatternMatch[1].split("|").map((pattern) => pattern.trim());
    for (const phaseAPath of phaseASamplePaths) {
      if (!gatePatterns.some((pattern) => shellPatternMatches(pattern, phaseAPath))) {
        failures.push(`required gate: consumed-image policy path must select full wallet jobs: ${phaseAPath}`);
      }
    }
  }
  const fullGateFallbacks = requiredGate.match(/echo "zuuli=true" >> "\$GITHUB_OUTPUT"/g) ?? [];
  if (!requiredGate.includes("set -euo pipefail") || fullGateFallbacks.length < 2) {
    failures.push("required gate: base/diff failures must select the full suite fail-closed");
  }
  const requiredGateJobs = workflowJobs(requiredGate, consumerWorkflows[0]);
  const changesJob = requiredGateJobs.find(
    (job) => job.name === ".github/workflows/zuuli.yml:changes",
  );
  const schemaJob = requiredGateJobs.find(
    (job) => job.name === ".github/workflows/zuuli.yml:zuuallet_schema",
  );
  const gateJob = requiredGateJobs.find(
    (job) => job.name === ".github/workflows/zuuli.yml:gate",
  );
  for (const expected of [
    "node scripts/check-zuuli-linux-image.mjs --self-test",
    "node scripts/check-zuuli-linux-image.mjs",
  ]) {
    const exactLines = (changesJob?.contents ?? "")
      .split("\n")
      .filter((line) => line.trim() === expected);
    if (exactLines.length !== 1) {
      failures.push(`required gate: changes job does not run image/schema policy: ${expected}`);
    }
  }
  const schemaPatternMatch = requiredGate.match(
    /case "\$file" in\s*\n\s*([^\n]+)\)\s*\n\s*zuuallet_schema=true/,
  );
  if (!schemaPatternMatch) {
    failures.push("required gate: cannot parse the Zuuallet schema change-detector patterns");
  } else {
    const schemaPatterns = schemaPatternMatch[1]
      .split("|")
      .map((pattern) => pattern.trim());
    for (const schemaInput of schemaGateSamplePaths) {
      if (!schemaPatterns.some((pattern) => shellPatternMatches(pattern, schemaInput))) {
        failures.push(`required gate: schema input must select regeneration: ${schemaInput}`);
      }
    }
  }
  if (!schemaJob?.contents.includes("if: needs.changes.outputs.zuuallet_schema == 'true'")) {
    failures.push("required gate: Zuuallet schema job is not selected by its change output");
  }
  if (!gateJob?.contents.match(/^\s+needs: \[[^\n]*\bzuuallet_schema\b[^\n]*\]$/m)) {
    failures.push("required gate: gate does not await the Zuuallet schema job");
  }
  for (const expected of [
    "REQUIRED_JOBS_JSON: ${{ toJSON(needs) }}",
    "node scripts/check-github-actions-pins.mjs --verify-gate-results",
  ]) {
    if (!gateJob?.contents.includes(expected)) {
      failures.push(`required gate: gate does not enforce the complete needs context: ${expected}`);
    }
  }
  const schemaGateFallbacks =
    requiredGate.match(/echo "zuuallet_schema=true" >> "\$GITHUB_OUTPUT"/g) ?? [];
  if (schemaGateFallbacks.length < 2) {
    failures.push("required gate: base/diff failures must select schema regeneration fail-closed");
  }
  for (const phaseAPath of phaseATriggerPaths) {
    if (!workflow.includes(phaseAPath)) {
      failures.push(`image workflow: bootstrap path is not covered: ${phaseAPath}`);
    }
  }
  const workflowContents = consumerWorkflows.map((consumer) => [consumer, read(root, consumer)]);
  const consumerContents = workflowContents.map(([, contents]) => contents).join("\n");
  if (countOccurrences(consumerContents, lockedImage) !== expectedConsumerCount) {
    failures.push(`consumers: expected ${expectedConsumerCount} references to the one locked image digest`);
  }
  const imageReferences = [...consumerContents.matchAll(/ghcr\.io\/free2z\/zuuli-linux-ci(?:@sha256:[0-9a-f]+|:[^\s'"}]+)/g)]
    .map((match) => match[0]);
  for (const reference of imageReferences) {
    if (reference !== lockedImage) failures.push(`consumers: mutable or mismatched image reference: ${reference}`);
  }
  for (const [name, value] of [
    ["packages: read permissions", "packages: read"],
    ["pull-time usernames", "username: ${{ github.actor }}"],
    ["pull-time credentials", "password: ${{ secrets.GITHUB_TOKEN }}"],
    ["Bash defaults", "shell: bash"],
    ["inventory invocations", "/usr/local/bin/verify-zuuli-linux-image"],
  ]) {
    if (countOccurrences(consumerContents, value) < expectedConsumerCount) {
      failures.push(`consumers: missing ${name}`);
    }
  }
  const consumerJobs = workflowContents
    .flatMap(([workflow, contents]) => workflowJobs(contents, workflow))
    .filter((job) => job.contents.includes(lockedImage));
  if (consumerJobs.length !== expectedConsumerCount) {
    failures.push(`consumers: expected ${expectedConsumerCount} digest-pinned job blocks`);
  }
  const actualConsumerJobs = new Set(consumerJobs.map((job) => job.name));
  for (const requiredJob of requiredConsumerJobs) {
    if (!actualConsumerJobs.has(requiredJob)) {
      failures.push(`consumers: required digest-pinned job is missing: ${requiredJob}`);
    }
  }
  for (const actualJob of actualConsumerJobs) {
    if (!requiredConsumerJobs.has(actualJob)) {
      failures.push(`consumers: unreviewed digest-pinned job: ${actualJob}`);
    }
  }
  for (const job of consumerJobs) {
    validateConsumerJob(job, failures);
    if (/^\s*(?:- run:\s*)?(?:sudo\s+)?apt(?:-get)?\s/m.test(job.contents)) {
      failures.push(`${job.name}: live apt commands are forbidden in a digest-pinned consumer`);
    }
  }
  if (countOccurrences(consumerContents, "for extension in AppImage deb rpm") < 2 ||
      countOccurrences(consumerContents, "-size +0c") < 2) {
    failures.push("consumers: packaging and release must require nonempty AppImage, deb, and rpm artifacts");
  }

  return failures;
}

function copyFixture(destination) {
  for (const path of [lockPath, workflowPath, documentationPath, ...consumerWorkflows]) {
    const target = resolve(destination, path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(resolve(repoRoot, path), target, { recursive: true });
  }
  mkdirSync(dirname(resolve(destination, contextDir)), { recursive: true });
  cpSync(resolve(repoRoot, contextDir), resolve(destination, contextDir), { recursive: true });
}

function validateLibxdoVerifierRuntime(root) {
  const failures = [];
  const runtimeFixture = mkdtempSync(join(tmpdir(), "zuuli-libxdo-verifier-"));
  try {
    const earlyMatch = resolve(runtimeFixture, "early-match-ldconfig");
    const absent = resolve(runtimeFixture, "absent-ldconfig");
    writeFileSync(
      earlyMatch,
      "#!/usr/bin/env bash\nset -euo pipefail\nprintf 'libxdo.so x86-64\\n'\nseq 1 50000\n",
    );
    writeFileSync(
      absent,
      "#!/usr/bin/env bash\nset -euo pipefail\nprintf 'libsomething-else.so x86-64\\n'\n",
    );
    chmodSync(earlyMatch, 0o755);
    chmodSync(absent, 0o755);

    const verifier = resolve(root, `${contextDir}/verify-libxdo.sh`);
    const positive = spawnSync("bash", [verifier, earlyMatch], {
      encoding: "utf8",
      timeout: 10_000,
    });
    if (positive.status !== 0) {
      failures.push(
        `libxdo verifier: early-match large-output regression failed (${positive.status ?? positive.error?.message ?? "unknown"})`,
      );
    }

    const negative = spawnSync("bash", [verifier, absent], {
      encoding: "utf8",
      timeout: 10_000,
    });
    if (negative.status === 0) {
      failures.push("libxdo verifier: genuinely absent library was accepted");
    }
  } finally {
    rmSync(runtimeFixture, { recursive: true, force: true });
  }
  return failures;
}

function validateTlsNetworkRuntime(root) {
  const fixture = mkdtempSync(join(tmpdir(), "zuuli-tls-classifier-"));
  try {
    const curl = resolve(fixture, "curl");
    writeFileSync(curl, `#!/usr/bin/env bash
case "$*" in
  *emudhra.we-have-a-problem.com*)
    case "$TLS_CASE" in
      issuer) echo 'SSL certificate problem: unable to get local issuer certificate' >&2; exit 60;;
      revoked) echo 'SSL certificate problem: certificate revoked' >&2; exit 60;;
      expired) echo 'SSL certificate problem: certificate has expired' >&2; exit 60;;
      hostname) echo 'no alternative certificate subject name matches' >&2; exit 60;;
      timeout) echo 'connection timed out' >&2; exit 28;;
      accepted) exit 0;;
      control|badstatus) echo 'SSL certificate problem: unable to get local issuer certificate' >&2; exit 60;;
    esac;;
  *) [[ "$TLS_CASE" != control ]] || exit 60; if [[ "$TLS_CASE" == badstatus ]]; then printf 500; else printf 200; fi;;
esac
`);
    chmodSync(curl, 0o755);
    for (const scenario of ["issuer", "revoked", "expired", "hostname", "timeout", "accepted", "control", "badstatus"]) {
      const result = spawnSync("bash", [resolve(root, `${contextDir}/verify-tls-network.sh`)], {
        env: { ...process.env, PATH: `${fixture}:${process.env.PATH}`, TLS_CASE: scenario },
        encoding: "utf8",
        timeout: 10_000,
      });
      const expected = scenario === "issuer" || scenario === "revoked";
      if (result.error || (result.status === 0) !== expected ||
          (expected && !result.stdout.includes("rejections=12 valid_controls=2"))) {
        throw new Error(`TLS network classifier mishandled ${scenario}`);
      }
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

function runSelfTest() {
  const fixture = mkdtempSync(join(tmpdir(), "zuuli-linux-image-policy-"));
  const removeChangeDetectorPatterns = (value, outputName, targets) => {
    const lines = value.split("\n");
    const candidates = [];
    for (let index = 0; index + 2 < lines.length; index += 1) {
      if (
        lines[index].trim() === 'case "$file" in' &&
        lines[index + 2].trim() === `${outputName}=true`
      ) {
        candidates.push(index + 1);
      }
    }
    if (candidates.length !== 1) {
      throw new Error(
        `self-test mutation target must find exactly one ${outputName} detector; found ${candidates.length}`,
      );
    }

    const patternIndex = candidates[0];
    const match = lines[patternIndex].match(/^(\s*)(.*)\)$/);
    if (!match) {
      throw new Error(`self-test mutation target cannot parse ${outputName} detector patterns`);
    }
    const patterns = match[2].split("|");
    for (const target of targets) {
      const targetCount = patterns.filter((pattern) => pattern === target).length;
      if (targetCount !== 1) {
        throw new Error(
          `self-test mutation target must find ${target} exactly once in ${outputName}; found ${targetCount}`,
        );
      }
    }
    lines[patternIndex] = `${match[1]}${patterns.filter((pattern) => !targets.includes(pattern)).join("|")})`;
    return lines.join("\n");
  };
  const asCandidateLock = (value, candidateHash) => {
    const withoutCandidate = value.replace(/^candidate_source_sha256=.*\n?/m, "");
    return `${withoutCandidate.replace(/^phase=.*$/m, "phase=candidate").trimEnd()}\n` +
      `candidate_source_sha256=${candidateHash}\n`;
  };
  try {
    copyFixture(fixture);
    const baseline = validate(fixture);
    if (baseline.length > 0) throw new Error(`baseline fixture failed: ${baseline.join("; ")}`);
    validateTlsNetworkRuntime(fixture);
    const runtimeBaseline = validateLibxdoVerifierRuntime(fixture);
    if (runtimeBaseline.length > 0) {
      throw new Error(`libxdo runtime fixture failed: ${runtimeBaseline.join("; ")}`);
    }

    const cases = [
      {
        name: "modified public roots",
        path: `${contextDir}/ca-certificates.pem`,
        mutate: (value) => `${value}\n`,
        expected: "public CA checksum mismatch",
      },
      {
        name: "missing pre-network trust installation",
        path: `${contextDir}/Dockerfile`,
        mutate: (value) => value.replace("RUN bash /usr/local/bin/install-zuuli-linux-tls-trust", "RUN true"),
        expected: "before apt network and after package postinst",
      },
      {
        name: "missing postinst trust installation",
        path: `${contextDir}/Dockerfile`,
        mutate: (value) => value.replace("&& bash /usr/local/bin/install-zuuli-linux-tls-trust", "&& true"),
        expected: "before apt network and after package postinst",
      },
      {
        name: "hashed alternate roots preserved",
        path: `${contextDir}/install-tls-trust.sh`,
        mutate: (value) => value.replace("rm -rf /etc/ssl/certs /etc/ssl/verified-empty", "true"),
        expected: "TLS trust: installer missing",
      },
      {
        name: "Node bundled roots selected",
        path: `${contextDir}/Dockerfile`,
        mutate: (value) => value.replace("ENV NODE_OPTIONS=--use-openssl-ca", "ENV NODE_OPTIONS=--use-bundled-ca"),
        expected: "TLS trust: Dockerfile missing ENV NODE_OPTIONS",
      },
      {
        name: "custom roots and verification bypass guard removed",
        path: `${contextDir}/verify-inventory.sh`,
        mutate: (value) => value.replace("for variable in NODE_EXTRA_CA_CERTS NODE_USE_SYSTEM_CA NODE_TLS_REJECT_UNAUTHORIZED GIT_SSL_NO_VERIFY", "for variable in UNUSED"),
        expected: "TLS trust: inventory missing for variable in NODE_EXTRA_CA_CERTS",
      },
      {
        name: "network rejection accepts a timeout",
        path: `${contextDir}/verify-tls-network.sh`,
        mutate: (value) => value.replace('[[ "$status" == 60 ]]', '[[ "$status" != 0 ]]'),
        expected: "TLS network: missing",
      },
      {
        name: "published image skips actual TLS proof",
        path: workflowPath,
        mutate: (value) => value.replaceAll("/usr/local/bin/verify-zuuli-linux-tls-network", "/bin/true"),
        expected: "TLS network: both",
      },
      {
        name: "mismatched lock digest",
        path: lockPath,
        mutate: (value) => value.replace(lockedImageDigest, `${lockedImageDigest.slice(0, -1)}0`),
        expected: "image_digest",
      },
      ...[
        ["source commit", lockedImageSourceCommit],
        ["publication run", `actions/runs/${lockedImagePublicationRun}`],
        ["attestation", `attestations/${lockedImageAttestation}`],
        ["digest", lockedImageDigest],
        ["Rekor index", `Rekor log index ${lockedImageRekorIndex}`],
      ].map(([name, evidence]) => ({
        name: `stale documented promotion ${name}`,
        path: documentationPath,
        mutate: (value) => value.replace(evidence, `${evidence.slice(0, -1)}0`),
        expected: "current promotion evidence",
      })),
      {
        name: "candidate overwrites consumed source binding",
        path: lockPath,
        mutate: (value) => asCandidateLock(value, lockedImageSourceHash).replace(
          `source_sha256=${lockedImageSourceHash}`,
          `source_sha256=${"0".repeat(64)}`,
        ),
        expected: "preserve the consumed source binding",
      },
      {
        name: "candidate source hash does not match candidate context",
        path: lockPath,
        mutate: (value) => asCandidateLock(value, "0".repeat(64)),
        expected: "candidate_source_sha256",
      },
      {
        name: "promotion forgets to refresh validator source binding",
        mutateFixture: (root) => {
          const dockerfilePath = resolve(root, `${contextDir}/Dockerfile`);
          writeFileSync(dockerfilePath, `${readFileSync(dockerfilePath, "utf8")}\n# next candidate\n`);
          const candidate = contextHash(root);
          const fixtureLock = resolve(root, lockPath);
          writeFileSync(
            fixtureLock,
            asCandidateLock(readFileSync(fixtureLock, "utf8"), candidate)
              .replace("phase=candidate", "phase=consumed")
              .replace(`source_sha256=${lockedImageSourceHash}`, `source_sha256=${candidate}`)
              .replace(/^candidate_source_sha256=.*\n/m, ""),
          );
        },
        expected: "validator binding",
      },
      {
        name: "baked Rust toolchain",
        path: `${contextDir}/Dockerfile`,
        mutate: (value) => `${value}\nRUN rustup toolchain install stable\n`,
        expected: "Rust installer/toolchain",
      },
      {
        name: "missing native package",
        path: `${contextDir}/packages.txt`,
        mutate: (value) => value.replace("libwebkit2gtk-4.1-dev\n", ""),
        expected: "missing libwebkit2gtk-4.1-dev",
      },
      {
        name: "missing explicit ELF inspection package",
        path: `${contextDir}/packages.txt`,
        mutate: (value) => value.replace("binutils\n", ""),
        expected: "missing binutils",
      },
      {
        name: "substituted SquashFS extraction package",
        path: `${contextDir}/packages.txt`,
        mutate: (value) => value.replace("squashfs-tools\n", "cpio\n"),
        expected: "missing squashfs-tools",
      },
      ...["readelf", "rpm2archive", "unsquashfs"].map((command) => ({
        name: `missing ${command} inventory contract`,
        path: `${contextDir}/verify-inventory.sh`,
        mutate: (value) => value.replace(`  ${command} \\\n`, ""),
        expected: `inventory: missing ${command}`,
      })),
      {
        name: "substituted RPM archive extractor",
        path: `${contextDir}/verify-inventory.sh`,
        mutate: (value) => value.replace("  rpm2archive \\\n", "  rpm2cpio \\\n"),
        expected: "inventory: missing rpm2archive",
      },
      {
        name: "mutable consumer image",
        path: consumerWorkflows[0],
        mutate: (value) => value.replace(lockedImage, `${imageRepository}:ubuntu-24.04`),
        expected: "mutable or mismatched",
      },
      {
        name: "mismatched consumer digest",
        path: consumerWorkflows[0],
        mutate: (value) => value.replace(lockedImageDigest, `${lockedImageDigest.slice(0, -1)}0`),
        expected: "one locked image digest",
      },
      {
        name: "missing required-gate policy path",
        path: consumerWorkflows[0],
        mutate: (value) => value.replace("scripts/check-zuuli-linux-image.mjs|", ""),
        expected: "policy path must select",
      },
      {
        name: "Zuuallet workflow no longer triggers image policy",
        path: workflowPath,
        mutate: (value) => value.replaceAll("      - .github/workflows/zuuallet.yml\n", ""),
        expected: "bootstrap path is not covered: .github/workflows/zuuallet.yml",
      },
      {
        name: "fail-open required-gate fallback",
        path: consumerWorkflows[0],
        mutate: (value) => value.replace(
          'echo "zuuli=true" >> "$GITHUB_OUTPUT"',
          'echo "zuuli=false" >> "$GITHUB_OUTPUT"',
        ),
        expected: "select the full suite fail-closed",
      },
      {
        name: "schema regeneration detached from required gate",
        path: consumerWorkflows[0],
        mutate: (value) =>
          removeRequiredGateDependency(value, "zuuallet_schema"),
        expected: "gate does not await the Zuuallet schema job",
      },
      {
        name: "schema result detached from complete-needs verifier",
        path: consumerWorkflows[0],
        mutate: (value) => value.replace(
          "          node scripts/check-github-actions-pins.mjs --verify-gate-results\n",
          "          echo \"$REQUIRED_JOBS_JSON\"\n",
        ),
        expected: "gate does not enforce the complete needs context",
      },
      {
        name: "schema policy removed from always-required changes job",
        path: consumerWorkflows[0],
        mutate: (value) => value.replace(
          "          node scripts/check-zuuli-linux-image.mjs --self-test\n",
          "",
        ),
        expected: "changes job does not run image/schema policy",
      },
      {
        name: "Zuuallet source stops selecting schema regeneration",
        path: consumerWorkflows[0],
        mutate: (value) =>
          removeChangeDetectorPatterns(
            value,
            "zuuallet_schema",
            ["wallet/zuuallet/src-tauri/*", "wallet/*/Cargo.toml"],
          ),
        expected: "schema input must select regeneration: wallet/zuuallet/src-tauri/Cargo.toml",
      },
      {
        name: "plugin source stops selecting schema regeneration",
        path: consumerWorkflows[0],
        mutate: (value) =>
          removeChangeDetectorPatterns(
            value,
            "zuuallet_schema",
            ["wallet/plugins/*", "wallet/*.rs"],
          ),
        expected: "schema input must select regeneration: wallet/plugins/tauri-plugin-zcash/build.rs",
      },
      {
        name: "schema policy changes stop selecting regeneration",
        path: consumerWorkflows[0],
        mutate: (value) =>
          removeChangeDetectorPatterns(
            value,
            "zuuallet_schema",
            ["scripts/check-zuuli-linux-image.mjs"],
          ),
        expected: "schema input must select regeneration: scripts/check-zuuli-linux-image.mjs",
      },
      {
        name: "fail-open schema regeneration fallback",
        path: consumerWorkflows[0],
        mutate: (value) => value.replace(
          'echo "zuuallet_schema=true" >> "$GITHUB_OUTPUT"',
          'echo "zuuallet_schema=false" >> "$GITHUB_OUTPUT"',
        ),
        expected: "select schema regeneration fail-closed",
      },
      {
        name: "mismatched attestation digest",
        path: workflowPath,
        mutate: (value) => value.replace(
          "subject-digest: ${{ steps.publish.outputs.digest }}",
          "subject-digest: sha256:deadbeef",
        ),
        expected: "subject-digest",
      },
      {
        name: "reintroduced live apt",
        path: consumerWorkflows[0],
        mutate: (value) => value.replace(
          '      - name: Configure exact Git workspace trust\n        run: git config --global --add safe.directory "$GITHUB_WORKSPACE"',
          '      - name: Configure exact Git workspace trust\n        run: git config --global --add safe.directory "$GITHUB_WORKSPACE"\n      - run: apt-get update',
        ),
        expected: "live apt commands",
      },
      {
        name: "Zuuallet consumer reintroduced live apt",
        path: consumerWorkflows[3],
        mutate: (value) => value.replace(
          '      - name: Configure exact Git workspace trust\n        run: git config --global --add safe.directory "$GITHUB_WORKSPACE"',
          '      - name: Configure exact Git workspace trust\n        run: git config --global --add safe.directory "$GITHUB_WORKSPACE"\n      - run: sudo apt-get update',
        ),
        expected: "live apt commands",
      },
      {
        name: "Zuuallet checkout retains credentials",
        path: consumerWorkflows[3],
        mutate: (value) => {
          const consumerStart = value.indexOf(lockedImage);
          return value.slice(0, consumerStart) + value.slice(consumerStart)
            .replace("persist-credentials: false", "persist-credentials: true");
        },
        expected: "persist-credentials: false",
      },
      {
        name: "Zuuallet build drops the locked graph",
        path: consumerWorkflows[3],
        mutate: (value) => value.replace(
          "cargo build --locked --manifest-path wallet/zuuallet/src-tauri/Cargo.toml",
          "cargo build --manifest-path wallet/zuuallet/src-tauri/Cargo.toml",
        ),
        expected: "cargo build --locked",
      },
      {
        name: "Zuuallet required build floats its Rust toolchain",
        path: consumerWorkflows[3],
        mutate: (value) => value.replace(
          pinnedZuualletToolchain,
          pinnedGenericToolchain,
        ),
        expected: pinnedZuualletToolchain,
      },
      {
        name: "missing pull-time credential",
        path: consumerWorkflows[0],
        mutate: (value) => value.replace("password: ${{ secrets.GITHUB_TOKEN }}", "password: missing"),
        expected: "pull-time credentials",
      },
      {
        name: "inventory is not first",
        path: consumerWorkflows[0],
        mutate: (value) => value.replace("      - name: Verify pinned Linux build image", "      - run: true\n      - name: Verify pinned Linux build image"),
        expected: "must be the first step",
      },
      {
        name: "pre-checkout inventory uses a missing workspace",
        path: consumerWorkflows[1],
        mutate: (value) => value.replace("working-directory: /", "working-directory: wallet/zuuli"),
        expected: "pre-checkout inventory",
      },
      {
        name: "wildcard Git ownership trust",
        path: consumerWorkflows[0],
        mutate: (value) => value.replace(
          'git config --global --add safe.directory "$GITHUB_WORKSPACE"',
          "git config --global --add safe.directory '*'",
        ),
        expected: "narrow exact-workspace Git ownership trust",
      },
      {
        name: "broad Git ownership trust",
        path: consumerWorkflows[0],
        mutate: (value) => value.replace(
          'git config --global --add safe.directory "$GITHUB_WORKSPACE"',
          'git config --global --add safe.directory "/__w"',
        ),
        expected: "narrow exact-workspace Git ownership trust",
      },
      {
        name: "missing Git ownership trust",
        path: consumerWorkflows[0],
        mutate: (value) => value.replace(
          '      - name: Configure exact Git workspace trust\n        run: git config --global --add safe.directory "$GITHUB_WORKSPACE"\n',
          "",
        ),
        expected: "narrow exact-workspace Git ownership trust",
      },
      {
        name: "Git ownership trust moved before checkout",
        path: consumerWorkflows[0],
        mutate: (value) => value.replace(
          `      - uses: ${pinnedActions[0]}\n      - name: Configure exact Git workspace trust\n        run: git config --global --add safe.directory "$GITHUB_WORKSPACE"`,
          `      - name: Configure exact Git workspace trust\n        run: git config --global --add safe.directory "$GITHUB_WORKSPACE"\n      - uses: ${pinnedActions[0]}`,
        ),
        expected: "must immediately follow checkout",
      },
      {
        name: "missing package format acceptance",
        path: consumerWorkflows[1],
        mutate: (value) => value.replace("for extension in AppImage deb rpm", "for extension in AppImage deb"),
        expected: "nonempty AppImage, deb, and rpm",
      },
    ];

    for (const testCase of cases) {
      copyFixture(fixture);
      if (testCase.mutateFixture) {
        testCase.mutateFixture(fixture);
      } else {
        const path = resolve(fixture, testCase.path);
        writeFileSync(path, testCase.mutate(readFileSync(path, "utf8")));
      }
      const failures = validate(fixture);
      if (!failures.some((failure) => failure.includes(testCase.expected))) {
        throw new Error(`${testCase.name}: validator did not report ${testCase.expected}`);
      }
    }

    copyFixture(fixture);
    const unsafeVerifier = resolve(fixture, `${contextDir}/verify-libxdo.sh`);
    writeFileSync(
      unsafeVerifier,
      readFileSync(unsafeVerifier, "utf8")
        .replace('linker_cache=$("$ldconfig_command" -p)\nreadonly linker_cache\n\n', "")
        .replace(
          "grep -E 'libxdo\\.so([[:space:]]|$)' <<<\"$linker_cache\" >/dev/null",
          '"$ldconfig_command" -p | grep -qE \'libxdo\\.so([[:space:]]|$)\'',
        ),
    );
    const unsafeRuntime = validateLibxdoVerifierRuntime(fixture);
    if (!unsafeRuntime.some((failure) => failure.includes("early-match large-output"))) {
      throw new Error("unsafe grep -q pipeline unexpectedly passed the SIGPIPE regression");
    }

    console.log(
      `ZUULI Linux image policy self-test passed (${cases.length} negative cases + TLS classifier/libxdo runtime cases).`,
    );
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

const failures = validate(repoRoot);
if (failures.length > 0) {
  console.error("ZUULI Linux image policy verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`ZUULI Linux image policy passed (${relative(repoRoot, resolve(repoRoot, contextDir))}).`);
if (process.argv.includes("--self-test")) runSelfTest();
