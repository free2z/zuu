import assert from "node:assert/strict";
import test from "node:test";

import {
  CANONICAL_ENTITLEMENTS,
  REQUIRED_APPLICATION_IDENTIFIER,
  REQUIRED_ENTITLEMENTS_PATH,
  verifyMacosKeychainEntitlements,
} from "./macos-keychain-entitlements.mjs";

const validConfig = JSON.stringify({
  identifier: "cash.free2z.zuuli",
  bundle: { macOS: { entitlements: REQUIRED_ENTITLEMENTS_PATH } },
});

test("accepts the exact reviewed Keychain entitlement contract", () => {
  assert.deepEqual(
    verifyMacosKeychainEntitlements(validConfig, CANONICAL_ENTITLEMENTS),
    [],
  );
});

test("rejects a package configuration without the entitlement file", () => {
  const failures = verifyMacosKeychainEntitlements(
    JSON.stringify({ identifier: "cash.free2z.zuuli", bundle: {} }),
    CANONICAL_ENTITLEMENTS,
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
    const failures = verifyMacosKeychainEntitlements(validConfig, mutation(CANONICAL_ENTITLEMENTS));
    assert.ok(failures.some((failure) => failure.includes("macOS entitlements")));
  });
}

test("rejects unexpected entitlement expansion", () => {
  const expanded = CANONICAL_ENTITLEMENTS.replace(
    "</dict>",
    "\t<key>com.apple.security.network.server</key>\n\t<true/>\n</dict>",
  );
  assert.notDeepEqual(verifyMacosKeychainEntitlements(validConfig, expanded), []);
});
