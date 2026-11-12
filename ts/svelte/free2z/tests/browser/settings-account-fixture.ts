import { expect, type Page } from "@playwright/test";

/** The shared billing fixture has no recovery address on its signed-in account. */
export async function installSettingsAccountFixture(page: Page) {
  await page.route("**/api/emails/status", (route) =>
    route.fulfill({
      json: {
        email: null,
        confirmed: false,
        pending: false,
        is_public: false,
        get_notifications: false,
      },
    }),
  );
  let recoveryReads = 0;
  await page.route("**/api/emails/recovery-status", (route) => {
    recoveryReads += 1;
    return route.fulfill({
      json: {
        can_recover: false,
        mfa_required: false,
        email_on_file: false,
        email_confirmed: false,
        email_pending: false,
        email_suppressed: false,
        password_set: true,
        risk: "no_recovery",
        next_step: "add_email",
      },
    });
  });
  return () => recoveryReads;
}

/** Prove hydration via real tab interaction and the authenticated account read. */
export async function openHydratedSettings(
  page: Page,
  url: string,
  recoveryReads: () => number,
  destination: "Financial" | "Security" = "Financial",
) {
  const session = page.waitForResponse(
    (response) => response.url().endsWith("/api/auth/user/") && response.ok(),
  );
  await page.goto(url);
  await session;
  const account = page.getByRole("tab", { name: "Account", exact: true });
  // Bits UI connects trigger to panel during hydration; the SSR trigger has
  // no aria-controls. Wait for that connection before exercising its handler.
  await expect(account).toHaveAttribute("aria-controls", /.+/);
  await account.click();
  await expect(account).toHaveAttribute("data-state", "active");
  await expect(page.getByTestId("recovery-no-email")).toBeVisible();
  expect(recoveryReads()).toBe(1);
  const tab = page.getByRole("tab", { name: destination, exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute("data-state", "active");
  expect(recoveryReads()).toBe(1);
}
