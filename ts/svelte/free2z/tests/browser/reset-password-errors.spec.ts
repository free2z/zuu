import { expect, test, type Page } from "@playwright/test";

//  the reset-password page said "We couldn't reset your password. The
// link may have expired — request a new one." for EVERY refusal, in every
// locale: it chose between two fallbacks of one catalog key, and the catalog
// entry always wins. A reader who typed a weak password or a stale
// authenticator code was sent to request link after link, each failing the
// same way.
//
// Each test answers the real form's POST with a body the backend sends and
// asserts the specific sentence on screen, not merely that "an error shows".
//
// NEGATIVE CONTROL: put the old `$t("auth.passwordReset.errors.expired",
// detail === "Invalid OTP token." ?...:...)` back in +page.svelte (it
// still compiles) and every test except "expired" goes red on its sentence.

const OLD_EXPIRED =
  "We couldn't reset your password. The link may have expired — request a new one.";

interface Refusal {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

async function submitAgainst(page: Page, refusal: Refusal, query = "") {
  const posted: Array<Record<string, string>> = [];
  await page.route("**/api/emails/do-reset-password", async (route) => {
    posted.push(JSON.parse(route.request().postData() || "{}"));
    await route.fulfill({
      status: refusal.status,
      contentType: "application/json",
      headers: refusal.headers,
      body: JSON.stringify(refusal.body),
    });
  });
  await page.goto(`/reset-password?token=reset-fixture-token${query}`);
  // The form is server-rendered; a click before hydration reaches no handler.
  await expect(page.locator('form[data-hydrated="true"]')).toBeAttached({
    timeout: 20_000,
  });
  await page.locator("#new-password").fill("password123");
  await page.locator("#confirm-password").fill("password123");
  await page.locator("#reset-otp-token").fill("123456");
  await page.locator('form button[type="submit"]').click();
  await expect.poll(() => posted.length).toBe(1);
  return page.getByRole("alert");
}

test("a weak password says why and asks for a different one", async ({
  page,
}) => {
  const alert = await submitAgainst(page, {
    status: 400,
    body: {
      message: "This password is too common.",
      code: "password_invalid",
      password_errors: [
        {
          code: "password_too_common",
          message: "This password is too common.",
        },
      ],
    },
  });
  await expect(alert).toHaveText(
    "This password is too common. Choose a different password and try again.",
  );
});

test("a wrong authenticator code asks for the current code", async ({
  page,
}) => {
  const alert = await submitAgainst(page, {
    status: 400,
    body: { message: "Invalid OTP token.", code: "invalid_otp" },
  });
  await expect(alert).toHaveText(
    "That authenticator code wasn't accepted. Enter the current code from your authenticator app and try again.",
  );
});

test("a rate limit says how long to wait", async ({ page }) => {
  const alert = await submitAgainst(page, {
    status: 429,
    headers: { "Retry-After": "37" },
    body: {
      detail: "Request was throttled. Expected available in 37 seconds.",
    },
  });
  await expect(alert).toHaveText(
    "Too many attempts. Wait 37 seconds and try again — your reset link still works.",
  );
});

test("only an expired link is called expired", async ({ page }) => {
  const alert = await submitAgainst(page, {
    status: 400,
    body: { message: "Token has expired.", code: "token_expired" },
  });
  await expect(alert).toHaveText(
    "This reset link has expired. Request a new password reset email.",
  );
  await expect(alert).not.toHaveText(OLD_EXPIRED);
});

test("the reason is translated, not only the English copy", async ({
  page,
}) => {
  const alert = await submitAgainst(
    page,
    {
      status: 400,
      body: { message: "Invalid OTP token.", code: "invalid_otp" },
    },
    "&lang=es",
  );
  await expect(alert).toHaveText(
    "No se aceptó ese código del autenticador. Introduce el código actual de tu aplicación de autenticación e inténtalo de nuevo.",
  );
});

test("successful password reset survives authentication and navigation until acknowledged", async ({
  page,
}) => {
  let reset = false;
  await page.route("**/api/auth/user/", (route) =>
    route.fulfill(
      reset
        ? { json: { id: 7312, username: "reset-user", tuzis: "33" } }
        : { status: 401, json: {} },
    ),
  );
  await page.route("**/api/emails/do-reset-password", async (route) => {
    reset = true;
    await route.fulfill({
      json: { message: "Password reset" },
      headers: {
        "set-cookie":
          "sessionid=reset-password-success-session; Path=/; SameSite=Lax",
      },
    });
  });
  await page.goto("/reset-password?token=reset-fixture-token");
  await expect(page.locator('form[data-hydrated="true"]')).toBeAttached({
    timeout: 20_000,
  });
  await page.locator("#new-password").fill("password123");
  await page.locator("#confirm-password").fill("password123");
  await page.locator('form button[type="submit"]').click();
  await expect(page).toHaveURL(/\/$/);
  const notice = page
    .locator("[data-sonner-toast]")
    .filter({ hasText: "Password reset. You're now signed in." });
  await expect(notice).toBeVisible();
  await page.waitForTimeout(4500);
  await expect(notice).toBeVisible();
  await notice.getByRole("button", { name: "Close notification" }).click();
  await expect(notice).toHaveCount(0);
});
