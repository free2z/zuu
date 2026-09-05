#!/usr/bin/env node
//
// Read `wallet/e2e2z/store-identity.json` and refuse, in words a human can act
// on, to proceed past a store record that does not exist yet.
//
// Why this file exists at all. Everything else in the e2e2z release path is a
// mirror of ZUULI's, and ZUULI hardcodes its two store identities directly in
// the workflow and in `normalize-generated-ios-project.mjs`: the provisioning
// profile `ZUULI App Store CI`, its UUID, and the Android upload certificate
// fingerprint. It can, because those things exist. For `cash.free2z.e2e2z` they
// do not:
//
//   * The App Store Connect **app record** must be created by a human in App
//     Store Connect. There is no API that creates one. Until it exists, no
//     provisioning profile can be issued for the bundle id, `altool
//     --validate-app` has nothing to validate against, and TestFlight has no
//     app to receive a build.
//   * The Play Console **listing** must likewise be created by a human. The
//     Android Publisher API only edits apps that already exist; `POST
//     /edits` against a package name Play has never seen returns a 404 that
//     reads like a permissions problem and is not one.
//   * Play App Signing then generates the **app signing certificate**, and its
//     SHA-256 — the fingerprint `assetlinks.json` must carry — is readable only
//     from Play Console (Setup -> App integrity -> App signing) once the
//     listing exists. It is one of the three values tracked in #461.
//
// So the honest shape is: keep those facts in one reviewed, source-controlled
// file, start them at `null`, and make every step that needs one fail closed
// with the sentence that says what to go and do. A pipeline that stops at a
// stated blocker is the goal. A pipeline that appears to work and does not is
// the failure this file exists to prevent, and an opaque 404 from Google three
// jobs deep is that failure wearing a hat.
//
// Nothing here is a secret. The profile name and UUID are not credentials, the
// upload fingerprint is a public certificate digest, and binding them in source
// is what lets the credential-free build job attest the export configuration
// the protected signing job will later be held to.
//
// Usage:
//   node scripts/store-identity.mjs                 print the parsed identity
//   node scripts/store-identity.mjs --require=apple  ... and require Apple ready
//   node scripts/store-identity.mjs --require=android ... and require Play ready
//   node scripts/store-identity.mjs --self-test      negative controls first

import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// `release-identity.mjs` imports `validate` from here, so everything below the
// exports must not run on import — an exiting module would take its importer
// with it.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const APPLE_RECORD_BLOCKER = [
  "cash.free2z.e2e2z has no App Store Connect app record.",
  "",
  "Nobody can create one from CI: App Store Connect has no API for it. A human",
  "with the Corpora (F9AV5HKF6N) account must, in this order:",
  "",
  "  1. Certificates, Identifiers & Profiles -> Identifiers: register an App ID",
  "     for cash.free2z.e2e2z.",
  "  2. App Store Connect -> Apps -> New App: create the app record on that",
  "     bundle id.",
  "  3. Profiles -> new App Store distribution profile for cash.free2z.e2e2z,",
  "     signed by the existing Corpora Apple Distribution certificate.",
  "  4. Record that profile's name and UUID in wallet/e2e2z/store-identity.json",
  '     and set apple.appStoreConnectRecord to "created", then export the',
  "     profile and store it as APPLE_PROVISIONING_PROFILE_BASE64 in the",
  "     e2e2z-app-stores environment.",
  "",
  "Until step 4 lands, the iOS lane stops here rather than failing later inside",
  "xcodebuild or altool with an error about something else.",
].join("\n");

const PLAY_LISTING_BLOCKER = [
  "cash.free2z.e2e2z has no Google Play Console listing.",
  "",
  "The Android Publisher API can only edit an app Play already knows about, so",
  "no CI step can create this. A human with access to the Play developer",
  "account must:",
  "",
  "  1. Play Console -> Create app, package name cash.free2z.e2e2z, and complete",
  "     enough of the dashboard for an internal-testing release to be accepted.",
  "  2. Grant the existing release service account access to the new app.",
  "  3. Create an upload key, register it with Play App Signing, and record its",
  "     SHA-256 as google.uploadCertificateSha256 in",
  "     wallet/e2e2z/store-identity.json (uppercase, colon-delimited, exactly as",
  "     `keytool -list -v` prints it), with the keystore itself stored as",
  "     ANDROID_KEYSTORE_BASE64 in the e2e2z-app-stores environment.",
  '  4. Set google.playConsoleListing to "created".',
  "",
  "Separately, and only after the listing exists, Play generates the app signing",
  "certificate. Its SHA-256 (Setup -> App integrity -> App signing) is the",
  "fingerprint assetlinks.json needs; record it as",
  "google.appSigningCertificateSha256. That value is tracked in #461 and is not",
  "used by this release path.",
].join("\n");

export function validate(identity) {
  const failures = [];
  const fail = (message) => failures.push(message);

  if (identity === null || typeof identity !== "object" || Array.isArray(identity))
    return ["store-identity.json root must be a JSON object"];
  if (identity.schemaVersion !== 1)
    fail(`store-identity.json schemaVersion must be 1, got ${JSON.stringify(identity.schemaVersion)}`);
  if (identity.applicationId !== "cash.free2z.e2e2z")
    fail(`store-identity.json applicationId must be cash.free2z.e2e2z, got ${JSON.stringify(identity.applicationId)}`);

  const apple = identity.apple;
  if (apple === null || typeof apple !== "object" || Array.isArray(apple)) {
    fail("store-identity.json apple must be an object");
  } else {
    if (apple.teamId !== "F9AV5HKF6N")
      fail(`Apple team must be F9AV5HKF6N, got ${JSON.stringify(apple.teamId)}`);
    if (apple.distributionIdentity !== "Apple Distribution: Corpora Inc (F9AV5HKF6N)")
      fail(`Apple distribution identity is not the reviewed Corpora certificate: ${JSON.stringify(apple.distributionIdentity)}`);
    if (!["missing", "created"].includes(apple.appStoreConnectRecord))
      fail(`apple.appStoreConnectRecord must be "missing" or "created", got ${JSON.stringify(apple.appStoreConnectRecord)}`);
    const name = apple.provisioningProfileName;
    const uuid = apple.provisioningProfileUuid;
    if (name !== null && (typeof name !== "string" || name.length === 0))
      fail("apple.provisioningProfileName must be a non-empty string or null");
    if (uuid !== null && (typeof uuid !== "string" || !UUID.test(uuid)))
      fail("apple.provisioningProfileUuid must be a lowercase UUID or null");
    // A record with no profile is a real intermediate state; a profile named
    // against a record that does not exist is not, and neither is half a
    // profile. Both would sail through the per-field checks above.
    if (apple.appStoreConnectRecord === "missing" && (name !== null || uuid !== null))
      fail("apple names a provisioning profile but reports no App Store Connect record");
    if ((name === null) !== (uuid === null))
      fail("apple.provisioningProfileName and apple.provisioningProfileUuid must both be set or both be null");
  }

  const google = identity.google;
  if (google === null || typeof google !== "object" || Array.isArray(google)) {
    fail("store-identity.json google must be an object");
  } else {
    if (!["missing", "created"].includes(google.playConsoleListing))
      fail(`google.playConsoleListing must be "missing" or "created", got ${JSON.stringify(google.playConsoleListing)}`);
    for (const key of ["uploadCertificateSha256", "appSigningCertificateSha256"]) {
      const value = google[key];
      if (value !== null && (typeof value !== "string" || !FINGERPRINT.test(value)))
        fail(`google.${key} must be an uppercase colon-delimited SHA-256 fingerprint or null`);
    }
    if (google.playConsoleListing === "missing" && google.uploadCertificateSha256 !== null)
      fail("google names an upload certificate but reports no Play Console listing");
  }

  return failures;
}

export function appleBlockers(identity) {
  const blockers = [];
  if (identity.apple?.appStoreConnectRecord !== "created")
    blockers.push(APPLE_RECORD_BLOCKER);
  else if (identity.apple?.provisioningProfileName === null)
    blockers.push(
      "cash.free2z.e2e2z has an App Store Connect record but no recorded App Store " +
        "distribution provisioning profile. Issue one and record its name and UUID " +
        "in wallet/e2e2z/store-identity.json.",
    );
  return blockers;
}

export function androidBlockers(identity) {
  const blockers = [];
  if (identity.google?.playConsoleListing !== "created")
    blockers.push(PLAY_LISTING_BLOCKER);
  else if (identity.google?.uploadCertificateSha256 === null)
    blockers.push(
      "cash.free2z.e2e2z has a Play Console listing but no recorded upload " +
        "certificate fingerprint. Record google.uploadCertificateSha256 in " +
        "wallet/e2e2z/store-identity.json; signing refuses to run without a " +
        "fingerprint to hold the keystore to.",
    );
  return blockers;
}

function read() {
  return JSON.parse(readFileSync(resolve(appDir, "store-identity.json"), "utf8"));
}

function selfTest() {
  const base = read();
  const clone = () => structuredClone(base);
  const expect = (label, failures, matcher) => {
    if (!failures.some((failure) => failure.includes(matcher)))
      throw new Error(`store-identity self-test failed: ${label}`);
  };

  if (validate(base).length !== 0)
    throw new Error(`committed store-identity.json is invalid: ${validate(base).join("; ")}`);

  let mutated = clone();
  mutated.applicationId = "cash.free2z.zuuli";
  expect("foreign application id", validate(mutated), "applicationId must be cash.free2z.e2e2z");

  mutated = clone();
  mutated.apple.provisioningProfileName = "e2e2z App Store CI";
  expect(
    "profile named without a record",
    validate(mutated),
    "names a provisioning profile but reports no App Store Connect record",
  );

  mutated = clone();
  mutated.apple.appStoreConnectRecord = "created";
  mutated.apple.provisioningProfileName = "e2e2z App Store CI";
  expect("half a profile", validate(mutated), "must both be set or both be null");

  mutated = clone();
  mutated.google.uploadCertificateSha256 = "aa:bb";
  expect("malformed fingerprint", validate(mutated), "uppercase colon-delimited SHA-256 fingerprint");

  mutated = clone();
  mutated.google.playConsoleListing = "created";
  mutated.google.uploadCertificateSha256 = "AB".concat(":AB".repeat(31));
  if (validate(mutated).length !== 0)
    throw new Error("store-identity self-test failed: a complete Play identity was rejected");
  if (androidBlockers(mutated).length !== 0)
    throw new Error("store-identity self-test failed: a complete Play identity still blocked");

  if (appleBlockers(base).length !== 1 || androidBlockers(base).length !== 1)
    throw new Error("store-identity self-test failed: the committed identity must block both lanes");
}

function main() {
  if (process.argv.includes("--self-test")) {
    selfTest();
    console.log("store-identity self-test passed");
    return 0;
  }

  const identity = read();
  const failures = validate(identity);
  if (failures.length) {
    console.error("store-identity.json is inconsistent:\n- " + failures.join("\n- "));
    return 1;
  }

  const required = process.argv
    .filter((arg) => arg.startsWith("--require="))
    .map((arg) => arg.slice("--require=".length));
  for (const platform of required) {
    if (!["apple", "android"].includes(platform)) {
      console.error(`--require must be apple or android, got ${platform}`);
      return 2;
    }
  }

  const blockers = [
    ...(required.includes("apple") ? appleBlockers(identity) : []),
    ...(required.includes("android") ? androidBlockers(identity) : []),
  ];
  if (blockers.length) {
    console.error(blockers.join("\n\n"));
    return 78; // EX_CONFIG: the configuration is absent, not wrong.
  }

  console.log(JSON.stringify(identity));
  return 0;
}

if (invokedDirectly) process.exit(main());
