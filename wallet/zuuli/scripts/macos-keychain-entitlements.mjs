#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const REQUIRED_APPLICATION_IDENTIFIER = "F9AV5HKF6N.cash.free2z.zuuli";
export const REQUIRED_TEAM_IDENTIFIER = "F9AV5HKF6N";
export const REQUIRED_ENTITLEMENTS_PATH = "./Entitlements.plist";
export const REQUIRED_INFO_PLIST_PATH = "Info.macos.plist";

/// #945 - the media-capture authority this app must NOT hold.
///
/// ZUULI held `com.apple.security.device.camera`/`.audio-input` and shipped
/// `NSCameraUsageDescription`/`NSMicrophoneUsageDescription` for the
/// livestreaming surface #904 phase 4 (#943) deleted. On the process that
/// holds the master seed, a macOS sandbox capability nothing can exercise is
/// free surface (#367), so the property is inverted: the entitlements and the
/// merged Info.plist are still pinned byte-for-byte, and what they are pinned
/// to now excludes capture.
export const FORBIDDEN_CAPTURE_ENTITLEMENTS = [
  "com.apple.security.device.audio-input",
  "com.apple.security.device.camera",
];
export const FORBIDDEN_USAGE_DESCRIPTION_KEYS = [
  "NSCameraUsageDescription",
  "NSMicrophoneUsageDescription",
];

export const CANONICAL_ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>com.apple.application-identifier</key>
\t<string>${REQUIRED_APPLICATION_IDENTIFIER}</string>
\t<key>com.apple.developer.team-identifier</key>
\t<string>${REQUIRED_TEAM_IDENTIFIER}</string>
\t<key>keychain-access-groups</key>
\t<array>
\t\t<string>${REQUIRED_APPLICATION_IDENTIFIER}</string>
\t</array>
</dict>
</plist>
`;

// The macOS Info.plist stays declared in tauri.conf.json and stays pinned here
// even though it is now empty: it is the file anyone would edit to add a usage
// description back, and an exact match makes that a red build rather than a
// quiet new TCC prompt on the wallet.
export const CANONICAL_INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict/>
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
      "macOS entitlements must be the reviewed identifiers and the exact Keychain access group, with no media-capture authority",
    );
  }
  if (infoPlistSource !== CANONICAL_INFO_PLIST) {
    failures.push(
      "macOS Info.plist must be the reviewed empty dictionary, declaring no media-capture usage description",
    );
  }
  // Named rather than only implied by the byte match, so the failure says what
  // is wrong instead of "these two blobs differ". #945.
  for (const entitlement of FORBIDDEN_CAPTURE_ENTITLEMENTS) {
    if (entitlementsSource.includes(entitlement))
      failures.push(
        `macOS entitlements must not claim ${entitlement}: ZUULI has no capture surface (#945)`,
      );
  }
  for (const key of FORBIDDEN_USAGE_DESCRIPTION_KEYS) {
    if (infoPlistSource.includes(key))
      failures.push(
        `macOS Info.plist must not declare ${key}: ZUULI has no capture surface (#945)`,
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
  console.log(
    "macOS Keychain authority is source-bound and complete, and no media-capture authority is claimed.",
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
