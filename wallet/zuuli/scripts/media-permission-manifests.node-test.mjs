import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const CAMERA_COPY =
  "ZUULI uses the camera when you broadcast or join a live video stream.";
const MICROPHONE_COPY =
  "ZUULI uses the microphone when you broadcast or join a live stream.";

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

const EXPECTED_ANDROID_PERMISSIONS = [
  "android.permission.INTERNET",
  "android.permission.CAMERA",
  "android.permission.RECORD_AUDIO",
  "android.permission.MODIFY_AUDIO_SETTINGS",
];

test("Android capture permissions are an exact, non-duplicated set", () => {
  const manifest = read("../src-tauri/gen/android/app/src/main/AndroidManifest.xml");
  assert.deepEqual(androidPermissionNames(manifest), EXPECTED_ANDROID_PERMISSIONS);
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

test("Apple source, generated plist, and project generator keep exact capture copy", () => {
  const macos = read("../src-tauri/Info.macos.plist");
  const source = read("../src-tauri/Info.ios.plist");
  const generated = read("../src-tauri/gen/apple/zuuli_iOS/Info.plist");
  const project = read("../src-tauri/gen/apple/project.yml");

  for (const [name, contents] of [
    ["Info.macos.plist", macos],
    ["Info.ios.plist", source],
    ["generated Info.plist", generated],
  ]) {
    assert.equal(occurrences(contents, "<key>NSCameraUsageDescription</key>"), 1, name);
    assert.equal(occurrences(contents, "<key>NSMicrophoneUsageDescription</key>"), 1, name);
    assert.equal(occurrences(contents, `<string>${CAMERA_COPY}</string>`), 1, name);
    assert.equal(occurrences(contents, `<string>${MICROPHONE_COPY}</string>`), 1, name);
  }

  assert.equal(occurrences(project, `NSCameraUsageDescription: ${CAMERA_COPY}`), 1);
  assert.equal(occurrences(project, `NSMicrophoneUsageDescription: ${MICROPHONE_COPY}`), 1);
});
