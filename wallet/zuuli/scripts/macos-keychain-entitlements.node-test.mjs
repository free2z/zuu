import assert from "node:assert/strict";
import test from "node:test";

import {
  CAMERA_COPY,
  CANONICAL_ENTITLEMENTS,
  CANONICAL_INFO_PLIST,
  MICROPHONE_COPY,
  REQUIRED_APPLICATION_IDENTIFIER,
  REQUIRED_ENTITLEMENTS_PATH,
  REQUIRED_INFO_PLIST_PATH,
  verifyMacosKeychainEntitlements,
} from "./macos-keychain-entitlements.mjs";

const validConfig = JSON.stringify({
  identifier: "cash.free2z.zuuli",
  bundle: {
    macOS: {
      entitlements: REQUIRED_ENTITLEMENTS_PATH,
      infoPlist: REQUIRED_INFO_PLIST_PATH,
    },
  },
});

test("accepts the exact reviewed Keychain entitlement contract", () => {
  assert.deepEqual(
    verifyMacosKeychainEntitlements(
      validConfig,
      CANONICAL_ENTITLEMENTS,
      CANONICAL_INFO_PLIST,
    ),
    [],
  );
});

test("rejects a package configuration without the entitlement file", () => {
  const failures = verifyMacosKeychainEntitlements(
    JSON.stringify({ identifier: "cash.free2z.zuuli", bundle: {} }),
    CANONICAL_ENTITLEMENTS,
    CANONICAL_INFO_PLIST,
  );
  assert.ok(failures.some((failure) => failure.includes("bundle.macOS.entitlements")));
});

for (const [name, mutation] of [
  [
    "application identifier",
    (source) => source.replace(
      `<string>${REQUIRED_APPLICATION_IDENTIFIER}</string>`,
      "<string>wrong.application</string>",
    ),
  ],
  [
    "team identifier",
    (source) => source.replace("<string>F9AV5HKF6N</string>", "<string>WRONGTEAM1</string>"),
  ],
  [
    "Keychain access group",
    (source) => source.replace("<key>keychain-access-groups</key>", "<key>unrelated</key>"),
  ],
]) {
  test(`rejects a missing or altered ${name}`, () => {
    const failures = verifyMacosKeychainEntitlements(
      validConfig,
      mutation(CANONICAL_ENTITLEMENTS),
      CANONICAL_INFO_PLIST,
    );
    assert.ok(failures.some((failure) => failure.includes("macOS entitlements")));
  });
}

test("rejects unexpected entitlement expansion", () => {
  const expanded = CANONICAL_ENTITLEMENTS.replace(
    "</dict>",
    "\t<key>com.apple.security.network.server</key>\n\t<true/>\n</dict>",
  );
  assert.notDeepEqual(
    verifyMacosKeychainEntitlements(validConfig, expanded, CANONICAL_INFO_PLIST),
    [],
  );
});

for (const entitlement of [
  "com.apple.security.device.audio-input",
  "com.apple.security.device.camera",
]) {
  test(`rejects missing ${entitlement} authority`, () => {
    const mutation = CANONICAL_ENTITLEMENTS.replace(
      `\t<key>${entitlement}</key>\n\t<true/>\n`,
      "",
    );
    assert.notDeepEqual(
      verifyMacosKeychainEntitlements(validConfig, mutation, CANONICAL_INFO_PLIST),
      [],
    );
  });
}

test("rejects a package configuration without the macOS Info.plist", () => {
  const config = JSON.stringify({
    identifier: "cash.free2z.zuuli",
    bundle: { macOS: { entitlements: REQUIRED_ENTITLEMENTS_PATH } },
  });
  assert.ok(
    verifyMacosKeychainEntitlements(
      config,
      CANONICAL_ENTITLEMENTS,
      CANONICAL_INFO_PLIST,
    ).some((failure) => failure.includes("bundle.macOS.infoPlist")),
  );
});

for (const [name, copy] of [
  ["camera", CAMERA_COPY],
  ["microphone", MICROPHONE_COPY],
]) {
  test(`rejects missing or altered macOS ${name} usage copy`, () => {
    const mutation = CANONICAL_INFO_PLIST.replace(copy, `Altered ${name} copy`);
    assert.ok(
      verifyMacosKeychainEntitlements(
        validConfig,
        CANONICAL_ENTITLEMENTS,
        mutation,
      ).some((failure) => failure.includes("macOS Info.plist")),
    );
  });
}
