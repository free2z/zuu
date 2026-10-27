import { expect, test } from "@playwright/test";

const USER = "fixtureowner";
const SETTINGS = `/${USER}/dashboard/settings`;
const CHALLENGE = {
  code: "insufficient_user_authentication",
  detail: "Sign in again before linking a sign-in method.",
  max_age: 300,
};

test("recovery email step-up keeps the draft and returns to an explicit save", async ({
  page,
}) => {
  let recent = false;
  const writes: string[] = [];
  await page.context().addCookies([
    {
      name: "sessionid",
      value: "billing-fixture-session",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
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
  await page.route("**/api/auth/login/", (route) => {
    recent = true;
    return route.fulfill({ json: { key: "session" } });
  });
  await page.route("**/api/auth/user/", (route) =>
    route.fulfill({
      json: {
        id: 8106,
        username: USER,
        full_name: "Fixture Owner",
      },
    }),
  );
  await page.route("**/api/emails/add", (route) => {
    writes.push(route.request().postDataJSON().email);
    return route.fulfill({
      status: recent ? 201 : 401,
      json: recent ? {} : CHALLENGE,
    });
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(SETTINGS);
  await page.waitForLoadState("networkidle");
  await page.getByRole("tab", { name: "Account", exact: true }).click();
  const email = page.getByLabel("Email Address", { exact: true });
  await email.fill("pending@example.com");
  await page.getByRole("button", { name: "Update", exact: true }).click();
  const notice = page.getByTestId("email-reauthentication");
  await expect(notice).toContainText("Sign in again");
  await notice.getByRole("button", { name: "Sign in again" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("pending email stays here");
  await dialog.locator("#username").fill(USER);
  await dialog.locator("#password").fill("correct-password");
  await dialog.getByRole("button", { name: "Log in", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(SETTINGS);
  await expect(email).toHaveValue("pending@example.com");
  expect(writes).toEqual(["pending@example.com"]);
  await page.getByRole("button", { name: "Update", exact: true }).click();
  await expect.poll(() => writes.length).toBe(2);
  await expect(
    page.getByText("Email update requested.", { exact: true }),
  ).toBeVisible();
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(2);
  await page.waitForTimeout(4500);
  const acknowledgement = page
    .locator("[data-sonner-toast]")
    .filter({ hasText: "Email update requested." });
  await expect(acknowledgement).toBeVisible();
  await acknowledgement
    .getByRole("button", { name: "Close notification" })
    .click();
  await expect(acknowledgement).toHaveCount(0);
});

for (const method of [
  "wallet",
  "google",
  "legacy-x",
  "bad-state",
  "bad-otp",
  "expired-submit",
] as const) {
  test(`passwordless recovery-email reauthentication through ${method} preserves the draft`, async ({
    page,
    context,
  }) => {
    let recent = false;
    let proofs = 0;
    const writes: string[] = [];
    await context.addCookies([
      {
        name: "sessionid",
        value: "billing-fixture-session",
        domain: "127.0.0.1",
        path: "/",
      },
    ]);
    await context.route("**/api/emails/status", (route) =>
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
    await context.route("**/api/auth/user/", (route) =>
      route.fulfill({
        json: { id: 8106, username: USER, full_name: "Fixture Owner" },
      }),
    );
    await context.route("**/api/auth/social/", (route) =>
      route.fulfill({ json: [{ provider: "google", needs_reconnect: false }] }),
    );
    await context.route("**/api/auth/social/providers/", (route) =>
      route.fulfill({
        json: {
          providers: [
            {
              provider: "google",
              configured: true,
              web_reauthentication: true,
            },
          ],
        },
      }),
    );
    await context.route("**/api/auth/recent/", (route) =>
      route.fulfill({
        status: recent ? 200 : 401,
        json: recent ? { username: USER } : CHALLENGE,
      }),
    );
    await context.route("**/api/emails/add", (route) => {
      writes.push(route.request().postDataJSON().email);
      return route.fulfill({
        status: recent ? 201 : 401,
        json: recent ? {} : CHALLENGE,
      });
    });
    await context.route("**/api/auth/zcash/challenge/", (route) =>
      route.fulfill({
        json: { challenge: "Free2Z sign-in fixture challenge" },
      }),
    );
    await context.route("**/api/auth/zcash/login/", (route) => {
      expect(route.request().postDataJSON()).toMatchObject({
        address: "t1existing",
        challenge: "Free2Z sign-in fixture challenge",
        signature: "wallet-signed-proof",
      });
      recent = true;
      return route.fulfill({ json: { token: "discarded-native-token" } });
    });
    await context.route("**/api/auth/social/google/start?*", (route) => {
      const redirect = new URL(route.request().url()).searchParams.get(
        "redirect_uri",
      )!;
      return route.fulfill({
        json: {
          state: "provider-state",
          authorize_url: `${redirect}?state=${method === "bad-state" ? "wrong-state" : "provider-state"}&code=one-time-code`,
        },
      });
    });
    await context.route("**/api/twitter/start", (route) =>
      route.fulfill({
        json: {
          authorize_url: "https://x.com/i/oauth2/authorize?state=legacy",
        },
      }),
    );
    await context.route("https://x.com/i/oauth2/authorize?*", async (route) => {
      recent = true;
      const origin = new URL(page.url()).origin;
      await route.fulfill({
        status: 302,
        headers: { location: `${origin}/${USER}/dashboard/profile` },
      });
    });
    await context.route("**/api/auth/social/google/", (route) => {
      proofs++;
      expect(route.request().postDataJSON()).toMatchObject({
        state: "provider-state",
        code: "one-time-code",
        otp_token: "654321",
      });
      if (method === "bad-otp")
        return route.fulfill({
          status: 401,
          json: { detail: "Invalid two-factor code." },
        });
      recent = true;
      return route.fulfill({ json: { token: "discarded-native-token" } });
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(SETTINGS);
    await page.waitForLoadState("networkidle");
    await page.getByRole("tab", { name: "Account", exact: true }).click();
    const email = page.getByLabel("Email Address", { exact: true });
    await email.fill("pending@example.com");
    await page.getByRole("button", { name: "Update", exact: true }).click();
    await page
      .getByTestId("email-reauthentication")
      .getByRole("button", { name: "Sign in again" })
      .click();
    const dialog = page.getByRole("dialog");
    if (method === "wallet") {
      await dialog
        .getByText("Sign in with an existing Zcash wallet", { exact: true })
        .click();
      await dialog
        .getByLabel("Zcash address", { exact: true })
        .fill("t1existing");
      await dialog
        .getByRole("button", { name: "Get sign-in challenge" })
        .click();
      await expect(dialog.getByLabel("Free2Z sign-in challenge")).toHaveValue(
        "Free2Z sign-in fixture challenge",
      );
      await dialog.getByLabel("Wallet signature").fill("wallet-signed-proof");
      await dialog
        .getByRole("button", { name: "Verify wallet signature" })
        .click();
    } else if (method === "legacy-x") {
      await dialog
        .getByRole("button", { name: "Continue with linked X account" })
        .click();
    } else {
      const opened = context.waitForEvent("page");
      await dialog
        .getByRole("button", { name: "Continue with Google" })
        .click();
      const popup = await opened;
      if (method === "bad-state") {
        await expect(popup.getByTestId("reauth-callback-status")).toContainText(
          "invalid or expired",
        );
        expect(proofs).toBe(0);
        expect(recent).toBe(false);
        await popup.close();
        await expect(dialog.getByRole("alert")).toContainText("cancelled");
        await page.keyboard.press("Escape");
        await expect(email).toHaveValue("pending@example.com");
        expect(writes).toEqual(["pending@example.com"]);
        return;
      }
      // Provider MFA is entered only AFTER OAuth returns, so a code cannot
      // expire while the user is still signing in at the provider.
      await expect(popup).toHaveURL(/\/oauth\/reauth-callback$/);
      await popup
        .getByLabel("Current two-factor code (if enabled)")
        .fill("654321");
      if (method === "expired-submit") {
        await popup.evaluate(() => {
          const now = Date.now();
          Date.now = () => now + 301000;
        });
      }
      // Two same-turn submit events must redeem the one-time proof only once.
      await popup.locator("form").evaluate((form) => {
        form.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
        form.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
      });
      if (method === "bad-otp" || method === "expired-submit") {
        await expect(popup.getByTestId("reauth-callback-status")).toContainText(
          "start again from settings",
        );
        await expect(
          popup.getByRole("button", { name: "Finish signing in" }),
        ).toHaveCount(0);
        expect(proofs).toBe(method === "bad-otp" ? 1 : 0);
        expect(recent).toBe(false);
        await popup.close();
        await page.keyboard.press("Escape");
        await expect(email).toHaveValue("pending@example.com");
        expect(writes).toEqual(["pending@example.com"]);
        return;
      }
      await expect.poll(() => proofs).toBe(1);
    }
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(SETTINGS);
    await expect(email).toHaveValue("pending@example.com");
    expect(writes).toEqual(["pending@example.com"]);
    await page.getByRole("button", { name: "Update", exact: true }).click();
    await expect.poll(() => writes.length).toBe(2);
    await expect(
      page.getByText("Email update requested.", { exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() =>
        JSON.stringify({ ...localStorage, ...sessionStorage }),
      ),
    ).not.toContain("discarded-native-token");
  });
}
