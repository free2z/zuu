import assert from "node:assert/strict";
import test from "node:test";

import {
  CANONICAL_ENTITLEMENTS,
  CANONICAL_INFO_PLIST,
  FORBIDDEN_CAPTURE_ENTITLEMENTS,
  FORBIDDEN_USAGE_DESCRIPTION_KEYS,
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

// #945 - the inverse of what these used to assert. They required camera and
// audio-input authority so that losing it was a red build; ZUULI has had no
// capture surface since #943, so re-granting it is what must be red now.
test("the reviewed contract claims no media-capture authority", () => {
  for (const entitlement of FORBIDDEN_CAPTURE_ENTITLEMENTS) {
    assert.ok(
      !CANONICAL_ENTITLEMENTS.includes(entitlement),
      `${entitlement} must not be in the reviewed entitlements`,
    );
  }
  for (const key of FORBIDDEN_USAGE_DESCRIPTION_KEYS) {
    assert.ok(
      !CANONICAL_INFO_PLIST.includes(key),
      `${key} must not be in the reviewed macOS Info.plist`,
    );
  }
  // The positive control: without it every assertion above would also pass
  // against an empty contract that grants nothing and pins nothing.
  assert.ok(CANONICAL_ENTITLEMENTS.includes("keychain-access-groups"));
  assert.deepEqual(
    verifyMacosKeychainEntitlements(
      validConfig,
      CANONICAL_ENTITLEMENTS,
      CANONICAL_INFO_PLIST,
    ),
    [],
  );
});

for (const entitlement of FORBIDDEN_CAPTURE_ENTITLEMENTS) {
  test(`rejects reintroduced ${entitlement} authority`, () => {
    const mutation = CANONICAL_ENTITLEMENTS.replace(
      "\t<key>keychain-access-groups</key>",
      `\t<key>${entitlement}</key>\n\t<true/>\n\t<key>keychain-access-groups</key>`,
    );
    assert.notEqual(mutation, CANONICAL_ENTITLEMENTS);
    const failures = verifyMacosKeychainEntitlements(
      validConfig,
      mutation,
      CANONICAL_INFO_PLIST,
    );
    assert.ok(
      failures.some((failure) => failure.includes(entitlement)),
      `a reintroduced ${entitlement} must be named in the failure, got ${JSON.stringify(failures)}`,
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

for (const key of FORBIDDEN_USAGE_DESCRIPTION_KEYS) {
  test(`rejects a reintroduced macOS ${key}`, () => {
    const mutation = CANONICAL_INFO_PLIST.replace(
      "<dict/>",
      `<dict>\n\t<key>${key}</key>\n\t<string>ZUULI needs this.</string>\n</dict>`,
    );
    assert.notEqual(mutation, CANONICAL_INFO_PLIST);
    const failures = verifyMacosKeychainEntitlements(
      validConfig,
      CANONICAL_ENTITLEMENTS,
      mutation,
    );
    assert.ok(
      failures.some((failure) => failure.includes(key)),
      `a reintroduced ${key} must be named in the failure, got ${JSON.stringify(failures)}`,
    );
  });
}
