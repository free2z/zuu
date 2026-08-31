#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const REQUIRED_APPLICATION_IDENTIFIER = "F9AV5HKF6N.cash.free2z.zuuli";
export const REQUIRED_TEAM_IDENTIFIER = "F9AV5HKF6N";
export const REQUIRED_ENTITLEMENTS_PATH = "./Entitlements.plist";
export const REQUIRED_INFO_PLIST_PATH = "Info.macos.plist";
export const CAMERA_COPY =
  "ZUULI uses the camera when you broadcast or join a live video stream.";
export const MICROPHONE_COPY =
  "ZUULI uses the microphone when you broadcast or join a live stream.";

export const CANONICAL_ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>com.apple.application-identifier</key>
\t<string>${REQUIRED_APPLICATION_IDENTIFIER}</string>
\t<key>com.apple.developer.team-identifier</key>
\t<string>${REQUIRED_TEAM_IDENTIFIER}</string>
\t<key>com.apple.security.device.audio-input</key>
\t<true/>
\t<key>com.apple.security.device.camera</key>
\t<true/>
\t<key>keychain-access-groups</key>
\t<array>
\t\t<string>${REQUIRED_APPLICATION_IDENTIFIER}</string>
\t</array>
</dict>
</plist>
`;

export const CANONICAL_INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>NSCameraUsageDescription</key>
\t<string>${CAMERA_COPY}</string>
\t<key>NSMicrophoneUsageDescription</key>
\t<string>${MICROPHONE_COPY}</string>
</dict>
</plist>
`;

export function verifyMacosKeychainEntitlements(
  tauriSource,
  entitlementsSource,
  infoPlistSource,
) {
  const failures = [];
  let tauri;
  try {
    tauri = JSON.parse(tauriSource);
  } catch (error) {
    return [`tauri.conf.json is invalid JSON: ${error instanceof Error ? error.message : String(error)}`];
  }

  if (tauri.identifier !== "cash.free2z.zuuli") {
    failures.push("tauri.conf.json must keep the reviewed macOS bundle identifier");
  }
  if (tauri.bundle?.macOS?.entitlements !== REQUIRED_ENTITLEMENTS_PATH) {
    failures.push(
      `tauri.conf.json bundle.macOS.entitlements must be ${JSON.stringify(REQUIRED_ENTITLEMENTS_PATH)}`,
    );
  }
  if (tauri.bundle?.macOS?.infoPlist !== REQUIRED_INFO_PLIST_PATH) {
    failures.push(
      `tauri.conf.json bundle.macOS.infoPlist must be ${JSON.stringify(REQUIRED_INFO_PLIST_PATH)}`,
    );
  }
  if (entitlementsSource !== CANONICAL_ENTITLEMENTS) {
    failures.push(
      "macOS entitlements must be the reviewed identifiers, exact Keychain access group, and camera/audio-input authority",
    );
  }
  if (infoPlistSource !== CANONICAL_INFO_PLIST) {
    failures.push(
      "macOS Info.plist must contain only the exact reviewed camera and microphone usage descriptions",
    );
  }
  return failures;
}

async function main() {
  const tauriUrl = new URL("../src-tauri/tauri.conf.json", import.meta.url);
  const entitlementsUrl = new URL("../src-tauri/Entitlements.plist", import.meta.url);
  const infoPlistUrl = new URL("../src-tauri/Info.macos.plist", import.meta.url);
  const failures = verifyMacosKeychainEntitlements(
    await readFile(tauriUrl, "utf8"),
    await readFile(entitlementsUrl, "utf8"),
    await readFile(infoPlistUrl, "utf8"),
  );
  if (failures.length > 0) {
    console.error("macOS Keychain entitlement policy failed:");
    failures.forEach((failure) => console.error(`- ${failure}`));
    process.exit(1);
  }
  console.log("macOS Keychain and media-capture authority are source-bound and complete.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
