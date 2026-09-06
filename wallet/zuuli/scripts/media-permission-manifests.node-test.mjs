import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/// #945 - the property is inverted, not deleted.
///
/// This file used to pin CAMERA/RECORD_AUDIO/MODIFY_AUDIO_SETTINGS and the
/// exact livestreaming usage copy, so that losing them was a red build. That
/// was right while ZUULI could stream. #904 phase 4 (#943) deleted
/// `features/live` and the RealtimeKit dependency and narrowed the CSP so the
/// WebView cannot reach a streaming origin, which left the process that holds
/// the master seed asking the OS for capture hardware it cannot use - free
/// surface under #367, and a store-review question with no answer.
///
/// So the same shape is asserted against the reduced set: an exact,
/// non-duplicated Android permission set, and Apple manifests that declare no
/// capture usage description anywhere. The parser self-tests below are kept
/// verbatim, because a permission audit that cannot see a permission would
/// pass this file no matter what shipped.
const FORBIDDEN_ANDROID_PERMISSIONS = [
  "android.permission.CAMERA",
  "android.permission.RECORD_AUDIO",
  "android.permission.MODIFY_AUDIO_SETTINGS",
];

const CAPTURE_USAGE_KEYS = [
  "NSCameraUsageDescription",
  "NSMicrophoneUsageDescription",
];

function read(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

function occurrences(source, literal) {
  return source.split(literal).length - 1;
}

function xmlTags(source) {
  const withoutComments = source.replace(/<!--[\s\S]*?-->/g, "");
  const tags = [];
  for (let start = withoutComments.indexOf("<"); start >= 0;) {
    let quote = null;
    let end = start + 1;
    for (; end < withoutComments.length; end += 1) {
      const character = withoutComments[end];
      if (quote !== null) {
        if (character === quote) quote = null;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === ">") {
        break;
      }
    }
    assert.ok(end < withoutComments.length, "Android manifest contains an unterminated XML tag");
    tags.push(withoutComments.slice(start + 1, end).trim());
    start = withoutComments.indexOf("<", end + 1);
  }
  return tags;
}

function androidPermissionNames(manifest) {
  const permissions = [];
  for (const tag of xmlTags(manifest)) {
    if (tag.startsWith("/") || tag.startsWith("!") || tag.startsWith("?")) continue;
    const name = tag.match(/^([^\s/>]+)/)?.[1] ?? "";
    if (!name.startsWith("uses-permission")) continue;
    assert.ok(
      name === "uses-permission" || name === "uses-permission-sdk-23",
      `unrecognized Android permission element <${name}>`,
    );
    const attributes = [...tag.matchAll(
      /(?:^|\s)android:name\s*=\s*(?:"([^"]*)"|'([^']*)')/g,
    )];
    assert.equal(
      attributes.length,
      1,
      `<${name}> must carry exactly one quoted android:name attribute`,
    );
    permissions.push(attributes[0][1] ?? attributes[0][2]);
  }
  return permissions;
}

const EXPECTED_ANDROID_PERMISSIONS = ["android.permission.INTERNET"];

test("Android permissions are an exact, non-duplicated set with no capture grant", () => {
  const manifest = read("../src-tauri/gen/android/app/src/main/AndroidManifest.xml");
  assert.deepEqual(androidPermissionNames(manifest), EXPECTED_ANDROID_PERMISSIONS);

  // Stated by name as well, so the failure says which dead grant came back
  // rather than only that two arrays differ. `includes` on the raw source also
  // catches a grant hiding somewhere the element parser would not reach.
  for (const permission of FORBIDDEN_ANDROID_PERMISSIONS) {
    assert.ok(
      !manifest.includes(permission),
      `${permission} is for a surface ZUULI no longer has (#945)`,
    );
  }
});

test("Android permission audit sees attributes and non-self-closing elements", () => {
  const manifest = read("../src-tauri/gen/android/app/src/main/AndroidManifest.xml");
  const expanded = manifest.replace(
    "</manifest>",
    `  <uses-permission android:maxSdkVersion="34" android:name="android.permission.ACCESS_FINE_LOCATION"></uses-permission>\n</manifest>`,
  );
  assert.deepEqual(androidPermissionNames(expanded), [
    ...EXPECTED_ANDROID_PERMISSIONS,
    "android.permission.ACCESS_FINE_LOCATION",
  ]);
  assert.notDeepEqual(androidPermissionNames(expanded), EXPECTED_ANDROID_PERMISSIONS);
});

test("Android permission audit sees sdk-23 authority and rejects unknown forms", () => {
  const manifest = read("../src-tauri/gen/android/app/src/main/AndroidManifest.xml");
  const sdk23 = manifest.replace(
    "</manifest>",
    `  <uses-permission-sdk-23 android:name='android.permission.BLUETOOTH_CONNECT' />\n</manifest>`,
  );
  assert.deepEqual(androidPermissionNames(sdk23), [
    ...EXPECTED_ANDROID_PERMISSIONS,
    "android.permission.BLUETOOTH_CONNECT",
  ]);
  assert.notDeepEqual(androidPermissionNames(sdk23), EXPECTED_ANDROID_PERMISSIONS);

  const unknown = manifest.replace(
    "</manifest>",
    `  <uses-permission-sdk-99 android:name="android.permission.CAMERA" />\n</manifest>`,
  );
  assert.throws(
    () => androidPermissionNames(unknown),
    /unrecognized Android permission element/,
  );
});

test("Apple source, generated plist, and project generator declare no capture usage", () => {
  const macos = read("../src-tauri/Info.macos.plist");
  const source = read("../src-tauri/Info.ios.plist");
  const generated = read("../src-tauri/gen/apple/zuuli_iOS/Info.plist");
  const project = read("../src-tauri/gen/apple/project.yml");

  const surfaces = [
    ["Info.macos.plist", macos],
    ["Info.ios.plist", source],
    ["generated Info.plist", generated],
    // `Info.ios.plist` is the regeneration source of truth and `project.yml`
    // is what XcodeGen writes the generated plist from, so all three Apple
    // inputs are covered; dropping only one of them regenerates the key back.
    ["generated project.yml", project],
  ];

  for (const [name, contents] of surfaces) {
    for (const key of CAPTURE_USAGE_KEYS) {
      assert.equal(
        occurrences(contents, key),
        0,
        `${name} must declare no ${key} (#945)`,
      );
    }
  }

  // The positive control. Every assertion above passes against an empty or
  // mis-pathed file, so prove each surface is the one that carries Apple
  // usage/identity declarations at all.
  assert.equal(occurrences(source, "<key>NSFaceIDUsageDescription</key>"), 1);
  assert.equal(occurrences(generated, "<key>NSFaceIDUsageDescription</key>"), 1);
  assert.equal(occurrences(project, "NSFaceIDUsageDescription: "), 1);
  assert.equal(occurrences(macos, '<plist version="1.0">'), 1);
});
