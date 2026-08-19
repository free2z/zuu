#!/usr/bin/env node

import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contextDir = ".github/containers/zuuli-linux";
const contextFiles = ["Dockerfile", "packages.txt", "verify-inventory.sh"];
const lockPath = `${contextDir}/image.lock`;
const workflowPath = ".github/workflows/zuuli-linux-image.yml";
const consumerWorkflows = [
  ".github/workflows/zuuli.yml",
  ".github/workflows/zuuli-packaging.yml",
  ".github/workflows/zuuli-release.yml",
];
const imageRepository = "ghcr.io/free2z/zuuli-linux-ci";
const phaseATriggerPaths = [
  ".github/containers/zuuli-linux",
  ".github/workflows/zuuli-linux-image.yml",
  "docs/ZUULI-LINUX-BUILD-IMAGE.md",
  "scripts/check-zuuli-linux-image.mjs",
];
const phaseASamplePaths = [
  ".github/containers/zuuli-linux/Dockerfile",
  ".github/workflows/zuuli-linux-image.yml",
  "docs/ZUULI-LINUX-BUILD-IMAGE.md",
  "scripts/check-zuuli-linux-image.mjs",
];
const pinnedActions = [
  "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
  "docker/setup-buildx-action@37fe631027851001ddb9b187196cc803df7f5f0e # v4.3.0",
  "docker/login-action@dbcb813823bdd20940b903addbd779551569679f # v4.6.0",
  "docker/build-push-action@53b7df96c91f9c12dcc8a07bcb9ccacbed38856a # v7.3.0",
  "actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6 # v4.2.2",
];
const requiredPackages = [
  "bash",
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
  "rpm",
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
  const expectedKeys = [
    "schema_version",
    "phase",
    "repository",
    "base_digest",
    "image_digest",
    "source_sha256",
  ];
  for (const key of expectedKeys) {
    if (!lock.has(key)) failures.push(`image.lock: missing ${key}`);
  }
  for (const key of lock.keys()) {
    if (!expectedKeys.includes(key)) failures.push(`image.lock: unknown key ${key}`);
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

function validate(root) {
  const failures = [];
  const dockerfile = read(root, `${contextDir}/Dockerfile`);
  const packages = read(root, `${contextDir}/packages.txt`)
    .split("\n")
    .filter(Boolean);
  const inventory = read(root, `${contextDir}/verify-inventory.sh`);
  const lock = parseLock(read(root, lockPath), failures);
  const workflow = read(root, workflowPath);

  if (lock.get("schema_version") !== "1") failures.push("image.lock: schema_version must be 1");
  if (lock.get("phase") !== "bootstrap") failures.push("image.lock: Phase A must remain bootstrap");
  if (lock.get("repository") !== imageRepository) failures.push("image.lock: unexpected repository");
  if (lock.get("image_digest") !== "UNPUBLISHED") {
    failures.push("image.lock: Phase A image_digest must be UNPUBLISHED");
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(lock.get("base_digest") ?? "")) {
    failures.push("image.lock: base_digest must be an immutable sha256 digest");
  }
  if (lock.get("source_sha256") !== contextHash(root)) {
    failures.push("image.lock: source_sha256 does not match reviewed image context");
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
    "rpmbuild",
    "timeout",
    "/var/lib/apt/lists",
    "APPIMAGE_EXTRACT_AND_RUN",
    "for forbidden in cargo rustc rustup",
  ]) {
    if (!inventory.includes(expected)) failures.push(`inventory: missing ${expected}`);
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
      if (gatePatterns.some((pattern) => shellPatternMatches(pattern, phaseAPath))) {
        failures.push(`required gate: bootstrap path unexpectedly selects full wallet jobs: ${phaseAPath}`);
      }
    }
  }
  const fullGateFallbacks = requiredGate.match(/echo "zuuli=true" >> "\$GITHUB_OUTPUT"/g) ?? [];
  if (!requiredGate.includes("set -euo pipefail") || fullGateFallbacks.length < 2) {
    failures.push("required gate: base/diff failures must select the full suite fail-closed");
  }
  for (const phaseAPath of phaseATriggerPaths) {
    if (!workflow.includes(phaseAPath)) {
      failures.push(`image workflow: bootstrap path is not covered: ${phaseAPath}`);
    }
  }
  for (const consumer of consumerWorkflows) {
    const contents = read(root, consumer);
    if (contents.includes(imageRepository)) {
      failures.push(`${consumer}: Phase A must not consume the unpublished image`);
    }
  }

  return failures;
}

function copyFixture(destination) {
  for (const path of [lockPath, workflowPath, ...consumerWorkflows]) {
    const target = resolve(destination, path);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(resolve(repoRoot, path), target, { recursive: true });
  }
  mkdirSync(dirname(resolve(destination, contextDir)), { recursive: true });
  cpSync(resolve(repoRoot, contextDir), resolve(destination, contextDir), { recursive: true });
}

function runSelfTest() {
  const fixture = mkdtempSync(join(tmpdir(), "zuuli-linux-image-policy-"));
  try {
    copyFixture(fixture);
    const baseline = validate(fixture);
    if (baseline.length > 0) throw new Error(`baseline fixture failed: ${baseline.join("; ")}`);

    const cases = [
      {
        name: "mutable image reference",
        path: lockPath,
        mutate: (value) => value.replace("image_digest=UNPUBLISHED", "image_digest=latest"),
        expected: "image_digest",
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
        name: "premature consumer",
        path: consumerWorkflows[0],
        mutate: (value) => `${value}\n# ${imageRepository}:latest\n`,
        expected: "must not consume",
      },
      {
        name: "overbroad required-gate pattern",
        path: consumerWorkflows[0],
        mutate: (value) => value.replace("scripts/check-rust-clippy.sh|", "scripts/*|"),
        expected: "bootstrap path unexpectedly selects",
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
        name: "mismatched attestation digest",
        path: workflowPath,
        mutate: (value) => value.replace(
          "subject-digest: ${{ steps.publish.outputs.digest }}",
          "subject-digest: sha256:deadbeef",
        ),
        expected: "subject-digest",
      },
    ];

    for (const testCase of cases) {
      copyFixture(fixture);
      const path = resolve(fixture, testCase.path);
      writeFileSync(path, testCase.mutate(readFileSync(path, "utf8")));
      const failures = validate(fixture);
      if (!failures.some((failure) => failure.includes(testCase.expected))) {
        throw new Error(`${testCase.name}: validator did not report ${testCase.expected}`);
      }
    }
    console.log(`ZUULI Linux image policy self-test passed (${cases.length} negative cases).`);
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
