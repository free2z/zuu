#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const json = (path) => JSON.parse(read(path));
const failures = [];
const releaseBytes = readFileSync(resolve(root, "release.json"));

try {
  execFileSync(process.execPath, ["scripts/verify-mobile-oauth-links.mjs"], {
    cwd: root,
    stdio: "pipe",
  });
} catch (error) {
  failures.push(
    `mobile OAuth link contract failed: ${error.stderr?.toString().trim() || error.message}`,
  );
}

function releaseEncryptionKeyCount(contents) {
  return (contents.match(/"iosUsesNonExemptEncryption"\s*:/g) ?? []).length;
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
  const canonicalBytes = Buffer.from(
    `${JSON.stringify(parsed, null, 2)}\n`,
    "utf8",
  );
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
    throw new Error(
      `release duplicate-key detector self-test failed: ${label}`,
    );
}

const invalidUtf8Fixture = Buffer.concat([
  Buffer.from(
    '{\n  "iosUsesNonExemptEncryption": false,\n  "$schema": "',
    "utf8",
  ),
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
const normalizeIosProject = read("scripts/normalize-generated-ios-project.mjs");
const verifyIosIpa = read("scripts/verify-ios-ipa.sh");
const releaseWorkflow = read("../../.github/workflows/zuuli-release.yml");
const packagingWorkflow = read("../../.github/workflows/zuuli-packaging.yml");

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
  (project.match(/^[ \t]*-[ \t]+path:[ \t]+Externals[ \t]*$/gm) ?? []).length,
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
for (const wiring of [
  "IOS_MOBILE_PROVISION: ${{ secrets.APPLE_PROVISIONING_PROFILE_BASE64 }}",
  "ZUULI_PREFLIGHT_KEYCHAIN=$keychain",
  'security list-keychains -d user -s "${keychains[@]}"',
  'security delete-keychain "$ZUULI_PREFLIGHT_KEYCHAIN"',
  "-t cert -f pkcs12",
  "-T /usr/bin/codesign -T /usr/bin/xcodebuild",
  "OAUTH_DEVICE_EVIDENCE_BASE64: ${{ inputs.target == 'public-gate' && secrets.ZUULI_OAUTH_DEVICE_EVIDENCE_BASE64 || '' }}",
  'npm run oauth-links:verify-public -- --source-sha="$source_sha"',
  "options: [mobile, ios, android, desktop, all, public-gate]",
  'if [[ "$target" == public-gate ]]; then',
  "needs.prepare.outputs.public_gate == 'true'",
  "needs.prepare.outputs.public_gate != 'true'",
]) {
  if (!releaseWorkflow.includes(wiring))
    failures.push(
      `protected iOS signing-keychain wiring is missing: ${wiring}`,
    );
}
const trustedSourceCheck = releaseWorkflow.indexOf(
  "Validate source provenance before loading protected inputs",
);
const dependencyInstall = releaseWorkflow.indexOf("      - run: npm ci");
const protectedEvidenceExposure = releaseWorkflow.indexOf(
  "OAUTH_DEVICE_EVIDENCE_BASE64: ${{ inputs.target == 'public-gate' && secrets.ZUULI_OAUTH_DEVICE_EVIDENCE_BASE64 || '' }}",
);
if (
  trustedSourceCheck === -1 ||
  dependencyInstall === -1 ||
  protectedEvidenceExposure === -1 ||
  trustedSourceCheck > dependencyInstall ||
  trustedSourceCheck > protectedEvidenceExposure
) {
  failures.push(
    "protected evidence and checked-out dependency code must follow the workflow-owned source provenance check",
  );
}
if (!packagingWorkflow.includes("run: npm run test:oauth-links")) {
  failures.push("packaging CI does not exercise the claimed-link release gate");
}
for (const [label, text, expression, expectedCount] of [
  [
    "protected profile associated-domain capability guard",
    releaseWorkflow,
    '["com.apple.developer.associated-domains"] == ["*"]',
    1,
  ],
  [
    "embedded profile associated-domain capability guard",
    verifyIosIpa,
    '["com.apple.developer.associated-domains"] == ["*"]',
    1,
  ],
  [
    "signed IPA exact associated-domain guard",
    verifyIosIpa,
    '["com.apple.developer.associated-domains"] == ["applinks:free2z.com"]',
    1,
  ],
]) {
  expect(label, occurrenceCount(text, expression), expectedCount);
}
expect(
  "historical profile UUID release pin count",
  occurrenceCount(
    `${releaseWorkflow}\n${normalizeIosProject}\n${verifyIosIpa}`,
    "e5ead62c-83ec-4e54-abb6-4770833b5e0d",
  ),
  0,
);
expect(
  "protected build certificate secret exposure count",
  occurrenceCount(
    releaseWorkflow,
    "IOS_CERTIFICATE: ${{ secrets.APPLE_DISTRIBUTION_CERTIFICATE_BASE64 }}",
  ),
  0,
);
expect(
  "protected build certificate password secret exposure count",
  occurrenceCount(
    releaseWorkflow,
    "IOS_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_DISTRIBUTION_CERTIFICATE_PASSWORD }}",
  ),
  0,
);
expect(
  "protected certificate materialization count",
  occurrenceCount(
    releaseWorkflow,
    "CERTIFICATE_BASE64: ${{ secrets.APPLE_DISTRIBUTION_CERTIFICATE_BASE64 }}",
  ),
  1,
);
expect(
  "protected certificate password materialization count",
  occurrenceCount(
    releaseWorkflow,
    "CERTIFICATE_PASSWORD: ${{ secrets.APPLE_DISTRIBUTION_CERTIFICATE_PASSWORD }}",
  ),
  1,
);
expect(
  "protected provisioning-profile build exposure count",
  occurrenceCount(
    releaseWorkflow,
    "IOS_MOBILE_PROVISION: ${{ secrets.APPLE_PROVISIONING_PROFILE_BASE64 }}",
  ),
  1,
);
const explicitCertificateImport = releaseWorkflow.indexOf(
  'security import "$files/distribution.p12" -P "$CERTIFICATE_PASSWORD"',
);
const decodedCertificateRemoval = releaseWorkflow.indexOf(
  'rm -f -- "$files/distribution.p12" "$files/profile-certificate.der"',
);
const protectedIosBuild = releaseWorkflow.indexOf(
  "      - name: Build, validate, and optionally upload",
);
const protectedIosCleanup = releaseWorkflow.indexOf(
  "      - name: Destroy ephemeral Apple credentials",
);
if (
  explicitCertificateImport === -1 ||
  decodedCertificateRemoval === -1 ||
  protectedIosBuild === -1 ||
  protectedIosCleanup === -1 ||
  explicitCertificateImport > decodedCertificateRemoval ||
  decodedCertificateRemoval > protectedIosBuild ||
  protectedIosBuild > protectedIosCleanup
) {
  failures.push(
    "protected iOS release must explicitly import, remove the decoded P12, build from the keychain, then clean up",
  );
}
for (const guard of [
  "refusing duplicate iOS certificate import",
  "refusing Tauri skip-signing path",
  "verified ephemeral keychain is missing from the user search list",
  "user keychain search list does not resolve the unique Corpora distribution identity",
]) {
  if (!mobileRelease.includes(guard))
    failures.push(`iOS release keychain guard is missing: ${guard}`);
}
for (const forbiddenTauriCredential of [
  'APPLE_API_ISSUER="$ASC_ISSUER_ID"',
  'APPLE_API_KEY="$ASC_KEY_ID"',
  'APPLE_API_KEY_PATH="$key_dir/private_keys/AuthKey_${ASC_KEY_ID}.p8"',
]) {
  if (mobileRelease.includes(forbiddenTauriCredential))
    failures.push(
      `Tauri must not receive App Store credentials that enable its skip-signing path: ${forbiddenTauriCredential}`,
    );
}
const ipaVerification = mobileRelease.indexOf(
  "\n  scripts/verify-ios-ipa.sh \\\n",
);
const appleValidation = mobileRelease.indexOf(
  "\n    xcrun altool --validate-app",
);
const appleUpload = mobileRelease.indexOf("\n      xcrun altool --upload-app");
const signingPreparation = mobileRelease.indexOf(
  "node scripts/normalize-generated-ios-project.mjs --prepare-manual-signing",
);
const tauriIosBuild = mobileRelease.indexOf(
  "./node_modules/.bin/tauri ios build",
);
const signingNormalization = mobileRelease.indexOf(
  "\n  node scripts/normalize-generated-ios-project.mjs\n",
  tauriIosBuild,
);
if (
  signingPreparation === -1 ||
  tauriIosBuild === -1 ||
  signingNormalization === -1 ||
  ipaVerification === -1 ||
  appleValidation === -1 ||
  appleUpload === -1 ||
  signingPreparation > tauriIosBuild ||
  tauriIosBuild > signingNormalization ||
  signingNormalization > ipaVerification ||
  ipaVerification > appleValidation ||
  ipaVerification > appleUpload
) {
  failures.push(
    "iOS release must prepare signing keys, build, normalize, inspect the IPA, then validate and upload with Apple",
  );
}
const unsignedIosBuild = packagingWorkflow.indexOf(
  "./node_modules/.bin/tauri ios build --ci --no-sign",
);
const unsignedIosInspection = packagingWorkflow.indexOf(
  'scripts/verify-ios-ipa.sh --verify-app-structure "${apps[0]}"',
);
const unsignedIosCollection = packagingWorkflow.indexOf(
  "- name: Collect unsigned package",
);
if (
  unsignedIosBuild === -1 ||
  unsignedIosInspection === -1 ||
  unsignedIosCollection === -1 ||
  unsignedIosBuild > unsignedIosInspection ||
  unsignedIosInspection > unsignedIosCollection
) {
  failures.push(
    "unsigned iOS packaging must build, inspect the app structure, then collect the artifact",
  );
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
    version: release.version,
    build: release.build,
    identity,
    tag,
  }),
);
