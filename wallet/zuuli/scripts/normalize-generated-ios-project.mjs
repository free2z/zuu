#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function occurrenceCount(contents, value) {
  return contents.split(value).length - 1;
}

function normalizeBuildSetting(contents, name, value, expectedCount) {
  const canonical = `${name} = ${value};`;
  const generated = `${name} = "${value}";`;
  const count =
    occurrenceCount(contents, canonical) + occurrenceCount(contents, generated);
  if (count !== expectedCount) {
    throw new Error(
      `refusing to normalize ${name}: expected ${expectedCount} known values, found ${count}`,
    );
  }
  return contents.replaceAll(generated, canonical);
}

function normalizeProject(contents) {
  let normalized = normalizeBuildSetting(
    contents,
    "DEVELOPMENT_TEAM",
    "F9AV5HKF6N",
    2,
  );
  normalized = normalizeBuildSetting(normalized, "PRODUCT_NAME", "ZUULI", 2);
  return normalized;
}

function normalizePlist(contents, label) {
  if (!contents.trimEnd().endsWith("</plist>")) {
    throw new Error(
      `refusing to normalize ${label}: plist terminator is missing`,
    );
  }
  return contents.endsWith("\n") ? contents : `${contents}\n`;
}

function selfTest() {
  const generatedProject = [
    'DEVELOPMENT_TEAM = "F9AV5HKF6N";',
    'PRODUCT_NAME = "ZUULI";',
    'DEVELOPMENT_TEAM = "F9AV5HKF6N";',
    'PRODUCT_NAME = "ZUULI";',
  ].join("\n");
  const expectedProject = generatedProject
    .replaceAll(' = "', " = ")
    .replaceAll('";', ";");
  if (normalizeProject(generatedProject) !== expectedProject) {
    throw new Error("iOS project normalization self-test failed");
  }
  if (
    normalizePlist("<plist><dict/></plist>", "fixture") !==
    "<plist><dict/></plist>\n"
  ) {
    throw new Error("iOS plist normalization self-test failed");
  }
  try {
    normalizeProject('DEVELOPMENT_TEAM = "F9AV5HKF6N";');
  } catch {
    return;
  }
  throw new Error("iOS project normalization accepted an unexpected shape");
}

if (process.argv.includes("--self-test")) {
  selfTest();
  process.exit(0);
}

const projectPath = resolve(
  appDir,
  "src-tauri/gen/apple/zuuli.xcodeproj/project.pbxproj",
);
const plistPaths = [
  "src-tauri/gen/apple/zuuli_iOS/Info.plist",
  "src-tauri/gen/apple/zuuli_iOS/zuuli_iOS.entitlements",
].map((path) => resolve(appDir, path));

const project = readFileSync(projectPath, "utf8");
const normalizedProject = normalizeProject(project);
if (normalizedProject !== project) {
  writeFileSync(projectPath, normalizedProject);
}

for (const plistPath of plistPaths) {
  const plist = readFileSync(plistPath, "utf8");
  const normalizedPlist = normalizePlist(plist, plistPath);
  if (normalizedPlist !== plist) {
    writeFileSync(plistPath, normalizedPlist);
  }
}
