#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = resolve(appDir, "../..");
const readRepo = (path) => readFileSync(resolve(repoDir, path), "utf8");
const failures = [];

function requireText(label, contents, expected) {
  if (!contents.includes(expected)) failures.push(`${label}: missing ${expected}`);
}

function rejectText(label, contents, forbidden) {
  if (contents.includes(forbidden)) failures.push(`${label}: contains ${forbidden}`);
}

function count(contents, value) {
  return contents.split(value).length - 1;
}

function requireCount(label, contents, value, expected) {
  const actual = count(contents, value);
  if (actual !== expected) {
    failures.push(`${label}: expected ${expected}, found ${actual}`);
  }
}

function triggerPaths(label, contents, event) {
  let workflow;
  try {
    workflow = parse(contents);
  } catch (error) {
    failures.push(
      `${label}: invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
  const paths = workflow?.on?.[event]?.paths;
  if (!Array.isArray(paths) || !paths.every((path) => typeof path === "string")) {
    failures.push(`${label}: on.${event}.paths must be a string list`);
    return [];
  }
  return paths;
}

function pathFilterCovers(pattern, path) {
  if (pattern.endsWith("/**")) return path.startsWith(pattern.slice(0, -2));
  return pattern === path;
}

const action = readRepo(".github/actions/zuuli-rust-cache/action.yml");
const packaging = readRepo(".github/workflows/zuuli-packaging.yml");
const release = readRepo(".github/workflows/zuuli-release.yml");
const storeAudit = readRepo(".github/workflows/zuuli-store-audit.yml");
const storePublish = readRepo(".github/workflows/zuuli-store-publish.yml");
const cleanup = readRepo(".github/workflows/cache-cleanup.yml");
const requiredGate = readRepo(".github/workflows/zuuli.yml");
const localAction = "uses: ./.github/actions/zuuli-rust-cache";
const cacheFamilies = [
  "zuuli-release-android-universal-v2-rust-${{ env.ZUULI_RUST_VERSION }}-ndk-${{ env.ZUULI_ANDROID_NDK_VERSION }}-api29-aarch64-armv7-i686-x86_64",
  "zuuli-release-ios-device-v2-rust-${{ env.ZUULI_RUST_VERSION }}-xcode-${{ env.ZUULI_XCODE_VERSION }}-ios18-aarch64-device",
  "zuuli-release-linux-v2-rust-${{ env.ZUULI_RUST_VERSION }}-ubuntu-24.04-gtk-webkit-4.1",
  "zuuli-release-macos-universal-v2-rust-${{ env.ZUULI_RUST_VERSION }}-xcode-${{ env.ZUULI_XCODE_VERSION }}-macos-arm64-x86_64",
];
const packagingLocalInputs = [
  // Direct scripts and configuration consumed from the broad ZUULI tree.
  "wallet/zuuli/package-lock.json",
  "wallet/zuuli/package.json",
  "wallet/zuuli/scripts/android-toolchain-env.sh",
  "wallet/zuuli/scripts/artifact-sbom.mjs",
  "wallet/zuuli/scripts/normalize-generated-ios-project.mjs",
  "wallet/zuuli/scripts/release-identity.mjs",
  "wallet/zuuli/scripts/release-manifest.mjs",
  "wallet/zuuli/scripts/verify-ci-cache-policy.mjs",
  "wallet/zuuli/scripts/verify-ios-ipa.sh",
  "wallet/zuuli/syft.yaml",
  "wallet/zuuli/syft-artifact.yaml",
  // Inputs outside wallet/zuuli/** that builds or contract checks consume.
  "wallet/plugins/tauri-plugin-zcash/Cargo.toml",
  "wallet/rust-toolchain.toml",
  "scripts/check-rust-toolchain.sh",
  "z/zcash/librustzcash",
  ".gitmodules",
  ".github/actions/zuuli-rust-cache/action.yml",
  ".github/workflows/cache-cleanup.yml",
  ".github/workflows/zuuli.yml",
  ".github/workflows/zuuli-packaging.yml",
  ".github/workflows/zuuli-release.yml",
  ".github/workflows/zuuli-store-audit.yml",
  ".github/workflows/zuuli-store-publish.yml",
  ".github/workflows/zuuli-testflight-bootstrap.yml",
  ".github/workflows/zuuli-testflight-recovery.yml",
];

function job(contents, name, nextName) {
  const startMarker = `\n  ${name}:\n`;
  const endMarker = `\n  ${nextName}:\n`;
  const start = contents.indexOf(startMarker);
  const end = contents.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) {
    failures.push(`workflow: cannot isolate ${name} job`);
    return "";
  }
  return contents.slice(start, end);
}

requireText(
  "cache action",
  action,
  "Swatinem/rust-cache@6323deb102c322ba6fcbdcafc7e3dddab59af2b6",
);
requireText(
  "cache action",
  action,
  "workspaces: wallet/zuuli/src-tauri -> target",
);
requireText("cache action", action, 'default: "false"');
requireText("cache action", action, 'cache-bin: "false"');
requireText("cache action", action, 'cache-workspace-crates: "false"');
requireText("cache action", action, 'cache-on-failure: "false"');
requireText("cache action", action, "shared-key: ${{ inputs.shared-key }}");
requireText("cache action", action, "save-if: ${{ inputs.save }}");
rejectText("cache action", action, "target-key:");
rejectText("cache action", action, "key: ${{ inputs.target-key }}");
rejectText("cache action", action, "add-job-id-key:");
rejectText("cache action", action, "release-artifacts");
rejectText("cache action", action, "gen/apple/build");
rejectText("cache action", action, "gen/android");
rejectText("cache action", action, "node_modules");
rejectText("cache action", action, "RUNNER_TEMP");

requireCount("packaging cache callers", packaging, localAction, 4);
requireCount(
  "packaging main-only cache writers",
  packaging,
  "save: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}",
  4,
);
rejectText("packaging cache callers", packaging, 'save: "true"');
for (const writer of [
  "Swatinem/rust-cache@",
  "actions/cache@",
  "actions/cache/save@",
  "gh cache",
]) {
  rejectText("packaging direct cache writer", packaging, writer);
}
requireText("packaging cold canary", packaging, "schedule:");
requireCount(
  "packaging cold-cache guards",
  packaging,
  "github.event_name != 'schedule' && github.event.inputs.cold_rust_cache != 'true'",
  4,
);
requireCount(
  "packaging cleanup policy trigger",
  packaging,
  ".github/workflows/cache-cleanup.yml",
  2,
);
const pullRequestPaths = triggerPaths(
  "packaging pull-request trigger",
  packaging,
  "pull_request",
);
const pushPaths = triggerPaths("packaging push trigger", packaging, "push");
for (const [event, paths] of [
  ["pull_request", pullRequestPaths],
  ["push", pushPaths],
]) {
  for (const input of packagingLocalInputs) {
    if (!paths.some((pattern) => pathFilterCovers(pattern, input))) {
      failures.push(`packaging ${event} trigger does not cover local input ${input}`);
    }
  }
}
if (JSON.stringify(pullRequestPaths) !== JSON.stringify(pushPaths)) {
  failures.push("packaging pull-request and push path filters must remain identical");
}

for (const family of cacheFamilies) {
  requireCount("packaging effective cache family", packaging, `shared-key: ${family}`, 1);
  requireCount("protected release effective cache family", release, `shared-key: ${family}`, 1);
}

requireCount("protected release cache callers", release, localAction, 4);
requireCount("protected release restore-only callers", release, 'save: "false"', 4);
rejectText("protected release", release, 'save: "true"');
for (const writer of [
  "Swatinem/rust-cache@",
  "actions/cache@",
  "actions/cache/save@",
  "cache: gradle",
  "bundler-cache: true",
  "gh cache",
]) {
  rejectText("protected release direct cache writer", release, writer);
}

requireText("store audit protected environment", storeAudit, "environment: zuuli-app-stores");
requireText(
  "store audit protected secret",
  storeAudit,
  "PLAY_SERVICE_ACCOUNT_JSON_BASE64: ${{ secrets.PLAY_SERVICE_ACCOUNT_JSON_BASE64 }}",
);
requireText("store publication protected environment", storePublish, "environment: zuuli-app-stores");
for (const writer of [
  "uses: ./.github/actions/zuuli-rust-cache",
  "Swatinem/rust-cache@",
  "actions/cache@",
  "actions/cache/save@",
  "cache: npm",
  "cache: gradle",
  "bundler-cache: true",
  "gh cache",
]) {
  rejectText("store audit credential-bearing job", storeAudit, writer);
  rejectText("store publication gate", storePublish, writer);
}
requireCount("protected release npm auto-cache", release, "cache: npm", 1);
const prepareJob = job(release, "prepare", "android");
requireCount("credential-free prepare npm auto-cache", prepareJob, "cache: npm", 1);
for (const [name, nextName] of [
  ["android", "ios-build"],
  ["ios-build", "ios-sign"],
  ["linux", "macos-build"],
  ["macos-build", "macos-sign"],
]) {
  const protectedJob = job(release, name, nextName);
  requireCount(`${name} cache caller`, protectedJob, localAction, 1);
  requireCount(`${name} restore-only cache caller`, protectedJob, 'save: "false"', 1);
  for (const writer of [
    "Swatinem/rust-cache@",
    "actions/cache@",
    "actions/cache/save@",
    "cache: npm",
    "cache: gradle",
    "bundler-cache: true",
    "gh cache",
  ]) {
    rejectText(`${name} protected job`, protectedJob, writer);
  }
}
for (const [name, nextName] of [
  ["ios-sign", "ios-verify"],
  ["ios-upload", "ios-finalize"],
  ["macos-sign", "macos-finalize"],
]) {
  const credentialJob = job(release, name, nextName);
  rejectText(`${name} credential-bearing job`, credentialJob, localAction);
  for (const writer of [
    "Swatinem/rust-cache@",
    "actions/cache@",
    "actions/cache/save@",
    "cache: npm",
    "cache: gradle",
    "bundler-cache: true",
    "gh cache",
  ]) {
    rejectText(`${name} credential-bearing job`, credentialJob, writer);
  }
}

requireText("cache cleanup trigger", cleanup, "pull_request_target:");
requireText("cache cleanup trigger", cleanup, "types: [closed]");
requireText("cache cleanup recovery", cleanup, "schedule:");
requireText("cache cleanup permissions", cleanup, "actions: write");
requireText("cache cleanup permissions", cleanup, "contents: none");
requireText("cache cleanup permissions", cleanup, "pull-requests: read");
requireText("cache cleanup scope", cleanup, 'pr_ref="refs/pull/$PR_NUMBER/merge"');
requireText("cache cleanup scope", cleanup, 'gh cache list --ref "$pr_ref"');
requireText("cache cleanup deletion", cleanup, 'gh cache delete "$cache_id"');
requireText(
  "cache cleanup closed-state proof",
  cleanup,
  'state=$(gh api "repos/$GH_REPO/pulls/$pr_number" --jq .state)',
);
requireText("cache cleanup closed-state proof", cleanup, '[[ "$state" == closed ]]');
requireText(
  "cache cleanup PR-only sweep",
  cleanup,
  "^refs/pull/([1-9][0-9]*)/merge$",
);
rejectText("cache cleanup", cleanup, "actions/checkout");
rejectText("cache cleanup", cleanup, "gh cache delete --all");

requireText(
  "required gate cache policy trigger",
  requiredGate,
  ".github/workflows/cache-cleanup.yml",
);
requireText(
  "required gate store audit trigger",
  requiredGate,
  ".github/workflows/zuuli-store-audit.yml",
);
requireText(
  "required gate store publication trigger",
  requiredGate,
  ".github/workflows/zuuli-store-publish.yml",
);
const frontendGate = job(requiredGate, "frontend", "rust_plugin");
requireCount(
  "required gate cache policy verification",
  frontendGate,
  "node scripts/verify-ci-cache-policy.mjs",
  1,
);

if (failures.length > 0) {
  console.error("ZUULI CI cache policy verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  "ZUULI CI cache policy verified: credential-free writers, restore-only releases, and exact closed-PR cleanup.",
);
