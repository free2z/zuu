export const releaseBumpRelativePaths = [
  "release.json",
  "package.json",
  "package-lock.json",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
  "src-tauri/tauri.conf.json",
  "src-tauri/gen/apple/project.yml",
  "src-tauri/gen/apple/zuuli_iOS/Info.plist",
  "src-tauri/gen/android/app/build.gradle.kts",
];

function replaceExactlyOne(contents, pattern, replacement, label) {
  const matches = contents.match(
    new RegExp(
      pattern.source,
      pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
    ),
  );
  if (!matches || matches.length !== 1) {
    throw new Error(
      `${label}: expected exactly one match, got ${matches?.length ?? 0}`,
    );
  }
  return contents.replace(pattern, replacement);
}

export function buildReleaseBumpContents({ read, version, build }) {
  const replacements = new Map();
  const replaceOne = (path, pattern, replacement, label) => {
    const before = replacements.get(path) ?? read(path);
    replacements.set(
      path,
      replaceExactlyOne(before, pattern, replacement, label),
    );
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

  return replacements;
}
