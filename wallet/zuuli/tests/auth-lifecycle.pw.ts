import { expect, test, type Page } from "@playwright/test";

const TOKEN_KEY = "zuuli.knox.token";
const RECOVERY_PHRASE =
  "wisdom shadow orchard zebra pledge notice frost violet render " +
  "summer harvest mirror canyon velvet ranch fossil pupil sunset " +
  "quantum ledger prosper anchor beyond zephyr";

async function openLogin(
  page: Page,
  walletScenario?: "empty" | "sign-error" | "slow-restore",
) {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.addInitScript((scenario) => {
    localStorage.removeItem("zuuli.knox.token");
    if (scenario) localStorage.setItem("zuuli.mock.wallet-scenario", scenario);
    else localStorage.removeItem("zuuli.mock.wallet-scenario");
  }, walletScenario);
  await page.goto("/login");
}

async function unmountLoginWithoutReload(page: Page) {
  await page.evaluate(() => {
    history.pushState({}, "", "/about");
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page).toHaveURL(/\/about$/);
}

async function expectNoInvisibleLogin(page: Page) {
  await page.waitForTimeout(2_500);
  expect(
    await page.evaluate((key) => localStorage.getItem(key), TOKEN_KEY),
  ).toBeNull();
  await expect(page).toHaveURL(/\/about$/);
  await expect(page.getByText(/Welcome (?:back|to ZUULI)/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Account menu" })).toHaveCount(
    0,
  );
}

test("unmounted password and OTP attempts cannot publish a session", async ({
  page,
}) => {
  await openLogin(page);
  await page.getByRole("button", { name: "Password", exact: true }).click();
  await page.getByLabel("Email or username").fill("plain-user");
  await page.getByLabel("Password").fill("password");
  await page
    .locator("[data-auth-selected='password']")
    .getByRole("button", { name: "Log in", exact: true })
    .click();
  await unmountLoginWithoutReload(page);
  await expectNoInvisibleLogin(page);

  await page.goto("/login");
  await page.getByRole("button", { name: "Password", exact: true }).click();
  await page.getByLabel("Email or username").fill("otp-user");
  await page.getByLabel("Password").fill("password");
  await page
    .locator("[data-auth-selected='password']")
    .getByRole("button", { name: "Log in", exact: true })
    .click();
  await expect(page.getByText("Two-factor authentication")).toBeVisible();
  await page.getByLabel("Authentication code").fill("123456");
  await page.getByRole("button", { name: "Verify and log in" }).click();
  await unmountLoginWithoutReload(page);
  await expectNoInvisibleLogin(page);
});

for (const stage of ["prepare", "challenge", "sign", "verify"] as const) {
  test(`unmounted Zcash ${stage} attempt cannot publish a session`, async ({
    page,
  }) => {
    await openLogin(page);
    await page.getByRole("button", { name: "Zcash", exact: true }).click();
    await page.getByRole("button", { name: "Continue", exact: true }).click();

    const titles = {
      prepare: "Preparing your identity",
      challenge: "Requesting a challenge",
      sign: "Signing with your key",
      verify: "Verifying",
    } as const;
    const step = page.locator("li", { hasText: titles[stage] });
    await expect(step.getByText("working", { exact: true })).toBeVisible();
    await unmountLoginWithoutReload(page);
    await expectNoInvisibleLogin(page);
  });
}

test("an unmounted Zcash retry cannot revive the failed attempt", async ({
  page,
}) => {
  await openLogin(page, "sign-error");
  await page.getByRole("button", { name: "Zcash", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Try again" }).click();
  await unmountLoginWithoutReload(page);
  await expectNoInvisibleLogin(page);
});

test("an unmounted recovery cannot continue into challenge verification", async ({
  page,
}) => {
  await openLogin(page, "slow-restore");
  await page.getByRole("button", { name: "Zcash", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Use existing identity" }).click();
  await page.getByLabel("Recovery phrase").fill(RECOVERY_PHRASE);
  await page.getByRole("button", { name: "Restore and continue" }).click();
  await expect(
    page.getByRole("button", { name: "Restoring identity…" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Choose another login method" }),
  ).toBeDisabled();

  await unmountLoginWithoutReload(page);
  await expect(page.locator("textarea")).toHaveCount(0);
  await expectNoInvisibleLogin(page);
  expect(
    await page.evaluate(
      (secret) =>
        Object.values(localStorage).some((value) => value.includes(secret)),
      "wisdom shadow",
    ),
  ).toBe(false);
});

test("new identity backup resumes after method switch and process-style reload", async ({
  page,
}) => {
  await openLogin(page, "empty");
  await page.getByRole("button", { name: "Zcash", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    page.getByText("No Zcash identity on this device"),
  ).toBeVisible();
  await expect(
    page.getByText(
      "A new key creates a distinct identity and may open a different account.",
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Create new identity" }).click();
  await expect(page.getByText("Back up your recovery phrase")).toBeVisible();

  await page
    .getByRole("button", { name: "Choose another login method" })
    .click();
  await expect(page.getByText("wisdom", { exact: true })).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      localStorage.getItem("zuuli.mock.backup-required"),
    ),
  ).toBe("mock-wallet-0");
  await page.getByRole("button", { name: "Password", exact: true }).click();
  await page
    .getByRole("button", { name: "Choose another login method" })
    .click();
  await page.getByRole("button", { name: "Zcash", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByText("Back up your recovery phrase")).toBeVisible();
  await page.getByRole("button", { name: "Reveal recovery phrase" }).click();
  await page.getByRole("button", { name: "Reveal recovery phrase" }).click();
  await expect(page.getByText("wisdom", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: "Choose another login method" })
    .click();
  await expect(page.getByText("wisdom", { exact: true })).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      localStorage.getItem("zuuli.mock.backup-required"),
    ),
  ).toBe("mock-wallet-0");

  await page.reload();
  await page.getByRole("button", { name: "Zcash", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByText("Back up your recovery phrase")).toBeVisible();
  await page.getByRole("button", { name: "Reveal recovery phrase" }).click();
  await page.getByRole("button", { name: "Reveal recovery phrase" }).click();
  await page.getByRole("checkbox").check();
  const confirm = page.getByRole("button", { name: "I saved it — continue" });
  await page.locator("[data-route-scroll]").evaluate((scroller) => {
    scroller.scrollTop = scroller.scrollHeight;
  });
  const [confirmBox, navBox] = await Promise.all([
    confirm.boundingBox(),
    page.locator("[data-app-bottom-nav]").boundingBox(),
  ]);
  expect(confirmBox).not.toBeNull();
  expect(navBox).not.toBeNull();
  expect(confirmBox!.y + confirmBox!.height).toBeLessThanOrEqual(navBox!.y);
  await confirm.click();

  await expect(page).toHaveURL(/\/$/, { timeout: 8_000 });
  expect(
    await page.evaluate((key) => localStorage.getItem(key), TOKEN_KEY),
  ).toBe("mock-knox-token-zcash");
});

test("backgrounding clears a revealed mnemonic and requires fresh reveal", async ({
  page,
}) => {
  await openLogin(page, "empty");
  await page.getByRole("button", { name: "Zcash", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Create new identity" }).click();

  await page.getByRole("button", { name: "Reveal recovery phrase" }).click();
  await page.getByRole("button", { name: "Reveal recovery phrase" }).click();
  await expect(page.getByText("wisdom", { exact: true })).toBeVisible();

  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(page.getByText("wisdom", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Back up your recovery phrase")).toBeVisible();

  await page.getByRole("button", { name: "Reveal recovery phrase" }).click();
  await expect(
    page.getByText("This recovery phrase is your identity."),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Reveal recovery phrase" }),
  ).toBeVisible();
});
