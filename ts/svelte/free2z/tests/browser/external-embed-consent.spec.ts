import { expect, test } from "@playwright/test";

import { PRIVACY_STORE_LOADER } from "./dev-source-module";

test("persistent embed consent synchronizes through native cross-tab storage events", async ({
  context,
}) => {
  const tabA = await context.newPage();
  const tabB = await context.newPage();
  await Promise.all([tabA.goto("/"), tabB.goto("/")]);

  await tabA.evaluate(async (loader) => {
    const { privacyStore } = await new Function(loader)();
    privacyStore.trustDomain("video.example");
    privacyStore.enableGlobalConsent();
  }, PRIVACY_STORE_LOADER);

  await expect
    .poll(() =>
      tabB.evaluate(async (loader) => {
        const { privacyStore } = await new Function(loader)();
        return {
          domains: privacyStore.getTrustedDomains(),
          global: privacyStore.hasGlobalConsent(),
        };
      }, PRIVACY_STORE_LOADER),
    )
    .toEqual({ domains: ["video.example"], global: true });

  await tabA.evaluate(async (loader) => {
    const { privacyStore } = await new Function(loader)();
    privacyStore.revokeDomain("video.example");
    privacyStore.disableGlobalConsent();
  }, PRIVACY_STORE_LOADER);

  await expect
    .poll(() =>
      tabB.evaluate(async (loader) => {
        const { privacyStore } = await new Function(loader)();
        return {
          domains: privacyStore.getTrustedDomains(),
          global: privacyStore.hasGlobalConsent(),
        };
      }, PRIVACY_STORE_LOADER),
    )
    .toEqual({ domains: [], global: false });
});

test("a pre-upgrade tab can revoke a current-version per-domain grant", async ({
  context,
}) => {
  const currentTab = await context.newPage();
  const legacyTab = await context.newPage();
  await Promise.all([currentTab.goto("/"), legacyTab.goto("/")]);

  await currentTab.evaluate(async (loader) => {
    const { privacyStore } = await new Function(loader)();
    // The app normally starts this listener from the root layout's onMount.
    // The test drives the source singleton directly, so register the same
    // production sync lifecycle before the legacy tab mutates storage. This
    // removes the load-vs-hydration race while keeping the real storage-event
    // path under test.
    privacyStore.startStorageSync();
    privacyStore.trustDomain("video.example");
  }, PRIVACY_STORE_LOADER);

  await expect
    .poll(() =>
      legacyTab.evaluate(() =>
        localStorage.getItem("trustedEmbedDomain:video.example"),
      ),
    )
    .toBe("true");

  // This is the complete revoke operation used by the pre-upgrade store.
  await legacyTab.evaluate(() => {
    localStorage.setItem("trustedEmbedDomains", "[]");
  });

  await expect
    .poll(() =>
      currentTab.evaluate(async (loader) => {
        const { privacyStore } = await new Function(loader)();
        return privacyStore.canLoadUrl("https://video.example/embed");
      }, PRIVACY_STORE_LOADER),
    )
    .toBe(false);

  await currentTab.reload();
  await expect
    .poll(() =>
      currentTab.evaluate(async (loader) => {
        const { privacyStore } = await new Function(loader)();
        return privacyStore.canLoadUrl("https://video.example/embed");
      }, PRIVACY_STORE_LOADER),
    )
    .toBe(false);
});

test("BroadcastChannel synchronizes revocations when storage does not mutate", async ({
  context,
}) => {
  const tabA = await context.newPage();
  const tabB = await context.newPage();
  await Promise.all([tabA.goto("/"), tabB.goto("/")]);

  await tabA.evaluate(async (loader) => {
    const { privacyStore } = await new Function(loader)();
    privacyStore.startStorageSync();
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "globalEmbedConsent") {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      }
      return originalSetItem.call(this, key, value);
    };
    try {
      privacyStore.enableGlobalConsent();
    } finally {
      Storage.prototype.setItem = originalSetItem;
    }
  }, PRIVACY_STORE_LOADER);

  await tabB.evaluate(async (loader) => {
    const { privacyStore } = await new Function(loader)();
    privacyStore.startStorageSync();
    privacyStore.disableGlobalConsent();
  }, PRIVACY_STORE_LOADER);

  await expect
    .poll(() =>
      tabA.evaluate(async (loader) => {
        const { privacyStore } = await new Function(loader)();
        return privacyStore.hasGlobalConsent();
      }, PRIVACY_STORE_LOADER),
    )
    .toBe(false);

  await tabA.evaluate(async (loader) => {
    localStorage.setItem("clearedEmbedDomains", "[]");
    const { privacyStore } = await new Function(loader)();
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (
        key === "trustedEmbedDomains" ||
        key.startsWith("trustedEmbedDomain:")
      ) {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      }
      return originalSetItem.call(this, key, value);
    };
    try {
      privacyStore.trustDomain("memory-only.example");
    } finally {
      Storage.prototype.setItem = originalSetItem;
    }
  }, PRIVACY_STORE_LOADER);

  await tabB.evaluate(async (loader) => {
    const { privacyStore } = await new Function(loader)();
    privacyStore.clearAll();
  }, PRIVACY_STORE_LOADER);

  await expect
    .poll(() =>
      tabA.evaluate(async (loader) => {
        const { privacyStore } = await new Function(loader)();
        return privacyStore.canLoadUrl("https://memory-only.example/embed");
      }, PRIVACY_STORE_LOADER),
    )
    .toBe(false);
});
