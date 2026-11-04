import { expect, test, type Page } from "@playwright/test";

//  server guards used to redirect an anonymous visitor to
// `/?login=true`, an ordinary homepage with no prompt. They now send the
// visitor to the real `/login` with a safely encoded `?next=`, the modal opens
// on arrival, and a successful login returns to the page that was asked for.
// One protected loader (the settings dashboard), one protected form action
// (billing checkout), and the editor's client-side load are covered.
//
//  `?reason=` puts a sentence inside the modal explaining why the
// visitor is looking at a login screen after an email change signed them out
// everywhere.
//
// NEGATIVE CONTROLS: `redirect(302, "/?login=true")` back in
// settings/+page.server.ts turns the first test red on the Location header;
// dropping `notice` from UnifiedAuthModal turns the reason test red.

const DESKTOP_VIEWPORT = { width: 1280, height: 900 };
// The mock API (tests/browser/mock-api.mjs) answers /api/auth/user/ for this
// session with `fixtureowner`, which is what the SSR guard needs to let the
// dashboard render once the browser holds the cookie.
const FIXTURE_USER = "fixtureowner";
const FIXTURE_SESSION = "billing-fixture-session";
const SETTINGS_PATH = `/${FIXTURE_USER}/dashboard/settings`;

async function installClientMocks(page: Page) {
  let authenticated = false;
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
          authenticated
            ? { id: 8106, username: FIXTURE_USER, full_name: "Fixture Owner" }
            : { detail: "Not authenticated" },
        ),
      });
      return;
    }
    if (pathname === "/api/auth/login/" && request.method() === "POST") {
      // The cookie the SSR guard will read on the way back to the dashboard.
      await page.context().addCookies([
        {
          name: "sessionid",
          value: FIXTURE_SESSION,
          url: new URL(page.url()).origin,
        },
      ]);
      authenticated = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ key: "session" }),
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

test("an anonymous dashboard visit lands on /login?next=, opens login at once, and returns after signing in", async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await installClientMocks(page);

  // The first hop is the guard's own answer, before any client code runs.
  const hop = await page.request.get(`${baseURL}${SETTINGS_PATH}`, {
    maxRedirects: 0,
  });
  expect(hop.status()).toBe(302);
  expect(hop.headers()["location"]).toBe(
    `/login?next=${encodeURIComponent(SETTINGS_PATH)}`,
  );

  await page.goto(SETTINGS_PATH);
  await expect(page).toHaveURL(
    `/login?next=${encodeURIComponent(SETTINGS_PATH)}`,
  );
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("#username")).toBeVisible();

  await dialog.locator("#username").fill(FIXTURE_USER);
  await dialog.locator("#password").fill("correct-password");
  await dialog.getByRole("button", { name: "Log in" }).click();

  await expect(page).toHaveURL(SETTINGS_PATH, { timeout: 20_000 });
  await expect(page.getByTestId("navbar-profile-trigger")).toBeVisible();
});

test("an anonymous protected form action redirects to /login and returns to the page, not the action", async ({
  page,
  baseURL,
}) => {
  const billingPath = `/${FIXTURE_USER}/dashboard/billing`;
  const response = await page.request.post(
    `${baseURL}${billingPath}?/checkout`,
    {
      maxRedirects: 0,
      headers: { origin: baseURL! },
      form: { amount: "100", method: "stripe" },
    },
  );
  // SvelteKit answers a fetch-shaped POST with a JSON redirect envelope and
  // a browser form post with a 303; both must name the page, not the action.
  const expected = `/login?next=${encodeURIComponent(billingPath)}`;
  if (response.status() === 200) {
    expect(await response.json()).toEqual({
      type: "redirect",
      status: 302,
      location: expected,
    });
  } else {
    expect([302, 303]).toContain(response.status());
    expect(response.headers()["location"]).toBe(expected);
  }
});

test("the editor's client-side guard sends an expired session to /login and back to the same draft", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await installClientMocks(page);

  await page.goto("/edit?id=42");
  await expect(page).toHaveURL("/login?next=%2Fedit%3Fid%3D42", {
    timeout: 20_000,
  });
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("?reason=email-changed explains the sign-out inside the login modal", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await installClientMocks(page);

  await page.goto(
    `/login?next=${encodeURIComponent(SETTINGS_PATH)}&reason=email-changed`,
  );
  const notice = page.getByTestId("auth-modal-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("Your email address was changed");
  await expect(notice).toContainText("signed out on every device");

  // Unknown reasons render nothing rather than whatever the URL says.
  await page.goto("/login?reason=You%20were%20hacked%20call%20now");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByTestId("auth-modal-notice")).toHaveCount(0);
});

//  codex review, finding 1. AuthModalHost mounts ONE UnifiedAuthModal for
// the whole app, so `initialView` now changes on a LIVE instance. It used to be
// read once at construction, which made `?view=signup` open the login form —
// a new creator submitting their chosen credentials got "Login failed".
//
// NEGATIVE CONTROL: delete the `viewAppliedForOpen` reactive block in
// UnifiedAuthModal.svelte and this test finds #username instead of
// #signup-username.
test("?view=signup opens the signup form, not the login form", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await installClientMocks(page);

  await page.goto(
    `/login?view=signup&next=${encodeURIComponent(SETTINGS_PATH)}`,
  );
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("#signup-username")).toBeVisible();
  await expect(dialog.locator("#confirm-password")).toBeVisible();
  // The login form's own username field is a different id; it must be gone.
  await expect(dialog.locator("#username")).toHaveCount(0);

  // And the default is still the login form on the very next open.
  await page.goto("/login");
  await expect(page.getByRole("dialog").locator("#username")).toBeVisible();
});

//  codex review, finding 2. OTPModal dispatches `close` only from its own
// close()/goBack(); Escape, a click outside and the dialog's X just flip its
// bound `open`. The store therefore stayed "open" with no dialog on screen and
// `/login` hid its own fallback behind `{#if !$authModal.open}`.
//
// NEGATIVE CONTROL: delete the `$authModal.open && !showAuthModal &&
// !showOTPModal` block in AuthModalHost.svelte and the "Open login" button
// never comes back.
test("dismissing the OTP step with Escape closes the shared modal state", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  let loginAttempts = 0;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (!pathname.startsWith("/api/")) {
      await route.continue();
      return;
    }
    if (pathname === "/api/auth/login/" && request.method() === "POST") {
      loginAttempts += 1;
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ non_field_errors: ["Invalid OTP token"] }),
      });
      return;
    }
    if (pathname === "/api/auth/user/") {
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
      body: JSON.stringify({ count: 0, next: null, results: [] }),
    });
  });

  await page.goto("/login");
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator("#username")).toBeVisible();
  await dialog.locator("#username").fill("mfa-user");
  await dialog.locator("#password").fill("correct-password");
  await dialog.getByRole("button", { name: "Log in" }).click();

  // The password step handed off to the OTP step.
  await expect(page.locator("#otpCode")).toBeVisible({ timeout: 20_000 });
  expect(loginAttempts).toBe(1);

  // Escape is the path OTPModal's own close() never sees.
  await page.keyboard.press("Escape");
  await expect(page.locator("#otpCode")).toHaveCount(0);

  // The page's fallback is back, so the visitor has a way in again.
  await expect(page.getByRole("button", { name: "Open login" })).toBeVisible();
  await page.getByRole("button", { name: "Open login" }).click();
  await expect(page.getByRole("dialog").locator("#username")).toBeVisible();
});

test("email status failure blocks ownership changes until a successful retry", async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  let authenticated = false;
  let statusRequests = 0;
  let updates = 0;
  let signedOut = false;
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (!pathname.startsWith("/api/")) {
      await route.continue();
      return;
    }
    if (pathname === "/api/auth/user/") {
      await route.fulfill({
        status: signedOut || !authenticated ? 401 : 200,
        json:
          signedOut || !authenticated
            ? { detail: "Not authenticated" }
            : { id: 8106, username: FIXTURE_USER, full_name: "Fixture Owner" },
      });
      return;
    }
    if (pathname === "/api/auth/login/") {
      authenticated = true;
      await page
        .context()
        .addCookies([
          { name: "sessionid", value: FIXTURE_SESSION, url: baseURL! },
        ]);
      await route.fulfill({ json: { key: "session" } });
      return;
    }
    if (pathname === "/api/emails/status") {
      statusRequests += 1;
      await route.fulfill(
        statusRequests === 1
          ? { status: 503, json: { detail: "Unavailable" } }
          : {
              json: {
                email: "confirmed@example.test",
                confirmed: true,
                pending: false,
                is_public: false,
                get_notifications: false,
              },
            },
      );
      return;
    }
    if (pathname === "/api/emails/add") {
      updates += 1;
      signedOut = true;
      await page.context().clearCookies();
      await route.fulfill({ json: { status: "success" } });
      return;
    }
    await route.fulfill({ json: { count: 0, results: [] } });
  });
  await page.goto(`/login?next=${encodeURIComponent(SETTINGS_PATH)}`);
  const dialog = page.getByRole("dialog");
  await dialog.locator("#username").fill(FIXTURE_USER);
  await dialog.locator("#password").fill("correct-password");
  await dialog.getByRole("button", { name: "Log in", exact: true }).click();
  await expect(page).toHaveURL(SETTINGS_PATH);
  await page.getByRole("tab", { name: "Account", exact: true }).click();
  await expect(
    page.getByText("Failed to fetch email status.", { exact: true }),
  ).toBeVisible();
  await page.locator("#primaryEmail").fill("replacement@example.test");
  await expect(
    page.getByRole("button", { name: "Update", exact: true }),
  ).toBeDisabled();
  expect(updates).toBe(0);
  await page.getByRole("button", { name: "Retry email status" }).click();
  await expect(page.getByTestId("email-signout-warning")).toBeVisible();
  await page.getByRole("button", { name: "Update", exact: true }).click();
  await expect(page).toHaveURL(
    `/login?next=${encodeURIComponent(SETTINGS_PATH)}&reason=email-changed`,
  );
  await expect(page.getByTestId("auth-modal-notice")).toContainText(
    "Your email address was changed",
  );
  expect(updates).toBe(1);
});

test("leaving the login route dismisses its modal and return callback", async ({
  page,
}) => {
  await installClientMocks(page);
  const loginDialog = page
    .getByRole("dialog")
    .filter({ has: page.locator("#username") });
  async function openMobileLoginPrompt() {
    await expect(page.locator('main[data-hydrated="true"]')).toBeVisible();
    await page
      .getByRole("button", { name: "New conversation", exact: true })
      .click();
    await page.getByTestId("converse-login-prompt").click();
  }
  let releaseLogin: (() => Promise<void>) | undefined;
  await page.route("**/api/auth/login/", (route) => {
    releaseLogin = () =>
      route.fulfill({
        status: 400,
        json: { non_field_errors: ["Invalid OTP token"] },
      });
  });
  await Promise.all([
    page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/auth/user/",
    ),
    page.goto("/converse"),
  ]);
  await openMobileLoginPrompt();
  await expect(loginDialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(loginDialog).toHaveCount(0);
  // The first Escape dismisses auth; the second dismisses the mobile composer.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.evaluate(() => {
    (
      window as Window & { authNavigationMarker?: string }
    ).authNavigationMarker = "same-document";
    const link = document.createElement("a");
    link.href = "/login?next=%2Ffixtureowner%2Fdashboard%2Fsettings";
    document.body.append(link);
    link.click();
    link.remove();
  });
  await expect(loginDialog).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as Window & { authNavigationMarker?: string })
          .authNavigationMarker,
    ),
  ).toBe("same-document");
  const oldDialog = loginDialog;
  await oldDialog.locator("#username").fill("old-mfa-account");
  await oldDialog.locator("#password").fill("correct-password");
  await oldDialog.getByRole("button", { name: "Log in", exact: true }).click();
  await expect.poll(() => Boolean(releaseLogin)).toBe(true);
  await page.goBack();
  await expect(page).toHaveURL("/converse");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await openMobileLoginPrompt();
  const completed = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/auth/login/",
  );
  await releaseLogin!();
  await (await completed).finished();
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await expect(page.locator("#otpCode")).toHaveCount(0);
  await expect(loginDialog.locator("#username")).toBeEnabled();
  await loginDialog.locator("#username").fill("new-account");
});

for (const action of ["bob", "logout"] as const) {
  test(`a delayed login is completed before the later ${action} session mutation`, async ({
    page,
  }) => {
    let releaseAlice: (() => Promise<void>) | undefined;
    const exchanges: string[] = [];
    await page.route(
      (url) => url.pathname.startsWith("/api/"),
      async (route) => {
        const request = route.request();
        const pathname = new URL(request.url()).pathname;
        if (pathname === "/api/auth/login/") {
          const username = request.postDataJSON().username;
          exchanges.push(`${username}-request`);
          const reply = async () => {
            exchanges.push(`${username}-response`);
            await route.fulfill({
              json: { key: "session" },
              headers: {
                "set-cookie": `sessionid=${username}-session; Path=/; SameSite=Lax`,
              },
            });
          };
          if (username === "alice") releaseAlice = reply;
          else await reply();
          return;
        }
        if (pathname === "/api/auth/logout/") {
          exchanges.push("logout-request");
          await route.fulfill({
            json: {},
            headers: {
              "set-cookie": "sessionid=; Path=/; Max-Age=0; SameSite=Lax",
            },
          });
          return;
        }
        if (pathname === "/api/auth/user/") {
          const cookie = request.headers().cookie || "";
          const username = cookie.includes("bob-session")
            ? "bob"
            : cookie.includes("alice-session")
              ? "alice"
              : null;
          await route.fulfill(
            username
              ? { json: { username } }
              : { status: 401, json: { detail: "Not authenticated" } },
          );
          return;
        }
        await route.fulfill({ json: { count: 0, results: [] } });
      },
    );
    await page.goto("/login");
    let dialog = page.getByRole("dialog");
    await dialog.locator("#username").fill("alice");
    await dialog.locator("#password").fill("fixture-password");
    await dialog.getByRole("button", { name: "Log in", exact: true }).click();
    await expect.poll(() => Boolean(releaseAlice)).toBe(true);
    await page.keyboard.press("Escape");
    if (action === "bob") {
      await page
        .getByRole("button", { name: "Open login", exact: true })
        .click();
      dialog = page.getByRole("dialog");
      await dialog.locator("#username").fill("bob");
      await dialog.locator("#password").fill("fixture-password");
      await dialog.getByRole("button", { name: "Log in", exact: true }).click();
      await expect(dialog.locator('button[type="submit"]')).toBeDisabled();
    } else {
      await page.evaluate(async () => {
        const modulePath = "/src/lib/stores/auth.ts";
        const { authStore } = await import(modulePath);
        void authStore.logout();
      });
    }
    await releaseAlice!();
    await expect(page).toHaveURL("/");
    const cookie = (await page.context().cookies()).find(
      (cookie) => cookie.name === "sessionid",
    )?.value;
    expect(cookie).toBe(action === "bob" ? "bob-session" : undefined);
    expect(exchanges).toEqual(
      action === "bob"
        ? ["alice-request", "alice-response", "bob-request", "bob-response"]
        : ["alice-request", "alice-response", "logout-request"],
    );
    if (action === "logout") {
      await expect(
        page.getByRole("button", { name: "Sign In", exact: true }),
      ).toBeVisible();
    } else {
      await expect
        .poll(() =>
          page.evaluate(async () => {
            const modulePath = "/src/lib/stores/auth.ts";
            const { authStore } = await import(modulePath);
            let username: string | undefined;
            authStore.subscribe(
              (state: { creator: { username: string } | null }) => {
                username = state.creator?.username;
              },
            )();
            return username;
          }),
        )
        .toBe("bob");
    }
  });
}
