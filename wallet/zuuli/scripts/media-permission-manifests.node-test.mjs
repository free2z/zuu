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

test("Android capture permissions are an exact, non-duplicated set", () => {
  const manifest = read("../src-tauri/gen/android/app/src/main/AndroidManifest.xml");
  const permissions = [...manifest.matchAll(
    /<uses-permission\s+android:name=["']([^"']+)["']\s*\/>/g,
  )].map((match) => match[1]);
  assert.deepEqual(permissions, [
    "android.permission.INTERNET",
    "android.permission.CAMERA",
    "android.permission.RECORD_AUDIO",
    "android.permission.MODIFY_AUDIO_SETTINGS",
  ]);
});

test("Apple source, generated plist, and project generator keep exact capture copy", () => {
  const source = read("../src-tauri/Info.ios.plist");
  const generated = read("../src-tauri/gen/apple/zuuli_iOS/Info.plist");
  const project = read("../src-tauri/gen/apple/project.yml");

  for (const [name, contents] of [
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
