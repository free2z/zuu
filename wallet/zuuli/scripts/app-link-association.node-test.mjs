import assert from "node:assert/strict";
import test from "node:test";

import {
  APPLE_TEAM_ID,
  APPS,
  ASSOCIATION_HOST,
  FORBIDDEN_FINGERPRINTS,
  associationFailures,
  defaultReader,
  renderAppleAppSiteAssociation,
  renderAssetLinks,
} from "./app-link-association.mjs";

// Every failure this file asserts is one the platform reports as SILENCE: on
// Android a wrong document is cached as a negative verification result, and on
// iOS the link simply opens Safari. Nothing throws and nothing logs, so a
// mutation test is the only evidence these checks are not inert. Each control
// below therefore both proves the committed tree passes AND proves a specific
// corruption is rejected -- a check that cannot fail is a check that is not
// there.

/// A reader over the real tree that lets one file be replaced. Reading the real
/// bytes is the point: a fixture-only test passes while the shipped manifest
/// says something else.
function readerWith(overrides = {}) {
  const real = defaultReader();
  const key = (directory, relativePath) => `${directory}/${relativePath}`;
  return {
    text: (directory, relativePath) => {
      const override = overrides[key(directory, relativePath)];
      if (typeof override === "function")
        return override(real.text(directory, relativePath));
      return real.text(directory, relativePath);
    },
    json: (directory, relativePath) => {
      const override = overrides[key(directory, relativePath)];
      if (typeof override === "function")
        return override(real.json(directory, relativePath));
      return real.json(directory, relativePath);
    },
    repo: (relativePath) => {
      const override = overrides[relativePath];
      if (typeof override === "function") return override(real.repo(relativePath));
      return real.repo(relativePath);
    },
  };
}

const failuresMatching = (failures, needle) =>
  failures.filter((failure) => failure.includes(needle));

function assertRejects(options, needle, what) {
  const failures = associationFailures(options);
  assert.ok(
    failuresMatching(failures, needle).length > 0,
    `${what}: expected a failure mentioning ${JSON.stringify(needle)}, got ${JSON.stringify(failures)}`,
  );
}

test("the committed tree is coherent", () => {
  assert.deepEqual(associationFailures(), []);
});

// ---------------------------------------------------------------------------
// The two checks #461 names explicitly, because both guard a silent failure.
// ---------------------------------------------------------------------------

test("no shipped fingerprint is the upload certificate", () => {
  // The live property, stated directly rather than only through the guard: the
  // reviewed record must not contain any forbidden certificate.
  for (const app of APPS) {
    assert.equal(
      FORBIDDEN_FINGERPRINTS.has(app.appSigningCertificateSha256),
      false,
      `${app.identifier} records a certificate that must never be published`,
    );
  }
  // And the committed document must not carry one either, however it got there.
  const rendered = renderAssetLinks();
  for (const forbidden of FORBIDDEN_FINGERPRINTS.keys()) {
    assert.equal(rendered.includes(forbidden), false);
  }
});

test("the upload certificate in assetlinks.json is rejected", () => {
  const [uploadCertificate] = [...FORBIDDEN_FINGERPRINTS.keys()];
  const apps = APPS.map((app, index) =>
    index === 0
      ? { ...app, appSigningCertificateSha256: uploadCertificate }
      : app,
  );
  assertRejects(
    { apps },
    "must never appear in an association document",
    "an upload certificate in the reviewed record",
  );
  // The forbidden value reaches the rendered document too, and the document
  // check has to catch it independently of the record check -- they are the two
  // places a bad paste can land.
  assert.ok(renderAssetLinks(apps).includes(uploadCertificate));
});

test("every shipped package and bundle id appears in both documents", () => {
  const assetlinks = defaultReader().repo(
    "docs/intent-bridge/association/assetlinks.json",
  );
  const aasa = defaultReader().repo(
    "docs/intent-bridge/association/apple-app-site-association.json",
  );
  for (const app of APPS) {
    assert.ok(
      JSON.parse(assetlinks).some(
        (statement) => statement.target.package_name === app.identifier,
      ),
      `assetlinks.json omits ${app.identifier}`,
    );
    assert.ok(
      JSON.parse(aasa).applinks.details.some((detail) =>
        detail.appIDs.includes(`${APPLE_TEAM_ID}.${app.identifier}`),
      ),
      `apple-app-site-association omits ${APPLE_TEAM_ID}.${app.identifier}`,
    );
  }
  // Every app the repo ships is in the record. A fourth Tauri app added without
  // an association row would otherwise pass every check above by not existing
  // in it -- which is exactly how an app ships claiming a host nothing
  // authorises.
  assert.deepEqual(
    APPS.map((app) => app.identifier).sort(),
    ["cash.free2z.e2e2z", "cash.free2z.free2z", "cash.free2z.zuuli"],
  );
});

test("a package missing from a document is rejected", () => {
  const options = {
    read: readerWith({
      "docs/intent-bridge/association/assetlinks.json": (contents) =>
        JSON.stringify(
          JSON.parse(contents).filter(
            (statement) => statement.target.package_name !== "cash.free2z.e2e2z",
          ),
          null,
          2,
        ) + "\n",
    }),
  };
  // Both halves fire, and they are independent questions: the first is "did
  // someone hand-edit this file", the second is "does it still name every app
  // we ship". A record edited to render the wrong bytes passes the first.
  assertRejects(
    options,
    "is not what the reviewed record renders",
    "an assetlinks document that drops an app",
  );
  assertRejects(
    options,
    "does not name cash.free2z.e2e2z",
    "an assetlinks document that drops an app",
  );
});

test("an App ID missing from the Apple document is rejected", () => {
  assertRejects(
    {
      read: readerWith({
        "docs/intent-bridge/association/apple-app-site-association.json": (
          contents,
        ) => contents.replace(`${APPLE_TEAM_ID}.cash.free2z.free2z`, "OTHERTEAM.cash.free2z.free2z"),
      }),
    },
    `does not name the App ID ${APPLE_TEAM_ID}.cash.free2z.free2z`,
    "an Apple document whose App ID moved to another team",
  );
});

// ---------------------------------------------------------------------------
// The client half. Each of these is a way the four surfaces can disagree.
// ---------------------------------------------------------------------------

test("an app that does not claim the host is rejected", () => {
  assertRejects(
    {
      read: readerWith({
        "e2e2z/src-tauri/gen/apple/e2e2z_iOS/e2e2z_iOS.entitlements": () =>
          '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict/>\n</plist>\n',
      }),
    },
    "declare no com.apple.developer.associated-domains",
    "an app whose entitlements lost the associated domain",
  );
});

test("an entitlement naming a different host is rejected", () => {
  assertRejects(
    {
      read: readerWith({
        "zuuli/src-tauri/gen/apple/zuuli_iOS/zuuli_iOS.entitlements": (contents) =>
          contents.replace(
            `applinks:${ASSOCIATION_HOST}`,
            "applinks:free2z.cash",
          ),
      }),
    },
    "generated iOS entitlements claim",
    "an entitlement that claims the unserved host",
  );
});

test("an Android filter without autoVerify is rejected", () => {
  assertRejects(
    {
      read: readerWith({
        "free2z/src-tauri/gen/android/app/src/main/AndroidManifest.xml": (contents) =>
          contents.replace(' android:autoVerify="true"', ""),
      }),
    },
    "autoVerify intent-filters, expected 1",
    "a manifest whose https filter stopped asking for verification",
  );
});

test("an Android filter that drops its path prefix is rejected", () => {
  assertRejects(
    {
      read: readerWith({
        "e2e2z/src-tauri/gen/android/app/src/main/AndroidManifest.xml": (contents) =>
          contents.replace(
            '<data android:pathPrefix="/bridge/e2e2z/" />',
            "",
          ),
      }),
    },
    "is missing <data android:pathPrefix",
    "a host-wide Android filter",
  );
});

test("an app claiming another app's bridge prefix is rejected", () => {
  assertRejects(
    {
      read: readerWith({
        "e2e2z/src-tauri/gen/android/app/src/main/AndroidManifest.xml": (contents) =>
          contents.replace(
            '<data android:pathPrefix="/bridge/e2e2z/" />',
            '<data android:pathPrefix="/bridge/e2e2z/" />\n                <data android:pathPrefix="/bridge/zuuli/" />',
          ),
      }),
    },
    "bridge prefix",
    "a manifest that also claims the wallet's request prefix",
  );
});

test("a deep-link route that stops claiming an app link is rejected", () => {
  assertRejects(
    {
      read: readerWith({
        "zuuli/src-tauri/tauri.conf.json": (config) => ({
          ...config,
          plugins: {
            ...config.plugins,
            "deep-link": {
              mobile: config.plugins["deep-link"].mobile.map((route) =>
                route.appLink === true ? { ...route, appLink: false } : route,
              ),
            },
          },
        }),
      }),
    },
    "expected exactly one appLink route",
    "a config that downgraded the app link to an unverified web link",
  );
});

test("an https route declaring appLink:false is rejected", () => {
  assertRejects(
    {
      read: readerWith({
        "free2z/src-tauri/tauri.conf.json": (config) => ({
          ...config,
          plugins: {
            ...config.plugins,
            "deep-link": {
              mobile: [
                ...config.plugins["deep-link"].mobile,
                {
                  scheme: ["https"],
                  host: ASSOCIATION_HOST,
                  path: ["/anything"],
                  appLink: false,
                },
              ],
            },
          },
        }),
      }),
    },
    "registers an unverified web link",
    "an unverified https route beside the verified one",
  );
});

test("a widened app-link route is rejected", () => {
  assertRejects(
    {
      read: readerWith({
        "free2z/src-tauri/tauri.conf.json": (config) => ({
          ...config,
          plugins: {
            ...config.plugins,
            "deep-link": {
              mobile: config.plugins["deep-link"].mobile.map((route) =>
                route.appLink === true
                  ? { ...route, pathPrefix: ["/bridge/"] }
                  : route,
              ),
            },
          },
        }),
      }),
    },
    "does not scope itself to",
    "an app link that claims the whole bridge namespace",
  );
});

test("a store identity that disagrees with the record is rejected", () => {
  assertRejects(
    {
      read: readerWith({
        "free2z/store-identity.json": (identity) => ({
          ...identity,
          google: { ...identity.google, appSigningCertificateSha256: null },
        }),
      }),
    },
    "disagrees with the reviewed association record",
    "a store identity that lost its app signing certificate",
  );
});

test("a bundle signed by another team is rejected", () => {
  assertRejects(
    {
      read: readerWith({
        "e2e2z/src-tauri/tauri.conf.json": (config) => ({
          ...config,
          bundle: {
            ...config.bundle,
            iOS: { ...config.bundle.iOS, developmentTeam: "AAAAAAAAAA" },
          },
        }),
      }),
    },
    "the AASA appID prefix would name a team this app is not signed by",
    "an app signed by a team the AASA does not name",
  );
});

// ---------------------------------------------------------------------------
// Properties of the record itself.
// ---------------------------------------------------------------------------

test("two apps sharing one signing certificate is rejected", () => {
  const apps = APPS.map((app, index) =>
    index === 1
      ? {
          ...app,
          appSigningCertificateSha256: APPS[0].appSigningCertificateSha256,
        }
      : app,
  );
  assertRejects({ apps }, "app signing fingerprint", "a reused Play key");
});

test("overlapping path patterns are rejected", () => {
  const apps = APPS.map((app) =>
    app.directory === "e2e2z"
      ? { ...app, extraAppleComponents: ["/bridge/*"] }
      : app,
  );
  assertRejects(
    { apps },
    "can match the same URL",
    "a component that swallows another app's prefix",
  );
});

test("a non-terminal wildcard is rejected", () => {
  const apps = APPS.map((app) =>
    app.directory === "free2z"
      ? { ...app, extraAppleComponents: ["/bridge/*/callback"] }
      : app,
  );
  assertRejects(
    { apps },
    "non-terminal '*'",
    "a pattern where Apple's and Google's wildcards disagree",
  );
});

test("a lower-cased path pattern is required", () => {
  const apps = APPS.map((app) =>
    app.directory === "free2z"
      ? { ...app, extraAppleComponents: ["/Bridge/Free2z/"] }
      : app,
  );
  assertRejects({ apps }, "is not lower case", "a mixed-case component");
});

test("a malformed fingerprint is rejected", () => {
  const apps = APPS.map((app, index) =>
    index === 0
      ? {
          ...app,
          appSigningCertificateSha256:
            "b4:3b:d4:24:64:10:47:6e:21:12:d9:ba:d5:7e:aa:7e:ff:ad:46:18:a6:16:66:4c:a9:3f:8e:2e:f6:0d:1a:62",
        }
      : app,
  );
  assertRejects(
    { apps },
    "not an uppercase colon-delimited SHA-256",
    "a lower-cased fingerprint",
  );
});

test("the rendered Apple document is the shape Apple parses", () => {
  const document = JSON.parse(renderAppleAppSiteAssociation());
  assert.deepEqual(Object.keys(document), ["applinks"]);
  for (const detail of document.applinks.details) {
    assert.equal(detail.appIDs.length, 1);
    assert.ok(detail.components.length > 0);
    for (const component of detail.components) {
      assert.deepEqual(Object.keys(component), ["/"]);
    }
  }
});

test("the rendered Android document scopes every package", () => {
  const relation = "delegate_permission/common.handle_all_urls";
  for (const statement of JSON.parse(renderAssetLinks())) {
    assert.deepEqual(statement.relation, [relation]);
    assert.equal(statement.target.namespace, "android_app");
    assert.equal(statement.target.sha256_cert_fingerprints.length, 1);
    // A package with no dynamic rule stays host-wide on Android 15+, which is
    // the opposite of what the path scheme is for.
    assert.ok(
      statement.relation_extensions[relation].dynamic_app_link_components
        .length > 0,
    );
  }
});
