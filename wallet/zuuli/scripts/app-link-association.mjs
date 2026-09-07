#!/usr/bin/env node
//
// The three apps claim one host, and each owns exactly one path prefix on it.
//
// `docs/intent-bridge/PROTOCOL.md` §7 refuses to ship the bridge over a custom
// scheme: any app can register `cash.free2z.zuuli://`, so on a custom scheme a
// hostile app can both impersonate the sender of an intent and intercept the
// response. `CALLER-AUTHENTICATION.md` §4 names the property that replaces it —
// a verified App Link / Universal Link is DOMAIN-BOUND, so only the app whose
// package or team owns the association receives the URL. That property is what
// #461 lands, and it is made of four things that must all agree:
//
//   1. `tauri.conf.json`      — the app-link route the plugin generates from.
//   2. the generated Android manifest — `android:autoVerify="true"` plus this
//      app's own `android:pathPrefix`.
//   3. the generated iOS entitlements — `com.apple.developer.associated-domains`.
//   4. the two association documents served by the host.
//
// Any one of those disagreeing with the others is a SILENT failure. Android
// caches a negative verification result, so a document that does not list the
// installed app's signing certificate makes the platform record "not verified"
// for the host and keep that answer long after the document is fixed. iOS simply
// opens Safari. Nothing throws, nothing logs, and the first symptom is a bridge
// response landing in a browser tab. So the agreement is asserted here rather
// than left to review.
//
// WHAT THIS FILE IS NOT. It is not the serving authority. The documents are
// served from `https://free2z.com/.well-known/` by the deployment repository's
// nginx, from its own reviewed inputs, and `docs/intent-bridge/association/`
// explains the split. What this file owns is the CLIENT half — what the three
// shipped apps claim — plus the reviewed record those documents must carry.
//
// It lives in `wallet/zuuli/scripts` for the same reason
// `messaging-contract.node-test.mjs` does: it reads across all three app trees
// and it must run inside the protected `gate`, which is ZUULI's `npm test`.
//
// Usage:
//   node wallet/zuuli/scripts/app-link-association.mjs
//   node wallet/zuuli/scripts/app-link-association.mjs --print=assetlinks
//   node wallet/zuuli/scripts/app-link-association.mjs --print=aasa
//   node --test wallet/zuuli/scripts/app-link-association.node-test.mjs

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WALLET_ROOT = path.resolve(SCRIPT_DIR, "../..");
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../../..");

/// The host the three apps claim, and the only host that serves the two
/// association documents today.
///
/// NOT `free2z.cash`, which is the canonical product host. `free2z.cash`
/// permanently redirects, and neither Apple nor Android follows a redirect for
/// these documents, so the deployment repository keeps them on `free2z.com` and
/// serves them there ahead of the redirect. An association is scoped to the
/// exact domain: what is cached for `free2z.com` does nothing for
/// `free2z.cash`.
///
/// Migrating to `free2z.cash` is recommended and is deliberately NOT one change:
/// the host must serve and cache both documents FIRST, and only then may a
/// client release claim it. Apple's CDN takes on the order of a day to fetch a
/// document and Android caches a negative result, so a `.cash`-claiming build
/// that reaches users before `.cash` serves the association opens a browser tab
/// for every bridge link, for days. Changing this constant is therefore the LAST
/// step of that migration, never the first.
export const ASSOCIATION_HOST = "free2z.com";

/// The Apple Developer team that owns all three App IDs. Cross-checked against
/// each app's `bundle.iOS.developmentTeam` below, so this cannot drift from what
/// the builds are signed with.
export const APPLE_TEAM_ID = "F9AV5HKF6N";

/// Fingerprints that must never appear in an association document, and why each
/// one is here. None of these is a secret — a certificate fingerprint is a hash
/// of a public certificate, and the whole purpose of `assetlinks.json` is to
/// publish one. They are recorded so that pasting the wrong one is a red build.
export const FORBIDDEN_FINGERPRINTS = new Map([
  [
    "AC:DD:93:86:43:8F:4E:DC:01:0B:B3:07:99:4E:1B:29:30:87:C4:66:69:83:A3:CE:0F:E3:24:A4:88:CA:14:E2",
    "ZUULI's UPLOAD certificate (the `ANDROID_UPLOAD_CERT_SHA256` repository " +
      "variable). It signs the AAB that goes to Play; Play then RE-SIGNS with " +
      "the Play App Signing key, and that is what users' installs carry. An " +
      "upload key verifies in a sideloaded test build and fails for everyone " +
      "else — and Android caches that failure.",
  ],
]);

/// The reviewed association record. One row per shipped app.
///
/// `appSigningCertificateSha256` is the PLAY APP SIGNING certificate, read from
/// Play Console -> Setup -> App integrity -> App signing. Each app is a separate
/// Play listing with its own key: there is no single "the" fingerprint, and
/// reusing one app's certificate for another package is precisely the
/// valid-but-wrong 200 that poisons Android's negative cache.
///
/// `pathPrefix` names the RECEIVING app, because a URL's only job is to reach
/// the right process. The bridge's own `caller` field says who sent it and
/// `CALLER-AUTHENTICATION.md` §5 is explicit that the claim is not authenticated
/// by the message.
///
/// The trailing slash is part of the prefix: `/bridge/zuuli/` does not match a
/// bare `/bridge/zuuli`, which is what stops `/bridge/zuuli-evil/...` from being
/// claimed by ZUULI. A client must always emit the slash.
export const APPS = [
  {
    directory: "zuuli",
    identifier: "cash.free2z.zuuli",
    pathPrefix: "/bridge/zuuli/",
    appSigningCertificateSha256:
      "B4:3B:D4:24:64:10:47:6E:21:12:D9:BA:D5:7E:AA:7E:FF:AD:46:18:A6:16:66:4C:A9:3F:8E:2E:F6:0D:1A:62",
    // ZUULI's OAuth relay terminates in `cash.free2z.zuuli://oauth/callback`, a
    // CUSTOM scheme, and this change does not move it. The component is listed
    // because it is already live in the served AASA and removing it from the
    // document would be a regression; no shipped build claims it as an App Link.
    extraAppleComponents: ["/oauth/callback"],
    storeIdentity: null,
  },
  {
    directory: "free2z",
    identifier: "cash.free2z.free2z",
    pathPrefix: "/bridge/free2z/",
    appSigningCertificateSha256:
      "75:8D:0C:62:A4:9B:D2:C1:03:B5:C5:39:B5:AF:5C:55:C5:AC:5E:1A:35:EF:B7:22:95:B0:44:AD:50:4B:72:5A",
    extraAppleComponents: [],
    storeIdentity: "store-identity.json",
  },
  {
    directory: "e2e2z",
    identifier: "cash.free2z.e2e2z",
    pathPrefix: "/bridge/e2e2z/",
    appSigningCertificateSha256:
      "B6:B8:BB:49:48:66:97:EF:FD:5B:E4:F8:6F:34:88:B8:A5:F9:1F:5B:A2:3A:70:7D:6D:C7:66:AB:B3:C0:08:8E",
    extraAppleComponents: [],
    storeIdentity: "store-identity.json",
  },
];

/// The Android relation that grants a package the right to handle URLs on the
/// host. It is HOST-WIDE: on its own, every package listed in `assetlinks.json`
/// may open any URL on the host. `android:pathPrefix` in each manifest is what
/// actually separates the three apps, on every Android version.
const RELATION = "delegate_permission/common.handle_all_urls";

/// Uppercase, colon-delimited, 32 bytes — the form Play Console prints. One
/// documented format, because accepting two makes the rendered document depend
/// on how someone pasted it.
const FINGERPRINT = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;

const readText = (...segments) =>
  readFileSync(path.join(REPO_ROOT, ...segments), "utf8");
const readJson = (...segments) => JSON.parse(readText(...segments));

function appleComponents(app) {
  return [...app.extraAppleComponents, `${app.pathPrefix}*`];
}

/// The reviewed Apple document, rendered from the record above.
export function renderAppleAppSiteAssociation(apps = APPS) {
  return `${JSON.stringify(
    {
      applinks: {
        details: apps.map((app) => ({
          appIDs: [`${APPLE_TEAM_ID}.${app.identifier}`],
          components: appleComponents(app).map((pattern) => ({ "/": pattern })),
        })),
      },
    },
    null,
    2,
  )}\n`;
}

/// The reviewed Android document, rendered from the record above.
///
/// `relation_extensions` carries Android 15's Dynamic App Links, derived from
/// the SAME components that scope iOS so the two platforms cannot be handed
/// different path ownership. It is defence in depth only: Android 14 and earlier
/// ignore the field, Android 15 applies it only on devices with Google services,
/// and dynamic rules can only narrow what a manifest already claims.
export function renderAssetLinks(apps = APPS) {
  return `${JSON.stringify(
    apps.map((app) => ({
      relation: [RELATION],
      target: {
        namespace: "android_app",
        package_name: app.identifier,
        sha256_cert_fingerprints: [app.appSigningCertificateSha256],
      },
      relation_extensions: {
        [RELATION]: {
          dynamic_app_link_components: appleComponents(app).map((pattern) => ({
            "/": pattern,
          })),
        },
      },
    })),
    null,
    2,
  )}\n`;
}

/// Apple's glob grammar, restricted to what both platforms agree on. Apple
/// matches `*` as "zero or more characters"; Google matches it as "zero or more
/// characters up until the character after the wildcard is found". At the END of
/// a pattern there is no character after the wildcard and the two definitions
/// coincide exactly, which is why a `*` anywhere else is refused rather than
/// translated: `/bridge/zuuli/*/callback` would open the app on iOS and fall
/// back to the browser on Android 15+, from one string that looks like one rule.
function patternPrefix(pattern) {
  if (pattern.endsWith("*")) return pattern.slice(0, -1);
  return pattern;
}

/// Two patterns overlap when some URL matches both. With terminal-`*`-only
/// patterns this reduces to prefix containment, which is decidable by string
/// comparison rather than by an automaton.
function patternsOverlap(a, b) {
  const [prefixA, prefixB] = [patternPrefix(a), patternPrefix(b)];
  const exactA = !a.endsWith("*");
  const exactB = !b.endsWith("*");
  if (exactA && exactB) return a === b;
  if (exactA) return a.startsWith(prefixB);
  if (exactB) return b.startsWith(prefixA);
  return prefixA.startsWith(prefixB) || prefixB.startsWith(prefixA);
}

function androidIntentFilters(manifest) {
  const filters = [];
  const pattern = /<intent-filter([^>]*)>([\s\S]*?)<\/intent-filter>/g;
  for (const [, attributes, body] of manifest.matchAll(pattern)) {
    filters.push({ attributes, body });
  }
  return filters;
}

function plistStringArray(plist, key) {
  const pattern = new RegExp(
    `<key>${key}</key>\\s*<array>([\\s\\S]*?)</array>`,
  );
  const match = plist.match(pattern);
  if (!match) return null;
  return [...match[1].matchAll(/<string>([^<]*)<\/string>/g)].map(
    ([, value]) => value,
  );
}

/// Every check, as a list of human-readable failures. Empty means the four
/// surfaces agree.
export function associationFailures({
  read = defaultReader(),
  apps = APPS,
  host = ASSOCIATION_HOST,
  forbiddenFingerprints = FORBIDDEN_FINGERPRINTS,
} = {}) {
  const failures = [];
  const seenFingerprints = new Map();

  for (const app of apps) {
    const label = `wallet/${app.directory}`;

    // ---- the reviewed record itself -------------------------------------
    const fingerprint = app.appSigningCertificateSha256;
    if (!FINGERPRINT.test(fingerprint)) {
      failures.push(
        `${app.identifier}: app signing fingerprint is not an uppercase colon-delimited SHA-256`,
      );
    }
    const forbiddenReason = forbiddenFingerprints.get(fingerprint);
    if (forbiddenReason) {
      failures.push(
        `${app.identifier}: app signing fingerprint is a certificate that must never appear in an association document. ${forbiddenReason}`,
      );
    }
    const previous = seenFingerprints.get(fingerprint);
    if (previous) {
      failures.push(
        `${app.identifier}: reuses ${previous}'s app signing fingerprint; each Play listing has its own key, and one app's certificate authorising another package is the valid-but-wrong document this whole mechanism avoids`,
      );
    }
    seenFingerprints.set(fingerprint, app.identifier);
    if (app.pathPrefix !== `/bridge/${app.directory}/`) {
      failures.push(
        `${app.identifier}: path prefix ${app.pathPrefix} does not name its own app`,
      );
    }
    for (const pattern of appleComponents(app)) {
      if (pattern !== pattern.toLowerCase()) {
        failures.push(
          `${app.identifier}: path pattern ${pattern} is not lower case; a caseSensitive:false component could otherwise merge two owners`,
        );
      }
      if (pattern.slice(0, -1).includes("*")) {
        failures.push(
          `${app.identifier}: path pattern ${pattern} has a non-terminal '*', where Apple's and Google's wildcards do not agree`,
        );
      }
    }

    // ---- tauri.conf.json -------------------------------------------------
    const tauri = read.json(app.directory, "src-tauri/tauri.conf.json");
    if (tauri.identifier !== app.identifier) {
      failures.push(
        `${label}/src-tauri/tauri.conf.json: identifier is ${tauri.identifier}, not ${app.identifier}`,
      );
    }
    if (tauri.bundle?.iOS?.developmentTeam !== APPLE_TEAM_ID) {
      failures.push(
        `${label}/src-tauri/tauri.conf.json: iOS development team is ${tauri.bundle?.iOS?.developmentTeam}, not ${APPLE_TEAM_ID}; the AASA appID prefix would name a team this app is not signed by`,
      );
    }
    const routes = tauri.plugins?.["deep-link"]?.mobile ?? [];
    const appLinkRoutes = routes.filter((route) => route?.appLink === true);
    if (appLinkRoutes.length !== 1) {
      failures.push(
        `${label}/src-tauri/tauri.conf.json: expected exactly one appLink route, found ${appLinkRoutes.length}`,
      );
    }
    for (const route of appLinkRoutes) {
      if (route.host !== host) {
        failures.push(
          `${label}/src-tauri/tauri.conf.json: appLink route claims ${route.host}, not ${host}`,
        );
      }
      if (
        !Array.isArray(route.scheme) ||
        route.scheme.length !== 1 ||
        route.scheme[0] !== "https"
      ) {
        failures.push(
          `${label}/src-tauri/tauri.conf.json: appLink route is not https-only`,
        );
      }
      if (
        !Array.isArray(route.pathPrefix) ||
        route.pathPrefix.length !== 1 ||
        route.pathPrefix[0] !== app.pathPrefix
      ) {
        failures.push(
          `${label}/src-tauri/tauri.conf.json: appLink route does not scope itself to ${app.pathPrefix}; the assetlinks relation is host-wide, so this prefix is the only thing keeping the three apps apart on Android`,
        );
      }
    }
    for (const route of routes) {
      if (route?.appLink === true) continue;
      if (route?.appLink !== false) {
        failures.push(
          `${label}/src-tauri/tauri.conf.json: a deep-link route does not state appLink; the plugin's default depends on the scheme`,
        );
      }
      if (Array.isArray(route?.scheme) && route.scheme.includes("https")) {
        failures.push(
          `${label}/src-tauri/tauri.conf.json: an https route declares appLink:false, which registers an unverified web link any app may also claim`,
        );
      }
    }

    // ---- the generated Android manifest ----------------------------------
    const manifest = read.text(
      app.directory,
      "src-tauri/gen/android/app/src/main/AndroidManifest.xml",
    );
    const verified = androidIntentFilters(manifest).filter(({ attributes }) =>
      attributes.includes('android:autoVerify="true"'),
    );
    if (verified.length !== 1) {
      failures.push(
        `${label}: generated AndroidManifest.xml has ${verified.length} autoVerify intent-filters, expected 1`,
      );
    }
    for (const { body } of verified) {
      for (const element of [
        '<data android:scheme="https" />',
        `<data android:host="${host}" />`,
        `<data android:pathPrefix="${app.pathPrefix}" />`,
      ]) {
        if (!body.includes(element)) {
          failures.push(
            `${label}: generated AndroidManifest.xml autoVerify filter is missing ${element}`,
          );
        }
      }
      for (const other of apps) {
        if (other.identifier === app.identifier) continue;
        if (body.includes(`android:pathPrefix="${other.pathPrefix}"`)) {
          failures.push(
            `${label}: generated AndroidManifest.xml claims ${other.identifier}'s bridge prefix; the OS would then choose arbitrarily between two apps for one URL`,
          );
        }
      }
    }

    // ---- the generated iOS entitlements ----------------------------------
    const entitlements = read.text(
      app.directory,
      `src-tauri/gen/apple/${app.directory}_iOS/${app.directory}_iOS.entitlements`,
    );
    const domains = plistStringArray(
      entitlements,
      "com\\.apple\\.developer\\.associated-domains",
    );
    if (domains === null) {
      failures.push(
        `${label}: generated iOS entitlements declare no com.apple.developer.associated-domains; without it iOS never fetches the AASA and every bridge link opens Safari`,
      );
    } else if (
      domains.length !== 1 ||
      domains[0] !== `applinks:${host}`
    ) {
      failures.push(
        `${label}: generated iOS entitlements claim ${JSON.stringify(domains)}, expected ["applinks:${host}"]`,
      );
    }

    // ---- store-identity.json --------------------------------------------
    if (app.storeIdentity) {
      const identity = read.json(app.directory, app.storeIdentity);
      if (identity.applicationId !== app.identifier) {
        failures.push(
          `${label}/${app.storeIdentity}: applicationId is ${identity.applicationId}, not ${app.identifier}`,
        );
      }
      if (identity.google?.appSigningCertificateSha256 !== fingerprint) {
        failures.push(
          `${label}/${app.storeIdentity}: google.appSigningCertificateSha256 disagrees with the reviewed association record`,
        );
      }
      if (identity.google?.uploadCertificateSha256 === fingerprint) {
        failures.push(
          `${label}/${app.storeIdentity}: records the same certificate as both upload and app signing; Play re-signs, so those are different keys`,
        );
      }
    }
  }

  // ---- no two apps may match the same URL --------------------------------
  for (let i = 0; i < apps.length; i += 1) {
    for (let j = i + 1; j < apps.length; j += 1) {
      for (const a of appleComponents(apps[i])) {
        for (const b of appleComponents(apps[j])) {
          if (patternsOverlap(a, b)) {
            failures.push(
              `${apps[i].identifier} (${a}) and ${apps[j].identifier} (${b}) can match the same URL; the OS would pick between them arbitrarily`,
            );
          }
        }
      }
    }
  }

  // ---- the committed association documents -------------------------------
  const documents = [
    ["docs/intent-bridge/association/assetlinks.json", renderAssetLinks(apps)],
    [
      "docs/intent-bridge/association/apple-app-site-association.json",
      renderAppleAppSiteAssociation(apps),
    ],
  ];
  for (const [relativePath, expected] of documents) {
    const committed = read.repo(relativePath);
    if (committed !== expected) {
      failures.push(
        `${relativePath} is not what the reviewed record renders; re-run \`node wallet/zuuli/scripts/app-link-association.mjs --print\` and commit the output`,
      );
    }
    // Deliberately NOT `else`. The fixed-point check above answers "did anyone
    // hand-edit this file", and these two answer "does the file say the thing
    // that matters" -- and a record edited to render the wrong bytes passes the
    // first while failing the second. Skipping them on a fixed-point failure
    // would make them unreachable in exactly the case they exist for.
    for (const app of apps) {
      if (!committed.includes(app.identifier)) {
        failures.push(`${relativePath} does not name ${app.identifier}`);
      }
    }
    for (const [forbidden, reason] of forbiddenFingerprints) {
      if (committed.includes(forbidden)) {
        failures.push(`${relativePath} carries a forbidden fingerprint. ${reason}`);
      }
    }
  }
  const aasa = read.repo(
    "docs/intent-bridge/association/apple-app-site-association.json",
  );
  for (const app of apps) {
    if (!aasa.includes(`${APPLE_TEAM_ID}.${app.identifier}`)) {
      failures.push(
        `docs/intent-bridge/association/apple-app-site-association.json does not name the App ID ${APPLE_TEAM_ID}.${app.identifier}`,
      );
    }
  }

  return failures;
}

export function defaultReader() {
  return {
    text: (directory, relativePath) =>
      readText("wallet", directory, relativePath),
    json: (directory, relativePath) =>
      readJson("wallet", directory, relativePath),
    repo: (relativePath) => readText(relativePath),
  };
}

export { WALLET_ROOT, REPO_ROOT };

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const printed = process.argv.find((argument) => argument.startsWith("--print"));
  if (printed) {
    const which = printed.includes("=") ? printed.split("=")[1] : "both";
    if (which === "assetlinks" || which === "both") process.stdout.write(renderAssetLinks());
    if (which === "aasa" || which === "both") process.stdout.write(renderAppleAppSiteAssociation());
    process.exit(0);
  }
  const failures = associationFailures();
  if (failures.length > 0) {
    console.error("App Link / Universal Link association check failed:\n");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(
    `App Link association is coherent for ${APPS.length} apps on ${ASSOCIATION_HOST}`,
  );
}
