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
        ...REVIEWED_MOBILE_F2ZMSG_PERMISSIONS,
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
          csp: "default-src 'self'; img-src 'self' blob:; connect-src 'self' https://free2z.cash https://*.free2z.cash; frame-src 'none'",
        },
      },
    },
  };
}

test("the reviewed native capability and frame boundary passes", () => {
  const { mobile, tauri } = fixture();
  assert.doesNotThrow(() => assertMobileWebviewAuthority(mobile, tauri));
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

test("messaging authority is exact, and the relay-trust downgrade stays out", () => {
  assert.ok(
    !REVIEWED_MOBILE_F2ZMSG_PERMISSIONS.includes("f2zmsg:allow-set-relay-trust"),
    "a store build must not let mobile opt in to a cleartext relay",
  );

  const widened = fixture();
  widened.mobile.permissions.push("f2zmsg:allow-set-relay-trust");
  assert.throws(
    () => assertMobileWebviewAuthority(widened.mobile, widened.tauri),
    /mobile messaging permissions differs/,
  );

  const missing = fixture();
  missing.mobile.permissions = missing.mobile.permissions.filter(
    (permission) => permission !== "f2zmsg:allow-send-message",
  );
  assert.throws(
    () => assertMobileWebviewAuthority(missing.mobile, missing.tauri),
    /mobile messaging permissions differs/,
  );

  // §2.2: enrollment is an app-crate command, so no capability grants it.
  const enrollment = fixture();
  enrollment.mobile.permissions.push("f2zmsg:allow-f2zmsg-enroll");
  assert.throws(
    () => assertMobileWebviewAuthority(enrollment.mobile, enrollment.tauri),
    /mobile messaging permissions differs/,
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

test("trusted image transport and local-only rendering stay compiler-bound", () => {
  const missingBlob = fixture();
  missingBlob.tauri.app.security.csp =
    "default-src 'self'; img-src 'self'; connect-src 'self' https://free2z.cash https://*.free2z.cash; frame-src 'none'";
  assert.throws(
    () => assertMobileWebviewAuthority(missingBlob.mobile, missingBlob.tauri),
    /validated local blob URLs/,
  );

  const missingSubdomains = fixture();
  missingSubdomains.tauri.app.security.csp =
    "default-src 'self'; img-src 'self' blob:; connect-src 'self' https://free2z.cash; frame-src 'none'";
  assert.throws(
    () =>
      assertMobileWebviewAuthority(
        missingSubdomains.mobile,
        missingSubdomains.tauri,
      ),
    /trusted Free2Z image transport/,
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

test("native trusted-image fetch cannot follow a redirect before validation", async () => {
  const remoteMedia = await readFile(
    new URL("../src/components/common/RemoteMedia.tsx", import.meta.url),
    "utf8",
  );

  assert.match(
    remoteMedia,
    /return mod\.fetch\(input, \{ \.\.\.init, maxRedirections: 0 \}\);/,
    "the Tauri HTTP transport must return every redirect for host revalidation",
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
