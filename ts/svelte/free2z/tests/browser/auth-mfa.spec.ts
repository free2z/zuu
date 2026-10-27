import { expect, test } from "@playwright/test";

const TEST_CREATOR = {
  id: 1,
  username: "mfa-user",
  full_name: "MFA User",
};

test("valid MFA login retries the direct login endpoint with the captcha token", async ({
  page,
}) => {
  const requests: Array<{ pathname: string; body: Record<string, string> }> =
    [];
  let authenticated = false;

  // Use the dedicated auth route so this contract test does not depend on
  // unrelated search-page SSR data or API fixtures.
  await page.goto("/login");

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;

    // The glob also matches Vite module URLs such as /src/lib/api/config.ts.
    // Let those assets load normally; only mock backend API paths.
    if (!pathname.startsWith("/api/")) {
      await route.continue();
      return;
    }

    let body: Record<string, string> = {};

    if (request.method() === "POST") {
      body = JSON.parse(request.postData() || "{}");
      requests.push({ pathname, body });
    }

    if (pathname === "/api/auth/login/") {
      if (
        requests.filter(({ pathname }) => pathname === "/api/auth/login/")
          .length === 1
      ) {
        await route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ non_field_errors: ["Invalid OTP token"] }),
        });
        return;
      }

      expect(body).toEqual({
        username: "mfa-user",
        password: "correct-password",
        captcha_result: "test",
        otp_token: "123456",
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ key: "session" }),
      });
      authenticated = true;
      return;
    }

    if (pathname === "/api/auth/user/") {
      if (!authenticated) {
        await route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({ detail: "Not authenticated" }),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(TEST_CREATOR),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ count: 0, results: [] }),
    });
  });

  await page.getByRole("button", { name: "Sign In" }).click();
  await page.locator("#username").fill("mfa-user");
  await page.locator("#password").fill("correct-password");
  await page.getByRole("button", { name: "Log in" }).click();

  await expect(page.locator("#otpCode")).toBeVisible();
  // Dialog focus-scope autofocus runs on the next animation frame after mount.
  // Wait for that state before moving focus so the dialog's pending autofocus
  // cannot race this explicit focus assertion.
  await expect(page.locator("#otpCode")).toBeFocused();
  const trouble = page.getByRole("link", {
    name: "Having trouble with 2FA?",
  });
  await expect(trouble).toHaveAttribute("href", "mailto:help@free2z.com");
  await trouble.focus();
  await expect(trouble).toBeFocused();
  await trouble.press("Enter");
  await expect(trouble).toHaveAttribute("href", "mailto:help@free2z.com");

  await page.locator("#otpCode").fill("123456");
  await page.getByRole("button", { name: "Verify" }).click();

  await expect
    .poll(
      () =>
        requests.filter(({ pathname }) => pathname === "/api/auth/login/")
          .length,
    )
    .toBe(2);
  expect(requests.some(({ pathname }) => pathname === "/api/start/")).toBe(
    false,
  );
  await expect(page).toHaveURL("/");
});
