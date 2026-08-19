import { expect, test, type Locator, type Page } from "@playwright/test";

const PHONE_VIEWPORTS = [
  { label: "320x568", width: 320, height: 568 },
  { label: "iPhone SE", width: 375, height: 667 },
] as const;

async function openLogin(
  page: Page,
  viewport: (typeof PHONE_VIEWPORTS)[number],
  walletScenario?: "empty" | "sign-error",
) {
  await page.setViewportSize(viewport);
  await page.addInitScript((scenario) => {
    localStorage.removeItem("zuuli.knox.token");
    if (scenario) localStorage.setItem("zuuli.mock.wallet-scenario", scenario);
    else localStorage.removeItem("zuuli.mock.wallet-scenario");
  }, walletScenario);
  await page.goto("/login");
  await page.addStyleTag({
    content: `:root {
      --safe-area-top: 20px !important;
      --safe-area-bottom: 16px !important;
    }`,
  });
  await expect(page.locator("[data-route-frame] [data-route-scroll]")).toBeVisible();
}

async function expectAuthGeometry(page: Page, noVerticalScroll: boolean) {
  const metrics = await page
    .locator("[data-route-frame] [data-route-scroll]")
    .evaluate((scroller) => {
      const boundary = scroller.getBoundingClientRect();
      const outside = [...scroller.querySelectorAll<HTMLElement>("*")]
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            !element.closest("[hidden], [inert], [aria-hidden='true']") &&
            !element.closest("svg") &&
            (rect.left < boundary.left - 1 || rect.right > boundary.right + 1)
          );
        })
        .map((element) => element.getAttribute("aria-label") ?? element.innerText.slice(0, 50));

      return {
        clientHeight: scroller.clientHeight,
        clientWidth: scroller.clientWidth,
        outside,
        rootClientHeight: document.documentElement.clientHeight,
        rootClientWidth: document.documentElement.clientWidth,
        rootScrollHeight: document.documentElement.scrollHeight,
        rootScrollWidth: document.documentElement.scrollWidth,
        scrollHeight: scroller.scrollHeight,
        scrollWidth: scroller.scrollWidth,
      };
    });

  expect(metrics.rootScrollWidth).toBeLessThanOrEqual(metrics.rootClientWidth);
  expect(metrics.rootScrollHeight).toBeLessThanOrEqual(metrics.rootClientHeight);
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
  expect(metrics.outside).toEqual([]);
  if (noVerticalScroll) {
    expect(metrics.scrollHeight).toBeLessThanOrEqual(metrics.clientHeight + 1);
  }
}

async function expectReachable(scroller: Locator, target: Locator) {
  await target.scrollIntoViewIfNeeded();
  await expect(target).toBeVisible();
  const [boundary, control] = await Promise.all([
    scroller.boundingBox(),
    target.boundingBox(),
  ]);
  expect(boundary).not.toBeNull();
  expect(control).not.toBeNull();
  const visibleTop = Math.max(control!.y, boundary!.y);
  const visibleBottom = Math.min(
    control!.y + control!.height,
    boundary!.y + boundary!.height,
  );
  expect(visibleBottom - visibleTop).toBeGreaterThanOrEqual(
    Math.min(44, control!.height),
  );
}

for (const viewport of PHONE_VIEWPORTS) {
  test(`chooser, password, OTP and error stay compact and reachable on ${viewport.label}`, async ({
    page,
  }) => {
    await openLogin(page, viewport);
    const scroller = page.locator("[data-route-frame] [data-route-scroll]");

    await expect(page.getByRole("heading", { name: "Log in" })).toBeVisible();
    await expect(page.getByText("Welcome back", { exact: false })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Zcash", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Password", exact: true })).toBeVisible();
    await expectAuthGeometry(page, true);

    await page.getByRole("button", { name: "Zcash", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Zcash" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeVisible();
    await expect(
      page.locator("[data-auth-selected]").getByText(/Login with Zcash|Continue with Zcash/),
    ).toHaveCount(0);
    await expectAuthGeometry(page, true);

    const back = page.getByRole("button", { name: "Choose another login method" });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("Tab");
    await expect(back).toBeFocused();
    expect(await back.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe("none");
    await back.hover();
    await expect(page.getByRole("tooltip", { name: "Choose another method" })).toBeVisible();
    await back.click();

    await page.getByRole("button", { name: "Password", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Password" })).toBeVisible();
    await expectAuthGeometry(page, true);
    const passwordBack = page.getByRole("button", {
      name: "Choose another login method",
    });
    await page.getByLabel("Email or username").fill("otp-user");
    await page.getByLabel("Password").fill("mock-password");
    await page
      .locator("[data-auth-selected='password']")
      .getByRole("button", { name: "Log in", exact: true })
      .click();
    await expect(passwordBack).toBeDisabled();

    await expect(page.getByText("Two-factor authentication")).toBeVisible();
    await expect(passwordBack).toBeEnabled();
    await expectAuthGeometry(page, false);
    await page.getByLabel("Authentication code").fill("000000");
    await page.getByRole("button", { name: "Verify and log in" }).click();
    await expect(passwordBack).toBeDisabled();
    const error = page.getByRole("alert");
    await expect(error).toContainText("code didn't match");
    await expect(passwordBack).toBeEnabled();
    await expectReachable(scroller, error);
    await expectReachable(scroller, page.getByRole("button", { name: "Use a different account" }));
    await expectAuthGeometry(page, false);
  });

  test(`Zcash error remains reachable on ${viewport.label}`, async ({ page }) => {
    await openLogin(page, viewport, "sign-error");
    const scroller = page.locator("[data-route-frame] [data-route-scroll]");
    await page.getByRole("button", { name: "Zcash", exact: true }).click();
    const back = page.getByRole("button", {
      name: "Choose another login method",
    });
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(back).toBeDisabled();
    const retry = page.getByRole("button", { name: "Try again" });
    await expect(retry).toBeVisible();
    await expect(back).toBeEnabled();
    await expectReachable(scroller, retry);
    await expectAuthGeometry(page, false);
  });

  test(`seed safety remains reachable on ${viewport.label}`, async ({ page }) => {
    await openLogin(page, viewport, "empty");
    const scroller = page.locator("[data-route-frame] [data-route-scroll]");
    await page.getByRole("button", { name: "Zcash", exact: true }).click();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByText("No Zcash identity on this device")).toBeVisible();
    await page.getByRole("button", { name: "Create a Zcash identity" }).click();

    await expect(page.getByText("This recovery phrase is your identity.")).toBeVisible();
    const reveal = page.getByRole("button", { name: "Reveal recovery phrase" });
    await expectReachable(scroller, reveal);
    await reveal.click();
    const acknowledgement = page.getByRole("checkbox");
    await expectReachable(scroller, acknowledgement);
    await acknowledgement.check();
    await expectReachable(scroller, page.getByRole("button", { name: "I saved it — continue" }));
    await expect(page.getByText(/Anyone who sees them controls your account/)).toBeVisible();
    await expectAuthGeometry(page, false);
  });
}
