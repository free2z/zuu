#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
const replacements = new Map();
const replaceOne = (path, pattern, replacement, label) => {
  const before = replacements.get(path) ?? read(path);
  const matches = before.match(
    new RegExp(
      pattern.source,
      `${pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`}`,
    ),
  );
  if (!matches || matches.length !== 1)
    throw new Error(
      `${label}: expected exactly one match, got ${matches?.length ?? 0}`,
    );
  replacements.set(path, before.replace(pattern, replacement));
};
const replaceJsonVersion = (path) => {
  const value = JSON.parse(read(path));
  value.version = version;
  if (path === "package-lock.json") value.packages[""].version = version;
  replacements.set(path, `${JSON.stringify(value, null, 2)}\n`);
};

const release = JSON.parse(read("release.json"));
release.version = version;
release.build = build;
replacements.set("release.json", `${JSON.stringify(release, null, 2)}\n`);
replaceJsonVersion("package.json");
replaceJsonVersion("package-lock.json");

replaceOne(
  "src-tauri/Cargo.toml",
  /^version\s*=\s*"[^"]+"/m,
  `version = "${version}"`,
  "Cargo.toml version",
);
replaceOne(
  "src-tauri/Cargo.lock",
  /(\[\[package\]\]\nname = "zuuli"\nversion = ")[^"]+("\n)/m,
  `$1${version}$2`,
  "Cargo.lock zuuli version",
);

replaceOne(
  "src-tauri/tauri.conf.json",
  /("version":\s*")[^"]+(")/,
  `$1${version}$2`,
  "Tauri marketing version",
);
replaceOne(
  "src-tauri/tauri.conf.json",
  /("bundleVersion":\s*")[^"]+(")/,
  `$1${build}$2`,
  "Tauri iOS build",
);
replaceOne(
  "src-tauri/tauri.conf.json",
  /("versionCode":\s*)\d+/,
  `$1${build}`,
  "Tauri Android build",
);

replaceOne(
  "src-tauri/gen/apple/project.yml",
  /(CFBundleShortVersionString:\s*)[^\s]+/,
  `$1${version}`,
  "XcodeGen marketing version",
);
replaceOne(
  "src-tauri/gen/apple/project.yml",
  /(CFBundleVersion:\s*)"?[^"\s]+"?/,
  `$1"${build}"`,
  "XcodeGen build",
);
replaceOne(
  "src-tauri/gen/apple/zuuli_iOS/Info.plist",
  /(<key>CFBundleShortVersionString<\/key>\s*<string>)[^<]+(<\/string>)/,
  `$1${version}$2`,
  "generated iOS marketing version",
);
replaceOne(
  "src-tauri/gen/apple/zuuli_iOS/Info.plist",
  /(<key>CFBundleVersion<\/key>\s*<string>)[^<]+(<\/string>)/,
  `$1${build}$2`,
  "generated iOS build",
);
replaceOne(
  "src-tauri/gen/android/app/build.gradle.kts",
  /(tauri\.android\.versionCode",\s*")[^"]+("\))/,
  `$1${build}$2`,
  "Android fallback build",
);
replaceOne(
  "src-tauri/gen/android/app/build.gradle.kts",
  /(tauri\.android\.versionName",\s*")[^"]+("\))/,
  `$1${version}$2`,
  "Android fallback version",
);

for (const [path, contents] of replacements) {
  const absolute = resolve(root, path);
  const temporary = `${absolute}.release-bump.tmp`;
  writeFileSync(temporary, contents, { mode: statSync(absolute).mode });
  renameSync(temporary, absolute);
}

console.log(`updated ZUULI release identity to ${version}+${build}`);
console.log("review the diff and run npm run release:verify before committing");
