#!/usr/bin/env node
//
// Undo the byte-level churn `tauri ios build` introduces, and nothing else.
//
// The release path runs `git diff --exit-code` immediately after the iOS build
// to prove the committed Xcode project is exactly the one that was built. Tauri
// regenerates the project through xcodegen on every build, and xcodegen quotes
// some build settings that the committed file spells bare, drops trailing
// newlines from the plists, and lets the deep-link plugin append its URL type to
// the generated Info.plist. None of that is a change to the project; all of it
// makes `git diff` non-empty.
//
// So this canonicalizes exactly three things and refuses anything it does not
// recognize:
//
//   * `KEY = "value";` back to `KEY = value;` for the two settings xcodegen
//     quotes, and only when the count of known values is exactly what the
//     committed project has. An unexpected count throws rather than rewrites.
//   * a trailing newline on each plist, after asserting the plist terminator is
//     still there, so this cannot "normalize" a truncated file.
//   * the deep-link plugin's Info.plist URL type, which it emits in either key
//     order, collapsed to the one canonical spelling. A scheme that is not
//     e2e2z's own fails closed -- that is the check, not the rewrite.
//
// The committed Info.plist must also keep declaring exempt encryption. e2e2z
// uses only standard cryptography, `release.json` says
// `iosUsesNonExemptEncryption: false`, and an app that silently stopped saying
// so would be held at App Store review every submission.
//
// This is the smaller sibling of wallet/zuuli/scripts/normalize-generated-ios-project.mjs.
// ZUULI's also has a `--prepare-manual-signing` mode that writes its
// provisioning profile into the project before building. e2e2z has no
// provisioning profile yet (see scripts/store-identity.mjs), so there is nothing
// to write and no mode that could be tested; the export configuration lives in
// the ExportOptions.plist the release workflow composes instead.
//
// Usage:
//   node scripts/normalize-generated-ios-project.mjs
//   node scripts/normalize-generated-ios-project.mjs --self-test

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const teamId = "F9AV5HKF6N";
const productName = "e2e2z";
const applicationId = "cash.free2z.e2e2z";

const projectPath = resolve(appDir, "src-tauri/gen/apple/e2e2z.xcodeproj/project.pbxproj");
const infoPlistPath = resolve(appDir, "src-tauri/gen/apple/e2e2z_iOS/Info.plist");
const entitlementsPath = resolve(
  appDir,
  "src-tauri/gen/apple/e2e2z_iOS/e2e2z_iOS.entitlements",
);

const exemptEncryptionDeclaration = [
  "\t<key>ITSAppUsesNonExemptEncryption</key>",
  "\t<false/>",
].join("\n");

const canonicalUrlTypeDictionary = [
  "\t\t<dict>",
  "\t\t\t<key>CFBundleURLName</key>",
  `\t\t\t<string>${applicationId}</string>`,
  "\t\t\t<key>CFBundleURLSchemes</key>",
  "\t\t\t<array>",
  `\t\t\t\t<string>${applicationId}</string>`,
  "\t\t\t</array>",
  "\t\t</dict>",
].join("\n");
const reversedUrlTypeDictionary = [
  "\t\t<dict>",
  "\t\t\t<key>CFBundleURLSchemes</key>",
  "\t\t\t<array>",
  `\t\t\t\t<string>${applicationId}</string>`,
  "\t\t\t</array>",
  "\t\t\t<key>CFBundleURLName</key>",
  `\t\t\t<string>${applicationId}</string>`,
  "\t\t</dict>",
].join("\n");
const urlType = (dictionaries) =>
  ["\t<key>CFBundleURLTypes</key>", "\t<array>", ...dictionaries, "\t</array>"].join("\n");
const canonicalUrlType = urlType([canonicalUrlTypeDictionary]);
const reversedUrlType = urlType([reversedUrlTypeDictionary]);

function occurrenceCount(contents, value) {
  return contents.split(value).length - 1;
}

function normalizeBuildSetting(contents, name, value, expectedCount) {
  const canonical = `${name} = ${value};`;
  const generated = `${name} = "${value}";`;
  const count = occurrenceCount(contents, canonical) + occurrenceCount(contents, generated);
  if (count !== expectedCount) {
    throw new Error(
      `refusing to normalize ${name}: expected ${expectedCount} known values, found ${count}`,
    );
  }
  return contents.replaceAll(generated, canonical);
}

export function normalizeProject(contents) {
  let normalized = normalizeBuildSetting(contents, "DEVELOPMENT_TEAM", teamId, 2);
  normalized = normalizeBuildSetting(normalized, "PRODUCT_NAME", productName, 2);
  return normalized;
}

export function normalizePlist(contents, label) {
  if (!contents.trimEnd().endsWith("</plist>"))
    throw new Error(`refusing to normalize ${label}: plist terminator is missing`);
  return contents.endsWith("\n") ? contents : `${contents}\n`;
}

export function normalizeInfoPlist(contents, label) {
  const normalized = normalizePlist(contents, label);
  const urlTypeKeyCount = occurrenceCount(normalized, "<key>CFBundleURLTypes</key>");
  if (urlTypeKeyCount !== 1)
    throw new Error(
      `refusing to normalize ${label}: expected exactly one CFBundleURLTypes key, found ${urlTypeKeyCount}`,
    );
  const encryptionKeyCount = occurrenceCount(
    normalized,
    "<key>ITSAppUsesNonExemptEncryption</key>",
  );
  const exemptDeclarationCount = occurrenceCount(normalized, exemptEncryptionDeclaration);
  if (encryptionKeyCount !== 1 || exemptDeclarationCount !== 1)
    throw new Error(
      `refusing to normalize ${label}: expected exactly one canonical exempt-encryption declaration, found ${encryptionKeyCount} keys and ${exemptDeclarationCount} false declarations`,
    );
  const matched = [canonicalUrlType, reversedUrlType].filter(
    (shape) => occurrenceCount(normalized, shape) === 1,
  );
  if (matched.length !== 1)
    throw new Error(
      `refusing to normalize ${label}: expected exactly one known e2e2z URL type, found ${matched.length}`,
    );
  return normalized.replace(matched[0], canonicalUrlType);
}

function selfTest() {
  const generated = [
    `DEVELOPMENT_TEAM = "${teamId}";`,
    `PRODUCT_NAME = "${productName}";`,
    `DEVELOPMENT_TEAM = "${teamId}";`,
    `PRODUCT_NAME = "${productName}";`,
  ].join("\n");
  const expected = generated.replaceAll(' = "', " = ").replaceAll('";', ";");
  if (normalizeProject(generated) !== expected)
    throw new Error("iOS project normalization self-test failed");

  let rejectedUnexpectedShape = false;
  try {
    normalizeProject(`DEVELOPMENT_TEAM = "${teamId}";`);
  } catch {
    rejectedUnexpectedShape = true;
  }
  if (!rejectedUnexpectedShape)
    throw new Error("iOS project normalization accepted an unexpected shape");

  if (normalizePlist("<plist><dict/></plist>", "fixture") !== "<plist><dict/></plist>\n")
    throw new Error("iOS plist normalization self-test failed");

  const canonicalFixture = `<plist><dict>\n${canonicalUrlType}\n${exemptEncryptionDeclaration}\n</dict></plist>`;
  const reversedFixture = `<plist><dict>\n${reversedUrlType}\n${exemptEncryptionDeclaration}\n</dict></plist>`;
  if (
    normalizeInfoPlist(canonicalFixture, "canonical fixture") !== `${canonicalFixture}\n` ||
    normalizeInfoPlist(reversedFixture, "reversed fixture") !== `${canonicalFixture}\n`
  )
    throw new Error("iOS URL type ordering self-test failed");

  for (const [label, unexpected] of [
    [
      "foreign scheme",
      canonicalUrlType.replaceAll(
        `<string>${applicationId}</string>`,
        "<string>attacker.example</string>",
      ),
    ],
    ["duplicate URL type keys", `${canonicalUrlType}\n${canonicalUrlType}`],
  ]) {
    let rejected = false;
    try {
      normalizeInfoPlist(
        `<plist><dict>\n${unexpected}\n${exemptEncryptionDeclaration}\n</dict></plist>`,
        label,
      );
    } catch (error) {
      rejected = error instanceof Error;
    }
    if (!rejected)
      throw new Error(`iOS URL type normalization accepted an unknown shape: ${label}`);
  }

  let rejectedNonExempt = false;
  try {
    normalizeInfoPlist(
      canonicalFixture.replace("\t<false/>", "\t<true/>"),
      "non-exempt encryption fixture",
    );
  } catch (error) {
    rejectedNonExempt =
      error instanceof Error &&
      error.message.includes("expected exactly one canonical exempt-encryption declaration");
  }
  if (!rejectedNonExempt)
    throw new Error("iOS plist normalization accepted non-exempt encryption");

  // The committed tree must already be canonical, or the release's
  // `git diff --exit-code` fails on files nothing changed.
  const committedInfoPlist = readFileSync(infoPlistPath, "utf8");
  if (normalizeInfoPlist(committedInfoPlist, infoPlistPath) !== committedInfoPlist)
    throw new Error("committed iOS Info.plist is not canonical");
  const committedProject = readFileSync(projectPath, "utf8");
  if (normalizeProject(committedProject) !== committedProject)
    throw new Error("committed iOS project is not canonical");
  const committedEntitlements = readFileSync(entitlementsPath, "utf8");
  if (normalizePlist(committedEntitlements, entitlementsPath) !== committedEntitlements)
    throw new Error("committed iOS entitlements are not canonical");
}

if (process.argv.includes("--self-test")) {
  selfTest();
  console.log("iOS project normalization self-test passed");
  process.exit(0);
}

const project = readFileSync(projectPath, "utf8");
const normalizedProject = normalizeProject(project);
if (normalizedProject !== project) writeFileSync(projectPath, normalizedProject);

const infoPlist = readFileSync(infoPlistPath, "utf8");
const normalizedInfoPlist = normalizeInfoPlist(infoPlist, infoPlistPath);
if (normalizedInfoPlist !== infoPlist) writeFileSync(infoPlistPath, normalizedInfoPlist);

const entitlements = readFileSync(entitlementsPath, "utf8");
const normalizedEntitlements = normalizePlist(entitlements, entitlementsPath);
if (normalizedEntitlements !== entitlements) writeFileSync(entitlementsPath, normalizedEntitlements);
