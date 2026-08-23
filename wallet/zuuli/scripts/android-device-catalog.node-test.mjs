import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const manifest = readFileSync(
  new URL(
    "../src-tauri/gen/android/app/src/main/AndroidManifest.xml",
    import.meta.url,
  ),
  "utf8",
);

function featureDeclarations(name) {
  const escaped = name.replaceAll(".", "\\.");
  return manifest.match(
    new RegExp(
      `<uses-feature\\s+android:name=["']${escaped}["'][^>]*\\/>`,
      "g",
    ),
  ) ?? [];
}

test("capture and touch hardware do not filter devices in Google Play", () => {
  const optionalFeatures = [
    "android.hardware.camera",
    "android.hardware.camera.autofocus",
    "android.hardware.camera.any",
    "android.hardware.microphone",
    "android.hardware.touchscreen",
    "android.hardware.faketouch",
  ];

  for (const name of optionalFeatures) {
    const declarations = featureDeclarations(name);
    assert.equal(declarations.length, 1, `${name} must be declared exactly once`);
    assert.match(
      declarations[0],
      /android:required=["']false["']/,
      `${name} must remain optional`,
    );
  }
});

test("camera permission remains available for hosts without implying hardware", () => {
  assert.equal(
    manifest.match(
      /<uses-permission\s+android:name=["']android\.permission\.CAMERA["']\s*\/>/g,
    )?.length,
    1,
  );
});
