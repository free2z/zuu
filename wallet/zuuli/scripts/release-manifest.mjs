#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const release = JSON.parse(readFileSync(resolve(root, "release.json"), "utf8"));
const buildMetadata = JSON.parse(
  readFileSync(resolve(root, "build-info.json"), "utf8"),
);
const option = (name, fallback) => {
  const prefix = `--${name}=`;
  const value = process.argv.find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
};
const artifactsRoot = resolve(
  process.cwd(),
  option("artifacts", "release-artifacts"),
);
const output = resolve(
  process.cwd(),
  option("output", "release-manifest.json"),
);
const checksumsOutput = resolve(
  process.cwd(),
  option("checksums", "CHECKSUMS.sha256"),
);

function filesUnder(path) {
  const files = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const absolute = resolve(path, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`release artifact must not be a symlink: ${absolute}`);
    if (entry.isDirectory()) files.push(...filesUnder(absolute));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const sourceSha = git("rev-parse", "HEAD");
const sourceTree = git("rev-parse", "HEAD^{tree}");
const artifacts = filesUnder(artifactsRoot)
  .filter((path) => ![output, checksumsOutput].includes(resolve(path)))
  .sort()
  .map((path) => ({
    path: relative(artifactsRoot, path),
    bytes: statSync(path).size,
    sha256: sha256(path),
  }));

if (artifacts.length === 0)
  throw new Error(`no artifacts found under ${artifactsRoot}`);
writeFileSync(
  checksumsOutput,
  `${artifacts.map((artifact) => `${artifact.sha256}  ${artifact.path}`).join("\n")}\n`,
  { flag: "wx", mode: 0o644 },
);
artifacts.push({
  path: relative(artifactsRoot, checksumsOutput),
  bytes: statSync(checksumsOutput).size,
  sha256: sha256(checksumsOutput),
});

const manifest = {
  schemaVersion: 1,
  applicationId: release.applicationId,
  channel: buildMetadata.channel,
  version: release.version,
  build: release.build,
  identity: `${release.version}+${release.build}`,
  source: {
    repository:
      process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY
        ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}`
        : git("remote", "get-url", "origin"),
    commit: sourceSha,
    tree: sourceTree,
    ref: process.env.GITHUB_REF || null,
  },
  builder: {
    githubRun: process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : null,
    runner:
      process.env.ImageOS && process.env.ImageVersion
        ? `${process.env.ImageOS}@${process.env.ImageVersion}`
        : process.env.RUNNER_OS && process.env.RUNNER_ARCH
          ? `${process.env.RUNNER_OS}/${process.env.RUNNER_ARCH}`
          : process.platform,
    rust: process.env.ZUULI_RUST_VERSION || null,
    node: process.env.ZUULI_NODE_VERSION || process.version,
    java: process.env.ZUULI_JAVA_VERSION || null,
    xcode: process.env.ZUULI_XCODE_VERSION || null,
    androidNdk: process.env.ZUULI_ANDROID_NDK_VERSION || null,
  },
  artifacts,
};

writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, {
  flag: "wx",
  mode: 0o644,
});
for (const artifact of artifacts)
  console.log(`${artifact.sha256}  ${artifact.path}`);
console.log(
  `wrote ${basename(output)} for ${artifacts.length} immutable artifact(s)`,
);
