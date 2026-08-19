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
const lockedImageDigest = "sha256:bc66315a17723a6a828a8d3c91733ff2e06f164d18a17de72acf199cc27381d1";
const lockedImage = `${imageRepository}@${lockedImageDigest}`;
const expectedConsumerCount = 5;
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

function validateConsumerJob(job, failures) {
  const exactTrust = 'git config --global --add safe.directory "$GITHUB_WORKSPACE"';
  const inventoryFirst = job.contents.match(/steps:\s*\n\s*- name: Verify pinned Linux build image/);
  if (!inventoryFirst) {
    failures.push(`${job.name}: image inventory and Bash smoke must be the first step`);
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
  if (lock.get("phase") !== "consumed") failures.push("image.lock: Phase B must be consumed");
  if (lock.get("repository") !== imageRepository) failures.push("image.lock: unexpected repository");
  if (lock.get("image_digest") !== lockedImageDigest) {
    failures.push("image.lock: image_digest must match the reviewed published digest");
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
      if (!gatePatterns.some((pattern) => shellPatternMatches(pattern, phaseAPath))) {
        failures.push(`required gate: consumed-image policy path must select full wallet jobs: ${phaseAPath}`);
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
  if (/^\s*(?:- run:\s*)?(?:sudo\s+)?apt(?:-get)?\s/m.test(consumerContents)) {
    failures.push("consumers: live apt commands are forbidden after digest promotion");
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
  for (const job of consumerJobs) validateConsumerJob(job, failures);
  if (countOccurrences(consumerContents, "for extension in AppImage deb rpm") < 2 ||
      countOccurrences(consumerContents, "-size +0c") < 2) {
    failures.push("consumers: packaging and release must require nonempty AppImage, deb, and rpm artifacts");
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
        name: "mismatched lock digest",
        path: lockPath,
        mutate: (value) => value.replace(lockedImageDigest, `${lockedImageDigest.slice(0, -1)}0`),
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
      {
        name: "reintroduced live apt",
        path: consumerWorkflows[0],
        mutate: (value) => `${value}\n      - run: apt-get update\n`,
        expected: "live apt commands",
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
        mutate: (value) => value.replace("steps:\n      - name: Verify pinned Linux build image", "steps:\n      - run: true\n      - name: Verify pinned Linux build image"),
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
          '      - uses: actions/checkout@v7\n      - name: Configure exact Git workspace trust\n        run: git config --global --add safe.directory "$GITHUB_WORKSPACE"',
          '      - name: Configure exact Git workspace trust\n        run: git config --global --add safe.directory "$GITHUB_WORKSPACE"\n      - uses: actions/checkout@v7',
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
