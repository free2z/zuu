import { expect, test, type Page } from "@playwright/test";
import { browserMockApiOrigin } from "./ports";

const MOBILE_VIEWPORT = { width: 390, height: 844 };
const NARROW_MOBILE_VIEWPORT = { width: 320, height: 700 };
const DESKTOP_VIEWPORT = { width: 1280, height: 900 };
// Upper bounds, not pinned design values. These guard the regression class
// (content spilling past the shell, or a yawning dead gap under the last
// section) without breaking every time a designer retunes the spacing.
const MOBILE_MAX_GUTTER = 24;
const MOBILE_MAX_BOTTOM_SPACING = 64;
const DESKTOP_MAX_BOTTOM_SPACING = 128;
const GEOMETRY_TOLERANCE = 0.5;
const STARVED_FRAME_MS = 150;

type AuthState = "anonymous" | "authenticated";
type ApiMockOptions = {
  feed?: {
    status: number;
    results?: unknown[];
    next?: string | null;
  };
  logoutStatus?: number;
  liveNow?: unknown[];
  liveDiscoveryStatus?: number;
  liveDiscoveryDelayMs?: number;
  liveDiscoveryServerMode?: boolean;
};

const TEST_CREATOR = {
  id: 782,
  username: "layout-test-user",
  full_name: "Layout Test User",
};

const TEST_FEED_STORIES = Array.from({ length: 6 }, (_, index) => ({
  id: 900 + index,
  free2zaddr: `layout-story-${index}`,
  title: `Layout story ${index + 1}`,
  created_at: "2026-07-22T12:00:00Z",
  creator: TEST_CREATOR,
}));

async function installApiMocks(
  page: Page,
  authState: AuthState,
  options: ApiMockOptions = {},
) {
  let authenticated = authState === "authenticated";
  const mockApiOrigin = browserMockApiOrigin();

  if (authState === "authenticated") {
    await page.addInitScript((creator) => {
      localStorage.setItem(
        "auth",
        JSON.stringify({
          isAuthenticated: true,
          creator,
          loading: false,
        }),
      );
    }, TEST_CREATOR);
  }

  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;

    // Vite serves source modules from paths such as /src/lib/api/config.ts.
    // Only intercept actual application API requests.
    if (!pathname.startsWith("/api/")) {
      await route.continue();
      return;
    }

    if (pathname === "/api/auth/user/") {
      if (authenticated) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(TEST_CREATOR),
        });
        return;
      }

      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ detail: "Not authenticated" }),
      });
      return;
    }

    if (pathname === "/api/auth/logout/") {
      const status = options.logoutStatus ?? 200;
      if (status < 400 || status === 401) {
        authenticated = false;
        await page.context().clearCookies();
      }
      await route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify({
          detail: status < 400 ? "Logged out" : "Logout rejected",
        }),
      });
      return;
    }

    if (pathname === "/api/dyte/public/discovery/") {
      if (options.liveDiscoveryServerMode) {
        // The app's normal same-origin Vite proxy points at the real backend
        // port. Fetch the response from the mock server explicitly so the
        // hydrated recovery still exercises the controllable server fixture.
        const upstreamUrl = new URL(route.request().url());
        upstreamUrl.host = new URL(mockApiOrigin).host;
        const upstream = await route.fetch({ url: upstreamUrl.toString() });
        await route.fulfill({ response: upstream });
        return;
      }
      const status = options.liveDiscoveryStatus ?? 200;
      if (options.liveDiscoveryDelayMs) {
        await new Promise((resolve) =>
          setTimeout(resolve, options.liveDiscoveryDelayMs),
        );
      }
      await route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(
          status >= 400
            ? { detail: "Live discovery fixture failure" }
            : (options.liveNow ?? []),
        ),
      });
      return;
    }

    if (pathname === "/api/zpage/" && options.feed) {
      await route.fulfill({
        status: options.feed.status,
        contentType: "application/json",
        body: JSON.stringify({
          count: options.feed.results?.length ?? 0,
          next: options.feed.next ?? null,
          results: options.feed.results ?? [],
        }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ count: 0, results: [] }),
    });
  });
}

async function mobileFeedGeometry(page: Page) {
  return page.getByTestId("homepage-mobile-feed").evaluate((feed) => {
    const lastStory = feed.querySelector<HTMLElement>("li:last-child");

    const feedRect = feed.getBoundingClientRect();
    const lastStoryRect = lastStory?.getBoundingClientRect();
    return {
      viewportHeight: window.innerHeight,
      feedHeight: feedRect.height,
      feedBottom: feedRect.bottom,
      minHeight: Number.parseFloat(getComputedStyle(feed).minHeight),
      scrollHeight: feed.scrollHeight,
      lastStoryBottom: lastStoryRect?.bottom ?? null,
    };
  });
}

async function expectHomepageGeometry(
  page: Page,
  expected: {
    viewportWidth: number;
    maxBottomSpacing: number;
    footer: "hidden" | "flush";
  },
) {
  const layoutMain = page.getByTestId("layout-main");
  const homepage = page.getByTestId("homepage-shell");
  const footer = page.locator("footer");

  await expect(layoutMain).toBeVisible();
  await expect(homepage).toBeVisible();
  if (expected.footer === "hidden") {
    await expect(footer).toBeHidden();
  } else {
    await expect(footer).toBeVisible();
  }
  await page.evaluate(() => document.fonts.ready);

  const geometry = await page.evaluate(() => {
    const main = document.querySelector<HTMLElement>(
      '[data-testid="layout-main"]',
    );
    const shell = document.querySelector<HTMLElement>(
      '[data-testid="homepage-shell"]',
    );
    const footerElement = document.querySelector<HTMLElement>("footer");

    if (!main || !shell || !footerElement) {
      throw new Error("Expected homepage layout elements were not rendered");
    }

    const mainRect = main.getBoundingClientRect();
    const shellRect = shell.getBoundingClientRect();
    const footerRect = footerElement.getBoundingClientRect();
    const footerStyle = getComputedStyle(footerElement);
    const mainStyle = getComputedStyle(main);
    const shellStyle = getComputedStyle(shell);
    // The bottom seam is a property of what is PAINTED, so only rendered
    // children count. The homepage now carries breakpoint-gated subtrees (the
    // mobile feed below md, the magazine sections above it), and a
    // `display: none` element reports an all-zero rect — measuring the seam
    // from one puts the "last" content hundreds of px above the real bottom.
    const lastFlowChild = Array.from(shell.children)
      .filter((child): child is HTMLElement => {
        if (!(child instanceof HTMLElement)) return false;
        const style = getComputedStyle(child);
        return style.position !== "absolute" && style.display !== "none";
      })
      .at(-1);

    if (!lastFlowChild) {
      throw new Error("Expected homepage flow content was not rendered");
    }

    const lastFlowChildRect = lastFlowChild.getBoundingClientRect();

    return {
      viewportWidth: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      main: { left: mainRect.left, right: mainRect.right },
      shell: {
        left: shellRect.left,
        right: shellRect.right,
        bottom: shellRect.bottom,
      },
      footer: {
        visible: footerStyle.display !== "none",
        left: footerRect.left,
        right: footerRect.right,
        top: footerRect.top,
      },
      mainPaddingLeft: Number.parseFloat(mainStyle.paddingLeft),
      mainPaddingRight: Number.parseFloat(mainStyle.paddingRight),
      bottomSpacing: shellRect.bottom - lastFlowChildRect.bottom,
      shellBackgroundImage: shellStyle.backgroundImage,
    };
  });

  expect(geometry.viewportWidth).toBe(expected.viewportWidth);
  expect(geometry.documentWidth).toBe(expected.viewportWidth);
  expect(geometry.main.left).toBeCloseTo(0, 5);
  expect(geometry.main.right).toBeCloseTo(expected.viewportWidth, 5);
  expect(geometry.shell.left).toBeCloseTo(0, 5);
  expect(geometry.shell.right).toBeCloseTo(expected.viewportWidth, 5);
  expect(geometry.mainPaddingLeft).toBeCloseTo(0, 5);
  expect(geometry.mainPaddingRight).toBeCloseTo(0, 5);
  // Direction and bound, not a pinned pixel value. Strictly positive: dropping
  // the shell's bottom padding altogether puts this at exactly 0, which is the
  // regression  established the breathing room to prevent.
  expect(geometry.bottomSpacing).toBeGreaterThan(0);
  expect(geometry.bottomSpacing).toBeLessThanOrEqual(expected.maxBottomSpacing);
  expect(geometry.shellBackgroundImage).not.toBe("none");
  expect(geometry.footer.visible).toBe(expected.footer === "flush");
  if (expected.footer === "flush") {
    expect(geometry.footer.left).toBeCloseTo(0, 5);
    expect(geometry.footer.right).toBeCloseTo(expected.viewportWidth, 5);
    expect(
      Math.abs(geometry.footer.top - geometry.shell.bottom),
    ).toBeLessThanOrEqual(GEOMETRY_TOLERANCE);
  }
}

test("mobile homepage SSR renders edge-to-edge without a footer", async ({
  page,
}) => {
  await page.setViewportSize(MOBILE_VIEWPORT);
  await installApiMocks(page, "anonymous");
  const response = await page.goto("/");

  expect(response?.status()).toBe(200);
  await expect(page.getByTestId("homepage-cta")).toBeHidden();
  await expect(page.getByTestId("homepage-live-now")).toHaveCount(0);
  await expectHomepageGeometry(page, {
    viewportWidth: MOBILE_VIEWPORT.width,
    maxBottomSpacing: MOBILE_MAX_BOTTOM_SPACING,
    footer: "hidden",
  });
});

test("homepage live rail uses the public list and canonical viewer link", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith("/api/")) requests.push(pathname);
  });
  await installApiMocks(page, "anonymous", {
    liveNow: [
      {
        username: "railfixture",
        avatar: null,
        meeting_type: "ppv",
        price_per_minute: "1.25",
      },
    ],
  });

  await page.goto("/");

  const rail = page.getByTestId("homepage-live-now");
  await expect(rail).toBeVisible();
  const card = page.getByTestId("homepage-live-now-card");
  await expect(card).toHaveAttribute("href", "/railfixture/ppv");
  await expect(card).toContainText("1.25 2Z/min");
  await expect(card).not.toContainText("$");
  expect(
    requests.filter((path) => path === "/api/dyte/public/discovery/"),
  ).toHaveLength(1);
  expect(requests.filter((path) => path.includes("/live-status"))).toEqual([]);
});

test("homepage live rail preserves Django static avatar fallback", async ({
  page,
}) => {
  await installApiMocks(page, "anonymous", {
    liveNow: [
      {
        username: "static-avatar-fixture",
        avatar: "/djstatic/g12f/logo512.png",
        meeting_type: "broadcast",
      },
    ],
  });

  await page.goto("/");

  await expect(
    page.getByTestId("homepage-live-now-card").locator("img"),
  ).toHaveAttribute("src", /\/djstatic\/g12f\/logo512\.png$/);
});

test("homepage live discovery does not send a session cookie", async ({
  page,
  context,
}) => {
  await context.addCookies([
    {
      name: "sessionid",
      value: "homepage-live-session",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  const publicRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/dyte/public/discovery/") {
      publicRequests.push(request.headers().cookie || "");
    }
  });
  await installApiMocks(page, "authenticated", {
    liveNow: [
      {
        username: "private-cookie-fixture",
        avatar: null,
        meeting_type: "broadcast",
      },
    ],
  });

  await page.goto("/");
  await expect(page.getByTestId("homepage-live-now")).toBeVisible();
  expect(publicRequests).toHaveLength(1);
  expect(publicRequests[0]).not.toContain("sessionid=");
});

test("unavailable discovery keeps creator-card live fallback polling enabled", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await page.context().addCookies([
    {
      name: "sessionid",
      value: "homepage-live-fallback-session",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  const requests: string[] = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.includes("/live-status")) requests.push(pathname);
  });
  await installApiMocks(page, "authenticated", { liveDiscoveryStatus: 503 });

  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: "Homepage Live Fallback" }),
  ).toBeVisible();
  await expect
    .poll(() => requests.length, { timeout: 5_000 })
    .toBeGreaterThan(0);
});

test("successful empty discovery disables redundant creator-card polling", async ({
  page,
}) => {
  await page.clock.install();
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await page.context().addCookies([
    {
      name: "sessionid",
      value: "homepage-live-empty-session",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  const requests: {
    pathname: string;
    timestamp: number;
    phase: "before-discovery-response" | "after-discovery-response";
  }[] = [];
  let discoveryResponseAt: number | null = null;
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.includes("/live-status")) {
      requests.push({
        pathname,
        timestamp: performance.now(),
        phase:
          discoveryResponseAt === null
            ? "before-discovery-response"
            : "after-discovery-response",
      });
    }
  });
  page.on("response", (response) => {
    if (
      new URL(response.url()).pathname === "/api/dyte/public/discovery/" &&
      discoveryResponseAt === null
    ) {
      discoveryResponseAt = performance.now();
    }
  });
  await installApiMocks(page, "authenticated", {
    liveNow: [],
    // SSR has no live snapshot, so the card's fallback query may start while
    // client discovery is unresolved. Hold the response to make that timing
    // explicit, then assert against requests made after the empty result lands.
    liveDiscoveryDelayMs: 500,
  });

  const discoveryResponsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/dyte/public/discovery/",
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Homepage Live Fallback" }),
  ).toBeVisible();
  await page.getByTestId("creator-card").scrollIntoViewIfNeeded();

  const cardLiveStatusPath = "/api/dyte/homepage-live-fallback/live-status";

  // A request made before discovery responds is the expected unknown-state
  // fallback, not evidence that an empty result failed to disable polling.
  await expect
    .poll(
      () =>
        requests.filter(
          (request) =>
            request.pathname === cardLiveStatusPath &&
            request.phase === "before-discovery-response",
        ).length,
      { timeout: 5_000 },
    )
    .toBeGreaterThan(0);
  const discoveryResponse = await discoveryResponsePromise;
  expect(discoveryResponse.status()).toBe(200);
  await discoveryResponse.finished();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );

  // Do not discard requests near the response boundary: retain their timing
  // phase so any request after the response is still visible to the assertion.
  expect(discoveryResponseAt).not.toBeNull();

  // Inactive indicators refetch after 60 seconds plus up to 5 seconds of
  // jitter. Virtual time covers that whole interval without a wall-clock wait.
  await page.clock.runFor(70_000);
  expect(
    requests.filter(
      (request) =>
        request.pathname === cardLiveStatusPath &&
        request.timestamp >= discoveryResponseAt!,
    ),
  ).toEqual([]);
});

test("client discovery failure recovers through the mock server and stops fallback polling", async ({
  page,
  request,
}) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await page.context().addCookies([
    {
      name: "sessionid",
      value: "homepage-live-ssr-failure-session",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  const liveStatusRequests: string[] = [];
  const discoveryResponses: number[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.includes("/live-status")) {
      liveStatusRequests.push(request.url());
    }
  });
  page.on("response", (response) => {
    if (new URL(response.url()).pathname === "/api/dyte/public/discovery/") {
      discoveryResponses.push(response.status());
    }
  });

  const mockApiOrigin = browserMockApiOrigin();
  await request.post(`${mockApiOrigin}/__live-discovery-mode?mode=fail-next`);
  await installApiMocks(page, "authenticated", {
    liveDiscoveryServerMode: true,
  });

  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Homepage Live Fallback" }),
  ).toBeVisible();
  // The client discovery request must really reach the mock server; this test
  // intentionally does not page.route() it.
  await expect
    .poll(() => discoveryResponses, { timeout: 10_000 })
    .toContain(200);
  const discoveryMode = await request.get(
    `${mockApiOrigin}/__live-discovery-mode`,
  );
  expect((await discoveryMode.json()).failures).toBe(1);
  expect(discoveryResponses).toContain(200);
  await expect.poll(() => liveStatusRequests.length).toBeGreaterThan(0);
  const requestsAfterRecovery = liveStatusRequests.length;
  await page.waitForTimeout(500);
  expect(liveStatusRequests.length).toBe(requestsAfterRecovery);
});

test("authenticated mobile homepage renders edge-to-edge without a footer", async ({
  page,
}) => {
  await page.setViewportSize(MOBILE_VIEWPORT);
  await installApiMocks(page, "authenticated");
  const response = await page.goto("/");

  expect(response?.status()).toBe(200);
  // Signed in, the CTA is not rendered at all rather than merely hidden.
  await expect(page.getByTestId("homepage-cta")).toHaveCount(0);
  await expectHomepageGeometry(page, {
    viewportWidth: MOBILE_VIEWPORT.width,
    maxBottomSpacing: MOBILE_MAX_BOTTOM_SPACING,
    footer: "hidden",
  });
});

test("logout on the homepage refreshes SSR auth and restores promotion", async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await page.context().addCookies([
    {
      name: "sessionid",
      value: "billing-fixture-session",
      url: baseURL!,
    },
  ]);
  await installApiMocks(page, "authenticated");

  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await expect(page.getByTestId("homepage-cta")).toHaveCount(0);
  await expect(
    page
      .locator("h1:visible, h2:visible, h3:visible")
      .filter({ hasText: "Private logout draft" })
      .first(),
  ).toBeVisible();

  await page.getByTestId("navbar-profile-trigger").click();
  await page.getByText("Log out", { exact: true }).click();

  await expect(page).toHaveURL("/");
  await expect(page.getByTestId("homepage-cta")).toBeVisible();
  await expect(page.getByText("Private logout draft")).toHaveCount(0);
});

test("failed logout keeps the authenticated homepage state honest", async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await page.context().addCookies([
    {
      name: "sessionid",
      value: "billing-fixture-session",
      url: baseURL!,
    },
  ]);
  await installApiMocks(page, "authenticated", { logoutStatus: 503 });

  await page.goto("/");
  await page.getByTestId("navbar-profile-trigger").click();
  await page.getByText("Log out", { exact: true }).click();

  await expect(
    page.getByText(
      "Could not log out. Your session is still active; please try again.",
    ),
  ).toBeVisible();
  await expect(page.getByTestId("navbar-profile-trigger")).toBeVisible();
  await expect(page.getByTestId("homepage-cta")).toHaveCount(0);
});

test("320px mobile homepage exposes Converse without navbar overlap", async ({
  page,
}) => {
  await page.setViewportSize(NARROW_MOBILE_VIEWPORT);
  await installApiMocks(page, "anonymous");
  const response = await page.goto("/");

  expect(response?.status()).toBe(200);
  const brand = page.getByTestId("navbar-brand");
  const converse = page.getByTestId("navbar-converse");
  const auth = page.getByTestId("navbar-auth-trigger");
  await expect(brand).toBeVisible();
  await expect(converse).toBeVisible();
  await expect(converse).toHaveAttribute("href", "/converse");
  await expect(converse).toHaveAccessibleName("Converse");
  await expect(auth).toBeVisible();
  await expect(page.getByTestId("navbar-mobile-search")).toHaveCount(0);

  const geometry = await page.evaluate(() => {
    const rect = (testId: string) => {
      const element = document.querySelector<HTMLElement>(
        `[data-testid="${testId}"]`,
      );
      if (!element) throw new Error(`Missing ${testId}`);
      const box = element.getBoundingClientRect();
      return {
        left: box.left,
        right: box.right,
        width: box.width,
        height: box.height,
      };
    };

    return {
      viewportWidth: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      brand: rect("navbar-brand"),
      converse: rect("navbar-converse"),
      auth: rect("navbar-auth-trigger"),
    };
  });

  expect(geometry.viewportWidth).toBe(NARROW_MOBILE_VIEWPORT.width);
  expect(geometry.documentWidth).toBe(NARROW_MOBILE_VIEWPORT.width);
  expect(geometry.brand.left).toBeGreaterThanOrEqual(0);
  expect(geometry.auth.right).toBeLessThanOrEqual(NARROW_MOBILE_VIEWPORT.width);
  expect(geometry.converse.width).toBeGreaterThanOrEqual(32);
  expect(geometry.converse.height).toBeGreaterThanOrEqual(32);
  expect(geometry.auth.width).toBeGreaterThanOrEqual(32);
  expect(geometry.auth.height).toBeGreaterThanOrEqual(32);
});

test("empty mobile feed with a load error fills the safe viewport", async ({
  page,
}) => {
  await page.setViewportSize(NARROW_MOBILE_VIEWPORT);
  await installApiMocks(page, "authenticated", {
    feed: { status: 503 },
  });
  const response = await page.goto("/");

  expect(response?.status()).toBe(200);
  await expect(page.getByText("Nothing published yet.")).toBeVisible();
  await expect(page.getByText("Could not load more.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();

  const geometry = await mobileFeedGeometry(page);
  expect(geometry.minHeight).toBeCloseTo(geometry.viewportHeight, 5);
  expect(geometry.feedHeight).toBeGreaterThanOrEqual(geometry.viewportHeight);
  expect(geometry.scrollHeight).toBeLessThanOrEqual(geometry.feedHeight);
});

test("populated mobile feed grows past the safe viewport without clipping", async ({
  page,
}) => {
  await page.setViewportSize(NARROW_MOBILE_VIEWPORT);
  await installApiMocks(page, "authenticated", {
    feed: { status: 200, results: TEST_FEED_STORIES },
  });
  const response = await page.goto("/");

  expect(response?.status()).toBe(200);
  await expect(page.getByText(TEST_FEED_STORIES.at(-1)!.title)).toBeVisible();

  const geometry = await mobileFeedGeometry(page);
  expect(geometry.minHeight).toBeCloseTo(geometry.viewportHeight, 5);
  expect(geometry.feedHeight).toBeGreaterThan(geometry.viewportHeight);
  expect(geometry.scrollHeight).toBeLessThanOrEqual(geometry.feedHeight);
  expect(geometry.lastStoryBottom).not.toBeNull();
  expect(geometry.lastStoryBottom!).toBeLessThanOrEqual(geometry.feedBottom);
});

test("long mobile sessions keep the mounted feed DOM bounded", async ({
  page,
}) => {
  const longFeed = Array.from({ length: 500 }, (_, index) => ({
    ...TEST_FEED_STORIES[index % TEST_FEED_STORIES.length],
    id: 10_000 + index,
    free2zaddr: `virtual-story-${index}`,
    title: `Virtual story ${index + 1}`,
  }));

  await page.setViewportSize(NARROW_MOBILE_VIEWPORT);
  await installApiMocks(page, "authenticated", {
    feed: { status: 200, results: longFeed },
  });
  const response = await page.goto("/");

  expect(response?.status()).toBe(200);
  const feed = page.getByTestId("homepage-mobile-feed");
  const mountedRows = feed.locator("ul > li.feed-row");
  await expect(
    page.getByText("Virtual story 1", { exact: true }),
  ).toBeVisible();
  expect(await mountedRows.count()).toBeLessThanOrEqual(20);

  await page.evaluate(() =>
    window.scrollTo(0, document.documentElement.scrollHeight),
  );
  await expect(
    page.getByText("Virtual story 500", { exact: true }),
  ).toBeVisible();
  expect(await mountedRows.count()).toBeLessThanOrEqual(20);
  await expect(mountedRows.first()).toHaveAttribute("aria-setsize", "500");

  await page.getByRole("button", { name: "Back to top" }).click();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(2);
  await expect(
    page.getByText("Virtual story 1", { exact: true }),
  ).toBeVisible();
  expect(await mountedRows.count()).toBeLessThanOrEqual(20);
});

test("cursor infinite scroll stays complete and DOM-bounded across many pages", async ({
  page,
}) => {
  const pageCount = 12;
  const rowsPerPage = 20;
  const requestedCursors: string[] = [];
  // Hold each response until the test has observed its request. This prevents
  // a fast mock from completing two cursor pages while the test is still
  // synchronizing the virtual layout for the first one.
  const releaseResponses: Array<() => void> = [];
  const responseLocks = Array.from(
    { length: pageCount },
    (_, index) =>
      new Promise<void>((resolve) => {
        releaseResponses[index] = resolve;
      }),
  );

  // On a loaded runner the virtualizer's animation frame can land after the
  // next cursor response. Hold every frame long enough to make that ordering
  // deterministic here; the assertions below must synchronize to committed
  // layout rather than accidentally passing because a local frame was fast.
  await page.addInitScript((delayMs) => {
    const native = window.requestAnimationFrame.bind(window);
    const cancelNative = window.cancelAnimationFrame.bind(window);
    const timers = new Map<number, ReturnType<typeof setTimeout>>();
    window.requestAnimationFrame = (callback: FrameRequestCallback) => {
      const handle = native(() => {
        timers.set(
          handle,
          setTimeout(() => {
            timers.delete(handle);
            callback(performance.now());
          }, delayMs),
        );
      });
      return handle;
    };
    window.cancelAnimationFrame = (handle: number) => {
      const timer = timers.get(handle);
      if (timer !== undefined) {
        clearTimeout(timer);
        timers.delete(handle);
      }
      cancelNative(handle);
    };
  }, STARVED_FRAME_MS);

  await page.setViewportSize(NARROW_MOBILE_VIEWPORT);
  await installApiMocks(page, "authenticated");
  await page.route("**/api/zpage/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("homeSort") === "updated") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          count: 0,
          next: null,
          previous: null,
          results: [],
        }),
      });
      return;
    }

    const cursor = url.searchParams.get("cursor") || "0";
    const pageIndex = Number(cursor);
    requestedCursors.push(cursor);
    await responseLocks[pageIndex];
    const results = Array.from({ length: rowsPerPage }, (_, rowIndex) => {
      const index = pageIndex * rowsPerPage + rowIndex;
      return {
        ...TEST_FEED_STORIES[index % TEST_FEED_STORIES.length],
        id: 30_000 + index,
        free2zaddr: `paged-virtual-story-${index}`,
        title: `Paged virtual story ${index + 1}`,
      };
    });
    const next =
      pageIndex + 1 < pageCount
        ? `${url.origin}/api/zpage/?pagination=cursor&page_size=${rowsPerPage}&cursor=${pageIndex + 1}`
        : null;

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        count: pageCount * rowsPerPage,
        next,
        previous: null,
        results,
      }),
    });
  });

  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  const feed = page.getByTestId("homepage-mobile-feed");
  const feedList = feed.locator("ul");
  const mountedRows = feed.locator("ul > li.feed-row");
  let committedFeedHeight = 0;

  for (
    let expectedRequests = 1;
    expectedRequests <= pageCount;
    expectedRequests++
  ) {
    await expect
      .poll(() => requestedCursors.length)
      .toBeGreaterThanOrEqual(expectedRequests);
    releaseResponses[expectedRequests - 1]();

    // A route starting is not a render boundary: the response still has to be
    // appended and the rAF-scheduled virtual spacers have to update. Waiting
    // for both logical row count and physical list growth prevents scrolling
    // against the previous page's document height.
    await expect(mountedRows.first()).toHaveAttribute(
      "aria-setsize",
      String(expectedRequests * rowsPerPage),
    );
    // The first frame runs the queued virtual-window calculation; the second
    // presents its spacer geometry so IntersectionObserver records that the
    // sentinel left the viewport before this test scrolls it back in.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(
      await feedList.evaluate((list) => list.getBoundingClientRect().height),
    ).toBeGreaterThan(committedFeedHeight);
    committedFeedHeight = await feedList.evaluate(
      (list) => list.getBoundingClientRect().height,
    );

    expect(await mountedRows.count()).toBeLessThanOrEqual(20);
    await page.evaluate(() =>
      window.scrollTo(0, document.documentElement.scrollHeight),
    );
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
  }

  await expect(
    page.getByText(`Paged virtual story ${pageCount * rowsPerPage}`, {
      exact: true,
    }),
  ).toBeVisible();
  expect(requestedCursors).toEqual(
    Array.from({ length: pageCount }, (_, index) => String(index)),
  );
  expect(await mountedRows.count()).toBeLessThanOrEqual(20);
  await expect(mountedRows.first()).toHaveAttribute(
    "aria-setsize",
    String(pageCount * rowsPerPage),
  );
});

test("switching feeds during a request immediately loads the visible mode", async ({
  page,
}) => {
  let markLatestStarted!: () => void;
  const latestStarted = new Promise<void>((resolve) => {
    markLatestStarted = resolve;
  });
  const trendingStory = {
    ...TEST_FEED_STORIES[0],
    id: 20_001,
    free2zaddr: "switch-trending-story",
    title: "Trending after switch",
  };

  await page.setViewportSize(NARROW_MOBILE_VIEWPORT);
  await installApiMocks(page, "authenticated");
  await page.route("**/api/zpage/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("homeSort") === "updated") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          next: null,
          previous: null,
          results: [trendingStory],
        }),
      });
      return;
    }

    markLatestStarted();
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (!route.request().isNavigationRequest()) {
      await route
        .fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            next: null,
            previous: null,
            results: [TEST_FEED_STORIES[0]],
          }),
        })
        .catch(() => {});
    }
  });

  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  await latestStarted;
  await page.getByRole("button", { name: "Switch to Trending" }).click();

  await expect(
    page.getByText(trendingStory.title, { exact: true }),
  ).toBeVisible();
});

const HOMEPAGE_LOCALES = [
  { language: "en", title: "Latest", eyebrow: "Fresh from Free2Z" },
  { language: "es", title: "Lo más reciente", eyebrow: "Lo nuevo en Free2Z" },
  { language: "fr", title: "Derniers", eyebrow: "Nouveau sur Free2Z" },
  {
    language: "pt-BR",
    title: "Mais recentes",
    eyebrow: "Novidades no Free2Z",
  },
] as const;

for (const { language, title, eyebrow } of HOMEPAGE_LOCALES) {
  test(`320px ${language} homepage search and feed heading stay compact`, async ({
    page,
  }) => {
    await page.setViewportSize(NARROW_MOBILE_VIEWPORT);
    await installApiMocks(page, "anonymous");
    const response = await page.goto(`/?lang=${language}`);

    expect(response?.status()).toBe(200);
    const control = page.getByTestId("homepage-mobile-search");
    const input = control.locator('input[type="search"]');
    const button = control.locator('button[type="submit"]');
    const heading = page.getByTestId("homepage-feed-switch");
    const headingRow = heading.locator("..");
    await expect(control).toBeVisible();
    await expect(input).toBeVisible();
    await expect(button).toBeVisible();
    await expect(heading).toBeVisible();
    await expect(heading).toContainText(title);
    await expect(page.getByText(eyebrow, { exact: true })).toHaveCount(0);
    await expect(control.locator("svg")).toHaveCount(1);

    const geometry = await control.evaluate((element) => {
      const inputElement = element.querySelector<HTMLInputElement>(
        'input[type="search"]',
      );
      const buttonElement = element.querySelector<HTMLButtonElement>(
        'button[type="submit"]',
      );
      if (!inputElement || !buttonElement) {
        throw new Error("Expected homepage search input and submit button");
      }

      const controlRect = element.getBoundingClientRect();
      const inputRect = inputElement.getBoundingClientRect();
      const buttonRect = buttonElement.getBoundingClientRect();
      return {
        documentWidth: document.documentElement.scrollWidth,
        control: { left: controlRect.left, right: controlRect.right },
        input: { left: inputRect.left, right: inputRect.right },
        button: {
          left: buttonRect.left,
          right: buttonRect.right,
          width: buttonRect.width,
          height: buttonRect.height,
        },
        inputBackground: getComputedStyle(inputElement).backgroundColor,
        buttonBackground: getComputedStyle(buttonElement).backgroundColor,
      };
    });

    expect(geometry.documentWidth).toBe(NARROW_MOBILE_VIEWPORT.width);
    expect(geometry.control.left).toBeGreaterThanOrEqual(0);
    expect(geometry.control.right).toBeLessThanOrEqual(
      NARROW_MOBILE_VIEWPORT.width,
    );
    // The button sits to the right of the input with a small gap, and stays
    // inside the control. The exact gap and inset are design choices.
    const buttonGap = geometry.button.left - geometry.input.right;
    const buttonInset = geometry.control.right - geometry.button.right;
    expect(buttonGap).toBeGreaterThanOrEqual(0);
    expect(buttonGap).toBeLessThanOrEqual(16);
    expect(buttonInset).toBeGreaterThanOrEqual(0);
    expect(buttonInset).toBeLessThanOrEqual(16);
    expect(geometry.button.width).toBeGreaterThanOrEqual(36);
    expect(geometry.button.height).toBeGreaterThanOrEqual(36);
    expect(geometry.buttonBackground).not.toBe(geometry.inputBackground);

    const headingGeometry = await headingRow.evaluate((element) => {
      const controlElement = document.querySelector<HTMLElement>(
        '[data-testid="homepage-mobile-search"]',
      );
      if (!controlElement) {
        throw new Error("Expected homepage search control");
      }

      const controlRect = controlElement.getBoundingClientRect();
      const headingRect = element.getBoundingClientRect();
      return {
        gapAfterSearch: headingRect.top - controlRect.bottom,
        rowHeight: headingRect.height,
      };
    });
    // The heading clears the search control without a dead band under it.
    expect(headingGeometry.gapAfterSearch).toBeGreaterThan(0);
    expect(headingGeometry.gapAfterSearch).toBeLessThanOrEqual(48);
    expect(headingGeometry.rowHeight).toBeLessThanOrEqual(64);

    await input.focus();
    await expect(input).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(button).toBeFocused();
    expect(
      await button.evaluate((element) => getComputedStyle(element).boxShadow),
    ).not.toBe("none");
  });
}

test("non-home mobile routes keep their footer", async ({ page }) => {
  await page.setViewportSize(MOBILE_VIEWPORT);
  await installApiMocks(page, "anonymous");
  const response = await page.goto("/search");

  expect(response?.status()).toBe(200);
  await expect(page.locator("footer")).toBeVisible();
});

for (const language of ["es", "fr"] as const) {
  test(`320px ${language} non-home navbar controls never overlap`, async ({
    page,
  }) => {
    await page.setViewportSize(NARROW_MOBILE_VIEWPORT);
    await installApiMocks(page, "anonymous");
    const response = await page.goto(`/trending?lang=${language}`);

    expect(response?.status()).toBe(200);
    const brand = page.getByTestId("navbar-brand");
    const search = page.getByTestId("navbar-mobile-search");
    const auth = page.getByTestId("navbar-auth-trigger");
    await expect(brand).toBeVisible();
    await expect(search).toBeVisible();
    await expect(auth).toBeVisible();

    const geometry = await page.evaluate(() => {
      const rect = (testId: string) => {
        const element = document.querySelector<HTMLElement>(
          `[data-testid="${testId}"]`,
        );
        if (!element) throw new Error(`Missing ${testId}`);
        const box = element.getBoundingClientRect();
        return {
          left: box.left,
          right: box.right,
          width: box.width,
          height: box.height,
        };
      };

      return {
        viewportWidth: document.documentElement.clientWidth,
        documentWidth: document.documentElement.scrollWidth,
        brand: rect("navbar-brand"),
        search: rect("navbar-mobile-search"),
        auth: rect("navbar-auth-trigger"),
      };
    });

    expect(geometry.viewportWidth).toBe(NARROW_MOBILE_VIEWPORT.width);
    expect(geometry.documentWidth).toBe(NARROW_MOBILE_VIEWPORT.width);
    expect(geometry.brand.left).toBeGreaterThanOrEqual(0);
    expect(geometry.auth.right).toBeLessThanOrEqual(
      NARROW_MOBILE_VIEWPORT.width,
    );
    expect(geometry.search.width).toBeGreaterThanOrEqual(32);
    expect(geometry.search.height).toBeGreaterThanOrEqual(32);
    expect(geometry.auth.width).toBeGreaterThanOrEqual(32);
    expect(geometry.auth.height).toBeGreaterThanOrEqual(32);
  });
}

test("320px authenticated navbar keeps notifications and the profile reachable", async ({
  page,
}) => {
  await page.setViewportSize(NARROW_MOBILE_VIEWPORT);
  await installApiMocks(page, "authenticated");
  const response = await page.goto("/trending?lang=fr");

  expect(response?.status()).toBe(200);
  const brand = page.getByTestId("navbar-brand");
  const search = page.getByTestId("navbar-mobile-search");
  const notifications = page.getByTestId("navbar-notifications");
  const profile = page.getByTestId("navbar-profile-trigger");
  await expect(brand).toBeVisible();
  await expect(search).toBeVisible();
  await expect(notifications).toBeVisible();
  await expect(profile).toBeVisible();

  const geometry = await page.evaluate(() => {
    const rect = (testId: string) => {
      const element = document.querySelector<HTMLElement>(
        `[data-testid="${testId}"]`,
      );
      if (!element) throw new Error(`Missing ${testId}`);
      const box = element.getBoundingClientRect();
      return {
        left: box.left,
        right: box.right,
        width: box.width,
        height: box.height,
      };
    };

    return {
      viewportWidth: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      brand: rect("navbar-brand"),
      search: rect("navbar-mobile-search"),
      profile: rect("navbar-profile-trigger"),
    };
  });

  expect(geometry.viewportWidth).toBe(NARROW_MOBILE_VIEWPORT.width);
  expect(geometry.documentWidth).toBe(NARROW_MOBILE_VIEWPORT.width);
  expect(geometry.brand.left).toBeGreaterThanOrEqual(0);
  expect(geometry.profile.right).toBeLessThanOrEqual(
    NARROW_MOBILE_VIEWPORT.width,
  );
  expect(geometry.search.width).toBeGreaterThanOrEqual(32);
  expect(geometry.search.height).toBeGreaterThanOrEqual(32);
  expect(geometry.profile.width).toBeGreaterThanOrEqual(32);
  expect(geometry.profile.height).toBeGreaterThanOrEqual(32);

  await page.getByTestId("navbar-mobile-menu").click();
  const sheet = page.locator('[data-slot="sheet-content"]');
  const sheetNotifications = page.getByTestId("mobile-menu-notifications");
  await expect(sheetNotifications).toBeVisible();
  await expect(sheetNotifications).toHaveAttribute(
    "href",
    `/${TEST_CREATOR.username}/dashboard/notifications`,
  );
  await expect(sheet).toHaveCSS("left", "0px");
  const sheetBox = await sheet.boundingBox();
  expect(sheetBox?.width).toBeLessThan(NARROW_MOBILE_VIEWPORT.width);
  const sheetTarget = await sheetNotifications.boundingBox();
  expect(sheetTarget?.height).toBeGreaterThanOrEqual(40);
});

for (const viewport of [NARROW_MOBILE_VIEWPORT, MOBILE_VIEWPORT]) {
  test(`${viewport.width}px mobile menu keeps page locked without a visible scrollbar`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await installApiMocks(page, "authenticated");
    const response = await page.goto("/trending?lang=fr");

    expect(response?.status()).toBe(200);
    const menuTrigger = page.getByTestId("navbar-mobile-menu");
    await expect(menuTrigger).toBeVisible();
    await expect(page.getByTestId("navbar-brand")).toBeVisible();
    await expect(page.getByTestId("navbar-profile-trigger")).toBeVisible();
    await menuTrigger.click();
    const sheet = page.locator('[data-slot="sheet-content"]');
    await expect(sheet).toBeVisible();
    await expect(page.locator("body")).toHaveCSS("overflow", "hidden");

    const menuScroll = page.getByTestId("mobile-menu-scroll");
    const preferences = page.getByTestId("mobile-menu-preferences");
    await expect(menuScroll).toBeVisible();
    await expect(preferences).toBeVisible();
    await expect(page.getByTestId("mobile-menu-classic")).toHaveCount(0);
    await expect(sheet).toHaveCSS("transform", "none");
    await preferences.scrollIntoViewIfNeeded();

    const state = await sheet.evaluate((element) => {
      const style = getComputedStyle(element);
      const scrollbarStyle = getComputedStyle(element, "::-webkit-scrollbar");
      return {
        overflowY: style.overflowY,
        overscrollBehaviorY: style.overscrollBehaviorY,
        scrollbarWidth: style.scrollbarWidth,
        scrollbarDisplay: scrollbarStyle.display,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        bodyOverflow: getComputedStyle(document.body).overflow,
        bodyInlineOverflow: document.body.style.overflow,
        pageScrollY: window.scrollY,
      };
    });

    expect(state.overflowY).toBe("hidden");
    expect(state.scrollHeight).toBeGreaterThanOrEqual(state.clientHeight);
    expect(state.bodyOverflow).toBe("hidden");
    expect(state.bodyInlineOverflow).toBe("hidden");
    expect(state.pageScrollY).toBe(0);

    const menuGeometry = await page.evaluate(() => {
      const scroll = document.querySelector<HTMLElement>(
        '[data-testid="mobile-menu-scroll"]',
      );
      const preferencesElement = document.querySelector<HTMLElement>(
        '[data-testid="mobile-menu-preferences"]',
      );
      if (!scroll || !preferencesElement) {
        throw new Error("Expected mobile menu regions were not rendered");
      }

      const scrollRect = scroll.getBoundingClientRect();
      const preferencesRect = preferencesElement.getBoundingClientRect();
      const preferenceButtons = Array.from(
        preferencesElement.querySelectorAll<HTMLElement>("button"),
      ).map((button) => {
        const rect = button.getBoundingClientRect();
        return { left: rect.left, right: rect.right };
      });

      return {
        scrollOverflowY: getComputedStyle(scroll).overflowY,
        scrollBottom: scrollRect.bottom,
        preferencesTop: preferencesRect.top,
        preferencesBottom: preferencesRect.bottom,
        preferenceButtons,
        viewportWidth: document.documentElement.clientWidth,
        viewportHeight: window.innerHeight,
      };
    });

    expect(menuGeometry.scrollOverflowY).toBe("auto");
    expect(menuGeometry.scrollBottom).toBeCloseTo(
      menuGeometry.preferencesTop,
      5,
    );
    expect(menuGeometry.preferencesBottom).toBeLessThanOrEqual(
      menuGeometry.viewportHeight,
    );
    // Both preference controls (language + theme) must survive; adding a third
    // is a design change, losing one is a regression.
    expect(menuGeometry.preferenceButtons.length).toBeGreaterThanOrEqual(2);
    for (const button of menuGeometry.preferenceButtons) {
      expect(button.left).toBeGreaterThanOrEqual(0);
      expect(button.right).toBeLessThanOrEqual(menuGeometry.viewportWidth);
    }

    expect(await page.evaluate(() => window.scrollY)).toBe(0);

    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");
    expect(await page.evaluate(() => document.body.style.overflow)).not.toBe(
      "hidden",
    );
  });
}

for (const authState of ["anonymous", "authenticated"] as const) {
  test(`desktop ${authState} homepage uses responsive bottom spacing with a flush seam`, async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP_VIEWPORT);
    await installApiMocks(page, authState);
    const response = await page.goto("/");

    expect(response?.status()).toBe(200);
    if (authState === "anonymous") {
      await expect(page.getByTestId("homepage-cta")).toBeVisible();
    } else {
      await expect(page.getByTestId("homepage-cta")).toHaveCount(0);
    }
    await expectHomepageGeometry(page, {
      viewportWidth: DESKTOP_VIEWPORT.width,
      maxBottomSpacing: DESKTOP_MAX_BOTTOM_SPACING,
      footer: "flush",
    });
  });
}

test("mobile gutter updates across rendered non-home to home navigation", async ({
  page,
}) => {
  await page.setViewportSize(MOBILE_VIEWPORT);
  await installApiMocks(page, "anonymous");
  const response = await page.goto("/search");
  expect(response?.status()).toBe(200);

  const geometry = await page.getByTestId("layout-main").evaluate((main) => {
    const rect = main.getBoundingClientRect();
    const firstPageElement = main.firstElementChild?.getBoundingClientRect();
    const style = getComputedStyle(main);

    if (!firstPageElement) {
      throw new Error("Expected the non-home page content to be rendered");
    }

    return {
      main: { left: rect.left, right: rect.right },
      content: {
        left: firstPageElement.left,
        right: firstPageElement.right,
      },
      paddingLeft: Number.parseFloat(style.paddingLeft),
      paddingRight: Number.parseFloat(style.paddingRight),
    };
  });

  expect(geometry.main.left).toBeCloseTo(0, 5);
  expect(geometry.main.right).toBeCloseTo(MOBILE_VIEWPORT.width, 5);
  // There is a gutter, it is symmetric, and the content sits inside it. The
  // exact width is a design choice, so only presence and an upper bound are
  // asserted — a zero gutter (content flush to the screen edge) and a runaway
  // one both still fail.
  expect(geometry.paddingLeft).toBeGreaterThan(0);
  expect(geometry.paddingLeft).toBeLessThanOrEqual(MOBILE_MAX_GUTTER);
  expect(geometry.paddingLeft).toBeCloseTo(geometry.paddingRight, 5);
  expect(geometry.content.left).toBeCloseTo(geometry.paddingLeft, 5);
  expect(geometry.content.right).toBeCloseTo(
    MOBILE_VIEWPORT.width - geometry.paddingRight,
    5,
  );

  // The route transition must remove both the content gutter and the mobile
  // footer without requiring a fresh SSR render.
  await page.locator('footer a[href="/"]').first().click();
  await expect(page).toHaveURL("/");
  await expect(page.getByTestId("homepage-cta")).toBeHidden();
  await expectHomepageGeometry(page, {
    viewportWidth: MOBILE_VIEWPORT.width,
    maxBottomSpacing: MOBILE_MAX_BOTTOM_SPACING,
    footer: "hidden",
  });
});
