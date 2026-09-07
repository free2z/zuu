#!/usr/bin/env node
//
// Tauri's deep-link plugin rewrites the generated AndroidManifest on every
// build and leaves whitespace-only lines behind where it interpolated optional
// filters. The release path runs `git diff --exit-code` right after the build to
// prove the committed project is exactly what was built, so those lines have to
// be normalized away or the check fails on nothing.
//
// It normalizes trailing whitespace and nothing else. Refusing to run without
// the plugin's own marker is what stops this from becoming a formatter that
// would happily "normalize" a manifest the build never touched.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(
  appDir,
  "src-tauri/gen/android/app/src/main/AndroidManifest.xml",
);
const manifest = readFileSync(manifestPath, "utf8");

if (!manifest.includes("DEEP LINK PLUGIN. AUTO-GENERATED. DO NOT REMOVE.")) {
  throw new Error(
    "refusing to normalize an Android manifest without Tauri's deep-link marker",
  );
}

const normalized = manifest.replace(/^[\t ]+$/gm, "");
if (normalized !== manifest) writeFileSync(manifestPath, normalized);
