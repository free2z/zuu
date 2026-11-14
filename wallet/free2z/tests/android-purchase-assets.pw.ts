import { expect, test } from "@playwright/test";

// Run against a production build (not Vite dev, no simulated native flag).
// This proves frontend target binding only, not a packaged/signed Android app.
test("Android production assets refuse purchase routes without native injection", async ({ page }) => {
  test.skip(process.env.FREE2Z_PW_ANDROID_ASSETS !== "1", "requires Android-target production assets");
  await page.route("**/api/**", (route) => route.abort());
  await page.addInitScript(() => { localStorage.clear(); sessionStorage.clear(); });
  for (const path of ["/ai", "/fund?success=true&session_id=replayed"]) {
    await page.goto(path);
    await expect(page.locator("[data-purchase-unavailable]")).toHaveText("Digital purchases are unavailable in this Android app.");
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /buy.*2Z/i })).toHaveCount(0);
    expect(await page.evaluate(() => "__FREE2Z_ANDROID_PURCHASES_UNAVAILABLE__" in window)).toBe(false);
  }
});
