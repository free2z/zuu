import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SHA = /^[0-9a-f]{40}$/;
const CHANNELS = new Set(["internal", "beta", "stable"]);
const PLATFORM_ALIASES = new Map([
  ["android", "android"],
  ["ios", "ios"],
  ["linux", "linux"],
  ["macos", "macos"],
  ["darwin", "macos"],
  ["windows", "windows"],
  ["win32", "windows"],
  ["web", "web"],
]);

function canonicalSha(value, label) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || !SHA.test(normalized) || /^0+$/.test(normalized)) {
    throw new Error(`${label} must be a nonzero full 40-character commit SHA`);
  }
  return normalized;
}

function checkedOutSha(root, git) {
  try {
    return canonicalSha(
      git("git", ["rev-parse", "--verify", "HEAD"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
      "checked-out source",
    );
  } catch {
    return null;
  }
}

function sourceCommit(root, env, git) {
  const head = checkedOutSha(root, git);
  // Protected recovery builds intentionally check out a reviewed historical
  // source while GITHUB_SHA still names the workflow-dispatch tip. The
  // release train's explicit source is authoritative in that case; ordinary
  // CI builds bind GitHub's event SHA instead.
  const declared = env.ZUULI_RELEASE_SOURCE_SHA
    ? [[
        "ZUULI_RELEASE_SOURCE_SHA",
        canonicalSha(env.ZUULI_RELEASE_SOURCE_SHA, "ZUULI_RELEASE_SOURCE_SHA"),
      ]]
    : env.GITHUB_ACTIONS === "true" && env.GITHUB_SHA !== undefined
      ? [["GITHUB_SHA", canonicalSha(env.GITHUB_SHA, "GITHUB_SHA")]]
      : [];

  for (const [label, value] of declared) {
    if (!head) {
      throw new Error(`${label} was supplied but the checked-out source cannot be verified`);
    }
    if (value !== head) {
      throw new Error(`${label} ${value} does not match checked-out source ${head}`);
    }
  }
  return head;
}

function buildPlatform(env) {
  const raw = env.ZUULI_BUILD_PLATFORM ?? env.TAURI_ENV_PLATFORM ?? "web";
  const normalized = raw.trim().toLowerCase();
  const platform = PLATFORM_ALIASES.get(normalized);
  if (!platform) {
    throw new Error(`unsupported immutable build platform: ${raw}`);
  }
  return platform;
}

/**
 * Read the only release source of truth and bind it to this checkout before
 * Vite serializes the value into the bundle. Nothing here runs in the app.
 */
export function loadBuildIdentity({
  root,
  env = process.env,
  git = execFileSync,
  read = readFileSync,
} = {}) {
  if (!root) throw new Error("build identity root is required");
  const release = JSON.parse(read(resolve(root, "release.json"), "utf8"));
  if (!CHANNELS.has(release.channel)) {
    throw new Error(`unsupported release channel: ${release.channel}`);
  }
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(release.version)) {
    throw new Error(`invalid release version: ${release.version}`);
  }
  if (!Number.isSafeInteger(release.build) || release.build < 1) {
    throw new Error(`invalid release build: ${release.build}`);
  }
  if (release.applicationId !== "cash.free2z.zuuli") {
    throw new Error(`invalid application ID: ${release.applicationId}`);
  }

  return Object.freeze({
    productName: "ZUULI",
    applicationId: release.applicationId,
    version: release.version,
    build: release.build,
    channel: release.channel,
    platform: buildPlatform(env),
    sourceCommit: sourceCommit(root, env, git),
  });
}
