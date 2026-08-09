#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const teamId = "F9AV5HKF6N";
const profileName = "ZUULI App Store CI";
const quotedProfileUuidPattern =
  /^"[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}"$/;
const distributionIdentity = `Apple Distribution: Corpora Inc (${teamId})`;
const appBundleSetting = "PRODUCT_BUNDLE_IDENTIFIER = cash.free2z.zuuli;";
const exemptEncryptionDeclaration = [
  "\t<key>ITSAppUsesNonExemptEncryption</key>",
  "\t<false/>",
].join("\n");
const canonicalUrlType = [
  "\t<key>CFBundleURLTypes</key>",
  "\t<array>",
  "\t\t<dict>",
  "\t\t\t<key>CFBundleURLName</key>",
  "\t\t\t<string>cash.free2z.zuuli</string>",
  "\t\t\t<key>CFBundleURLSchemes</key>",
  "\t\t\t<array>",
  "\t\t\t\t<string>cash.free2z.zuuli</string>",
  "\t\t\t</array>",
  "\t\t</dict>",
  "\t</array>",
].join("\n");
const reversedUrlType = [
  "\t<key>CFBundleURLTypes</key>",
  "\t<array>",
  "\t\t<dict>",
  "\t\t\t<key>CFBundleURLSchemes</key>",
  "\t\t\t<array>",
  "\t\t\t\t<string>cash.free2z.zuuli</string>",
  "\t\t\t</array>",
  "\t\t\t<key>CFBundleURLName</key>",
  "\t\t\t<string>cash.free2z.zuuli</string>",
  "\t\t</dict>",
  "\t</array>",
].join("\n");

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

function settingLine(key, value) {
  return `\t\t\t\t${key} = ${value};`;
}

function settingIndex(lines, key) {
  const prefix = `${key} = `;
  const matches = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trimStart().startsWith(prefix)) matches.push(index);
  }
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one ${key} setting, found ${matches.length}`,
    );
  }
  return matches[0];
}

function replaceSetting(lines, key, expectedValue, replacementValue) {
  const index = settingIndex(lines, key);
  const expected = settingLine(key, expectedValue);
  if (lines[index] !== expected) {
    throw new Error(
      `refusing to normalize ${key}: expected ${JSON.stringify(expected)}, found ${JSON.stringify(lines[index])}`,
    );
  }
  if (replacementValue === null) lines.splice(index, 1);
  else lines[index] = settingLine(key, replacementValue);
}

function normalizePreparedProfileSetting(lines, key, configuration, remove = false) {
  const index = settingIndex(lines, key);
  const prefix = settingLine(key, "").slice(0, -1);
  const line = lines[index];
  if (!line.startsWith(prefix) || !line.endsWith(";")) {
    throw new Error(`refusing to normalize malformed ${key} setting`);
  }
  const value = line.slice(prefix.length, -1);
  const canonical = configuration === "debug" ? '""' : `"${profileName}"`;
  if (value !== canonical && !quotedProfileUuidPattern.test(value)) {
    throw new Error(
      `refusing to normalize ${key}: expected the protected profile name or a well-formed generated UUID, found ${JSON.stringify(value)}`,
    );
  }
  if (remove || configuration === "debug") lines.splice(index, 1);
  else lines[index] = settingLine(key, canonical);
}

function insertSettingAfter(lines, afterKey, key, value) {
  if (lines.some((line) => line.trimStart().startsWith(`${key} = `))) {
    throw new Error(`refusing to prepare duplicate ${key} setting`);
  }
  lines.splice(settingIndex(lines, afterKey) + 1, 0, settingLine(key, value));
}

function transformAppConfigurations(contents, transform) {
  const configurationPattern =
    /(\t\t[0-9A-F]+ \/\* (debug|release) \*\/ = \{\n\t\t\tisa = XCBuildConfiguration;\n\t\t\tbuildSettings = \{\n)([\s\S]*?)(\n\t\t\t\};\n\t\t\tname = (debug|release);\n\t\t\};)/g;
  let appConfigurationCount = 0;
  const transformed = contents.replace(
    configurationPattern,
    (block, prefix, headerName, body, suffix, footerName) => {
      if (headerName !== footerName) {
        throw new Error(
          `Xcode configuration name mismatch: ${headerName} != ${footerName}`,
        );
      }
      if (!body.includes(appBundleSetting)) return block;
      appConfigurationCount += 1;
      return `${prefix}${transform(body, headerName)}${suffix}`;
    },
  );
  if (appConfigurationCount !== 2) {
    throw new Error(
      `expected two ZUULI app build configurations, found ${appConfigurationCount}`,
    );
  }
  return transformed;
}

function normalizeAppSigning(body, configuration) {
  const lines = body.split("\n");
  const sdkIdentity = '"CODE_SIGN_IDENTITY[sdk=iphoneos*]"';
  const sdkTeam = '"DEVELOPMENT_TEAM[sdk=iphoneos*]"';
  const sdkProfile = '"PROVISIONING_PROFILE_SPECIFIER[sdk=iphoneos*]"';
  const hasPreparedSigning = lines.some((line) =>
    line.trimStart().startsWith(`${sdkIdentity} = `),
  );

  if (hasPreparedSigning) {
    replaceSetting(
      lines,
      "CODE_SIGN_IDENTITY",
      configuration === "debug"
        ? '"Apple Development"'
        : `"${distributionIdentity}"`,
      configuration === "debug"
        ? '"Apple Development"'
        : '"Apple Distribution"',
    );
    replaceSetting(
      lines,
      sdkIdentity,
      configuration === "debug"
        ? '"Apple Development"'
        : `"${distributionIdentity}"`,
      null,
    );
    replaceSetting(
      lines,
      "CODE_SIGN_STYLE",
      "Manual",
      configuration === "debug" ? "Automatic" : "Manual",
    );
    replaceSetting(lines, "DEVELOPMENT_TEAM", teamId, teamId);
    replaceSetting(lines, sdkTeam, teamId, null);
    normalizePreparedProfileSetting(
      lines,
      "PROVISIONING_PROFILE_SPECIFIER",
      configuration,
    );
    normalizePreparedProfileSetting(lines, sdkProfile, configuration, true);
  }

  return lines.join("\n");
}

function prepareAppSigning(body, configuration) {
  const lines = body.split("\n");
  const canonicalIdentity =
    configuration === "debug" ? '"Apple Development"' : '"Apple Distribution"';
  const identity =
    configuration === "debug"
      ? '"Apple Development"'
      : `"${distributionIdentity}"`;
  const profile = configuration === "debug" ? '""' : `"${profileName}"`;
  replaceSetting(lines, "CODE_SIGN_IDENTITY", canonicalIdentity, identity);
  replaceSetting(
    lines,
    "CODE_SIGN_STYLE",
    configuration === "debug" ? "Automatic" : "Manual",
    configuration === "debug" ? "Automatic" : "Manual",
  );
  replaceSetting(lines, "DEVELOPMENT_TEAM", teamId, teamId);
  insertSettingAfter(
    lines,
    "CODE_SIGN_IDENTITY",
    '"CODE_SIGN_IDENTITY[sdk=iphoneos*]"',
    identity,
  );
  insertSettingAfter(
    lines,
    "DEVELOPMENT_TEAM",
    '"DEVELOPMENT_TEAM[sdk=iphoneos*]"',
    teamId,
  );
  if (configuration === "debug") {
    insertSettingAfter(
      lines,
      "PRODUCT_NAME",
      "PROVISIONING_PROFILE_SPECIFIER",
      profile,
    );
  } else {
    replaceSetting(lines, "PROVISIONING_PROFILE_SPECIFIER", profile, profile);
  }
  insertSettingAfter(
    lines,
    "PROVISIONING_PROFILE_SPECIFIER",
    '"PROVISIONING_PROFILE_SPECIFIER[sdk=iphoneos*]"',
    profile,
  );
  return lines.join("\n");
}

function normalizeProject(contents) {
  let normalized = normalizeBuildSetting(
    contents,
    "DEVELOPMENT_TEAM",
    "F9AV5HKF6N",
    2,
  );
  normalized = normalizeBuildSetting(normalized, "PRODUCT_NAME", "ZUULI", 2);
  return transformAppConfigurations(normalized, normalizeAppSigning);
}

function prepareManualSigningProject(contents) {
  return transformAppConfigurations(
    normalizeProject(contents),
    prepareAppSigning,
  );
}

function normalizePlist(contents, label) {
  if (!contents.trimEnd().endsWith("</plist>")) {
    throw new Error(
      `refusing to normalize ${label}: plist terminator is missing`,
    );
  }
  return contents.endsWith("\n") ? contents : `${contents}\n`;
}

function normalizeInfoPlist(contents, label) {
  const normalized = normalizePlist(contents, label);
  const encryptionKeyCount = occurrenceCount(
    normalized,
    "<key>ITSAppUsesNonExemptEncryption</key>",
  );
  const exemptDeclarationCount = occurrenceCount(
    normalized,
    exemptEncryptionDeclaration,
  );
  if (encryptionKeyCount !== 1 || exemptDeclarationCount !== 1) {
    throw new Error(
      `refusing to normalize ${label}: expected exactly one canonical exempt-encryption declaration, found ${encryptionKeyCount} keys and ${exemptDeclarationCount} false declarations`,
    );
  }
  const canonicalCount = occurrenceCount(normalized, canonicalUrlType);
  const reversedCount = occurrenceCount(normalized, reversedUrlType);
  if (canonicalCount + reversedCount !== 1) {
    throw new Error(
      `refusing to normalize ${label}: expected exactly one known ZUULI URL type, found ${canonicalCount + reversedCount}`,
    );
  }
  return normalized.replace(reversedUrlType, canonicalUrlType);
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
  let normalizedFixture = normalizeBuildSetting(
    generatedProject,
    "DEVELOPMENT_TEAM",
    teamId,
    2,
  );
  normalizedFixture = normalizeBuildSetting(
    normalizedFixture,
    "PRODUCT_NAME",
    "ZUULI",
    2,
  );
  if (normalizedFixture !== expectedProject) {
    throw new Error("iOS basic project normalization self-test failed");
  }
  if (
    normalizePlist("<plist><dict/></plist>", "fixture") !==
    "<plist><dict/></plist>\n"
  ) {
    throw new Error("iOS plist normalization self-test failed");
  }
  const canonicalFixture = `<plist><dict>\n${canonicalUrlType}\n${exemptEncryptionDeclaration}\n</dict></plist>`;
  const reversedFixture = `<plist><dict>\n${reversedUrlType}\n${exemptEncryptionDeclaration}\n</dict></plist>`;
  if (
    normalizeInfoPlist(canonicalFixture, "canonical fixture") !==
      `${canonicalFixture}\n` ||
    normalizeInfoPlist(reversedFixture, "reversed fixture") !==
      `${canonicalFixture}\n`
  ) {
    throw new Error("iOS URL type ordering self-test failed");
  }
  let rejectedUnknownUrlShape = false;
  try {
    normalizeInfoPlist(
      `<plist><dict>\n${exemptEncryptionDeclaration}\n</dict></plist>`,
      "unknown fixture",
    );
  } catch (error) {
    rejectedUnknownUrlShape =
      error instanceof Error &&
      error.message.includes("expected exactly one known ZUULI URL type");
  }
  if (!rejectedUnknownUrlShape) {
    throw new Error("iOS URL type normalization accepted an unknown shape");
  }
  let rejectedNonExemptEncryption = false;
  try {
    normalizeInfoPlist(
      canonicalFixture.replace("\t<false/>", "\t<true/>"),
      "non-exempt encryption fixture",
    );
  } catch (error) {
    rejectedNonExemptEncryption =
      error instanceof Error &&
      error.message.includes(
        "expected exactly one canonical exempt-encryption declaration",
      );
  }
  if (!rejectedNonExemptEncryption) {
    throw new Error("iOS plist normalization accepted non-exempt encryption");
  }
  const infoPlistPath = resolve(
    appDir,
    "src-tauri/gen/apple/zuuli_iOS/Info.plist",
  );
  const committedInfoPlist = readFileSync(infoPlistPath, "utf8");
  if (
    normalizeInfoPlist(committedInfoPlist, infoPlistPath) !== committedInfoPlist
  ) {
    throw new Error("committed iOS Info.plist is not canonical");
  }
  let rejectedUnexpectedShape = false;
  try {
    normalizeProject('DEVELOPMENT_TEAM = "F9AV5HKF6N";');
  } catch {
    rejectedUnexpectedShape = true;
  }
  if (!rejectedUnexpectedShape) {
    throw new Error("iOS project normalization accepted an unexpected shape");
  }
  const projectPath = resolve(
    appDir,
    "src-tauri/gen/apple/zuuli.xcodeproj/project.pbxproj",
  );
  const canonical = readFileSync(projectPath, "utf8");
  if (normalizeProject(canonical) !== canonical) {
    throw new Error("committed iOS project is not canonical");
  }
  const prepared = prepareManualSigningProject(canonical);
  if (prepared === canonical) {
    throw new Error("manual-signing preparation did not add guarded settings");
  }
  let tauriGenerated = normalizeBuildSetting(
    prepared,
    "DEVELOPMENT_TEAM",
    teamId,
    2,
  );
  tauriGenerated = normalizeBuildSetting(
    tauriGenerated,
    "PRODUCT_NAME",
    "ZUULI",
    2,
  );
  tauriGenerated = transformAppConfigurations(
    tauriGenerated,
    (body, configuration) => {
      const lines = body.split("\n");
      const fixtureProfileUuid = '"11111111-2222-3333-4444-555555555555"';
      const canonicalProfile =
        configuration === "debug" ? '""' : `"${profileName}"`;
      replaceSetting(
        lines,
        "CODE_SIGN_STYLE",
        configuration === "debug" ? "Automatic" : "Manual",
        "Manual",
      );
      replaceSetting(lines, "DEVELOPMENT_TEAM", teamId, `"${teamId}"`);
      replaceSetting(
        lines,
        "PROVISIONING_PROFILE_SPECIFIER",
        canonicalProfile,
        fixtureProfileUuid,
      );
      replaceSetting(
        lines,
        '"PROVISIONING_PROFILE_SPECIFIER[sdk=iphoneos*]"',
        canonicalProfile,
        fixtureProfileUuid,
      );
      return lines.join("\n");
    },
  );
  tauriGenerated = tauriGenerated
    .replaceAll(
      `DEVELOPMENT_TEAM = ${teamId};`,
      `DEVELOPMENT_TEAM = "${teamId}";`,
    )
    .replaceAll("PRODUCT_NAME = ZUULI;", 'PRODUCT_NAME = "ZUULI";');
  if (normalizeProject(tauriGenerated) !== canonical) {
    throw new Error(
      "manual-signing project did not normalize to canonical bytes",
    );
  }
  let rejectedMalformedProfileUuid = false;
  try {
    normalizeProject(
      prepared.replaceAll(`"${profileName}"`, '"not-a-profile-uuid"'),
    );
  } catch {
    rejectedMalformedProfileUuid = true;
  }
  if (!rejectedMalformedProfileUuid) {
    throw new Error("iOS project normalization accepted a malformed profile UUID");
  }
}

if (process.argv.includes("--self-test")) {
  selfTest();
  process.exit(0);
}

const projectPath = resolve(
  appDir,
  "src-tauri/gen/apple/zuuli.xcodeproj/project.pbxproj",
);
const infoPlistPath = resolve(
  appDir,
  "src-tauri/gen/apple/zuuli_iOS/Info.plist",
);
const entitlementsPath = resolve(
  appDir,
  "src-tauri/gen/apple/zuuli_iOS/zuuli_iOS.entitlements",
);

const project = readFileSync(projectPath, "utf8");
const normalizedProject = process.argv.includes("--prepare-manual-signing")
  ? prepareManualSigningProject(project)
  : normalizeProject(project);
if (normalizedProject !== project) {
  writeFileSync(projectPath, normalizedProject);
}

const infoPlist = readFileSync(infoPlistPath, "utf8");
const normalizedInfoPlist = normalizeInfoPlist(infoPlist, infoPlistPath);
if (normalizedInfoPlist !== infoPlist) {
  writeFileSync(infoPlistPath, normalizedInfoPlist);
}

const entitlements = readFileSync(entitlementsPath, "utf8");
const normalizedEntitlements = normalizePlist(entitlements, entitlementsPath);
if (normalizedEntitlements !== entitlements) {
  writeFileSync(entitlementsPath, normalizedEntitlements);
}
