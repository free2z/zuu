import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assertMobileWebviewAuthority,
  REVIEWED_MOBILE_F2ZMSG_PERMISSIONS,
  REVIEWED_MOBILE_ZCASH_PERMISSIONS,
} from "./mobile-webview-authority.mjs";

function fixture() {
  return {
    mobile: {
      platforms: ["iOS", "android"],
      windows: ["main"],
      permissions: [
        "core:default",
        "deep-link:default",
        "opener:default",
        ...REVIEWED_MOBILE_ZCASH_PERMISSIONS,
        {
          identifier: "http:default",
          allow: [
            { url: "https://free2z.cash/*" },
            { url: "https://*.free2z.cash/*" },
            { url: "https://stage.free2z.cash/*" },
          ],
        },
      ],
    },
    tauri: {
      app: {
        security: {
          csp: "default-src 'self'; img-src 'self' data:; connect-src 'self' https://free2z.cash https://*.free2z.cash; frame-src 'none'",
        },
      },
    },
  };
}

test("the reviewed native capability and frame boundary passes", () => {
  const { mobile, tauri } = fixture();
  assert.doesNotThrow(() => assertMobileWebviewAuthority(mobile, tauri));
});

/**
 * #916. The messaging permissions used to be an exact 42-entry allowlist here.
 * ZUULI has no messaging frontend after #904, so the contract inverted: any
 * `f2zmsg:` grant on the seed-holding WebView now fails, named or blanket.
 * `REVIEWED_MOBILE_F2ZMSG_PERMISSIONS` still exists as `wallet/e2e2z`'s
 * contract, which is exactly the population this must refuse.
 */
test("no named messaging permission may return to ZUULI's mobile main", () => {
  for (const permission of REVIEWED_MOBILE_F2ZMSG_PERMISSIONS) {
    const { mobile, tauri } = fixture();
    mobile.permissions.push(permission);
    assert.throws(
      () => assertMobileWebviewAuthority(mobile, tauri),
      /must grant no messaging permission it cannot use/,
      permission,
    );
  }
  assert.ok(
    REVIEWED_MOBILE_F2ZMSG_PERMISSIONS.length > 40,
    "the refused population must be the real one, not an empty list",
  );
});

test("zcash:default cannot return to privileged mobile main", () => {
  const { mobile, tauri } = fixture();
  mobile.permissions.push("zcash:default");
  assert.throws(
    () => assertMobileWebviewAuthority(mobile, tauri),
    /must not receive zcash:default/,
  );
});

test("f2zmsg:default cannot return to privileged mobile main", () => {
  const { mobile, tauri } = fixture();
  mobile.permissions.push("f2zmsg:default");
  assert.throws(
    () => assertMobileWebviewAuthority(mobile, tauri),
    /must not receive f2zmsg:default/,
  );
});

test("the relay-trust downgrade stays out of the delegated contract too", () => {
  // Still true and still worth pinning: `REVIEWED_MOBILE_F2ZMSG_PERMISSIONS`
  // is now `wallet/e2e2z`'s allowlist, and a store build there must not let
  // mobile opt in to a cleartext relay.
  assert.ok(
    !REVIEWED_MOBILE_F2ZMSG_PERMISSIONS.includes("f2zmsg:allow-set-relay-trust"),
    "a store build must not let mobile opt in to a cleartext relay",
  );

  const widened = fixture();
  widened.mobile.permissions.push("f2zmsg:allow-set-relay-trust");
  assert.throws(
    () => assertMobileWebviewAuthority(widened.mobile, widened.tauri),
    /must grant no messaging permission it cannot use/,
  );

  // §2.2: enrollment is an app-crate command, so no capability grants it.
  const enrollment = fixture();
  enrollment.mobile.permissions.push("f2zmsg:allow-f2zmsg-enroll");
  assert.throws(
    () => assertMobileWebviewAuthority(enrollment.mobile, enrollment.tauri),
    /must grant no messaging permission it cannot use/,
  );
});

test("unreviewed named wallet authority and widened windows fail closed", () => {
  const extra = fixture();
  extra.mobile.permissions.push("zcash:allow-get-spending-key");
  assert.throws(
    () => assertMobileWebviewAuthority(extra.mobile, extra.tauri),
    /mobile Zcash permissions differs/,
  );

  const missing = fixture();
  missing.mobile.permissions = missing.mobile.permissions.filter(
    (permission) => permission !== REVIEWED_MOBILE_ZCASH_PERMISSIONS[0],
  );
  assert.throws(
    () => assertMobileWebviewAuthority(missing.mobile, missing.tauri),
    /mobile Zcash permissions differs/,
  );

  const widened = fixture();
  widened.mobile.windows.push("*");
  assert.throws(
    () => assertMobileWebviewAuthority(widened.mobile, widened.tauri),
    /mobile capability windows differs/,
  );
});

for (const requiredIdentityPermission of [
  "zcash:allow-list-wallets",
  "zcash:allow-switch-wallet",
]) {
  test(`${requiredIdentityPermission} is required by the mobile wallet identity bridge`, () => {
    const missing = fixture();
    missing.mobile.permissions = missing.mobile.permissions.filter(
      (permission) => permission !== requiredIdentityPermission,
    );
    assert.throws(
      () => assertMobileWebviewAuthority(missing.mobile, missing.tauri),
      /mobile Zcash permissions differs/,
    );
  });
}

test("legacy preview authority is exact and cannot be dropped or widened", () => {
  const missing = fixture();
  missing.mobile.permissions = missing.mobile.permissions.filter(
    (permission) => permission !== "zcash:allow-preview-legacy-wallet-import",
  );
  assert.throws(
    () => assertMobileWebviewAuthority(missing.mobile, missing.tauri),
    /mobile Zcash permissions differs/,
  );

  const widened = fixture();
  widened.mobile.permissions.push("zcash:allow-import-legacy-wallet");
  assert.throws(
    () => assertMobileWebviewAuthority(widened.mobile, widened.tauri),
    /mobile Zcash permissions differs/,
  );
});

test("remote, wildcard, and implicit frame policies fail closed", () => {
  for (const csp of [
    "default-src 'self'; frame-src https://www.youtube-nocookie.com",
    "default-src 'self'; frame-src https:",
    "default-src 'self'",
  ]) {
    const { mobile, tauri } = fixture();
    tauri.app.security.csp = csp;
    assert.throws(
      () => assertMobileWebviewAuthority(mobile, tauri),
      /frame-src 'none'/,
    );
  }
});

test("image and connect authority stay exact rather than merely present", () => {
  // #904 phase 4: the mobile WebView must load no remote image and reach no
  // origin but the free2z API. A *widened* directive is the regression that
  // matters, so both are exact-match rather than "contains".
  const widenedImages = fixture();
  widenedImages.tauri.app.security.csp =
    "default-src 'self'; img-src 'self' data: https:; connect-src 'self' https://free2z.cash https://*.free2z.cash; frame-src 'none'";
  assert.throws(
    () =>
      assertMobileWebviewAuthority(widenedImages.mobile, widenedImages.tauri),
    /only bundled and inlined images/,
  );

  const blobImages = fixture();
  blobImages.tauri.app.security.csp =
    "default-src 'self'; img-src 'self' data: blob:; connect-src 'self' https://free2z.cash https://*.free2z.cash; frame-src 'none'";
  assert.throws(
    () => assertMobileWebviewAuthority(blobImages.mobile, blobImages.tauri),
    /only bundled and inlined images/,
  );

  const missingSubdomains = fixture();
  missingSubdomains.tauri.app.security.csp =
    "default-src 'self'; img-src 'self' data:; connect-src 'self' https://free2z.cash; frame-src 'none'";
  assert.throws(
    () =>
      assertMobileWebviewAuthority(
        missingSubdomains.mobile,
        missingSubdomains.tauri,
      ),
    /only the free2z API origins/,
  );

  const widenedConnect = fixture();
  widenedConnect.tauri.app.security.csp =
    "default-src 'self'; img-src 'self' data:; connect-src 'self' https://free2z.cash https://*.free2z.cash https://*.dyte.io; frame-src 'none'";
  assert.throws(
    () =>
      assertMobileWebviewAuthority(widenedConnect.mobile, widenedConnect.tauri),
    /only the free2z API origins/,
  );

  const widenedHttp = fixture();
  const http = widenedHttp.mobile.permissions.find(
    (permission) => typeof permission === "object",
  );
  http.allow.push({ url: "https://*.example.com/*" });
  assert.throws(
    () => assertMobileWebviewAuthority(widenedHttp.mobile, widenedHttp.tauri),
    /mobile HTTP URLs differs/,
  );
});

test("the committed mobile capability and packaged CSP satisfy the contract", async () => {
  const [mobile, tauri] = await Promise.all([
    readFile(
      new URL("../src-tauri/capabilities/mobile.json", import.meta.url),
      "utf8",
    ).then(JSON.parse),
    readFile(
      new URL("../src-tauri/tauri.conf.json", import.meta.url),
      "utf8",
    ).then(JSON.parse),
  ]);
  assert.doesNotThrow(() => assertMobileWebviewAuthority(mobile, tauri));
});
