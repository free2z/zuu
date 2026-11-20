import { expect, test, type Page } from "@playwright/test";

async function chooseNew(page: Page) {
  await page.addInitScript(() => {
    localStorage.removeItem("zuuli.knox.token");
    localStorage.setItem("zuuli.mock.username-new", "1");
  });
  await page.goto("/login");
  await page.getByRole("button", { name: "Zcash", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Choose your username" })).toBeVisible();
}

test("new identity can choose an available name", async ({ page }) => {
  await chooseNew(page);
  const input = page.getByLabel("Username", { exact: true });
  await input.fill("taken");
  await expect(page.getByText("That username is taken.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with username" })).toBeDisabled();
  await input.fill("river");
  await expect(page.getByText("Available", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Continue with username" }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 10000 });
});

test("leaving choice does not sign in", async ({ page }) => {
  await chooseNew(page);
  await page.getByRole("button", { name: "Choose another login method" }).click();
  await expect(page.getByRole("heading", { name: "Choose your username" })).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("zuuli.knox.token"))).toBeNull();
});

test("skip accepts a generated name", async ({ page }) => {
  await chooseNew(page);
  await page.getByRole("button", { name: "Use a generated username" }).click();
  await expect(page).toHaveURL(/\/$/, { timeout: 10000 });
});

test("a session introduced while choosing prevents submission", async ({ page }) => {
  await chooseNew(page);
  await page.evaluate(() => localStorage.setItem("zuuli.knox.token", "other-session"));
  await page.getByRole("button", { name: "Use a generated username" }).click();
  await expect(page.getByRole("alert")).toContainText("The session changed");
  expect(await page.evaluate(() => localStorage.getItem("zuuli.knox.token"))).toBe("other-session");
});

test("editing invalidates an earlier availability result", async ({ page }) => {
  await chooseNew(page);
  const input = page.getByLabel("Username", { exact: true });
  await input.fill("river");
  await expect(page.getByText("Available", { exact: true })).toBeVisible();
  await input.fill("taken");
  await expect(page.getByRole("button", { name: "Continue with username" })).toBeDisabled();
  await expect(page.getByText("That username is taken.")).toBeVisible();
});

test("a wallet switch while choosing prevents creation", async ({ page }) => {
  await chooseNew(page);
  await page.evaluate(() => localStorage.setItem("zuuli.mock.wallet-scenario", "wallet-switch"));
  await page.getByRole("button", { name: "Use a generated username" }).click();
  await expect(page.getByRole("alert")).toContainText("selected Zcash identity is no longer active");
  expect(await page.evaluate(() => localStorage.getItem("zuuli.knox.token"))).toBeNull();
});

test("switching wallet during a delayed login cannot publish the old session", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.removeItem("zuuli.knox.token");
    localStorage.setItem("zuuli.mock.slow-zcash-login", "1");
  });
  await page.goto("/login");
  await page.getByRole("button", { name: "Zcash", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const verify = page.locator("li", { hasText: "Verifying" });
  await expect(verify.getByText("working")).toBeVisible();
  await page.waitForTimeout(1000);
  await page.evaluate(() => localStorage.setItem("zuuli.mock.wallet-scenario", "wallet-switch"));
  await expect(page.getByRole("alert")).toContainText("selected Zcash identity is no longer active");
  expect(await page.evaluate(() => localStorage.getItem("zuuli.knox.token"))).toBeNull();
  await expect(page.getByRole("button", { name: "Account menu" })).toHaveCount(0);
});
