import { expect, test, type Page } from "@playwright/test";

/**
 * The server's reason reaches the screen.
 *
 * Change-password used to answer every refusal with "Failed to update
 * password." while the API said `{"old_password": ["Incorrect password."]}`,
 * and "Mark all as read" failed silently. The unit tests
 * (`tests/api-errors.test.mjs`) pin the parser; this proves the sentence is
 * what a person actually sees, on a hand-rolled `apiFetch` surface and a
 * generated-client (`customInstance`) surface.
 */

// Fixture literals are duplicated in tests/browser/mock-api.mjs; keep in sync.
const SESSION = "billing-fixture-session";
const USER = "fixtureowner";

async function signIn(page: Page) {
  await page.context().clearCookies();
  await page
    .context()
    .addCookies([
      { name: "sessionid", value: SESSION, domain: "127.0.0.1", path: "/" },
    ]);
}

test("change password shows the server's reason, not a generic failure", async ({
  page,
}) => {
  await signIn(page);
  await page.route("**/api/emails/password-is-set", (route) =>
    route.fulfill({ json: { password_set: true } }),
  );
  let posted = 0;
  await page.route("**/api/emails/change-password", (route) => {
    posted += 1;
    return route.fulfill({
      status: 400,
      json: { old_password: ["Incorrect password."] },
    });
  });

  await page.goto(`/${USER}/dashboard/settings`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("tab", { name: "Security" }).click();

  await page.locator("#currentPassword").fill("not-my-password");
  await page.locator("#newPassword").fill("a-brand-new-passphrase");
  await page.locator("#confirmPassword").fill("a-brand-new-passphrase");
  await page.getByRole("button", { name: "Update Password" }).click();

  const error = page.getByTestId("password-change-error");
  await expect(error).toBeVisible();
  await expect(error).toHaveAttribute("role", "alert");
  await expect(error).toHaveText("Incorrect password.");
  await expect(page.getByText("Failed to update password.")).toHaveCount(0);
  //...and no confident success state after a refused request.
  await expect(page.getByText("Password updated successfully.")).toHaveCount(0);
  expect(posted).toBe(1);
});

test("mark all read says why it failed and does not claim success", async ({
  page,
}) => {
  await signIn(page);
  const unread = {
    id: "evt-2052",
    type: "PAGE_VOTE",
    read: false,
    amount: 2,
    contributor: { username: "alice" },
    payee: null,
    receiving_user: { username: USER },
    content_title: "A page",
    content_url: `/${USER}/a-page`,
    created_at: "2026-09-22T00:00:00Z",
  };
  await page.route(
    (url) => url.pathname.startsWith("/api/events/"),
    (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname === "/api/events/read/all/") {
        return route.fulfill({
          status: 503,
          json: { detail: "Notifications are read-only for maintenance." },
        });
      }
      if (pathname.includes("unread")) {
        return route.fulfill({
          json: { count: 1, unread_count: 1, recipient_username: USER },
        });
      }
      if (pathname.includes("has")) {
        return route.fulfill({ json: { has_events: true } });
      }
      return route.fulfill({
        json: { count: 1, next: null, previous: null, results: [unread] },
      });
    },
  );

  await page.goto(`/${USER}/dashboard/notifications`);
  await page.waitForLoadState("networkidle");
  const markAll = page.getByRole("button", { name: /Mark all/ });
  await expect(markAll).toBeVisible();
  await markAll.click();

  await expect(
    page.getByText("Notifications are read-only for maintenance."),
  ).toBeVisible();
  // Not a confident "all read": the unread count came back, so the control
  // offering to mark them is still there.
  await expect(markAll).toBeVisible();
  await expect(markAll).toBeEnabled();
});
