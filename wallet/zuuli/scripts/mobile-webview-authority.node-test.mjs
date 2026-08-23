import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assertMobileWebviewAuthority,
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
            { url: "https://stage.free2z.cash/*" },
          ],
        },
      ],
    },
    tauri: { app: { security: { csp: "default-src 'self'; frame-src 'none'" } } },
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
