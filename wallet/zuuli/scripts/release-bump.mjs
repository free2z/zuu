#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildReleaseBumpContents } from "./release-bump-content.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argument = (name) =>
  process.argv.find((item) => item.startsWith(`--${name}=`))?.split("=", 2)[1];
const version = argument("version");
const buildText = argument("build");
const build = Number(buildText);

if (!version || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
  throw new Error("--version must be a strict major.minor.patch value");
}
if (
  !buildText ||
  !/^\d+$/.test(buildText) ||
  !Number.isSafeInteger(build) ||
  build < 1 ||
  build > 2_100_000_000
) {
  throw new Error("--build must be an integer from 1 through 2100000000");
}
if (
  execFileSync("git", ["status", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
  }).trim()
) {
  throw new Error("release bump requires a clean worktree");
}

const read = (path) => readFileSync(resolve(root, path), "utf8");
const replacements = buildReleaseBumpContents({ read, version, build });

for (const [path, contents] of replacements) {
  const absolute = resolve(root, path);
  const temporary = `${absolute}.release-bump.tmp`;
  writeFileSync(temporary, contents, { mode: statSync(absolute).mode });
  renameSync(temporary, absolute);
}

console.log(`updated ZUULI release identity to ${version}+${build}`);
console.log("review the diff and run npm run release:verify before committing");
