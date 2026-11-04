import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import {
  ASSET_RECOVERY_MAX_AGE_MS,
  ASSET_RECOVERY_STORAGE_KEY,
  claimAssetRecovery,
  clearExpiredAssetRecovery,
  isSvelteKitAssetErrorMessage,
  isSvelteKitAssetUrl,
} from "../src/lib/client/asset-recovery.js";

function storage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, String(value)),
  };
}

function inlineRecoveryHarness(state = storage()) {
  const appHtml = readFileSync(
    new URL("../src/app.html", import.meta.url),
    "utf8",
  );
  // `[^>]*` so the tag can carry attributes. It grew
  // `nonce="%sveltekit.nonce%"` in, and an anchored `>` silently turned
  // all four of these tests into "app.html must contain the inline recovery
  // listener" — a failure that names the wrong thing entirely.
  const script = appHtml.match(
    /<script data-f2z-asset-recovery[^>]*>([\s\S]*?)<\/script>/,
  );
  assert.ok(script, "app.html must contain the inline recovery listener");

  const listeners = new Map();
  let reloads = 0;
  const window = {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    location: {
      href: "https://free2z.cash/free2z?tag=latest",
      reload() {
        reloads += 1;
      },
    },
    sessionStorage: state,
  };

  vm.runInNewContext(script[1], { URL, window });
  return {
    appHtml,
    dispatchError(target) {
      listeners.get("error")?.({ target });
    },
    reloads: () => reloads,
  };
}

test("only SvelteKit versioned asset paths are eligible for recovery", () => {
  assert.equal(isSvelteKitAssetUrl("/_app/immutable/chunks/app.js"), true);
  assert.equal(isSvelteKitAssetUrl("/_app/version.json"), true);
  assert.equal(isSvelteKitAssetUrl("/static/js/main.js"), false);
  assert.equal(isSvelteKitAssetUrl("https://cdn.example/app.js"), false);
});

test("chunk failure messages are narrow enough to avoid generic reloads", () => {
  assert.equal(
    isSvelteKitAssetErrorMessage("Failed to fetch dynamically imported module"),
    true,
  );
  assert.equal(
    isSvelteKitAssetErrorMessage("ChunkLoadError: loading CSS failed"),
    true,
  );
  assert.equal(isSvelteKitAssetErrorMessage("API request failed"), false);
});

test("the same page can claim only one reload during the guard window", () => {
  const state = storage();
  const url = "https://free2z.cash/free2z?tag=latest";

  assert.equal(claimAssetRecovery(state, url, 1000), true);
  assert.equal(claimAssetRecovery(state, url, 1100), false);
  assert.equal(
    state.getItem(ASSET_RECOVERY_STORAGE_KEY),
    JSON.stringify({ timestamp: 1000, url }),
  );
  assert.equal(
    claimAssetRecovery(state, url, 1000 + ASSET_RECOVERY_MAX_AGE_MS + 1),
    true,
  );
});

test("expired recovery markers are discarded", () => {
  const state = storage();
  const url = "https://free2z.cash/free2z";
  claimAssetRecovery(state, url, 1000);

  clearExpiredAssetRecovery(state, 1000 + ASSET_RECOVERY_MAX_AGE_MS + 1);
  assert.equal(state.getItem(ASSET_RECOVERY_STORAGE_KEY), null);
});

test("inline recovery is installed before SvelteKit bootstrap", () => {
  const { appHtml } = inlineRecoveryHarness();
  const listener = appHtml.indexOf("data-f2z-asset-recovery");

  assert.ok(listener < appHtml.indexOf("%sveltekit.head%"));
  assert.ok(listener < appHtml.indexOf("%sveltekit.body%"));
});

test("inline recovery reloads an initial asset failure only once", () => {
  const state = storage();
  const firstDocument = inlineRecoveryHarness(state);

  firstDocument.dispatchError({
    tagName: "SCRIPT",
    src: "https://free2z.cash/_app/immutable/entry/start.js",
  });
  firstDocument.dispatchError({
    href: "https://free2z.cash/_app/immutable/assets/app.css",
    tagName: "LINK",
  });
  assert.equal(firstDocument.reloads(), 1);

  const reloadedDocument = inlineRecoveryHarness(state);
  reloadedDocument.dispatchError({
    tagName: "SCRIPT",
    src: "https://free2z.cash/_app/immutable/entry/start.js",
  });
  assert.equal(reloadedDocument.reloads(), 0);
});

test("inline recovery ignores failures outside SvelteKit immutable assets", () => {
  const document = inlineRecoveryHarness();

  document.dispatchError({
    tagName: "SCRIPT",
    src: "https://free2z.cash/static/js/main.js",
  });
  document.dispatchError({ tagName: "IMG", src: "/_app/immutable/logo.png" });
  assert.equal(document.reloads(), 0);
});

test("inline recovery removes a corrupt marker instead of disabling itself", () => {
  const state = storage();
  state.setItem(ASSET_RECOVERY_STORAGE_KEY, "not-json");
  const document = inlineRecoveryHarness(state);

  document.dispatchError({
    tagName: "SCRIPT",
    src: "https://free2z.cash/_app/immutable/entry/start.js",
  });
  assert.equal(document.reloads(), 1);
});
