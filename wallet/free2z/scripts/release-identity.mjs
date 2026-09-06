#!/usr/bin/env node
//
// One release identity, asserted against every file that restates it.
//
// `release.json` is the source of truth for what `cash.free2z.free2z` calls
// itself: a SemVer core version and a monotonically increasing build number.
// Seven other files restate one or both — package.json, package-lock.json,
// Cargo.toml, Cargo.lock, tauri.conf.json, and the two generated mobile
// projects — and a store upload that ships a bundle whose internal version
// disagrees with the tag is not recoverable: Play and App Store Connect both
// treat a version code as spent forever. So the restatements are checked, not
// trusted, before anything is built.
//
// This is a sibling of `wallet/e2e2z/scripts/release-identity.mjs`, which is
// itself the smaller sibling of ZUULI's. What is carried over verbatim is the
// part that is load-bearing rather than decorative:
//
//   * `release.json` must be *canonical bytes*, not merely parseable JSON. A
//     duplicate `iosUsesNonExemptEncryption` key parses fine and silently keeps
//     the last value, which is how a `true` gets shipped under a reviewed
//     `false`; comparing the raw bytes against a re-serialization rejects
//     duplicates, escaped key names and non-UTF-8 in one move. The self-test
//     below proves the detector actually detects, against four fixtures.
//
// What is NOT carried over is e2e2z's permission rule, and this is the one
// place the two apps genuinely differ. e2e2z declares exactly INTERNET and
// forbids capture outright. free2z hosts Cloudflare RealtimeKit rooms, so it
// declares four permissions and must keep declaring exactly those four — see
// the "capture boundary" section below, and the reasoning in the generated
// AndroidManifest and Info.ios.plist. The rule here is an equality on a set,
// not a ban list with a hole in it: a fifth permission fails, and so does
// dropping one of the four, because either way the reviewed shape moved.
//
// Usage:
//   node scripts/release-identity.mjs
//   node scripts/release-identity.mjs --require-main
//   node scripts/release-identity.mjs --source-sha=<40 hex>
//   node scripts/release-identity.mjs --require-newer-than=<40 hex>

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";

import { validate as validateStoreIdentity } from "./store-identity.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const json = (path) => JSON.parse(read(path));
const failures = [];

// ---------------------------------------------------------------------------
// Canonical release.json bytes.
// ---------------------------------------------------------------------------

function releaseEncryptionKeyCount(contents) {
  return (contents.match(/"iosUsesNonExemptEncryption"\s*:/g) ?? []).length;
}

function parseCanonicalRelease(bytes, label, target) {
  let contents;
  try {
    contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    target.push(`${label} must contain valid UTF-8`);
    return undefined;
  }
  const encryptionKeys = releaseEncryptionKeyCount(contents);
  if (encryptionKeys !== 1)
    target.push(
      `${label} must contain exactly one raw iosUsesNonExemptEncryption key, found ${encryptionKeys}`,
    );
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
  const canonical = Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  if (!bytes.equals(canonical))
    target.push(
      `${label} bytes must be canonical UTF-8 JSON without duplicate or escaped property names`,
    );
  return parsed;
}

// Negative controls for the detector above, run on every invocation: a checker
// that has quietly stopped detecting is worse than no checker, and these cost
// microseconds. Two of the four fixtures are escaped duplicates, which JSON.parse
// accepts and the raw-key count cannot see — only the canonical-bytes comparison
// catches those, and the counts below assert exactly that split.
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
  const parsed = parseCanonicalRelease(Buffer.from(fixture, "utf8"), label, fixtureFailures);
  const canonicalFailures = fixtureFailures.filter((failure) =>
    failure.includes("bytes must be canonical UTF-8 JSON"),
  );
  const rawFailures = fixtureFailures.filter((failure) =>
    failure.includes("must contain exactly one raw"),
  );
  if (
    canonicalFailures.length !== 1 ||
    rawFailures.length !== expectedRawFailures ||
    parsed.iosUsesNonExemptEncryption !== false
  )
    throw new Error(`release duplicate-key detector self-test failed: ${label}`);
}

const invalidUtf8 = Buffer.concat([
  Buffer.from('{\n  "iosUsesNonExemptEncryption": false,\n  "$schema": "', "utf8"),
  Buffer.from([0xff]),
  Buffer.from('"\n}\n', "utf8"),
]);
const invalidUtf8Failures = [];
if (
  parseCanonicalRelease(invalidUtf8, "invalid UTF-8 fixture", invalidUtf8Failures) !== undefined ||
  invalidUtf8Failures.length !== 1 ||
  invalidUtf8Failures[0] !== "invalid UTF-8 fixture must contain valid UTF-8"
)
  throw new Error("release invalid-UTF-8 detector self-test failed");

const release = parseCanonicalRelease(
  readFileSync(resolve(root, "release.json")),
  "release.json",
  failures,
);
if (release === undefined) {
  console.error("free2z release identity is inconsistent:\n- " + failures.join("\n- "));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Restatements.
// ---------------------------------------------------------------------------

function expect(label, actual, expected) {
  if (`${actual}` !== `${expected}`)
    failures.push(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
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
expect("release application ID", release.applicationId, "cash.free2z.free2z");
if (release.iosUsesNonExemptEncryption !== false)
  failures.push("release iOS non-exempt encryption declaration must be Boolean false");
expect("release minimum iOS", release.minimums?.ios, "18.0");
expect("release minimum Android", release.minimums?.android, 29);

if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(release.version))
  failures.push(`release.json version is not strict SemVer core: ${release.version}`);
if (
  !Number.isSafeInteger(release.build) ||
  release.build < 1 ||
  release.build > 2_100_000_000
)
  failures.push(
    `release.json build must be an integer from 1 through 2100000000: ${release.build}`,
  );

const packageJson = json("package.json");
const packageLock = json("package-lock.json");
const tauri = json("src-tauri/tauri.conf.json");
const cargo = read("src-tauri/Cargo.toml");
const cargoLock = read("src-tauri/Cargo.lock");
const gradle = read("src-tauri/gen/android/app/build.gradle.kts");
const androidManifest = read("src-tauri/gen/android/app/src/main/AndroidManifest.xml");
const androidToolchain = read("scripts/android-toolchain-env.sh");
const appleProject = read("src-tauri/gen/apple/project.yml");
const appleInfoPlist = read("src-tauri/gen/apple/free2z_iOS/Info.plist");
const sourceInfoPlist = read("src-tauri/Info.ios.plist");
const releaseWorkflow = read("../../.github/workflows/free2z-release.yml");
const mobileRelease = read("scripts/mobile-release.sh");
const rustToolchain = read("../rust-toolchain.toml");

expect("package.json version", packageJson.version, release.version);
expect("package-lock.json version", packageLock.version, release.version);
expect("package-lock.json root version", packageLock.packages?.[""]?.version, release.version);
expect(
  "Cargo.toml package version",
  capture(/^version\s*=\s*"([^"]+)"/m, cargo, "Cargo.toml package version"),
  release.version,
);
expect(
  "Cargo.lock free2z package version",
  capture(
    /\[\[package\]\]\nname = "free2z"\nversion = "([^"]+)"/m,
    cargoLock,
    "Cargo.lock free2z package version",
  ),
  release.version,
);

expect("tauri.conf.json version", tauri.version, release.version);
expect("tauri.conf.json identifier", tauri.identifier, release.applicationId);
expect("tauri iOS bundleVersion", tauri.bundle?.iOS?.bundleVersion, release.build);
expect("tauri Apple team", tauri.bundle?.iOS?.developmentTeam, "F9AV5HKF6N");
expect("tauri iOS minimum", tauri.bundle?.iOS?.minimumSystemVersion, release.minimums.ios);
expect("tauri iOS extra Info.plist", tauri.bundle?.iOS?.infoPlist, "Info.ios.plist");
expect("tauri Android versionCode", tauri.bundle?.android?.versionCode, release.build);
expect("tauri Android minimum", tauri.bundle?.android?.minSdkVersion, release.minimums.android);

// ---------------------------------------------------------------------------
// The generated Android project.
// ---------------------------------------------------------------------------

expect(
  "Gradle applicationId",
  capture(/applicationId = "([^"]+)"/, gradle, "Gradle applicationId"),
  release.applicationId,
);
expect(
  "Gradle namespace",
  capture(/namespace = "([^"]+)"/, gradle, "Gradle namespace"),
  release.applicationId,
);
expect(
  "Gradle minSdk",
  capture(/\n\s*minSdk = (\d+)/, gradle, "Gradle minSdk"),
  release.minimums.android,
);
expect(
  "Gradle versionCode fallback",
  capture(/"tauri\.android\.versionCode", "(\d+)"/, gradle, "Gradle versionCode fallback"),
  release.build,
);
expect(
  "Gradle versionName fallback",
  capture(/"tauri\.android\.versionName", "([^"]+)"/, gradle, "Gradle versionName fallback"),
  release.version,
);
const ndkVersion = capture(/ndkVersion = "([^"]+)"/, gradle, "Gradle ndkVersion");
if (ndkVersion !== undefined && !androidToolchain.includes(`/ndk/${ndkVersion}"`))
  failures.push(`Android toolchain does not pin the NDK Gradle names (${ndkVersion})`);
for (const target of [
  "aarch64-linux-android",
  "armv7a-linux-androideabi",
  "i686-linux-android",
  "x86_64-linux-android",
]) {
  if (!androidToolchain.includes(`${target}${release.minimums.android}-clang`))
    failures.push(`Android toolchain does not pin ${target} to API ${release.minimums.android}`);
}
// The signing configuration must be driven by the environment and refuse to be
// half-configured. Without the second line a missing ANDROID_KEY_PASSWORD would
// silently produce an unsigned release build rather than stopping.
for (const contract of [
  'System.getenv("ANDROID_KEYSTORE_PATH")',
  "Android release signing is partially configured; set all four ANDROID_KEYSTORE_* variables",
  'signingConfig = signingConfigs.getByName("releaseFromEnvironment")',
]) {
  if (!gradle.includes(contract))
    failures.push(`Gradle release signing contract is missing: ${contract}`);
}

// ---------------------------------------------------------------------------
// The capture boundary.
//
// free2z holds four Android permissions and exactly four. The set is asserted
// as a set, in both directions:
//
//   INTERNET               — every article, profile, search result and live
//                            media stream crosses the network.
//   CAMERA, RECORD_AUDIO   — a live host publishes both the moment the room
//                            opens (src/features/live/Stage.tsx), and the
//                            RealtimeKit meeting UI offers both toggles to
//                            every participant.
//   MODIFY_AUDIO_SETTINGS  — not a product decision. wry's
//                            RustWebChromeClient.onPermissionRequest maps a
//                            WebView AUDIO_CAPTURE request to
//                            [MODIFY_AUDIO_SETTINGS, RECORD_AUDIO] and grants
//                            the page only if EVERY entry comes back granted.
//                            An undeclared permission comes back denied, so
//                            omitting this one denies every microphone grant
//                            after the user has already said yes.
//
// Adding a fifth is a store disclosure free2z has not made. Dropping one is a
// feature that silently stops working on a device. Both are failures here.
// ---------------------------------------------------------------------------

const ANDROID_PERMISSIONS = [
  "android.permission.CAMERA",
  "android.permission.INTERNET",
  "android.permission.MODIFY_AUDIO_SETTINGS",
  "android.permission.RECORD_AUDIO",
];
const declaredPermissions = [
  ...androidManifest.matchAll(/<uses-permission\s+android:name="([^"]+)"/g),
].map(([, name]) => name);
const sortedPermissions = [...declaredPermissions].sort();
if (
  declaredPermissions.length !== ANDROID_PERMISSIONS.length ||
  sortedPermissions.some((name, index) => name !== ANDROID_PERMISSIONS[index])
)
  failures.push(
    `free2z must declare exactly these Android permissions: ${ANDROID_PERMISSIONS.join(", ")}; found ` +
      (declaredPermissions.length ? declaredPermissions.join(", ") : "none"),
  );
// A permission free2z has never disclosed to either store. Matched over the
// whole file rather than over the parsed list, so a block pasted in from
// ZUULI's or a wallet's manifest fails even before it parses as a declaration.
for (const forbidden of [
  "android.permission.ACCESS_COARSE_LOCATION",
  "android.permission.ACCESS_FINE_LOCATION",
  "android.permission.BLUETOOTH_CONNECT",
  "android.permission.FOREGROUND_SERVICE",
  "android.permission.POST_NOTIFICATIONS",
  "android.permission.READ_CONTACTS",
  "android.permission.READ_EXTERNAL_STORAGE",
  "android.permission.READ_MEDIA_IMAGES",
  "android.permission.WRITE_EXTERNAL_STORAGE",
]) {
  if (androidManifest.includes(forbidden))
    failures.push(`Android manifest names a forbidden permission: ${forbidden}`);
}
// Declaring CAMERA makes Android imply a *required* android.hardware.camera and
// android.hardware.camera.autofocus; RECORD_AUDIO implies a required
// android.hardware.microphone. Google Play then hides free2z from every device
// missing one, which for a reading-and-watching app is most of the reason to be
// on Play at all. These overrides are the only thing standing between the
// permission set above and a silently shrunken device catalog, so they are held
// here rather than left to whoever next regenerates the manifest.
for (const feature of [
  "android.hardware.camera",
  "android.hardware.camera.any",
  "android.hardware.camera.autofocus",
  "android.hardware.microphone",
  "android.hardware.touchscreen",
]) {
  if (
    !androidManifest.includes(
      `<uses-feature android:name="${feature}" android:required="false" />`,
    )
  )
    failures.push(
      `Android manifest must declare ${feature} as an optional feature; a required one filters devices out of Google Play`,
    );
}
// The content surface holds a Knox session token and a rendered article cache;
// neither belongs in a cloud backup or a device-to-device transfer.
for (const contract of [
  'android:allowBackup="false"',
  'android:dataExtractionRules="@xml/data_extraction_rules"',
  'android:fullBackupContent="@xml/backup_rules"',
]) {
  if (!androidManifest.includes(contract))
    failures.push(`Android manifest backup contract is missing: ${contract}`);
}
// One intent-filter per registered deep-link route, and no more: the plugin
// regenerates this block on every build from tauri.conf.json, so a mismatch
// means the committed manifest and the configured routes have drifted apart.
const deepLinkRoutes = tauri.plugins?.["deep-link"]?.mobile ?? [];
expect(
  "Android manifest deep-link routes",
  occurrenceCount(androidManifest, `<data android:scheme="${release.applicationId}" />`),
  deepLinkRoutes.length,
);
if (deepLinkRoutes.length === 0)
  failures.push("tauri.conf.json registers no mobile deep-link route to check");

// ---------------------------------------------------------------------------
// The generated Apple project.
// ---------------------------------------------------------------------------

expect(
  "Xcode bundle identifier",
  capture(/PRODUCT_BUNDLE_IDENTIFIER: (\S+)/, appleProject, "Xcode bundle identifier"),
  release.applicationId,
);
expect(
  "Xcode development team",
  capture(/DEVELOPMENT_TEAM: (\S+)/, appleProject, "Xcode development team"),
  "F9AV5HKF6N",
);
expect(
  "Xcode deployment target",
  capture(/deploymentTarget:\n\s+iOS: (\S+)/, appleProject, "Xcode deployment target"),
  release.minimums.ios,
);
expect(
  "Xcode short version",
  capture(/CFBundleShortVersionString: (\S+)/, appleProject, "Xcode short version"),
  release.version,
);
expect(
  "Xcode bundle version",
  capture(/CFBundleVersion: "(\d+)"/, appleProject, "Xcode bundle version"),
  release.build,
);
// xcodegen fails outright on a source path that is absent from a clean
// checkout, and Externals/ is a build output.
if (appleProject.includes("- path: Externals"))
  failures.push("Xcode project must not list the generated Externals directory as a source");
if (!appleProject.includes("- script: npm run -- tauri ios xcode-script"))
  failures.push(
    "Xcode pre-build script must invoke the app's npm tauri binary; the generated `node tauri` resolves to nothing",
  );

expect(
  "iOS Info.plist short version",
  capture(
    /<key>CFBundleShortVersionString<\/key>\s*\n\s*<string>([^<]+)<\/string>/,
    appleInfoPlist,
    "iOS Info.plist short version",
  ),
  release.version,
);
expect(
  "iOS Info.plist bundle version",
  capture(
    /<key>CFBundleVersion<\/key>\s*\n\s*<string>([^<]+)<\/string>/,
    appleInfoPlist,
    "iOS Info.plist bundle version",
  ),
  release.build,
);
// The mirror image of the Android rule. WKWebView will not hand `getUserMedia`
// a capture device without the matching usage string, and iOS kills the process
// outright if it is missing at the moment of capture — so for free2z these two
// are required, not forbidden. They are required in BOTH files: `Info.ios.plist`
// is the reviewed source, and the generated plist is what actually ships.
// XML comments are stripped first: both plists explain, at length, which
// capabilities free2z deliberately does NOT claim, and a scan over raw text
// would either forbid the file from explaining itself or accept a `<key>` that
// only exists inside a comment.
const withoutXmlComments = (contents) => contents.replace(/<!--[\s\S]*?-->/g, "");
for (const [file, raw] of [
  ["src-tauri/Info.ios.plist", sourceInfoPlist],
  ["src-tauri/gen/apple/free2z_iOS/Info.plist", appleInfoPlist],
]) {
  const contents = withoutXmlComments(raw);
  for (const required of ["NSCameraUsageDescription", "NSMicrophoneUsageDescription"]) {
    if (!contents.includes(`<key>${required}</key>`))
      failures.push(
        `${file} must declare ${required}; free2z hosts live rooms and iOS terminates a capture with no usage string`,
      );
  }
  for (const forbidden of [
    "NSContactsUsageDescription",
    "NSFaceIDUsageDescription",
    "NSLocationAlwaysAndWhenInUseUsageDescription",
    "NSLocationWhenInUseUsageDescription",
    "NSPhotoLibraryAddUsageDescription",
    "NSPhotoLibraryUsageDescription",
  ]) {
    if (contents.includes(forbidden))
      failures.push(`${file} names a capability free2z does not have: ${forbidden}`);
  }
}

// ---------------------------------------------------------------------------
// The release path itself.
// ---------------------------------------------------------------------------

const rustChannel = capture(/channel = "([^"]+)"/, rustToolchain, "Rust toolchain channel");
if (rustChannel !== undefined && !releaseWorkflow.includes(`FREE2Z_RUST_VERSION: "${rustChannel}"`))
  failures.push(
    `release workflow must restate the pinned Rust toolchain FREE2Z_RUST_VERSION: "${rustChannel}"`,
  );
// Four source-bound jobs: the two credential-free builds and the two that
// re-derive the identity before touching a store. Losing one silently unbinds
// that job from the exact commit under release.
expect(
  "protected source-build SHA bindings",
  occurrenceCount(
    releaseWorkflow,
    "FREE2Z_RELEASE_SOURCE_SHA: ${{ needs.prepare.outputs.source_sha }}",
  ),
  4,
);
for (const contract of [
  "environment: free2z-app-stores",
  "scripts/store-identity.mjs --require=android",
  "scripts/store-identity.mjs --require=apple",
]) {
  if (!releaseWorkflow.includes(contract))
    failures.push(`release workflow contract is missing: ${contract}`);
}
// A shared environment would put another app's provisioning profile, its Play
// service account and the team's distribution certificate inside a workflow
// whose only business is free2z. See the header of
// .github/workflows/free2z-release.yml. Matched as a real `environment:` key at
// the start of a line, not anywhere in the file: the header comment explains
// this choice and names the environments it is rejecting.
const declaredEnvironments = [
  ...releaseWorkflow.matchAll(/^[ \t]+environment: (\S+)$/gm),
].map(([, name]) => name);
for (const environment of new Set(declaredEnvironments)) {
  if (environment !== "free2z-app-stores")
    failures.push(
      `the free2z release must sign only inside its own protected environment, not ${environment}`,
    );
}
for (const contract of [
  "node scripts/store-identity.mjs --require=android",
  "ANDROID_UPLOAD_CERT_SHA256",
  "keytool -list -v",
]) {
  if (!mobileRelease.includes(contract))
    failures.push(`mobile-release.sh contract is missing: ${contract}`);
}

const storeIdentity = json("store-identity.json");
for (const failure of validateStoreIdentity(storeIdentity))
  failures.push(`store-identity.json: ${failure}`);
expect("store identity application ID", storeIdentity.applicationId, release.applicationId);

const identity = `${release.version}+${release.build}`;
const tag = `free2z-v${identity}`;
if (process.env.FREE2Z_NODE_VERSION)
  expect("Node runtime", process.versions.node, process.env.FREE2Z_NODE_VERSION);

// ---------------------------------------------------------------------------
// Git bindings.
// ---------------------------------------------------------------------------

if (process.argv.includes("--require-main")) {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    execFileSync("git", ["merge-base", "--is-ancestor", head, "refs/remotes/origin/main"], {
      cwd: root,
      stdio: "ignore",
    });
  } catch {
    failures.push("checked-out source is not a commit on origin/main");
  }
}

const sourceArg = process.argv.find((arg) => arg.startsWith("--source-sha="));
if (sourceArg) {
  const required = sourceArg.slice("--source-sha=".length);
  if (!/^[0-9a-f]{40}$/.test(required))
    failures.push("--source-sha must be a full lowercase 40-character commit SHA");
  else {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    expect("checked-out source SHA", head, required);
  }
}

const newerArg = process.argv.find((arg) => arg.startsWith("--require-newer-than="));
if (newerArg) {
  const previousSha = newerArg.slice("--require-newer-than=".length);
  if (!/^[0-9a-f]{40}$/.test(previousSha)) {
    failures.push("--require-newer-than must be a full lowercase 40-character commit SHA");
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
        execFileSync("git", ["show", `${previousSha}:wallet/free2z/release.json`], {
          cwd: root,
          encoding: "utf8",
        }),
      );
      if (previous.schemaVersion !== 2 || previous.applicationId !== release.applicationId)
        failures.push("previous release identity has an incompatible schema or application ID");
      if (!Number.isSafeInteger(previous.build) || previous.build < 1)
        failures.push("previous release build is not a positive safe integer");
      else if (release.build <= previous.build)
        failures.push(
          `release build must increase: ${release.build} is not greater than ${previous.build}`,
        );
      const semverCore = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
      const previousVersion = semverCore.exec(previous.version ?? "");
      const currentVersion = semverCore.exec(release.version ?? "");
      if (!previousVersion) {
        failures.push("previous release version is not strict SemVer core");
      } else if (currentVersion) {
        const previousParts = previousVersion.slice(1).map(Number);
        const currentParts = currentVersion.slice(1).map(Number);
        const order = currentParts.findIndex((part, index) => part !== previousParts[index]);
        if (order !== -1 && currentParts[order] < previousParts[order])
          failures.push(
            `release version must not decrease: ${release.version} is older than ${previous.version}`,
          );
      }
    } catch {
      failures.push(
        "previous release source is missing, malformed, or not an ancestor of HEAD",
      );
    }
  }
}

if (failures.length) {
  console.error("free2z release identity is inconsistent:\n- " + failures.join("\n- "));
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
