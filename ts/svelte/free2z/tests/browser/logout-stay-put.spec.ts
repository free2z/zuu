import { expect, test, type Page } from "@playwright/test";

//  signing out used to throw the visitor to the homepage from
// everywhere. A public page now keeps its URL and gets a NEW DOCUMENT
// (`window.location.reload()`), so everything fetched under the old session
// is discarded exactly as before; a page that needs a session still leaves
// for `/`.
//
// Two things are asserted on the public page, and they are different
// properties:
//   - the URL is unchanged (the UX fix);
//   - the document was replaced — a `window` marker set before the click is
//     gone after it, and content the mock only served to the authenticated
//     session is gone with it (the privacy control).
//
// NEGATIVE CONTROLS: swapping `window.location.reload()` for
// `goto(window.location.href, { invalidateAll: true })` in
// src/lib/stores/auth.ts keeps the URL and turns the marker assertion red;
// restoring the unconditional `assign("/")` turns the URL assertion red.

const DESKTOP_VIEWPORT = { width: 1280, height: 900 };
const FIXTURE_USER = "fixtureowner";
const FIXTURE_SESSION = "billing-fixture-session";
const PRIVATE_MARKER = "Private converse draft only a session can see";

const TEST_CREATOR = {
  id: 1461,
  username: FIXTURE_USER,
  full_name: "Fixture Owner",
};

async function installAuthenticatedMocks(page: Page, baseURL: string) {
  let authenticated = true;

  await page
    .context()
    .addCookies([{ name: "sessionid", value: FIXTURE_SESSION, url: baseURL }]);
  await page.addInitScript((creator) => {
    localStorage.setItem(
      "auth",
      JSON.stringify({ isAuthenticated: true, creator, loading: false }),
    );
  }, TEST_CREATOR);

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (!pathname.startsWith("/api/")) {
      await route.continue();
      return;
    }
    if (pathname === "/api/auth/user/") {
      await route.fulfill({
        status: authenticated ? 200 : 401,
        contentType: "application/json",
        body: JSON.stringify(
          authenticated ? TEST_CREATOR : { detail: "Not authenticated" },
        ),
      });
      return;
    }
    if (pathname === "/api/auth/logout/") {
      authenticated = false;
      await page.context().clearCookies();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ detail: "Logged out" }),
      });
      return;
    }
    if (pathname === "/api/comments/") {
      // A post the authenticated session can see and the anonymous one cannot.
      const results = authenticated
        ? [
            {
              uuid: "private-1461",
              parent: null,
              headline: "",
              content: PRIVATE_MARKER,
              tuzis: 1,
              num_children: "0",
              tags: [],
              content_url: null,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              author: { username: FIXTURE_USER, avatar_image: null },
            },
          ]
        : [];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ count: results.length, next: null, results }),
      });
      return;
    }
    if (pathname === "/api/emails/status") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          email: null,
          confirmed: false,
          pending: false,
          is_public: false,
          get_notifications: false,
        }),
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

async function logOut(page: Page) {
  await page.getByTestId("navbar-profile-trigger").click();

  // The click's async handler POSTs to /api/auth/logout/, then issues a REAL
  // navigation (`window.location.reload()` or `.assign("/")`) — never a
  // client-side one (see src/lib/stores/auth.ts). Before that navigation
  // fires, the store update it kicks off (`clearAuthState()`) already
  // reaches this SAME document reactively, so "navbar-auth-trigger" can
  // become visible pre-navigation for a moment. Racing a follow-up
  // `page.evaluate` against the navigation that follows throws "Execution
  // context was destroyed" about 1 run in 15. `waitForEvent`
  // must be armed *before* the click that triggers the navigation, so
  // `Promise.all` — not a bare `await` after the click, which can lose the
  // race the other way if the mock API resolves fast.
  await Promise.all([
    page.waitForEvent("load"),
    page.getByText("Log out", { exact: true }).click(),
  ]);
}

test("logging out on a public Converse thread keeps the URL and replaces the document", async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await installAuthenticatedMocks(page, baseURL!);

  await page.goto("/converse?sort=new#top");
  await expect(page.locator("#converse-content")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText(PRIVATE_MARKER)).toBeVisible();
  await page.evaluate(() => {
    (window as any).__f2zLogoutProbe = "old document";
  });

  await logOut(page);

  // Still here — query and fragment included.
  await expect(page.getByTestId("navbar-auth-trigger")).toBeVisible({
    timeout: 20_000,
  });
  expect(new URL(page.url()).pathname).toBe("/converse");
  expect(new URL(page.url()).search).toBe("?sort=new");
  expect(new URL(page.url()).hash).toBe("#top");

  // …but in a NEW document: the probe did not survive, and neither did what
  // the authenticated session had fetched.
  expect(
    await page.evaluate(() => (window as any).__f2zLogoutProbe ?? null),
  ).toBeNull();
  await expect(page.getByText(PRIVATE_MARKER)).toHaveCount(0);
  await expect(
    page.locator('[data-testid="converse-login-prompt"]'),
  ).toBeVisible();
});

test("logging out on a session-only page still leaves for the homepage", async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await installAuthenticatedMocks(page, baseURL!);

  await page.goto(`/${FIXTURE_USER}/dashboard/settings`);
  await expect(page.getByTestId("navbar-profile-trigger")).toBeVisible({
    timeout: 20_000,
  });

  await logOut(page);

  await expect(page).toHaveURL("/", { timeout: 20_000 });
  await expect(page.getByTestId("navbar-auth-trigger")).toBeVisible();
});
