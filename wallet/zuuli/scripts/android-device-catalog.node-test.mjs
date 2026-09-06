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

test("touch hardware does not filter devices in Google Play", () => {
  const optionalFeatures = ["android.hardware.touchscreen", "android.hardware.faketouch"];

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

/// #945. Play derives its implied hardware filters from the *permissions* a
/// manifest declares, so the camera and microphone `uses-feature` overrides
/// existed only to undo the filtering that CAMERA and RECORD_AUDIO implied.
/// Those permissions went with the livestreaming surface (#943), so the
/// overrides are dead too, and re-adding either half is the mistake this
/// asserts against.
test("no capture permission or capture hardware declaration remains", () => {
  for (const name of [
    "android.hardware.camera",
    "android.hardware.camera.autofocus",
    "android.hardware.camera.any",
    "android.hardware.microphone",
  ]) {
    assert.deepEqual(featureDeclarations(name), [], `${name} must not be declared`);
  }

  for (const permission of ["CAMERA", "RECORD_AUDIO", "MODIFY_AUDIO_SETTINGS"]) {
    assert.equal(
      manifest.match(
        new RegExp(
          `<uses-permission\\s+android:name=["']android\\.permission\\.${permission}["']`,
          "g",
        ),
      ),
      null,
      `android.permission.${permission} must not be declared`,
    );
  }

  // The positive control: `featureDeclarations` and the permission matcher
  // both return nothing for a manifest that failed to load, so prove they see
  // what is still there.
  assert.equal(featureDeclarations("android.hardware.touchscreen").length, 1);
  assert.equal(
    manifest.match(
      /<uses-permission\s+android:name=["']android\.permission\.INTERNET["']/g,
    )?.length,
    1,
  );
});
