import { expect, test, type Locator, type Page } from "@playwright/test";

const VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 360, height: 640 },
] as const;

async function setScenario(
  page: Page,
  scenario: "all-off" | "x" | "contract-error",
  authenticated = false,
) {
  await page.addInitScript(
    ({ nextScenario, signedIn }) => {
      if (!sessionStorage.getItem("zuuli.mock.social-providers")) {
        sessionStorage.setItem("zuuli.mock.social-providers", nextScenario);
      }
      if (signedIn) localStorage.setItem("zuuli.knox.token", "mock-knox-token");
      else localStorage.removeItem("zuuli.knox.token");
    },
    { nextScenario: scenario, signedIn: authenticated },
  );
}

async function expectNoHorizontalOverflow(page: Page) {
  const metrics = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(metrics.scroll).toBeLessThanOrEqual(metrics.client);
}

async function expectTapTarget(target: Locator) {
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
}

for (const viewport of VIEWPORTS) {
  test(`social discovery states remain explicit at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await setScenario(page, "all-off");
    await page.goto("/login");

    await expect(page.getByRole("heading", { name: "Log in" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue with X" })).toHaveCount(0);
    await expect(page.getByText("More sign-in options coming soon.")).toHaveCount(0);
    await expectNoHorizontalOverflow(page);

    await page.evaluate(() =>
      sessionStorage.setItem("zuuli.mock.social-providers", "contract-error"),
    );
    await page.reload();
    const alert = page.getByRole("alert");
    await expect(alert).toContainText("Couldn't check sign-in options.");
    await expect(page.getByText("More sign-in options coming soon.")).toHaveCount(0);
    const retry = page.getByRole("button", { name: "Retry" });
    const retryBox = await retry.boundingBox();
    expect(retryBox).not.toBeNull();
    expect(retryBox!.width).toBeGreaterThanOrEqual(44);
    expect(retryBox!.height).toBeGreaterThanOrEqual(44);

    await page.evaluate(() =>
      sessionStorage.setItem("zuuli.mock.social-providers", "x"),
    );
    await retry.click();
    const continueWithX = page.getByRole("button", { name: "Continue with X" });
    await expect(continueWithX).toBeVisible();
    await expectTapTarget(continueWithX);
    await expect(page.getByRole("button", { name: "Continue with Google" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Continue with GitHub" })).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  });

  test(`configured association stays auth-coherent at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await setScenario(page, "x", true);
    await page.goto("/profile");

    await expect(page.getByRole("heading", { name: "Linked identities" })).toBeVisible();
    const linkX = page.getByRole("button", { name: "Link X" });
    await expect(linkX).toBeVisible();
    await expectTapTarget(linkX);
    await expect(page.getByRole("button", { name: "Link Google" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Link GitHub" })).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  });
}
