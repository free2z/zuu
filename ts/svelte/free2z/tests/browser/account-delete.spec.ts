import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * `/account/delete` — the account-deletion URL SDK apps link and Google Play
 * lists (Apple 5.1.1(v)). Backend: `dj.apps.g12f.account_deletion`.
 *
 * What these protect:
 * - signed out, the URL is a real page that says what deletion does, and its
 *   sign-in is a plain link to `/login?next=/account/delete` (the store
 *   reviewer and the Play listing land here without a session; a redirect
 *   away or a 404 fails review);
 * - the page never mounts the auth modal and never loads reCAPTCHA: only
 *   /login may (owner ruling) -- both sign-in and re-authentication leave
 *   for /login, re-authentication only after a confirmed sign-out;
 * - signed in, nothing is sent until the username is typed, a stale sign-in
 *   is answered with the re-authentication step (not an email), and the
 *   request carries exactly the typed username.
 *
 * The account calls are mocked at the browser so each test owns its data;
 * assertions on the write read the request the page SENT.
 *
 * NEGATIVE CONTROLS (run by hand): making `canDelete` ignore the typed
 * username turns "the delete button waits for the username" red; dropping
 * the `insufficient_user_authentication` branch in `deleteAccount` turns
 * "a stale sign-in asks to sign in again" red (the generic failure shows).
 */

const SESSION = "billing-fixture-session";

function json(route: Route, status: number, body: unknown) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: body === null ? "" : JSON.stringify(body),
  });
}

async function signedOut(page: Page) {
  await page.context().clearCookies();
}

// The shared mock API knows this session as `fixtureowner`.
async function signedIn(page: Page) {
  await page.context().clearCookies();
  await page
    .context()
    .addCookies([
      { name: "sessionid", value: SESSION, domain: "127.0.0.1", path: "/" },
    ]);
}

/**
 * Every request to Google's reCAPTCHA (the script, its frames, gstatic
 * assets) from the start. The app's own same-origin modules don't count:
 * they are code, not the third-party load the ruling is about.
 */
function watchRecaptcha(page: Page): string[] {
  const seen: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      /(^|\.)(google\.com|gstatic\.com|recaptcha\.net)$/i.test(url.hostname) &&
      /recaptcha/i.test(url.pathname + url.hostname)
    ) {
      seen.push(request.url());
    }
  });
  return seen;
}

const PREVIEW = {
  username: "fixtureowner",
  balance_2z: "12.500",
  connected_apps: 1,
  pages: 0,
  blockers: [] as string[],
};

test("signed out, the deletion URL explains and links to /login", async ({
  page,
}) => {
  await signedOut(page);
  const recaptcha = watchRecaptcha(page);
  await page.goto("/account/delete");

  await expect(
    page.getByRole("heading", { name: "Delete your Free2Z account" }),
  ).toBeVisible();
  await expect(page.getByTestId("account-delete-terms")).toContainText(
    "Payment, 2Z ledger and tax records are kept",
  );
  await expect(page.getByTestId("account-delete-signed-out")).toBeVisible();
  const signIn = page.getByRole("link", { name: "Sign in" });
  await expect(signIn).toBeVisible();
  const href = new URL(
    (await signIn.getAttribute("href")) || "",
    "http://placeholder",
  );
  expect(href.pathname).toBe("/login");
  expect(href.searchParams.get("next")).toBe("/account/delete");
  // Absence assertions sit behind a positive barrier: before hydration a
  // modal could not have mounted yet, so "no dialog" would prove nothing.
  await expect(page.locator('[data-hydrated="true"]')).toHaveCount(1);
  // An SDK-facing page ('s isSdkPage): no site chrome, so no navbar
  // sign-in either -- the page's own link is the only way in.
  await expect(page.getByTestId("navbar-brand")).toHaveCount(0);
  // Nothing on THIS page may mount the modal or reach reCAPTCHA.
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(recaptcha).toEqual([]);
  await signIn.click();
  await page.waitForURL((url) => url.pathname === "/login");
  expect(new URL(page.url()).searchParams.get("next")).toBe("/account/delete");
});

test("the delete button waits for the username, and a stale sign-in asks to sign in again", async ({
  page,
}) => {
  await signedIn(page);
  const posted: Record<string, unknown>[] = [];
  let answer: { status: number; body: unknown } = {
    status: 401,
    body: {
      code: "insufficient_user_authentication",
      detail: "Sign in again to delete your account.",
    },
  };
  await page.route(
    (url) =>
      url.pathname === "/api/auth/account-deletion/" ||
      url.pathname === "/api/auth/account-deletion/schedule/",
    (route) => {
      const request = route.request();
      if (request.method() === "GET") return json(route, 200, PREVIEW);
      // Requesting deletion never POSTs the preview's path (an old backend
      // deleted at once there).
      expect(new URL(request.url()).pathname).toBe(
        "/api/auth/account-deletion/schedule/",
      );
      posted.push(JSON.parse(request.postData() || "{}"));
      return json(route, answer.status, answer.body);
    },
  );
  const recaptcha = watchRecaptcha(page);
  await page.goto("/account/delete");

  const confirm = page.getByTestId("account-delete-confirm");
  // The session check and the preview both land after hydration.
  await expect(confirm).toContainText("@fixtureowner", { timeout: 20_000 });
  await expect(page.getByTestId("account-delete-balance")).toContainText(
    "12.5",
  );
  const submit = page.getByTestId("account-delete-submit");
  await expect(submit).toBeDisabled();
  await page.getByTestId("account-delete-username").fill("fixtureowne");
  await expect(submit).toBeDisabled();
  await page.getByTestId("account-delete-username").fill("fixtureowner");
  await expect(submit).toBeEnabled();

  await submit.click();
  await expect(page.getByTestId("account-delete-reauth")).toBeVisible();
  expect(posted).toEqual([{ confirm_username: "fixtureowner" }]);
  await expect(page.locator('[data-hydrated="true"]')).toHaveCount(1);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(recaptcha).toEqual([]);

  answer = {
    status: 202,
    body: {
      purge_after: "2026-11-13T22:00:00Z",
      username_free_after: "2026-12-13T22:00:00Z",
    },
  };
  await submit.click();
  // A request, not an erasure: the page says when, and how to keep it.
  const done = page.getByTestId("account-deleted");
  await expect(done).toBeVisible();
  await expect(done).toContainText("November 13, 2026");
  await expect(done).toContainText("sign in before then");
  await expect(done).toContainText("December 13, 2026");
  expect(posted).toHaveLength(2);
});

test("re-authentication signs out, then leaves for /login and comes back", async ({
  page,
}) => {
  await signedIn(page);
  await page.route(
    (url) =>
      url.pathname === "/api/auth/account-deletion/" ||
      url.pathname === "/api/auth/account-deletion/schedule/",
    (route) =>
      route.request().method() === "GET"
        ? json(route, 200, PREVIEW)
        : json(route, 401, { code: "insufficient_user_authentication" }),
  );
  const loggedOut: string[] = [];
  await page.route(
    (url) => url.pathname === "/api/auth/logout/",
    async (route) => {
      loggedOut.push(route.request().method());
      // What the real logout does to the browser: the session cookie goes.
      // (/login sends a visitor who still holds one straight back to next.)
      await page.context().clearCookies();
      return json(route, 200, {});
    },
  );
  const recaptcha = watchRecaptcha(page);
  await page.goto("/account/delete");
  await expect(page.getByTestId("account-delete-confirm")).toContainText(
    "@fixtureowner",
    { timeout: 20_000 },
  );
  await page.getByTestId("account-delete-username").fill("fixtureowner");
  await page.getByTestId("account-delete-submit").click();
  // Nothing on THIS page may mount the modal or reach reCAPTCHA.
  await expect(page.locator('[data-hydrated="true"]')).toHaveCount(1);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(recaptcha).toEqual([]);
  await page.getByTestId("account-delete-reauth-button").click();
  await page.waitForURL((url) => url.pathname === "/login");
  const landed = new URL(page.url());
  expect(loggedOut).toEqual(["POST"]);
  expect(landed.searchParams.get("next")).toBe("/account/delete");
  expect(landed.searchParams.get("reason")).toBe("delete-account");
});

test("a blocker explains instead of offering the delete button", async ({
  page,
}) => {
  await signedIn(page);
  await page.route(
    (url) =>
      url.pathname === "/api/auth/account-deletion/" ||
      url.pathname === "/api/auth/account-deletion/schedule/",
    (route) => json(route, 200, { ...PREVIEW, blockers: ["earnings_owed"] }),
  );
  await page.goto("/account/delete");
  await expect(page.getByTestId("account-delete-blocked")).toContainText(
    "help@free2z.com",
    { timeout: 20_000 },
  );
  await expect(page.getByTestId("account-delete-submit")).toHaveCount(0);
});

// X-only accounts: /login?next=/account/delete offering "Sign in with
// X" and carrying the return path is pinned by 's oauth-apps.spec.ts; an
// X sign-in to an account in its deletion grace period landing on the keep
// page (never a session) is pinned server-side in
// py/dj/apps/g12f/test_account_deletion_grace.py.

test("the connected-apps list links deletion once; the focused manage view keeps its own", async ({
  page,
}) => {
  await signedIn(page);
  await page.route(
    (url) => url.pathname === "/api/oauth/grants/",
    (route) => json(route, 200, []),
  );
  await page.goto("/account/apps");
  const link = page.getByTestId("connected-apps-delete-account");
  await expect(link).toHaveAttribute("href", "/account/delete", {
    timeout: 20_000,
  });
  await expect(page.getByTestId("manage-delete-account")).toHaveCount(0);

  // The focused `?client_id=` view: one delete link, its own, never two.
  await page.goto("/account/apps?client_id=aha-test.client_1");
  await expect(page.getByTestId("manage-delete-account")).toHaveCount(1, {
    timeout: 20_000,
  });
  await expect(page.getByTestId("connected-apps-delete-account")).toHaveCount(
    0,
  );
});

test("the keep page asks first, strips the token, and keeps on request", async ({
  page,
}) => {
  await signedOut(page);
  const kept: Record<string, unknown>[] = [];
  await page.route(
    (url) => url.pathname === "/api/auth/account-deletion/keep/",
    (route) => {
      kept.push(JSON.parse(route.request().postData() || "{}"));
      return json(route, 200, { username: "fixtureowner" });
    },
  );
  await page.goto("/account/keep#t=keep-token-1&d=2026-11-13T22%3A00%3A00Z");
  const ask = page.getByTestId("account-keep-ask");
  await expect(ask).toContainText("November 13, 2026", { timeout: 20_000 });
  // The token never stays in the address bar or history.
  expect(new URL(page.url()).hash).toBe("");
  expect(kept).toEqual([]); // nothing is sent until the holder chooses
  await page.getByTestId("account-keep-confirm").click();
  await expect(page.getByTestId("account-kept")).toContainText("connect again");
  expect(kept).toEqual([{ keep_token: "keep-token-1" }]);
});

test("cancel on the keep page sends nothing; an expired token says so", async ({
  page,
}) => {
  await signedOut(page);
  const kept: string[] = [];
  await page.route(
    (url) => url.pathname === "/api/auth/account-deletion/keep/",
    (route) => {
      kept.push("called");
      return json(route, 400, { code: "keep_token_invalid" });
    },
  );
  await page.goto("/account/keep#t=keep-token-2&d=2026-11-13T22%3A00%3A00Z");
  await page.getByTestId("account-keep-cancel").click({ timeout: 20_000 });
  await expect(page.getByTestId("account-keep-left")).toBeVisible();
  expect(kept).toEqual([]);

  // A fresh document, as a sign-in redirect always is (a same-path hash
  // change would not remount the page).
  await page.goto("about:blank");
  await page.goto("/account/keep#t=keep-token-3");
  await page.getByTestId("account-keep-confirm").click({ timeout: 20_000 });
  await expect(page.getByTestId("account-keep-invalid")).toBeVisible();
});

test("a keep resumes where the sign-in was headed, inside the SDK chrome", async ({
  page,
}) => {
  await signedOut(page);
  await page.route(
    (url) => url.pathname === "/api/auth/account-deletion/keep/",
    (route) => json(route, 200, { username: "fixtureowner" }),
  );
  const authorize = "/oauth/authorize?client_id=aha&state=s1";
  await page.goto(
    `/account/keep#t=keep-token-4&d=2026-11-13T22%3A00%3A00Z&n=${encodeURIComponent(authorize)}`,
  );
  await expect(page.getByTestId("account-keep-ask")).toBeVisible({
    timeout: 20_000,
  });
  // SDK-facing (an app's sign-in may land here): no site navigation.
  await expect(page.getByTestId("navbar-brand")).toHaveCount(0);
  await Promise.all([
    page.waitForURL((url) => url.pathname === "/oauth/authorize", {
      timeout: 20_000,
    }),
    page.getByTestId("account-keep-confirm").click(),
  ]);
  expect(new URL(page.url()).searchParams.get("state")).toBe("s1");
});

test("an unsafe resume target is dropped", async ({ page }) => {
  await signedOut(page);
  await page.route(
    (url) => url.pathname === "/api/auth/account-deletion/keep/",
    (route) => json(route, 200, { username: "fixtureowner" }),
  );
  await page.goto("/account/keep#t=keep-token-5&n=%2F%2Fevil.example%2Fsteal");
  await page.getByTestId("account-keep-confirm").click({ timeout: 20_000 });
  await expect(page.getByTestId("account-kept")).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/account/keep");
});

test("cancelling a keep from an app's sign-in offers no way into the site", async ({
  page,
}) => {
  await signedOut(page);
  const authorize = "/oauth/authorize?client_id=aha&state=s2";
  await page.goto(
    `/account/keep#t=keep-token-6&n=${encodeURIComponent(authorize)}`,
  );
  await page.getByTestId("account-keep-cancel").click({ timeout: 20_000 });
  const left = page.getByTestId("account-keep-left");
  await expect(left).toBeVisible();
  await expect(left.locator('a[href="/"]')).toHaveCount(0);
  await expect(page.getByTestId("navbar-brand")).toHaveCount(0);
});
