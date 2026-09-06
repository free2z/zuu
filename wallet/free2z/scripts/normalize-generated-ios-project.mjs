#!/usr/bin/env node
//
// Undo the byte-level churn `tauri ios build` introduces, and nothing else.
//
// The release path runs `git diff --exit-code` immediately after the iOS build
// to prove the committed Xcode project is exactly the one that was built. Tauri
// regenerates the project through xcodegen on every build, and xcodegen quotes
// some build settings that the committed file spells bare, drops trailing
// newlines from the plists, and merges `src-tauri/Info.ios.plist` into the
// generated Info.plist. None of that is a change to the project; all of it makes
// `git diff` non-empty.
//
// So this canonicalizes exactly three things and refuses anything it does not
// recognize:
//
//   * `KEY = "value";` back to `KEY = value;` for the two settings xcodegen
//     quotes, and only when the count of known values is exactly what the
//     committed project has. An unexpected count throws rather than rewrites.
//   * a trailing newline on each plist, after asserting the plist terminator is
//     still there, so this cannot "normalize" a truncated file.
//   * the merged Info.plist's URL type, which the deep-link merge emits in
//     either key order, collapsed to the one canonical spelling. A scheme that
//     is not free2z's own fails closed -- that is the check, not the rewrite.
//
// The committed Info.plist must also keep two things free2z cannot ship without:
// the exempt-encryption declaration (`release.json` says
// `iosUsesNonExemptEncryption: false`, and an app that silently stopped saying so
// would be held at App Store review every submission), and the camera and
// microphone usage strings. The second is the free2z-specific half. e2e2z's
// version of this file forbids every usage description because e2e2z captures
// nothing; free2z hosts live rooms, so WKWebView will refuse `getUserMedia`
// without them and iOS will terminate the process outright if one is missing at
// the moment of capture. A normalizer that let them fall out would turn a
// merge-order change into a crash on first broadcast, which is exactly the class
// of thing this file exists to catch, so it asserts them rather than tolerating
// them.
//
// Usage:
//   node scripts/normalize-generated-ios-project.mjs
//   node scripts/normalize-generated-ios-project.mjs --self-test

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const teamId = "F9AV5HKF6N";
const productName = "free2z";
const applicationId = "cash.free2z.free2z";

const projectPath = resolve(appDir, "src-tauri/gen/apple/free2z.xcodeproj/project.pbxproj");
const infoPlistPath = resolve(appDir, "src-tauri/gen/apple/free2z_iOS/Info.plist");
const entitlementsPath = resolve(
  appDir,
  "src-tauri/gen/apple/free2z_iOS/free2z_iOS.entitlements",
);

const exemptEncryptionDeclaration = [
  "\t<key>ITSAppUsesNonExemptEncryption</key>",
  "\t<false/>",
].join("\n");

// The two capabilities free2z actually exercises. Required, not forbidden --
// see the header.
const requiredUsageDescriptions = [
  "NSCameraUsageDescription",
  "NSMicrophoneUsageDescription",
];
// Everything else. free2z reads no contacts, no location and no photo library,
// and holds no seed to unlock, so a usage string for any of these is a claim
// nobody reviewed and an App Store reviewer will ask about.
const forbiddenUsageDescriptions = [
  "NSContactsUsageDescription",
  "NSFaceIDUsageDescription",
  "NSLocationAlwaysAndWhenInUseUsageDescription",
  "NSLocationWhenInUseUsageDescription",
  "NSPhotoLibraryAddUsageDescription",
  "NSPhotoLibraryUsageDescription",
];

const canonicalUrlTypeDictionary = [
  "\t\t<dict>",
  "\t\t\t<key>CFBundleURLName</key>",
  `\t\t\t<string>${applicationId}</string>`,
  "\t\t\t<key>CFBundleURLSchemes</key>",
  "\t\t\t<array>",
  `\t\t\t\t<string>${applicationId}</string>`,
  "\t\t\t</array>",
  "\t\t</dict>",
].join("\n");
const reversedUrlTypeDictionary = [
  "\t\t<dict>",
  "\t\t\t<key>CFBundleURLSchemes</key>",
  "\t\t\t<array>",
  `\t\t\t\t<string>${applicationId}</string>`,
  "\t\t\t</array>",
  "\t\t\t<key>CFBundleURLName</key>",
  `\t\t\t<string>${applicationId}</string>`,
  "\t\t</dict>",
].join("\n");
const urlType = (dictionaries) =>
  ["\t<key>CFBundleURLTypes</key>", "\t<array>", ...dictionaries, "\t</array>"].join("\n");
const canonicalUrlType = urlType([canonicalUrlTypeDictionary]);
const reversedUrlType = urlType([reversedUrlTypeDictionary]);

// The deep-link plugin emits ONE iOS URL-type dictionary per configured mobile
// route, and free2z has three -- `bridge/return`, `oauth/callback` and
// `checkout/return`. iOS URL types carry no host or path, so all three collapse
// to the same custom scheme and a build deterministically writes three identical
// dictionaries. One canonical entry is kept in source control and exactly that
// generated shape is collapsed back to it.
//
// The count is derived from `tauri.conf.json` rather than written out, so adding
// or removing a route does not silently start failing; what is NOT derived is
// the scheme. Every route must name this app's own bundle id and must not claim
// an app link, or this refuses to collapse anything -- a foreign scheme in the
// shipped bundle is the failure the whole check exists for, and ZUULI's version
// of this file pins an exact route array for the same reason.
function configuredMobileRouteCount() {
  const config = JSON.parse(
    readFileSync(resolve(appDir, "src-tauri/tauri.conf.json"), "utf8"),
  );
  const routes = config?.plugins?.["deep-link"]?.mobile;
  if (!Array.isArray(routes) || routes.length === 0)
    throw new Error("tauri.conf.json registers no mobile deep-link route");
  for (const route of routes) {
    if (!isDeepStrictEqual(route?.scheme, [applicationId]))
      throw new Error(
        `a mobile deep-link route names a scheme that is not ${applicationId}`,
      );
    if (route?.appLink !== false)
      throw new Error(
        "a mobile deep-link route claims an app link; free2z registers custom schemes only",
      );
  }
  return routes.length;
}

function knownUrlTypeShapes(routeCount) {
  const shapes = [];
  for (const dictionary of [canonicalUrlTypeDictionary, reversedUrlTypeDictionary]) {
    shapes.push(urlType([dictionary]));
    if (routeCount > 1)
      shapes.push(urlType(Array.from({ length: routeCount }, () => dictionary)));
  }
  return shapes;
}

function occurrenceCount(contents, value) {
  return contents.split(value).length - 1;
}

function normalizeBuildSetting(contents, name, value, expectedCount) {
  const canonical = `${name} = ${value};`;
  const generated = `${name} = "${value}";`;
  const count = occurrenceCount(contents, canonical) + occurrenceCount(contents, generated);
  if (count !== expectedCount) {
    throw new Error(
      `refusing to normalize ${name}: expected ${expectedCount} known values, found ${count}`,
    );
  }
  return contents.replaceAll(generated, canonical);
}

export function normalizeProject(contents) {
  let normalized = normalizeBuildSetting(contents, "DEVELOPMENT_TEAM", teamId, 2);
  normalized = normalizeBuildSetting(normalized, "PRODUCT_NAME", productName, 2);
  return normalized;
}

export function normalizePlist(contents, label) {
  if (!contents.trimEnd().endsWith("</plist>"))
    throw new Error(`refusing to normalize ${label}: plist terminator is missing`);
  return contents.endsWith("\n") ? contents : `${contents}\n`;
}

// The capability rules below scan for key names, and a plist that explains in a
// comment which capabilities free2z does not claim would otherwise be judged on
// its own prose. Comments are stripped for the scans only; the returned value is
// always derived from the original bytes.
const withoutXmlComments = (contents) => contents.replace(/<!--[\s\S]*?-->/g, "");

export function normalizeInfoPlist(contents, label, routeCount = configuredMobileRouteCount()) {
  const normalized = normalizePlist(contents, label);
  const scanned = withoutXmlComments(normalized);
  const urlTypeKeyCount = occurrenceCount(normalized, "<key>CFBundleURLTypes</key>");
  if (urlTypeKeyCount !== 1)
    throw new Error(
      `refusing to normalize ${label}: expected exactly one CFBundleURLTypes key, found ${urlTypeKeyCount}`,
    );
  const encryptionKeyCount = occurrenceCount(
    normalized,
    "<key>ITSAppUsesNonExemptEncryption</key>",
  );
  const exemptDeclarationCount = occurrenceCount(normalized, exemptEncryptionDeclaration);
  if (encryptionKeyCount !== 1 || exemptDeclarationCount !== 1)
    throw new Error(
      `refusing to normalize ${label}: expected exactly one canonical exempt-encryption declaration, found ${encryptionKeyCount} keys and ${exemptDeclarationCount} false declarations`,
    );
  for (const required of requiredUsageDescriptions) {
    if (occurrenceCount(scanned, `<key>${required}</key>`) !== 1)
      throw new Error(
        `refusing to normalize ${label}: expected exactly one ${required}; free2z hosts live rooms and iOS terminates a capture with no usage string`,
      );
  }
  for (const forbidden of forbiddenUsageDescriptions) {
    if (scanned.includes(forbidden))
      throw new Error(
        `refusing to normalize ${label}: names a capability free2z does not have (${forbidden})`,
      );
  }
  const matched = knownUrlTypeShapes(routeCount).filter(
    (shape) => occurrenceCount(normalized, shape) === 1,
  );
  if (matched.length !== 1)
    throw new Error(
      `refusing to normalize ${label}: expected exactly one known free2z URL type, found ${matched.length}`,
    );
  return normalized.replace(matched[0], canonicalUrlType);
}

function selfTest() {
  const generated = [
    `DEVELOPMENT_TEAM = "${teamId}";`,
    `PRODUCT_NAME = "${productName}";`,
    `DEVELOPMENT_TEAM = "${teamId}";`,
    `PRODUCT_NAME = "${productName}";`,
  ].join("\n");
  const expected = generated.replaceAll(' = "', " = ").replaceAll('";', ";");
  if (normalizeProject(generated) !== expected)
    throw new Error("iOS project normalization self-test failed");

  let rejectedUnexpectedShape = false;
  try {
    normalizeProject(`DEVELOPMENT_TEAM = "${teamId}";`);
  } catch {
    rejectedUnexpectedShape = true;
  }
  if (!rejectedUnexpectedShape)
    throw new Error("iOS project normalization accepted an unexpected shape");

  if (normalizePlist("<plist><dict/></plist>", "fixture") !== "<plist><dict/></plist>\n")
    throw new Error("iOS plist normalization self-test failed");

  const usage = requiredUsageDescriptions
    .map((key) => `\t<key>${key}</key>\n\t<string>free2z uses this for live streams.</string>`)
    .join("\n");
  const body = (urlTypeShape) =>
    `<plist><dict>\n${urlTypeShape}\n${usage}\n${exemptEncryptionDeclaration}\n</dict></plist>`;
  const canonicalFixture = body(canonicalUrlType);
  const reversedFixture = body(reversedUrlType);
  if (
    normalizeInfoPlist(canonicalFixture, "canonical fixture", 1) !== `${canonicalFixture}\n` ||
    normalizeInfoPlist(reversedFixture, "reversed fixture", 1) !== `${canonicalFixture}\n`
  )
    throw new Error("iOS URL type ordering self-test failed");

  // The shape a real build of this app actually writes: one identical dictionary
  // per configured route, in the plugin's key order, collapsed back to the one
  // canonical entry that is committed.
  const routeCount = configuredMobileRouteCount();
  if (routeCount < 2)
    throw new Error(
      "iOS URL type self-test expects free2z to register more than one mobile deep-link route",
    );
  for (const dictionary of [canonicalUrlTypeDictionary, reversedUrlTypeDictionary]) {
    const generated = body(urlType(Array.from({ length: routeCount }, () => dictionary)));
    if (normalizeInfoPlist(generated, "generated fixture", routeCount) !== `${canonicalFixture}\n`)
      throw new Error("iOS URL type duplicate-collapse self-test failed");
    // The same bytes are NOT accepted when only one route is configured, which
    // is what stops the collapse from becoming a blanket deduplicator.
    let rejectedUnconfiguredDuplicate = false;
    try {
      normalizeInfoPlist(generated, "generated fixture", 1);
    } catch (error) {
      rejectedUnconfiguredDuplicate = error instanceof Error;
    }
    if (!rejectedUnconfiguredDuplicate)
      throw new Error("iOS URL type normalization collapsed a duplicate no route explains");
  }

  for (const [label, unexpected] of [
    [
      "foreign scheme",
      canonicalUrlType.replaceAll(
        `<string>${applicationId}</string>`,
        "<string>attacker.example</string>",
      ),
    ],
    ["duplicate URL type keys", `${canonicalUrlType}\n${canonicalUrlType}`],
  ]) {
    let rejected = false;
    try {
      normalizeInfoPlist(body(unexpected), label, 1);
    } catch (error) {
      rejected = error instanceof Error;
    }
    if (!rejected)
      throw new Error(`iOS URL type normalization accepted an unknown shape: ${label}`);
  }

  let rejectedNonExempt = false;
  try {
    normalizeInfoPlist(
      canonicalFixture.replace("\t<false/>", "\t<true/>"),
      "non-exempt encryption fixture",
      1,
    );
  } catch (error) {
    rejectedNonExempt =
      error instanceof Error &&
      error.message.includes("expected exactly one canonical exempt-encryption declaration");
  }
  if (!rejectedNonExempt)
    throw new Error("iOS plist normalization accepted non-exempt encryption");

  // Both directions of the capability rule, because either one alone would let
  // the other regress silently.
  for (const required of requiredUsageDescriptions) {
    let rejectedMissing = false;
    try {
      normalizeInfoPlist(
        canonicalFixture.replace(`<key>${required}</key>`, "<key>NSUnusedKey</key>"),
        `missing ${required} fixture`,
        1,
      );
    } catch (error) {
      rejectedMissing =
        error instanceof Error && error.message.includes(`expected exactly one ${required}`);
    }
    if (!rejectedMissing)
      throw new Error(`iOS plist normalization accepted a missing ${required}`);
  }
  for (const forbidden of forbiddenUsageDescriptions) {
    let rejectedForbidden = false;
    try {
      normalizeInfoPlist(
        canonicalFixture.replace(
          "</dict></plist>",
          `\t<key>${forbidden}</key>\n\t<string>nope</string>\n</dict></plist>`,
        ),
        `${forbidden} fixture`,
        1,
      );
    } catch (error) {
      rejectedForbidden =
        error instanceof Error && error.message.includes("names a capability free2z does not have");
    }
    if (!rejectedForbidden)
      throw new Error(`iOS plist normalization accepted ${forbidden}`);
  }

  // The committed tree must already be canonical, or the release's
  // `git diff --exit-code` fails on files nothing changed.
  const committedInfoPlist = readFileSync(infoPlistPath, "utf8");
  if (normalizeInfoPlist(committedInfoPlist, infoPlistPath) !== committedInfoPlist)
    throw new Error("committed iOS Info.plist is not canonical");
  const committedProject = readFileSync(projectPath, "utf8");
  if (normalizeProject(committedProject) !== committedProject)
    throw new Error("committed iOS project is not canonical");
  const committedEntitlements = readFileSync(entitlementsPath, "utf8");
  if (normalizePlist(committedEntitlements, entitlementsPath) !== committedEntitlements)
    throw new Error("committed iOS entitlements are not canonical");
}

if (process.argv.includes("--self-test")) {
  selfTest();
  console.log("iOS project normalization self-test passed");
  process.exit(0);
}

const project = readFileSync(projectPath, "utf8");
const normalizedProject = normalizeProject(project);
if (normalizedProject !== project) writeFileSync(projectPath, normalizedProject);

const infoPlist = readFileSync(infoPlistPath, "utf8");
const normalizedInfoPlist = normalizeInfoPlist(infoPlist, infoPlistPath);
if (normalizedInfoPlist !== infoPlist) writeFileSync(infoPlistPath, normalizedInfoPlist);

const entitlements = readFileSync(entitlementsPath, "utf8");
const normalizedEntitlements = normalizePlist(entitlements, entitlementsPath);
if (normalizedEntitlements !== entitlements) writeFileSync(entitlementsPath, normalizedEntitlements);
