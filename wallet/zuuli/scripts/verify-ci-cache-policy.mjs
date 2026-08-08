#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

const action = readRepo(".github/actions/zuuli-rust-cache/action.yml");
const packaging = readRepo(".github/workflows/zuuli-packaging.yml");
const release = readRepo(".github/workflows/zuuli-release.yml");
const cleanup = readRepo(".github/workflows/cache-cleanup.yml");
const localAction = "uses: ./.github/actions/zuuli-rust-cache";

function job(contents, name, nextName) {
  const startMarker = `\n  ${name}:\n`;
  const endMarker = `\n  ${nextName}:\n`;
  const start = contents.indexOf(startMarker);
  const end = contents.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) {
    failures.push(`protected release workflow: cannot isolate ${name} job`);
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
requireText("cache action", action, "key: ${{ inputs.target-key }}");
requireText("cache action", action, "save-if: ${{ inputs.save }}");
rejectText("cache action", action, "release-artifacts");
rejectText("cache action", action, "gen/apple/build");
rejectText("cache action", action, "gen/android");
rejectText("cache action", action, "node_modules");
rejectText("cache action", action, "RUNNER_TEMP");

requireCount("packaging cache callers", packaging, localAction, 3);
requireCount(
  "packaging main-only cache writers",
  packaging,
  "save: ${{ github.event_name == 'push' && github.ref == 'refs/heads/main' }}",
  3,
);
rejectText("packaging cache callers", packaging, 'save: "true"');
requireText("packaging cold canary", packaging, "schedule:");
requireCount(
  "packaging cold-cache guards",
  packaging,
  "github.event_name != 'schedule' && github.event.inputs.cold_rust_cache != 'true'",
  3,
);

requireCount("protected release cache callers", release, localAction, 4);
requireCount("protected release restore-only callers", release, 'save: "false"', 4);
rejectText("protected release", release, 'save: "true"');
for (const [name, nextName] of [
  ["android", "ios"],
  ["ios", "linux"],
  ["macos", "release-index"],
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

if (failures.length > 0) {
  console.error("ZUULI CI cache policy verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  "ZUULI CI cache policy verified: credential-free writers, restore-only releases, and exact closed-PR cleanup.",
);
