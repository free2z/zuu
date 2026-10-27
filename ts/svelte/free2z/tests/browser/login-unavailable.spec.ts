import { expect, test, type Page } from "@playwright/test";

//  the credential throttles fail CLOSED: while their Redis is down,
// /api/auth/login/ and /api/start/ answer 503 with a `detail`. The store
// turns that into AUTH_UNAVAILABLE_CODE, and this pins the half the node
// tests cannot see: the MODAL shows the server's sentence, not "Login
// failed" (which reads as a wrong password and sends people to reset one).
//
// NEGATIVE CONTROL: drop AUTH_UNAVAILABLE_CODE from STORE_SENTENCE_CODES in
// UnifiedAuthModal.svelte and this goes red on the "Login failed" text.

const DESKTOP_VIEWPORT = { width: 1280, height: 900 };
const DETAIL =
  "Sign-in is temporarily unavailable. Please try again in a minute.";

async function installUnavailableMocks(page: Page, calls: string[]) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (!pathname.startsWith("/api/")) {
      await route.continue();
      return;
    }
    if (request.method() === "POST") calls.push(pathname);
    if (pathname === "/api/auth/user/") {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ detail: "Not authenticated" }),
      });
      return;
    }
    if (
      (pathname === "/api/auth/login/" || pathname === "/api/start/") &&
      request.method() === "POST"
    ) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        headers: { "Retry-After": "30" },
        body: JSON.stringify({ detail: DETAIL }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ count: 0, next: null, results: [] }),
    });
  });
}

test("a 503 from the sign-in throttle shows its detail in the modal, not 'Login failed'", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  const calls: string[] = [];
  await installUnavailableMocks(page, calls);

  await page.goto("/login");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.locator("#username").fill("fixtureowner");
  await dialog.locator("#password").fill("correct-password");
  await dialog.getByRole("button", { name: "Log in" }).click();

  await expect(dialog.getByText(DETAIL)).toBeVisible({ timeout: 20_000 });
  await expect(dialog.getByText("Login failed")).toHaveCount(0);
  expect(calls).toContain("/api/auth/login/");
});
