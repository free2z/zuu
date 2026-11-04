import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { browserAppOrigin } from "./ports";

// Issue  — when the `/ws/profile` reconnect breaker trips, the tab stops
// receiving notifications for minutes at a time and the bell looked exactly the
// same as it does on a quiet afternoon.
//
// This drives the real thing: real layout, real controller, real navbar. Only
// two things are faked, and both are the environment rather than the code under
// test:
//
//   1. The `/ws/profile` WebSocket, replaced with one that always fails its
//      handshake. The dev server has no `/ws/profile`, and depending on how
//      Vite's HMR server handles a foreign upgrade the browser can be left with
//      a socket that neither opens nor closes — a hang, not the failure we are
//      reproducing. Vite's own HMR socket remains native so cold module reloads
//      cannot interfere with app bootstrap.
//   2. The clock. The breaker is reachable only after the full 1s/3s/7s/15s/30s
//      backoff curve, which is ~206 seconds of wall time. Faking the clock is
//      what makes this a test instead of a four-minute stall.
//
// Auth is mocked in the browser rather than taken from the mock-api fixture
// server, exactly as tests/browser/homepage-layout.spec.ts does. The dev
// server proxies the browser's `/api/**` to `localhost:8000`, which nothing
// listens on in this harness (and certainly not in CI) — a spec that needs a
// logged-in navbar has to serve its own auth, or it is testing the weather.
const TEST_CREATOR = {
  id: 1075,
  username: "socket-test-user",
  full_name: "Socket Test User",
};

// Mirrors $lib/ws/profileSocket: attempts 1..9 walk the fast lane, attempt 10
// trips the breaker. Duplicated rather than imported — a spec that reads the
// constant from the module under test cannot notice the module changing it.
//
// The nine steps also carry up to 1s of jitter EACH, so the worst case is 9s
// above the sum of the base delays. Codex review of this PR caught the first
// version budgeting 5s of slack for it: the breaker would fail to trip on an
// unlucky draw and the suite would go red for reasons that have nothing to do
// with the code. The slack is the full jitter budget plus room, and it stays
// well inside the slow lane's earliest probe (150s) so it cannot accidentally
// advance into one.
const FAST_LANE_BASE_MS = 1000 + 3000 + 7000 + 15000 + 30000 * 5;
const FAST_LANE_MAX_JITTER_MS = 9 * 1000;
const FAST_LANE_MS = FAST_LANE_BASE_MS + FAST_LANE_MAX_JITTER_MS;
// The controller refuses a resume within 30s of the last connection; the slow
// lane's earliest automatic probe is 150s out. The retry test lives between
// those two numbers, so a new socket can only be the click's doing.
const RESUME_COOLDOWN_MS = 30_000;

// The state lives ON the bell — a second control does not fit a 320px navbar,
// see the header of NotificationBell.svelte.
const bell = (page: Page) => page.getByTestId("navbar-notifications");

/**
 * A WebSocket that always dies. `onclose` is dispatched from a timer, like a
 * real one, so the controller's "a deliberate close must not schedule a
 * reconnect" handling is exercised rather than short-circuited.
 */
async function failEveryWebSocket(page: Page) {
  await page.addInitScript(() => {
    const win = window as unknown as { __wsOpened: number };
    win.__wsOpened = 0;

    const nativeWebSocket = window.WebSocket;

    class DeadSocket {
      onopen: ((event?: unknown) => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: ((event?: unknown) => void) | null = null;
      onerror: ((event?: unknown) => void) | null = null;

      constructor(public url: string) {
        win.__wsOpened += 1;
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

    // Vite's HMR channel is part of the dev-server bootstrap.  Replacing it
    // with the dead profile socket makes cold dependency reloads race the app
    // itself and can leave the auth request unissued.  Intercept only the
    // production profile endpoint; every other socket keeps native behavior.
    const profileOnlyWebSocket = new Proxy(nativeWebSocket, {
      construct(target, args: any[]) {
        const [url] = args;
        if (/\/ws\/profile(?:[/?#]|$)/.test(String(url))) {
          return new DeadSocket(String(url));
        }
        return Reflect.construct(target, args);
      },
    });

    Object.defineProperty(window, "WebSocket", {
      configurable: true,
      writable: true,
      value: profileOnlyWebSocket,
    });
  });
}

/** A logged-in navbar with no backend behind it. */
async function authenticate(page: Page) {
  // The layout's SSR session hint is authoritative when no cookie is present;
  // seed the same test session that the mocked user endpoint serves so the
  // authenticated navbar exists before the client store hydrates.
  await page.context().addCookies([
    {
      name: "sessionid",
      value: "notification-socket-session",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);

  await page.addInitScript((creator) => {
    localStorage.setItem(
      "auth",
      JSON.stringify({ isAuthenticated: true, creator, loading: false }),
    );
  }, TEST_CREATOR);

  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    // Vite serves source modules from paths such as /src/lib/api/config.ts.
    if (!pathname.startsWith("/api/")) {
      await route.continue();
      return;
    }
    if (pathname === "/api/auth/user/") {
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
      body: JSON.stringify({ results: [], count: 0, next: null }),
    });
  });
}

const socketsOpened = (page: Page) =>
  page.evaluate(() => (window as unknown as { __wsOpened: number }).__wsOpened);

async function gotoAuthenticated(page: Page, path = "/") {
  const sessionCheck = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === "/api/auth/user/",
  );
  await page.goto(path);
  await sessionCheck;
  await expect(bell(page)).toBeVisible();
}

test.describe("notification socket affordance", () => {
  let warmupContext: BrowserContext | undefined;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(60_000);
    // The first dev-server page compiles the entire Svelte module graph. On
    // a fresh CI worker that can finish after the 30s test budget, before a
    // notification test can even issue its auth request. Warm the graph in
    // an isolated anonymous context and wait for a client-only navbar effect
    // so the actual tests start with the same app that a warmed suite sees.
    warmupContext = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    const warmupPage = await warmupContext.newPage();
    const appOrigin = browserAppOrigin();
    await warmupPage.goto(`${appOrigin}/`);
    await warmupPage.locator("nav kbd").waitFor();
  });

  test.afterAll(async () => {
    await warmupContext?.close();
  });

  test.beforeEach(async ({ page }) => {
    await authenticate(page);
    await failEveryWebSocket(page);
    await page.clock.install();
  });

  test("cold authenticated header reads its owner's count while socket is down", async ({
    page,
  }) => {
    let unreadRequests = 0;
    await page.route("**/api/events/unread_count/**", async (route) => {
      const url = new URL(route.request().url());
      unreadRequests += 1;
      expect(url.searchParams.get("include_recipient")).toBe("1");
      await route.fulfill({
        json: {
          unread_count: 7,
          recipient_username: TEST_CREATOR.username,
        },
      });
    });

    await gotoAuthenticated(page);

    await expect(bell(page)).toContainText("7");
    expect(unreadRequests).toBeGreaterThan(0);
  });

  for (const [caseName, recipient] of [
    ["foreign", "somebody-else"],
    ["missing", undefined],
  ] as const) {
    test(`cold authenticated header rejects ${caseName} count ownership`, async ({
      page,
    }) => {
      let unreadRequests = 0;
      await page.route("**/api/events/unread_count/**", async (route) => {
        const url = new URL(route.request().url());
        unreadRequests += 1;
        expect(url.searchParams.get("include_recipient")).toBe("1");
        await route.fulfill({
          json: {
            unread_count: 7,
            ...(recipient ? { recipient_username: recipient } : {}),
          },
        });
      });

      await gotoAuthenticated(page);

      expect(unreadRequests).toBeGreaterThan(0);
      await expect(bell(page)).not.toContainText("7");
    });
  }

  test("the bell says nothing while the fast retry loop is still trying", async ({
    page,
  }) => {
    await gotoAuthenticated(page);

    // Four failed connections in, well inside the fast lane.
    await page.clock.runFor(12_000);
    expect(await socketsOpened(page)).toBeGreaterThan(1);
    await expect(bell(page)).toHaveAttribute("data-socket-state", "none");
    await expect(bell(page)).toHaveAccessibleName("Notifications");
  });

  test("the bell shows an offline state once the socket gives up", async ({
    page,
  }) => {
    await gotoAuthenticated(page);

    await page.clock.runFor(FAST_LANE_MS + 5_000);

    await expect(bell(page)).toHaveAttribute("data-socket-state", "offline");
    // The accessible name has to carry the meaning: this is an icon-only
    // control, and "amber icon" is not information.
    await expect(bell(page)).toHaveAccessibleName(/offline/i);
    //...and so does the shape, for anyone who cannot resolve the amber.
    await expect(bell(page).locator("svg.lucide-bell-off")).toBeVisible();
  });

  test("the offline state fits the narrowest phone on a busy route", async ({
    page,
  }) => {
    // Codex review of this PR measured the first design — a separate 32px
    // control beside the bell — pushing this exact page to 332px: at 320px on
    // a non-home route the navbar already fits its viewport exactly (menu,
    // brand, search, create, converse, bell, avatar). Nothing else covers the
    // combination, because the existing 320px checks never trip the breaker
    // and the tests above run at 390px on the homepage.
    await page.setViewportSize({ width: 320, height: 640 });
    await gotoAuthenticated(page, "/trending");
    const widthWhileHealthy = await page.evaluate(
      () => document.documentElement.scrollWidth,
    );

    await page.clock.runFor(FAST_LANE_MS + 5_000);
    await expect(bell(page)).toHaveAttribute("data-socket-state", "offline");

    const measured = await page.evaluate(
      (before: number) => ({
        before,
        viewport: document.documentElement.clientWidth,
        content: document.documentElement.scrollWidth,
        nav: document.querySelector("nav")?.scrollWidth ?? 0,
      }),
      widthWhileHealthy,
    );
    expect(
      measured.content,
      "the offline affordance must not push the page sideways",
    ).toBeLessThanOrEqual(measured.viewport);
    expect(measured.nav).toBeLessThanOrEqual(measured.viewport);
    // The offline state must cost nothing: the navbar is exactly as wide as it
    // was before the breaker tripped.
    expect(measured.content).toBe(measured.before);
  });

  test("clicking the offline state asks for a reconnection now", async ({
    page,
  }) => {
    await gotoAuthenticated(page);

    await page.clock.runFor(FAST_LANE_MS + 5_000);
    await expect(bell(page)).toHaveAttribute("data-socket-state", "offline");

    // Straight after the trip, the resume cooldown still owns the tab: the
    // click genuinely cannot open anything. Saying nothing here would rebuild
    // the same silence one layer up.
    const throttled = await socketsOpened(page);
    await bell(page).click();
    await expect(page.getByText(/keep retrying/i)).toBeVisible();
    expect(await socketsOpened(page)).toBe(throttled);
    // The click is still a navigation: the feed the dead socket cost the user
    // is fetched over HTTP, and that is the half of the recovery the click can
    // always deliver.
    await expect(page).toHaveURL(/\/dashboard\/notifications$/);

    // Past the resume cooldown but well short of the slow lane's earliest
    // probe, so a new connection can only be the click's doing.
    await page.clock.runFor(RESUME_COOLDOWN_MS + 5_000);
    const before = await socketsOpened(page);

    await bell(page).click();
    await expect
      .poll(() => socketsOpened(page), {
        message: "the retry must actually open a socket",
      })
      .toBeGreaterThan(before);

    // Still broken: the probe dies and the affordance comes back rather than
    // leaving a spinner that never resolves.
    await page.clock.runFor(1_000);
    await expect(bell(page)).toHaveAttribute("data-socket-state", "offline");
    expect(
      await socketsOpened(page),
      "a click must buy one probe, not a burst",
    ).toBeLessThan(before + 3);
  });
});
