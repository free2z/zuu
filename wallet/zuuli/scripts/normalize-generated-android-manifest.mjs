#!/usr/bin/env node

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
