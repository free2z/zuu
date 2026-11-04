import { expect, test, type Page } from "@playwright/test";

// Issue  — The desktop navbar NotificationBell was missing pathname awareness,
// so visiting /<username>/dashboard/notifications did not mark the bell as active
// with aria-current="page" or the primary accent color.
//
// Requirements:
// 1. The desktop notification bell is visibly active (accent color) and has aria-current="page"
//    on the authenticated user's notifications route.
// 2. It becomes inactive after client-side navigation away (no stale state).
// 3. Unrelated routes and unrelated users' notifications pages do not mark the bell active.
// 4. When the notification socket is offline/retrying, amber warning styling takes precedence
//    over active-route styling, while aria-current="page" remains accessible.

const DESKTOP_VIEWPORT = { width: 1280, height: 900 };

const FIXTURE_SESSION = "profile-fixture-session";
const FIXTURE_USER = "profilefixture";
const FIXTURE_CREATOR = {
  id: 1295,
  username: FIXTURE_USER,
  full_name: "Profile Fixture",
};

// Negative lookbehind ensures we assert the standalone utility class, not hover: or focus-visible: modifiers
const ACCENT_CLASS_REGEX = /(?<!:)\btext-\(--f2z-accent-primary\)/;
const FAST_LANE_MS = 1000 + 3000 + 7000 + 15000 + 30000 * 5 + 9 * 1000;

async function authenticate(
  page: Page,
  creator = FIXTURE_CREATOR,
  session = FIXTURE_SESSION,
) {
  await page.context().clearCookies();
  await page
    .context()
    .addCookies([
      { name: "sessionid", value: session, domain: "127.0.0.1", path: "/" },
    ]);

  await page.addInitScript((creator) => {
    localStorage.setItem(
      "auth",
      JSON.stringify({
        status: "authenticated",
        isAuthenticated: true,
        creator,
        loading: false,
      }),
    );
  }, creator);

  // SSR reaches the real profile fixture through PRIVATE_API_BASE_URL. Client
  // fetches instead hit Vite's /api proxy, whose development target is the
  // intentionally absent localhost:8000. Keep both halves authenticated with
  // the same creator; otherwise the navbar races between its cached session
  // and an unresolved client revalidation.
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (!pathname.startsWith("/api/")) {
      await route.continue();
      return;
    }

    if (pathname === "/api/auth/user/") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(creator),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ count: 0, results: [], next: null }),
    });
  });
}

async function failEveryWebSocket(page: Page) {
  await page.addInitScript(() => {
    class DeadSocket {
      onopen: ((event?: unknown) => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: ((event?: unknown) => void) | null = null;
      onerror: ((event?: unknown) => void) | null = null;

      constructor() {
        setTimeout(() => {
          this.onerror?.({});
          this.onclose?.({ code: 1006 });
        }, 10);
      }

      close() {
        setTimeout(() => this.onclose?.({ code: 1000 }), 0);
      }

      send() {}
    }

    Object.defineProperty(window, "WebSocket", {
      configurable: true,
      writable: true,
      value: DeadSocket,
    });
  });
}

async function hydratedNotificationBell(page: Page) {
  const bell = page.getByTestId("navbar-notifications");
  // A cold Vite worker can finish the server render several seconds before it
  // transforms and hydrates the client navbar. Requiring the authenticated
  // bell itself keeps this a state gate, not an arbitrary sleep.
  await expect(bell).toBeVisible({ timeout: 15_000 });
  return bell;
}

test.describe("navbar notification bell active state", () => {
  // The first route transform on a cold Vite worker can consume most of
  // Playwright's 30-second default before the browser begins hydrating.
  test.describe.configure({ timeout: 90_000 });

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await authenticate(page);
  });

  test("the notification bell is marked active on the authenticated user notifications route", async ({
    page,
  }) => {
    await page.goto(`/${FIXTURE_USER}/dashboard/notifications`, {
      waitUntil: "domcontentloaded",
    });

    const bell = await hydratedNotificationBell(page);
    await expect(bell).toHaveAttribute("aria-current", "page");
    await expect(bell).toHaveClass(ACCENT_CLASS_REGEX);
  });

  test("the notification bell is active on a notifications sub-route", async ({
    page,
  }) => {
    await page.goto(`/${FIXTURE_USER}/dashboard/notifications/settings`, {
      waitUntil: "domcontentloaded",
    });

    const bell = await hydratedNotificationBell(page);
    await expect(bell).toHaveAttribute("aria-current", "page");
    await expect(bell).toHaveClass(ACCENT_CLASS_REGEX);
  });

  test("the notification bell is active for a mixed-charset username whose URL encoding matches neither raw nor encodeURIComponent comparison alone", async ({
    page,
  }) => {
    // `kévin+f2z` exercises the gap: URL.pathname percent-encodes non-ASCII
    // but leaves `+` alone, while encodeURIComponent encodes `+` as %2B AND
    // the non-ASCII — so neither naive comparison can match. The fixture user
    // has no server-side SSR profile, so reach the route client-side (same
    // pattern as the other-user case below).
    const MIXED_CHARSET_USER = "kévin+f2z";
    const MIXED_CHARSET_CREATOR = {
      id: 1296,
      username: MIXED_CHARSET_USER,
      full_name: "Kévin Plus F2Z",
    };
    await authenticate(page, MIXED_CHARSET_CREATOR, "mixed-charset-session");

    await page.goto("/", { waitUntil: "domcontentloaded" });
    const homeBell = await hydratedNotificationBell(page);
    await expect(homeBell).not.toHaveAttribute("aria-current", "page");

    await page.evaluate((username) => {
      const link = document.createElement("a");
      link.href = `/${encodeURIComponent(username)}/dashboard/notifications`;
      document.body.append(link);
      link.click();
    }, MIXED_CHARSET_USER);
    await expect(page).toHaveURL(
      `/${encodeURIComponent(MIXED_CHARSET_USER)}/dashboard/notifications`,
    );

    const bell = await hydratedNotificationBell(page);
    await expect(bell).toHaveAttribute("aria-current", "page");
    await expect(bell).toHaveClass(ACCENT_CLASS_REGEX);
  });

  test("the notification bell becomes inactive after client-side navigation away", async ({
    page,
  }) => {
    await page.goto(`/${FIXTURE_USER}/dashboard/notifications`, {
      waitUntil: "domcontentloaded",
    });

    const bell = await hydratedNotificationBell(page);
    await expect(bell).toHaveAttribute("aria-current", "page");
    await expect(bell).toHaveClass(ACCENT_CLASS_REGEX);

    // Client-side navigate away via the navbar Converse button
    await page.getByTestId("navbar-converse").click();
    await expect(page).toHaveURL("/converse");

    await expect(bell).toBeVisible();
    await expect(bell).not.toHaveAttribute("aria-current", "page");
    await expect(bell).not.toHaveClass(ACCENT_CLASS_REGEX);
  });

  test("the notification bell is inactive on unrelated routes and other users dashboards", async ({
    page,
  }) => {
    // Unrelated route
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const bell = await hydratedNotificationBell(page);
    await expect(bell).not.toHaveAttribute("aria-current", "page");
    await expect(bell).not.toHaveClass(ACCENT_CLASS_REGEX);

    // Use a client-side link so this assertion exercises the navbar's path
    // reactivity without asking the SSR fixture API for a nonexistent creator.
    await page.evaluate(() => {
      const link = document.createElement("a");
      link.href = "/other-user/dashboard/notifications";
      document.body.append(link);
      link.click();
    });
    await expect(page).toHaveURL("/other-user/dashboard/notifications");
    const otherUserBell = await hydratedNotificationBell(page);
    await expect(otherUserBell).not.toHaveAttribute("aria-current", "page");
    await expect(otherUserBell).not.toHaveClass(ACCENT_CLASS_REGEX);
  });

  test("offline socket styling takes visual precedence over active accent on notifications route", async ({
    page,
  }) => {
    await failEveryWebSocket(page);
    await page.clock.install();

    await page.goto(`/${FIXTURE_USER}/dashboard/notifications`, {
      waitUntil: "domcontentloaded",
    });

    const bell = await hydratedNotificationBell(page);

    // Advance time past the fast-lane reconnect attempts to trip the breaker
    await page.clock.runFor(FAST_LANE_MS + 5_000);

    await expect(bell).toHaveAttribute("data-socket-state", "offline");
    // Amber warning styling takes visual priority
    await expect(bell).toHaveClass(/text-amber-600/);
    await expect(bell).not.toHaveClass(ACCENT_CLASS_REGEX);
    // Accessible current-page state is still maintained
    await expect(bell).toHaveAttribute("aria-current", "page");
  });
});
