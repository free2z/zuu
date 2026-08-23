#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(scriptDirectory, "../../..");
const statusPath = "wallet/zuuli/STATUS.md";

// This is the release-impacting surface selected by the required ZUULI gate.
// A change here can invalidate a source-backed STATUS.md disposition even when
// it does not live in the application directory itself.
const releaseImpactingPrefixes = [
  "wallet/zuuli/",
  "wallet/plugins/",
  ".github/containers/zuuli-linux/",
  ".github/actions/zuuli-rust-cache/",
];
const releaseImpactingPaths = new Set([
  "wallet/rust-toolchain.toml",
  "wallet/deny.toml",
  "scripts/check-github-actions-pins.mjs",
  "scripts/check-rust-fmt.sh",
  "scripts/check-rust-deny.sh",
  "scripts/check-rust-clippy.sh",
  "scripts/check-zcash-permissions.mjs",
  "scripts/check-zuuli-linux-image.mjs",
  "z/zcash/librustzcash",
  ".gitmodules",
  ".github/workflows/zuuli.yml",
  ".github/workflows/zuuli-linux-image.yml",
  ".github/workflows/zuuli-packaging.yml",
  ".github/workflows/zuuli-release.yml",
  ".github/workflows/zuuli-store-audit.yml",
  ".github/workflows/zuuli-store-publish.yml",
  ".github/workflows/zuuli-testflight-bootstrap.yml",
  ".github/workflows/zuuli-testflight-recovery.yml",
  ".github/workflows/cache-cleanup.yml",
  "docs/ZUULI-LINUX-BUILD-IMAGE.md",
]);

// release-bump.mjs owns exactly these generated identity surfaces. The source
// commit is still checked by release-identity.mjs, which proves that their
// version/build values agree with canonical release.json.
export const releaseBumpPaths = new Set([
  "wallet/zuuli/release.json",
  "wallet/zuuli/package.json",
  "wallet/zuuli/package-lock.json",
  "wallet/zuuli/src-tauri/Cargo.toml",
  "wallet/zuuli/src-tauri/Cargo.lock",
  "wallet/zuuli/src-tauri/tauri.conf.json",
  "wallet/zuuli/src-tauri/gen/apple/project.yml",
  "wallet/zuuli/src-tauri/gen/apple/zuuli_iOS/Info.plist",
  "wallet/zuuli/src-tauri/gen/android/app/build.gradle.kts",
]);

export function isReleaseImpactingPath(path) {
  return (
    releaseImpactingPaths.has(path) ||
    releaseImpactingPrefixes.some((prefix) => path.startsWith(prefix)) ||
    path.startsWith("z/zcash/librustzcash/")
  );
}

function validCalendarDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, year, month, day] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function parseStatusMarker(contents) {
  const label = "Last re-derived from `origin/main` at";
  const occurrences = contents.split(label).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `STATUS.md must contain exactly one ${JSON.stringify(label)} marker, found ${occurrences}`,
    );
  }

  const marker =
    /^Last re-derived from `origin\/main` at\n`([0-9a-f]{40})` on (\d{4}-\d{2}-\d{2})\./m.exec(
      contents,
    );
  if (!marker) {
    throw new Error(
      "STATUS.md re-derivation marker must contain a full lowercase 40-character commit SHA and YYYY-MM-DD date",
    );
  }
  if (!validCalendarDate(marker[2])) {
    throw new Error(`STATUS.md re-derivation date is not a real calendar date: ${marker[2]}`);
  }
  return { auditSha: marker[1], auditDate: marker[2] };
}

function git(repoRoot, args, options = {}) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: options.encoding ?? "utf8",
    stdio: options.stdio,
  });
}

function requireCommit(repoRoot, sha, label) {
  try {
    git(repoRoot, ["cat-file", "-e", `${sha}^{commit}`], { stdio: "ignore" });
  } catch {
    throw new Error(`${label} is not an available commit: ${sha}`);
  }
}

function changedPaths(repoRoot, from, to) {
  const bytes = git(
    repoRoot,
    ["diff", "--name-only", "--no-renames", "-z", from, to, "--"],
    { encoding: "buffer" },
  );
  return bytes
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

function sourceParent(repoRoot, sourceSha) {
  const fields = git(repoRoot, ["rev-list", "--parents", "-n", "1", sourceSha])
    .trim()
    .split(/\s+/);
  if (fields.length !== 2) {
    throw new Error(
      `release source must have exactly one parent on linear main, found ${fields.length - 1}`,
    );
  }
  return fields[1];
}

function isFirstParentAncestor(repoRoot, ancestor, descendant) {
  return git(repoRoot, ["rev-list", "--first-parent", descendant])
    .trim()
    .split("\n")
    .includes(ancestor);
}

function readStatusAtSource(repoRoot, sourceSha) {
  let bytes;
  try {
    bytes = git(repoRoot, ["show", `${sourceSha}:${statusPath}`], {
      encoding: "buffer",
    });
  } catch {
    throw new Error(`${statusPath} is missing from release source ${sourceSha}`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${statusPath} at release source must contain valid UTF-8`);
  }
}

export function verifyStatusFreshness({ repoRoot = defaultRepoRoot, sourceSha }) {
  if (!/^[0-9a-f]{40}$/.test(sourceSha ?? "")) {
    throw new Error("source SHA must be a full lowercase 40-character commit SHA");
  }
  requireCommit(repoRoot, sourceSha, "release source");

  const parentSha = sourceParent(repoRoot, sourceSha);
  const { auditSha, auditDate } = parseStatusMarker(
    readStatusAtSource(repoRoot, sourceSha),
  );
  requireCommit(repoRoot, auditSha, "recorded STATUS.md audit source");
  if (!isFirstParentAncestor(repoRoot, auditSha, parentSha)) {
    throw new Error(
      `recorded STATUS.md audit source ${auditSha} is not on the release parent's first-parent history`,
    );
  }

  const staleBeforeRelease = changedPaths(repoRoot, auditSha, parentSha).filter(
    (path) => isReleaseImpactingPath(path) && path !== statusPath,
  );
  if (staleBeforeRelease.length > 0) {
    throw new Error(
      `STATUS.md was not re-derived after release-impacting changes:\n${staleBeforeRelease.map((path) => `- ${path}`).join("\n")}`,
    );
  }

  const sourceDelta = changedPaths(repoRoot, parentSha, sourceSha);
  if (!sourceDelta.includes("wallet/zuuli/release.json")) {
    throw new Error(
      "release source must be the commit that changes wallet/zuuli/release.json",
    );
  }
  const unexpectedSourcePaths = sourceDelta.filter(
    (path) =>
      isReleaseImpactingPath(path) &&
      path !== statusPath &&
      !releaseBumpPaths.has(path),
  );
  if (unexpectedSourcePaths.length > 0) {
    throw new Error(
      `release source contains non-ceremony release-impacting changes:\n${unexpectedSourcePaths.map((path) => `- ${path}`).join("\n")}`,
    );
  }

  const statusWasReDerived = changedPaths(repoRoot, auditSha, sourceSha).includes(
    statusPath,
  );
  if (!statusWasReDerived) {
    throw new Error(
      `STATUS.md at the release source was not committed after its recorded audit source ${auditSha}`,
    );
  }

  return { sourceSha, parentSha, auditSha, auditDate };
}

function argument(name) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function main() {
  try {
    const result = verifyStatusFreshness({ sourceSha: argument("source-sha") });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`ZUULI status source boundary failed:\n- ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
