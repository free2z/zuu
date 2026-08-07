#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const json = (path) => JSON.parse(read(path));
const release = json("release.json");
const failures = [];

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

expect("release schema version", release.schemaVersion, 1);
expect("release application ID", release.applicationId, "cash.free2z.zuuli");
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
const rustToolchain = read("../rust-toolchain.toml");
const gradle = read("src-tauri/gen/android/app/build.gradle.kts");
const gradleWrapper = read(
  "src-tauri/gen/android/gradle/wrapper/gradle-wrapper.properties",
);
const gradleProperties = read("src-tauri/gen/android/gradle.properties");
const androidToolchain = read("scripts/android-toolchain-env.sh");
const gemLock = read("Gemfile.lock");

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
  "1.88.0",
);
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
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  if (!/^[0-9a-f]{40}$/.test(required))
    failures.push(
      "--source-sha must be a full lowercase 40-character commit SHA",
    );
  expect("checked-out source SHA", head, required);
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
