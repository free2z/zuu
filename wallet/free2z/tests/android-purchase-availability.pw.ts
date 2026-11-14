import { expect, test } from "@playwright/test";

const notice = {
  en: "Digital purchases are unavailable in this Android app.",
  es: "Las compras digitales no están disponibles en esta aplicación de Android.",
  fr: "Les achats numériques ne sont pas disponibles dans cette application Android.",
};

for (const locale of ["en", "es", "fr"] as const) {
  test(`Android direct purchase routes and login continuations are unavailable (${locale})`, async ({ page }) => {
    await page.addInitScript((language) => {
      Object.defineProperty(window, "__FREE2Z_ANDROID_PURCHASES_UNAVAILABLE__", { value: true });
      localStorage.setItem("free2z-locale", language);
      localStorage.setItem("zuuli.knox.token", "mock-knox-token");
      sessionStorage.setItem("zuuli.auth.pending-paid-intent", JSON.stringify({
        returnTo: "/ai", createdAt: Date.now(), intent: { kind: "ai", draft: "stale purchase draft" },
      }));
    }, locale);
    for (const path of ["/fund?success=true&session_id=stale", "/ai", "/creator/mining_maya", "/live/mining_maya", "/articles/why-shielded-by-default"]) {
      await page.goto(path);
      await expect(page.locator("[data-purchase-unavailable]").first()).toHaveText(notice[locale], { timeout: 15_000 });
      await expect(page.getByRole("button", { name: "Sign in to send message" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /Subscribe to .*2Z/ })).toHaveCount(0);
      await expect(page.getByRole("link", { name: /buy.*2Z/i })).toHaveCount(0);
      expect(await page.evaluate(() => sessionStorage.getItem("zuuli.auth.pending-paid-intent"))).toBeNull();
    }
  });
}

test("Android creator ZEC tips remain distinct from unavailable 2Z spending", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "__FREE2Z_ANDROID_PURCHASES_UNAVAILABLE__", { value: true });
    localStorage.setItem("zuuli.knox.token", "mock-knox-token");
  });
  await page.goto("/creator/mining_maya");
  await page.getByRole("button", { name: /tip/i }).first().click();
  await expect(page.locator("[data-purchase-unavailable]").last()).toBeVisible();
  await page.getByRole("button", { name: "ZEC Zcash wallet", exact: true }).click();
  await expect(page.getByRole("button", { name: "Continue with ZEC" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send tip" })).toHaveCount(0);
});

test("Android preserves existing membership cancellation while withholding renewal", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "__FREE2Z_ANDROID_PURCHASES_UNAVAILABLE__", { value: true });
    localStorage.setItem("zuuli.knox.token", "mock-knox-token");
  });
  await page.goto("/creator/mining_maya");
  await page.getByRole("button", { name: /Manage your .* membership/ }).click();
  await page.getByRole("button", { name: /Turn off auto-renew for your .* membership/ }).click();
  await expect(page.getByText("Auto-renew is off — you'll keep access until it expires.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Resume auto-renew/ })).toHaveCount(0);
  await expect(page.getByRole("dialog").locator("[data-purchase-unavailable]")).toBeVisible();
});
