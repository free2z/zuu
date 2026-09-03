#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";

import {
  verifyAppleCredentialBoundary,
  verifyGithubReleasePublisher,
  verifyReleaseIndexVerifier,
  verifyReleaseTagVerifier,
} from "./apple-credential-boundary.mjs";
import { artifactSbomWorkflowFailures } from "./artifact-sbom.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const json = (path) => JSON.parse(read(path));
const failures = [];
const releaseBytes = readFileSync(resolve(root, "release.json"));

function releaseEncryptionKeyCount(contents) {
  return (
    contents.match(/"iosUsesNonExemptEncryption"\s*:/g) ?? []
  ).length;
}

function validateReleaseEncryptionKeyCount(contents, label, target) {
  const count = releaseEncryptionKeyCount(contents);
  if (count !== 1)
    target.push(
      `${label} must contain exactly one raw iosUsesNonExemptEncryption key, found ${count}`,
    );
}

function parseCanonicalRelease(bytes, label, target) {
  let contents;
  try {
    contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    target.push(`${label} must contain valid UTF-8`);
    return undefined;
  }
  validateReleaseEncryptionKeyCount(contents, label, target);
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch {
    target.push(`${label} must contain valid JSON`);
    return undefined;
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    target.push(`${label} root must be a JSON object`);
    return undefined;
  }
  const canonicalBytes = Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  if (!bytes.equals(canonicalBytes))
    target.push(
      `${label} bytes must be canonical UTF-8 JSON without duplicate or escaped property names`,
    );
  return parsed;
}

for (const [label, fixture, expectedRawFailures] of [
  [
    "same-value literal duplicate",
    '{\n  "iosUsesNonExemptEncryption": false,\n  "iosUsesNonExemptEncryption": false\n}\n',
    1,
  ],
  [
    "conflicting literal duplicate",
    '{\n  "iosUsesNonExemptEncryption": true,\n  "iosUsesNonExemptEncryption": false\n}\n',
    1,
  ],
  [
    "same-value escaped duplicate",
    `${String.raw`{
  "iosUsesNonExemptEncryption": false,
  "iosUsesNonExemptEncrypt\u0069on": false
}`}\n`,
    0,
  ],
  [
    "conflicting escaped duplicate",
    `${String.raw`{
  "iosUsesNonExemptEncryption": true,
  "iosUsesNonExemptEncrypt\u0069on": false
}`}\n`,
    0,
  ],
]) {
  const fixtureFailures = [];
  const parsedFixture = parseCanonicalRelease(
    Buffer.from(fixture, "utf8"),
    label,
    fixtureFailures,
  );
  const canonicalFailures = fixtureFailures.filter((failure) =>
    failure.includes("bytes must be canonical UTF-8 JSON"),
  );
  const rawFailures = fixtureFailures.filter((failure) =>
    failure.includes("must contain exactly one raw"),
  );
  if (
    canonicalFailures.length !== 1 ||
    rawFailures.length !== expectedRawFailures ||
    parsedFixture.iosUsesNonExemptEncryption !== false
  )
    throw new Error(`release duplicate-key detector self-test failed: ${label}`);
}

const invalidUtf8Fixture = Buffer.concat([
  Buffer.from('{\n  "iosUsesNonExemptEncryption": false,\n  "$schema": "', "utf8"),
  Buffer.from([0xff]),
  Buffer.from('"\n}\n', "utf8"),
]);
const invalidUtf8Failures = [];
if (
  parseCanonicalRelease(
    invalidUtf8Fixture,
    "invalid UTF-8 fixture",
    invalidUtf8Failures,
  ) !== undefined ||
  invalidUtf8Failures.length !== 1 ||
  invalidUtf8Failures[0] !== "invalid UTF-8 fixture must contain valid UTF-8"
)
  throw new Error("release invalid-UTF-8 detector self-test failed");

const release = parseCanonicalRelease(releaseBytes, "release.json", failures);
if (release === undefined) {
  console.error(
    "ZUULI release identity is inconsistent:\n- " + failures.join("\n- "),
  );
  process.exit(1);
}

function parseCanonicalBuildMetadata(bytes, target) {
  let contents;
  try {
    contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    target.push("build-info.json must contain valid UTF-8");
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch {
    target.push("build-info.json must contain valid JSON");
    return {};
  }
  const canonical = Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  if (!bytes.equals(canonical))
    target.push(
      "build-info.json bytes must be canonical UTF-8 JSON without duplicate or escaped property names",
    );
  const expectedKeys = ["$schema", "channel", "schemaVersion"];
  if (
    parsed === null ||
    Array.isArray(parsed) ||
    typeof parsed !== "object" ||
    JSON.stringify(Object.keys(parsed).sort()) !== JSON.stringify(expectedKeys)
  ) {
    target.push("build-info.json must contain exactly its schema, version, and channel");
    return {};
  }
  if (parsed.$schema !== "./build-info.schema.json")
    target.push("build-info.json schema reference is unsupported");
  return parsed;
}

const buildMetadata = parseCanonicalBuildMetadata(
  readFileSync(resolve(root, "build-info.json")),
  failures,
);

function expect(label, actual, expected) {
  if (`${actual}` !== `${expected}`) {
    failures.push(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function capture(pattern, text, label) {
  const match = text.match(pattern);
  if (!match) {
    failures.push(`${label}: value not found`);
    return undefined;
  }
  return match[1];
}

function occurrenceCount(contents, value) {
  return contents.split(value).length - 1;
}

expect("release schema version", release.schemaVersion, 2);
expect("release application ID", release.applicationId, "cash.free2z.zuuli");
expect("build metadata schema version", buildMetadata.schemaVersion, 1);
if (!["internal", "beta", "stable"].includes(buildMetadata.channel))
  failures.push(`release channel is unsupported: ${buildMetadata.channel}`);
if (release.iosUsesNonExemptEncryption !== false)
  failures.push(
    "release iOS non-exempt encryption declaration must be Boolean false",
  );
expect("release minimum iOS", release.minimums?.ios, "18.0");
expect("release minimum Android", release.minimums?.android, 29);

if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(release.version)) {
  failures.push(
    `release.json version is not strict SemVer core: ${release.version}`,
  );
}
if (
  !Number.isSafeInteger(release.build) ||
  release.build < 1 ||
  release.build > 2_100_000_000
) {
  failures.push(
    `release.json build must be an integer from 1 through 2100000000: ${release.build}`,
  );
}

const packageJson = json("package.json");
const packageLock = json("package-lock.json");
const tauri = json("src-tauri/tauri.conf.json");
const cargo = read("src-tauri/Cargo.toml");
const cargoLock = read("src-tauri/Cargo.lock");
const project = read("src-tauri/gen/apple/project.yml");
const plist = read("src-tauri/gen/apple/zuuli_iOS/Info.plist");
const plistSource = read("src-tauri/Info.ios.plist");
const pbxproj = read("src-tauri/gen/apple/zuuli.xcodeproj/project.pbxproj");
const entitlements = read(
  "src-tauri/gen/apple/zuuli_iOS/zuuli_iOS.entitlements",
);
const rustToolchain = read("../rust-toolchain.toml");
const gradle = read("src-tauri/gen/android/app/build.gradle.kts");
const gradleWrapper = read(
  "src-tauri/gen/android/gradle/wrapper/gradle-wrapper.properties",
);
const gradleProperties = read("src-tauri/gen/android/gradle.properties");
const androidManifest = read(
  "src-tauri/gen/android/app/src/main/AndroidManifest.xml",
);
const androidToolchain = read("scripts/android-toolchain-env.sh");
const gemLock = read("Gemfile.lock");
const mobileRelease = read("scripts/mobile-release.sh");
const ascTestFlight = read("scripts/asc-testflight.mjs");
const gateWorkflow = read("../../.github/workflows/zuuli.yml");
const releaseWorkflow = read("../../.github/workflows/zuuli-release.yml");
const githubReleasePublisher = read("scripts/publish-github-release.sh");
const releaseTagVerifier = read("scripts/verify-release-tag.sh");
const releaseIndexVerifier = read("scripts/verify-release-index.sh");
const testFlightRecoveryWorkflow = read(
  "../../.github/workflows/zuuli-testflight-recovery.yml",
);
const testFlightBootstrapWorkflow = read(
  "../../.github/workflows/zuuli-testflight-bootstrap.yml",
);
const storeAuditWorkflow = read("../../.github/workflows/zuuli-store-audit.yml");
const storePublishWorkflow = read("../../.github/workflows/zuuli-store-publish.yml");
const packagingWorkflow = read("../../.github/workflows/zuuli-packaging.yml");
const viteConfig = read("vite.config.ts");
const buildIdentitySource = read("scripts/build-identity.mjs");
const releaseManifestSource = read("scripts/release-manifest.mjs");

for (const [label, contents, contract] of [
  ["Vite build identity", viteConfig, "__ZUULI_BUILD_INFO__"],
  ["Vite build identity loader", viteConfig, "loadBuildIdentity({ root })"],
  ["build identity release source", buildIdentitySource, 'resolve(root, "release.json")'],
  ["build identity metadata source", buildIdentitySource, 'resolve(root, "build-info.json")'],
  ["release manifest channel", releaseManifestSource, "channel: buildMetadata.channel"],
]) {
  if (!contents.includes(contract))
    failures.push(`${label} contract is missing: ${contract}`);
}
expect(
  "protected source-build SHA bindings",
  occurrenceCount(
    releaseWorkflow,
    "ZUULI_RELEASE_SOURCE_SHA: ${{ needs.prepare.outputs.source_sha }}",
  ),
  4,
);

for (const failure of artifactSbomWorkflowFailures(
  packagingWorkflow,
  releaseWorkflow,
)) {
  failures.push(`artifact SBOM workflow: ${failure}`);
}

expect("package.json version", packageJson.version, release.version);
expect("package-lock.json version", packageLock.version, release.version);
expect(
  "package-lock.json root version",
  packageLock.packages?.[""]?.version,
  release.version,
);
expect(
  "Cargo.toml package version",
  capture(/^version\s*=\s*"([^"]+)"/m, cargo, "Cargo.toml package version"),
  release.version,
);
expect(
  "Cargo.lock zuuli package version",
  capture(
    /\[\[package\]\]\nname = "zuuli"\nversion = "([^"]+)"/m,
    cargoLock,
    "Cargo.lock zuuli package version",
  ),
  release.version,
);
expect("tauri.conf.json version", tauri.version, release.version);
expect("tauri.conf.json identifier", tauri.identifier, release.applicationId);
expect(
  "tauri iOS bundleVersion",
  tauri.bundle?.iOS?.bundleVersion,
  release.build,
);
expect("tauri Apple team", tauri.bundle?.iOS?.developmentTeam, "F9AV5HKF6N");
expect(
  "tauri Android versionCode",
  tauri.bundle?.android?.versionCode,
  release.build,
);
expect(
  "tauri iOS minimum",
  tauri.bundle?.iOS?.minimumSystemVersion,
  release.minimums.ios,
);
expect(
  "tauri Android minimum",
  tauri.bundle?.android?.minSdkVersion,
  release.minimums.android,
);

expect(
  "XcodeGen bundle identifier",
  capture(
    /PRODUCT_BUNDLE_IDENTIFIER:\s*([^\s]+)/,
    project,
    "XcodeGen bundle identifier",
  ),
  release.applicationId,
);
expect(
  "XcodeGen marketing version",
  capture(
    /CFBundleShortVersionString:\s*([^\s]+)/,
    project,
    "XcodeGen marketing version",
  ),
  release.version,
);
expect(
  "XcodeGen build",
  capture(/CFBundleVersion:\s*"?([^"\s]+)"?/, project, "XcodeGen build"),
  release.build,
);
expect(
  "XcodeGen iOS non-exempt encryption key count",
  (project.match(/^\s*ITSAppUsesNonExemptEncryption:/gm) ?? []).length,
  1,
);
expect(
  "XcodeGen iOS non-exempt encryption declaration count",
  (project.match(/^\s*ITSAppUsesNonExemptEncryption:\s*false\s*$/gm) ?? [])
    .length,
  1,
);
expect(
  "XcodeGen Apple team",
  capture(/DEVELOPMENT_TEAM:\s*([^\s]+)/, project, "XcodeGen Apple team"),
  "F9AV5HKF6N",
);
expect(
  "generated iOS marketing version",
  capture(
    /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/,
    plist,
    "generated iOS marketing version",
  ),
  release.version,
);
expect(
  "generated iOS build",
  capture(
    /<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/,
    plist,
    "generated iOS build",
  ),
  release.build,
);
expect(
  "generated iOS bundle identifier",
  capture(
    /PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/,
    pbxproj,
    "generated iOS bundle identifier",
  ),
  release.applicationId,
);
if (!pbxproj.includes('CODE_SIGN_IDENTITY = "Apple Development";'))
  failures.push(
    "generated Xcode debug signing identity is not Apple Development",
  );
if (!pbxproj.includes('CODE_SIGN_IDENTITY = "Apple Distribution";'))
  failures.push(
    "generated Xcode release signing identity is not Apple Distribution",
  );
if (!pbxproj.includes('PROVISIONING_PROFILE_SPECIFIER = "ZUULI App Store CI";'))
  failures.push("generated Xcode release provisioning profile is not pinned");
expect(
  "XcodeGen link-only Rust archive dependency count",
  (
    project.match(
      /^[ \t]*-[ \t]+framework:[ \t]+libapp\.a[ \t]*\n[ \t]+embed:[ \t]+false[ \t]*$/gm,
    ) ?? []
  ).length,
  1,
);
expect(
  "XcodeGen Rust archive source-tree count",
  (project.match(/^[ \t]*-[ \t]+path:[ \t]+Externals[ \t]*$/gm) ?? [])
    .length,
  0,
);
expect(
  "generated Xcode Rust archive framework-phase count",
  occurrenceCount(pbxproj, "libapp.a in Frameworks"),
  2,
);
expect(
  "generated Xcode Rust archive resource-phase count",
  occurrenceCount(pbxproj, "libapp.a in Resources"),
  0,
);
expect(
  "generated Xcode Rust archive total build-phase label count",
  occurrenceCount(pbxproj, "libapp.a in "),
  2,
);
expect(
  "generated Xcode Rust archive file-reference count",
  occurrenceCount(pbxproj, "/* libapp.a */ = {isa = PBXFileReference;"),
  1,
);
for (const [label, contents] of [
  ["generated Xcode project", pbxproj],
  ["generated iOS plist", plist],
  ["generated iOS entitlements", entitlements],
]) {
  if (!contents.endsWith("\n"))
    failures.push(`${label} has no terminal newline`);
}
expect(
  "generated Xcode canonical team setting count",
  occurrenceCount(pbxproj, "DEVELOPMENT_TEAM = F9AV5HKF6N;"),
  2,
);
expect(
  "generated Xcode quoted team setting count",
  occurrenceCount(pbxproj, 'DEVELOPMENT_TEAM = "F9AV5HKF6N";'),
  0,
);
expect(
  "generated Xcode canonical product name count",
  occurrenceCount(pbxproj, "PRODUCT_NAME = ZUULI;"),
  2,
);
expect(
  "generated Xcode quoted product name count",
  occurrenceCount(pbxproj, 'PRODUCT_NAME = "ZUULI";'),
  0,
);
for (const privacyKey of [
  "NSCameraUsageDescription",
  "NSFaceIDUsageDescription",
  "NSMicrophoneUsageDescription",
]) {
  const sourceValue = capture(
    new RegExp(`<key>${privacyKey}<\\/key>\\s*<string>([^<]+)<\\/string>`),
    plistSource,
    `iOS source ${privacyKey}`,
  );
  const generatedValue = capture(
    new RegExp(`<key>${privacyKey}<\\/key>\\s*<string>([^<]+)<\\/string>`),
    plist,
    `generated iOS ${privacyKey}`,
  );
  if (sourceValue !== undefined && generatedValue !== undefined)
    expect(`generated iOS ${privacyKey}`, generatedValue, sourceValue);
}
for (const [label, contents] of [
  ["iOS source", plistSource],
  ["generated iOS", plist],
]) {
  expect(
    `${label} ITSAppUsesNonExemptEncryption key count`,
    occurrenceCount(contents, "<key>ITSAppUsesNonExemptEncryption</key>"),
    1,
  );
  expect(
    `${label} ITSAppUsesNonExemptEncryption`,
    capture(
      /<key>ITSAppUsesNonExemptEncryption<\/key>\s*<(true|false)\s*\/>/,
      contents,
      `${label} ITSAppUsesNonExemptEncryption`,
    ),
    release.iosUsesNonExemptEncryption,
  );
}
const callbackScheme = "cash.free2z.zuuli";
if (
  !new RegExp(
    `CFBundleURLSchemes:\\s*\\n\\s*-\\s*${callbackScheme.replaceAll(".", "\\.")}`,
  ).test(project)
)
  failures.push("XcodeGen OAuth callback URL scheme is missing");
for (const [label, contents] of [
  ["iOS source", plistSource],
  ["generated iOS", plist],
]) {
  if (
    !new RegExp(
      `<key>CFBundleURLSchemes<\\/key>\\s*<array>\\s*<string>${callbackScheme.replaceAll(".", "\\.")}<\\/string>`,
    ).test(contents)
  )
    failures.push(`${label} OAuth callback URL scheme is missing`);
}

expect(
  "Android namespace",
  capture(/namespace\s*=\s*"([^"]+)"/, gradle, "Android namespace"),
  release.applicationId,
);
expect(
  "Android applicationId",
  capture(/applicationId\s*=\s*"([^"]+)"/, gradle, "Android applicationId"),
  release.applicationId,
);
if (/^[\t ]+$/m.test(androidManifest))
  failures.push("generated Android manifest contains whitespace-only lines");
for (const callbackElement of [
  `<data android:scheme="${callbackScheme}" />`,
  '<data android:host="oauth" />',
  '<data android:path="/callback" />',
]) {
  if (!androidManifest.includes(callbackElement))
    failures.push(
      `generated Android OAuth callback is missing ${callbackElement}`,
    );
}
expect(
  "Android fallback version name",
  capture(
    /tauri\.android\.versionName",\s*"([^"]+)"/,
    gradle,
    "Android fallback version name",
  ),
  release.version,
);
expect(
  "Android fallback version code",
  capture(
    /tauri\.android\.versionCode",\s*"([^"]+)"/,
    gradle,
    "Android fallback version code",
  ),
  release.build,
);
expect(
  "Android compile SDK",
  capture(/compileSdk\s*=\s*(\d+)/, gradle, "Android compile SDK"),
  36,
);
expect(
  "Android target SDK",
  capture(/targetSdk\s*=\s*(\d+)/, gradle, "Android target SDK"),
  36,
);
expect(
  "Android NDK",
  capture(/ndkVersion\s*=\s*"([^"]+)"/, gradle, "Android NDK"),
  "27.0.12077973",
);
expect(
  "Gradle wrapper",
  capture(/gradle-([0-9.]+)-bin\.zip/, gradleWrapper, "Gradle wrapper"),
  "8.14.3",
);
expect(
  "Gradle wrapper checksum",
  capture(
    /^distributionSha256Sum=([0-9a-f]{64})$/m,
    gradleWrapper,
    "Gradle wrapper checksum",
  ),
  "bd71102213493060956ec229d946beee57158dbd89d0e62b91bca0fa2c5f3531",
);
expect(
  "Gradle daemon isolation",
  capture(
    /^org\.gradle\.daemon=(\S+)$/m,
    gradleProperties,
    "Gradle daemon isolation",
  ),
  "false",
);
expect(
  "Fastlane lock",
  capture(/^    fastlane \(([^)]+)\)$/m, gemLock, "Fastlane lock"),
  "2.237.0",
);
expect(
  "Bundler lock",
  capture(
    /^  ([0-9.]+)$/m,
    gemLock.split("BUNDLED WITH")[1] ?? "",
    "Bundler lock",
  ),
  "4.0.3",
);
expect(
  "Android toolchain NDK",
  capture(
    /export NDK_HOME="\$ANDROID_HOME\/ndk\/([0-9.]+)"/,
    androidToolchain,
    "Android toolchain NDK",
  ),
  "27.0.12077973",
);
expect(
  "Rust toolchain",
  capture(/channel\s*=\s*"([^"]+)"/, rustToolchain, "Rust toolchain"),
  // rust-toolchain.toml channel, restated so a silent edit to the source of
  // truth fails here too. scripts/check-rust-toolchain.sh holds it in step.
  "1.97.1",
);
// This parsed-YAML verifier owns the exact release-index verifier step and its
// order; do not replace it with raw source-fragment presence checks below.
for (const boundaryFailure of verifyAppleCredentialBoundary(releaseWorkflow))
  failures.push(`Apple credential boundary: ${boundaryFailure}`);
for (const publisherFailure of verifyGithubReleasePublisher(githubReleasePublisher))
  failures.push(`GitHub release publisher: ${publisherFailure}`);
for (const verifierFailure of verifyReleaseTagVerifier(releaseTagVerifier))
  failures.push(`Release-tag verifier: ${verifierFailure}`);
for (const verifierFailure of verifyReleaseIndexVerifier(releaseIndexVerifier))
  failures.push(`Release-index verifier: ${verifierFailure}`);
if (mobileRelease.includes("tauri ios build") || mobileRelease.includes("platform == ios"))
  failures.push("mobile-release.sh must not recombine iOS credentials with dependency-controlled builds");
for (const preservedContract of [
  "node scripts/normalize-generated-ios-project.mjs --prepare-manual-signing",
  "./node_modules/.bin/tauri ios build --ci --no-sign --archive-only --config '{\"build\":{\"beforeBuildCommand\":null}}' -- --locked",
  "node scripts/normalize-generated-ios-project.mjs",
  "xcodebuild -exportArchive",
  "scripts/verify-ios-ipa.sh --expected-profile-sha256",
  "xcrun altool --validate-app",
  "xcrun altool --upload-app",
  "node verified-ios/asc-testflight.mjs --ensure",
  "xcrun notarytool submit",
  "xcrun stapler validate",
  "node scripts/release-manifest.mjs",
]) {
  if (!releaseWorkflow.includes(preservedContract))
    failures.push(`protected Apple release contract is missing: ${preservedContract}`);
}
for (const contract of [
  'export const ASC_APP_ID = "6799322201"',
  'export const ASC_BUNDLE_ID = "cash.free2z.zuuli"',
  'export const ASC_INTERNAL_GROUP = "ZUULI Internal Testers"',
  '"filter[preReleaseVersion.version]"',
  '"filter[preReleaseVersion.platform]"',
  '"MISSING_EXPORT_COMPLIANCE"',
  '"INVALID_BINARY"',
  '"AMBIGUOUS_EXACT_BUILD"',
  'availableToInternalTesters: true',
  'async createInternalGroup()',
  'let groupCreationAttempted = false',
  '"POST", "/v1/betaGroups"',
  'isInternalGroup: true',
  'hasAccessToAllBuilds: false',
  'app: { data: { type: "apps", id: ASC_APP_ID } }',
  '/relationships/builds',
]) {
  if (!ascTestFlight.includes(contract))
    failures.push(`App Store Connect state contract is missing: ${contract}`);
}
if (ascTestFlight.includes("betaTesters"))
  failures.push("App Store Connect state machine must never request tester identities");
for (const recoveryContract of [
  "name: ZUULI / TestFlight read-only recovery",
  "environment: zuuli-app-stores",
  "--read-only",
  "source SHA must be the commit that established this release identity",
  "node --test scripts/asc-testflight.node-test.mjs",
]) {
  if (!testFlightRecoveryWorkflow.includes(recoveryContract))
    failures.push(`TestFlight recovery workflow is missing: ${recoveryContract}`);
}
if (
  testFlightRecoveryWorkflow.includes("--ensure") ||
  testFlightRecoveryWorkflow.includes("--bootstrap")
)
  failures.push("TestFlight recovery workflow must remain read-only");
if (!gateWorkflow.includes(".github/workflows/zuuli-testflight-recovery.yml"))
  failures.push("ZUULI gate must select TestFlight recovery workflow changes");
for (const bootstrapContract of [
  "name: ZUULI / TestFlight protected bootstrap",
  "environment: zuuli-app-stores",
  "--bootstrap",
  "source SHA must be the commit that established this release identity",
  "confirmed identity is no longer current on origin/main",
  "node --test scripts/asc-testflight.node-test.mjs",
  "Destroy ephemeral ASC credential",
  "Upload sanitized bootstrap evidence",
]) {
  if (!testFlightBootstrapWorkflow.includes(bootstrapContract))
    failures.push(`TestFlight bootstrap workflow is missing: ${bootstrapContract}`);
}
for (const forbiddenBootstrapContract of ["--ensure", "--read-only", "betaTesters"]) {
  if (testFlightBootstrapWorkflow.includes(forbiddenBootstrapContract))
    failures.push(
      `TestFlight bootstrap workflow has a forbidden contract: ${forbiddenBootstrapContract}`,
    );
}
if (!gateWorkflow.includes(".github/workflows/zuuli-testflight-bootstrap.yml"))
  failures.push("ZUULI gate must select TestFlight bootstrap workflow changes");
for (const auditContract of [
  "name: ZUULI / Store listing read-only audit",
  "environment: zuuli-app-stores",
  "test \"$(git rev-parse refs/remotes/origin/main)\" = \"$SOURCE_SHA\"",
  "npm run test:store-listing",
  "node scripts/store-state-audit.mjs",
  "id: audit\n        continue-on-error: true",
  "id: cleanup\n        if: always()\n        continue-on-error: true",
  "steps.audit.outputs.evidence_present == 'true'",
  "steps.audit.outcome",
  "steps.cleanup.outcome",
  "::add-mask::$ASC_KEY_ID",
  "Destroy ephemeral store credentials",
  "Upload sanitized store-state evidence",
  "Enforce audit and cleanup verdict",
  "ephemeral store credential cleanup did not succeed",
  "one or more requested store provider audits failed",
]) {
  if (!storeAuditWorkflow.includes(auditContract))
    failures.push(`store audit workflow is missing: ${auditContract}`);
}
for (const forbiddenAuditContract of ["edits:commit", "updateTesters", "betaTesters"])
  if (storeAuditWorkflow.includes(forbiddenAuditContract))
    failures.push(`store audit workflow has a forbidden contract: ${forbiddenAuditContract}`);
if (storeAuditWorkflow.includes("    env:\n      ASC_KEY_ID: ${{ vars.ASC_KEY_ID }}"))
  failures.push("store audit workflow must not expose ASC identifiers in every Play-only step");
const storeAuditExecution = storeAuditWorkflow.indexOf("      - name: Audit canonical locales, media, and Play tester mode");
const storeAuditCleanup = storeAuditWorkflow.indexOf("      - name: Destroy ephemeral store credentials");
const storeAuditEvidence = storeAuditWorkflow.indexOf("      - name: Upload sanitized store-state evidence");
const storeAuditVerdict = storeAuditWorkflow.indexOf("      - name: Enforce audit and cleanup verdict");
if (
  storeAuditExecution === -1 ||
  storeAuditCleanup === -1 ||
  storeAuditEvidence === -1 ||
  storeAuditVerdict === -1 ||
  storeAuditExecution > storeAuditCleanup ||
  storeAuditCleanup > storeAuditEvidence ||
  storeAuditEvidence > storeAuditVerdict
) failures.push("store audit must execute, clean credentials, upload sanitized evidence, then enforce its verdict");
for (const publishContract of [
  "name: ZUULI / Store listing publication gate",
  "environment: zuuli-app-stores",
  "test \"$(git rev-parse refs/remotes/origin/main)\" = \"$SOURCE_SHA\"",
  "test \"$actual_locales\" = \"$CONFIRMED_LOCALES\"",
  "npm run store:validate -- --publish",
  "Phase A has no enabled store writer",
]) {
  if (!storePublishWorkflow.includes(publishContract))
    failures.push(`store publication gate is missing: ${publishContract}`);
}
for (const releaseTagContract of [
  'RELEASE_SOURCE_SHA: ${{ needs.prepare.outputs.source_sha }}',
  'pattern: zuuli-{android,ios,linux,macos}-${{ needs.prepare.outputs.identity }}-${{ needs.prepare.outputs.source_sha }}',
  'scripts/publish-github-release.sh "$RELEASE_TAG" "$RELEASE_IDENTITY" "$RELEASE_SOURCE_SHA" release-downloads',
]) {
  if (!releaseWorkflow.includes(releaseTagContract))
    failures.push(`release tag identity contract is missing: ${releaseTagContract}`);
}
const releaseDecision = releaseWorkflow.indexOf("          should_release=true");
const statusBoundaryCondition = releaseWorkflow.indexOf(
  '          if [[ "$should_release" == true && "$dry_run" == false ]]; then',
);
const statusBoundaryInvocation = releaseWorkflow.indexOf(
  '            node scripts/status-freshness.mjs "--source-sha=$source_sha"',
);
const releaseOutputs = releaseWorkflow.indexOf('            echo "identity=$actual"');
if (
  releaseDecision === -1 ||
  statusBoundaryCondition === -1 ||
  statusBoundaryInvocation === -1 ||
  releaseOutputs === -1 ||
  releaseDecision > statusBoundaryCondition ||
  statusBoundaryCondition > statusBoundaryInvocation ||
  statusBoundaryInvocation > releaseOutputs
) {
  failures.push(
    "real promotion must verify STATUS.md after the release decision and before publishing prepare outputs",
  );
}
if (!packageJson.scripts?.test?.includes("scripts/status-freshness.node-test.mjs"))
  failures.push("the required test suite must exercise the STATUS.md source boundary");
for (const releasePublishContract of [
  'verify-release-tag.sh" "$tag" "$expected_commit"',
  'release-tag-identity.json',
  'reverify_tag_identity',
]) {
  if (!githubReleasePublisher.includes(releasePublishContract))
    failures.push(`GitHub release publication identity contract is missing: ${releasePublishContract}`);
}
for (const releaseIndexContract of [
  '[[ -d "$artifact_root" ]]',
  '[[ "$identity" =~ ^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\+(0|[1-9][0-9]*)$ ]]',
  '[[ "$expected_commit" =~ ^[0-9a-f]{40}$ ]]',
  'mobile) expected_platforms=(android ios)',
  'desktop) expected_platforms=(linux macos)',
  'all) expected_platforms=(android ios linux macos)',
  '"zuuli-android-$identity-$expected_commit"',
  '"zuuli-ios-$identity-$expected_commit"',
  '"zuuli-linux-$identity-$expected_commit"',
  '"zuuli-macos-$identity-$expected_commit"',
  '[[ -d "$directory" ]]',
  '[[ -f "$directory/provenance.json" ]]',
  "'.source.commit == $sha'",
  '[[ "$provenance_count" -eq 1 ]]',
  'release index contains unselected platform artifact',
  'release index is missing selected platform artifact',
  '[[ "$artifact_count" -eq "${#expected_platforms[@]}" ]]',
]) {
  if (!releaseIndexVerifier.includes(releaseIndexContract))
    failures.push(`release-index verifier contract is missing: ${releaseIndexContract}`);
}
if (/gh release edit[^\n]*(?:--draft(?:=|\s+)false|--draft=false)/.test(githubReleasePublisher))
  failures.push("GitHub release publication must not make a draft public without a final tag identity gate");
for (const forbiddenPublishContract of ["ASC_KEY_BASE64", "PLAY_SERVICE_ACCOUNT_JSON_BASE64", "fastlane deliver", "fastlane supply"])
  if (storePublishWorkflow.includes(forbiddenPublishContract))
    failures.push(`Phase A store publication gate must not materialize credentials or invoke a writer: ${forbiddenPublishContract}`);
for (const workflowPath of [
  ".github/workflows/zuuli-store-audit.yml",
  ".github/workflows/zuuli-store-publish.yml",
]) {
  if (!gateWorkflow.includes(workflowPath)) failures.push(`ZUULI gate must select ${workflowPath} changes`);
}
const unsignedIosBuild = packagingWorkflow.indexOf(
  "./node_modules/.bin/tauri ios build --ci --no-sign",
);
const unsignedIosFrontend = packagingWorkflow.indexOf(
  "- name: Build source-bound frontend from the clean checkout",
);
const unsignedIosInspection = packagingWorkflow.indexOf(
  'scripts/verify-ios-ipa.sh --verify-app-structure "${apps[0]}"',
);
const unsignedIosCollection = packagingWorkflow.indexOf(
  "- name: Collect unsigned package",
);
if (
  unsignedIosFrontend === -1 ||
  unsignedIosBuild === -1 ||
  unsignedIosInspection === -1 ||
  unsignedIosCollection === -1 ||
  unsignedIosFrontend > unsignedIosBuild ||
  unsignedIosBuild > unsignedIosInspection ||
  unsignedIosInspection > unsignedIosCollection
) {
  failures.push(
    "unsigned iOS packaging must build, inspect the app structure, then collect the artifact",
  );
}
for (const [label, workflow, contract] of [
  ["packaging iOS build platform", packagingWorkflow, "ZUULI_BUILD_PLATFORM: ios"],
  ["protected iOS build platform", releaseWorkflow, "ZUULI_BUILD_PLATFORM: ios"],
  [
    "packaging iOS clean frontend handoff",
    packagingWorkflow,
    "--config '{\"build\":{\"beforeBuildCommand\":null}}'",
  ],
]) {
  if (!workflow.includes(contract)) failures.push(`${label} contract is missing: ${contract}`);
}
for (const target of [
  "aarch64-linux-android",
  "armv7a-linux-androideabi",
  "i686-linux-android",
  "x86_64-linux-android",
]) {
  if (!androidToolchain.includes(`${target}29-clang`))
    failures.push(`Android toolchain does not pin ${target} to API 29`);
}

const identity = `${release.version}+${release.build}`;
const tag = `zuuli-v${identity}`;
if (process.env.ZUULI_NODE_VERSION)
  expect("Node runtime", process.versions.node, process.env.ZUULI_NODE_VERSION);
if (process.argv.includes("--require-main")) {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    execFileSync(
      "git",
      ["merge-base", "--is-ancestor", head, "refs/remotes/origin/main"],
      { cwd: root, stdio: "ignore" },
    );
  } catch {
    failures.push("checked-out source is not a commit on origin/main");
  }
}
if (process.argv.includes("--require-tag")) {
  let head;
  let tagged;
  let remoteTagged;
  try {
    head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    tagged = execFileSync("git", ["rev-list", "-n", "1", `refs/tags/${tag}`], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const tagType = execFileSync(
      "git",
      ["cat-file", "-t", `refs/tags/${tag}`],
      {
        cwd: root,
        encoding: "utf8",
      },
    ).trim();
    if (tagType !== "tag")
      failures.push(
        `release tag must be annotated, got Git object type ${tagType}`,
      );
    remoteTagged = execFileSync(
      "git",
      ["ls-remote", "--tags", "origin", `refs/tags/${tag}^{}`],
      { cwd: root, encoding: "utf8" },
    )
      .trim()
      .split(/\s+/)[0];
    if (!remoteTagged)
      failures.push(`required release tag is not published on origin: ${tag}`);
  } catch {
    failures.push(`required immutable release tag is missing: ${tag}`);
  }
  if (head && tagged && head !== tagged)
    failures.push(`${tag} points to ${tagged}, not checked-out ${head}`);
  if (tagged && remoteTagged && tagged !== remoteTagged)
    failures.push(
      `${tag} resolves to ${tagged} locally but ${remoteTagged} on origin`,
    );
}

const sourceArg = process.argv.find((arg) => arg.startsWith("--source-sha="));
if (sourceArg) {
  const required = sourceArg.slice("--source-sha=".length);
  if (!/^[0-9a-f]{40}$/.test(required))
    failures.push(
      "--source-sha must be a full lowercase 40-character commit SHA",
    );
  else {
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    expect("checked-out source SHA", head, required);
  }
}

const newerArg = process.argv.find((arg) =>
  arg.startsWith("--require-newer-than="),
);
if (newerArg) {
  const previousSha = newerArg.slice("--require-newer-than=".length);
  if (!/^[0-9a-f]{40}$/.test(previousSha)) {
    failures.push(
      "--require-newer-than must be a full lowercase 40-character commit SHA",
    );
  } else {
    try {
      const head = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim();
      execFileSync("git", ["merge-base", "--is-ancestor", previousSha, head], {
        cwd: root,
        stdio: "ignore",
      });
      const previous = JSON.parse(
        execFileSync(
          "git",
          ["show", `${previousSha}:wallet/zuuli/release.json`],
          { cwd: root, encoding: "utf8" },
        ),
      );
      if (
        ![1, 2].includes(previous.schemaVersion) ||
        previous.applicationId !== release.applicationId
      ) {
        failures.push(
          "previous release identity has an incompatible schema or application ID",
        );
      }
      if (!Number.isSafeInteger(previous.build) || previous.build < 1) {
        failures.push("previous release build is not a positive safe integer");
      } else if (release.build <= previous.build) {
        failures.push(
          `release build must increase: ${release.build} is not greater than ${previous.build}`,
        );
      }
      const semverCore = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
      const previousVersion = semverCore.exec(previous.version ?? "");
      const currentVersion = semverCore.exec(release.version ?? "");
      if (!previousVersion) {
        failures.push("previous release version is not strict SemVer core");
      } else if (currentVersion) {
        const previousParts = previousVersion.slice(1).map(Number);
        const currentParts = currentVersion.slice(1).map(Number);
        const versionOrder = currentParts.findIndex(
          (part, index) => part !== previousParts[index],
        );
        if (
          versionOrder !== -1 &&
          currentParts[versionOrder] < previousParts[versionOrder]
        ) {
          failures.push(
            `release version must not decrease: ${release.version} is older than ${previous.version}`,
          );
        }
      }
    } catch {
      failures.push(
        "previous release source is missing, malformed, or not an ancestor of HEAD",
      );
    }
  }
}

if (failures.length) {
  console.error(
    "ZUULI release identity is inconsistent:\n- " + failures.join("\n- "),
  );
  process.exit(1);
}

console.log(
  JSON.stringify({
    applicationId: release.applicationId,
    channel: buildMetadata.channel,
    version: release.version,
    build: release.build,
    identity,
    tag,
  }),
);
