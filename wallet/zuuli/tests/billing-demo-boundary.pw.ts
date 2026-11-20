import { expect, test } from "@playwright/test";

test("a Tauri build with accidental mock configuration cannot buy or verify funding", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("zuuli.knox.token", "mock-knox-token");
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {} });
  });
  await page.goto("/wallet/fund");
  await expect(page.getByText("Live account billing unavailable", { exact: true })).toBeVisible();
  await expect(page.getByText("This runtime uses mock data. No payment can be made or verified here.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Open Free2Z billing|Refresh account balance|Pay with card|Pay with ZEC|Run demo/ })).toHaveCount(0);
});
