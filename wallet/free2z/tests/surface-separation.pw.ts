/**
 * The three couplings #904 names between the content surface and the wallet,
 * asserted against the running app rather than against the source.
 *
 *   1. `features/creator` was the ONE import from social into wallet. It has no
 *      wallet route to hand a tip to here, and must not invent a transport
 *      (#905, blocked on #461).
 *   2. Login with Zcash needs a key this process does not hold; classic and
 *      OAuth must still work, and the omission must be stated, not hidden.
 *   3. The shell — TopBar's ZEC chip, LegacyWalletNotice, and App's
 *      unconditional `bootstrapWallet()` — must be gone.
 *
 * The negative assertions matter more than the positive ones: this file exists
 * to fail if a wallet affordance is reintroduced by a later merge.
 */
import { expect, test, type Page } from "@playwright/test";

const PHONE = { width: 320, height: 568 };

async function signIn(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("zuuli.knox.token", "mock-knox-token");
  });
}

test("the shell exposes no wallet destination and no ZEC balance", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/articles");

  const header = page.locator("[data-app-top-bar]");
  await expect(header).toBeVisible();
  // The 2Z chip stays: 2Z is a fiat-funded content credit, not a key.
  await expect(header.getByRole("link", { name: /Buy 2Zs\. Balance/ })).toBeVisible();
  await expect(header.getByText("ZEC")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Open wallet" })).toHaveCount(0);

  await expect(page.getByRole("link", { name: "Wallet" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Messages" })).toHaveCount(0);
  await expect(page.locator("a[href^='/wallet']")).toHaveCount(0);

  // ZUULI's shell renders LegacyWalletNotice under the header. It reads
  // `store/wallet`, which does not exist on this surface.
  await expect(page.getByText("Earlier wallet preserved")).toHaveCount(0);

  const menu = header.getByRole("button", { name: "Account menu" });
  await menu.click();
  const items = await page.getByRole("menuitem").allInnerTexts();
  expect(items).toEqual(["Buy 2Zs", "Sign out"]);
});

test("an unmounted wallet path renders NotFound rather than a wallet", async ({
  page,
}) => {
  await page.goto("/wallet/send");

  await expect(page.getByText("Page not found")).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to Articles" })).toBeVisible();
});

test("login offers password and states why Zcash is not here", async ({
  page,
}) => {
  await page.goto("/login");

  const chooser = page.locator("[data-auth-chooser]");
  await expect(chooser).toBeVisible();
  await expect(chooser.getByRole("button", { name: "Password" })).toBeVisible();
  await expect(chooser.getByRole("button", { name: "Zcash" })).toHaveCount(0);

  const pending = page.locator("[data-auth-zcash-pending]");
  await expect(pending).toBeVisible();
  await expect(pending).toContainText("Zcash login is not on this surface yet");
  await expect(pending).toContainText("ZUULI");

  await chooser.getByRole("button", { name: "Password" }).click();
  await expect(page.locator("[data-auth-selected='password']")).toBeVisible();
  await expect(page.getByLabel("Email or username")).toBeVisible();
});

test("a creator ZEC tip records the intent without a wallet handoff", async ({
  page,
}) => {
  await signIn(page);
  await page.setViewportSize(PHONE);

  const navigations: string[] = [];
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations.push(frame.url());
  });

  await page.goto("/creator/zooko");
  const before = page.url();

  await page.getByRole("button", { name: /Tip zooko/i }).click();
  await expect(page.getByRole("group", { name: "Tip currency" })).toBeVisible();
  await page.getByRole("button", { name: /^ZEC Zcash wallet$/ }).click();
  await page.getByRole("button", { name: "Continue with ZEC" }).click();

  // The dialog closes and the reader is told where the tip is actually signed.
  await expect(page.getByText("ZEC tips are signed in ZUULI")).toBeVisible();
  expect(page.url()).toBe(before);
  expect(navigations.filter((url) => url !== before)).toEqual([]);
  await expect(page.locator("[data-testid='creator-tip-context']")).toHaveCount(0);
});
