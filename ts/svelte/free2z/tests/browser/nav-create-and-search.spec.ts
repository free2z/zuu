import { expect, test, type Page } from "@playwright/test";

// Covers the navbar "Create" affordance  and the two search-palette
// polish items from: focus the input when ⌘K opens the palette, and
// never show the ⌘K hint on a coarse pointer.

const DESKTOP_VIEWPORT = { width: 1280, height: 900 };

const TEST_CREATOR = {
  id: 991,
  username: "nav-create-user",
  full_name: "Nav Create User",
};

type AuthState = "anonymous" | "authenticated";

async function installApiMocks(
  page: Page,
  authState: AuthState,
  unreadCount = 0,
) {
  let currentUnreadCount = unreadCount;
  if (authState === "authenticated") {
    // The layout uses the session cookie as its SSR hint.  Seeding only the
    // client store leaves the server rendered navbar anonymous until
    // hydration, which makes the readiness assertion depend on cold module
    // compilation timing.
    await page.context().addCookies([
      {
        name: "sessionid",
        value: "nav-create-session",
        domain: "127.0.0.1",
        path: "/",
      },
    ]);

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
    if (!pathname.startsWith("/api/")) {
      await route.continue();
      return;
    }

    if (pathname === "/api/auth/user/") {
      if (authState === "authenticated") {
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

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        pathname === "/api/events/unread_count/"
          ? {
              unread_count: currentUnreadCount,
              recipient_username: TEST_CREATOR.username,
            }
          : { count: 0, results: [] },
      ),
    });
  });
  return {
    setUnreadCount(count: number) {
      currentUnreadCount = count;
    },
  };
}

async function gotoAuthenticatedHome(page: Page) {
  const sessionCheck = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === "/api/auth/user/",
  );
  await page.goto("/");
  await sessionCheck;
}

test("signed-in users get a one-click Create entry point in the navbar", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await installApiMocks(page, "authenticated");
  await gotoAuthenticatedHome(page);

  const create = page.getByTestId("nav-create");
  await expect(create).toBeVisible();
  await expect(create).toHaveAttribute("href", "/edit");
  // Labelled from md up; the icon alone carries an accessible name below that.
  await expect(create).toContainText("Create");
});

test("the Create entry point is hidden from signed-out visitors", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await installApiMocks(page, "anonymous");
  await page.goto("/");

  await expect(page.getByTestId("nav-create")).toHaveCount(0);
});

test("the user menu offers a New post shortcut to the editor", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await installApiMocks(page, "authenticated");
  await gotoAuthenticatedHome(page);

  await page.getByTestId("navbar-profile-trigger").click();

  const newPost = page.getByTestId("user-menu-new-post");
  await expect(newPost).toBeVisible();
  await expect(newPost).toContainText("New post");
});

test("⌘K focuses the search input so the first keystrokes are not swallowed", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await installApiMocks(page, "anonymous");
  // Seed history so the palette opens onto the "Recent searches" list, which
  // is the state  was reported against.
  await page.addInitScript(() => {
    localStorage.setItem("recentSearches", JSON.stringify(["zcash", "memo"]));
  });
  await page.goto("/");

  // The shortcut hint is rendered by a client-only effect, so its presence is
  // proof that hydration attached the global keydown handler.
  await expect(page.locator("nav kbd")).toBeVisible();

  await page.keyboard.press("ControlOrMeta+k");

  // Type straight away, with no wait for the dialog to settle: that is the
  // flow the shortcut exists for, and the one that was dropping characters.
  await page.keyboard.type("privacy");

  const input = page.locator("[data-slot=command-input]");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("privacy");
});

// How long a deferred animation frame is held back once the test arms the
// starvation shim, and how long the assertions wait it out afterwards.
const STARVED_FRAME_MS = 150;
const OUTLAST_STARVED_FRAME_MS = 500;

test("the palette does not yank focus back once the user tabs away", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await installApiMocks(page, "anonymous");

  // The bug this guards is a race with bits-ui's focus scope, which claims
  // focus from inside a `requestAnimationFrame`. On an idle machine that frame
  // lands in ~16ms — sooner than Playwright can round-trip a keypress over
  // CDP — so the race is simply unobservable and the test passes either way.
  // On a loaded CI runner the frame lands *after* the Tab and focus is yanked
  // back, which is exactly how this spec was failing.
  //
  // Rather than depend on the runner being slow, starve the frame on purpose:
  // once armed, every `requestAnimationFrame` callback is held for
  // STARVED_FRAME_MS. That makes the ordering deterministic on any machine —
  // the library's focus pass is guaranteed to run after the Tab. It is armed
  // only for this test, and only from the moment the palette is opened.
  await page.addInitScript((delayMs) => {
    const native = window.requestAnimationFrame.bind(window);
    const cancelNative = window.cancelAnimationFrame.bind(window);
    const timers = new Map<number, ReturnType<typeof setTimeout>>();
    Object.defineProperty(window, "__starveFrames", {
      value: false,
      writable: true,
      configurable: true,
    });
    window.requestAnimationFrame = (cb: FrameRequestCallback) => {
      if (!(window as unknown as { __starveFrames: boolean }).__starveFrames) {
        return native(cb);
      }
      const handle = native(() => {
        timers.set(
          handle,
          setTimeout(() => {
            timers.delete(handle);
            cb(performance.now());
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

  await page.goto("/");
  await expect(page.locator("nav kbd")).toBeVisible();

  await page.evaluate(() => {
    (window as unknown as { __starveFrames: boolean }).__starveFrames = true;
  });

  await page.keyboard.press("ControlOrMeta+k");

  const input = page.locator("[data-slot=command-input]");
  // Focus must be claimed synchronously, i.e. without waiting for a frame —
  // under starvation nothing rAF-scheduled has run yet.
  await expect(input).toBeFocused();

  await page.keyboard.press("Tab");
  await expect(input).not.toBeFocused();
  // Outlast the starved frame. If anything still owns a deferred focus pass,
  // this is where it fires and steals focus back.
  await page.waitForTimeout(OUTLAST_STARVED_FRAME_MS);
  await expect(input).not.toBeFocused();
});

test("the ⌘K hint is hidden on a coarse pointer", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: DESKTOP_VIEWPORT,
    // Chromium reports `(pointer: coarse)` under touch emulation.
    hasTouch: true,
    // A desktop-class UA string on purpose: the pre-existing user-agent
    // sniffing already blanks the hint for anything that looks mobile, and on
    // a macOS host it also catches `maxTouchPoints`. Pinning a Linux desktop
    // UA takes those paths out of play so this test can only pass because of
    // the media-query check.
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();
  await installApiMocks(page, "anonymous");
  await page.goto("/");

  const trigger = page.getByRole("button", { name: "Search" }).first();
  await expect(trigger).toBeVisible();

  // SSR emits no hint at all (the label is computed client-side), so asserting
  // "not visible" before hydration would pass for the wrong reason. Opening
  // and closing the palette proves the client handlers — and therefore the
  // effect that computes the label — are live.
  // Retry: a click that lands before hydration is simply lost.
  const paletteInput = page.locator("[data-slot=command-input]");
  await expect(async () => {
    await trigger.click();
    await expect(paletteInput).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await page.keyboard.press("Escape");
  await expect(paletteInput).toHaveCount(0);

  // Guard against the emulation silently changing under us and making the
  // assertion below vacuous.
  await expect
    .poll(() =>
      page.evaluate(() => window.matchMedia("(pointer: coarse)").matches),
    )
    .toBe(true);

  const hintVisible = await page.evaluate(() => {
    const kbd = document.querySelector("nav kbd");
    if (!kbd) return false;
    return getComputedStyle(kbd).display !== "none";
  });
  expect(hintVisible).toBe(false);

  await context.close();
});

test("the ⌘K hint is still shown on a fine pointer", async ({ page }) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await installApiMocks(page, "anonymous");
  await page.goto("/");

  await expect
    .poll(() =>
      page.evaluate(() => window.matchMedia("(pointer: coarse)").matches),
    )
    .toBe(false);
  await expect(page.locator("nav kbd")).toBeVisible();
});

//exercise the real document-scrolling article and existing navbar
// selectors. Per-frame 6px deltas used to leave it hidden indefinitely.
async function scrollFrames(page: Page, delta: number, frames: number) {
  await page.evaluate(
    async ({ delta, frames }) => {
      for (let index = 0; index < frames; index++) {
        window.scrollBy(0, delta);
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
      }
    },
    { delta, frames },
  );
}

for (const width of [390, 2560]) {
  test(`gentle scrolling reveals the topbar without reversal jitter at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await installApiMocks(page, "authenticated", 75);
    await page.goto("/hero-user/hero-outline-fixture");
    await expect(page.getByTestId("navbar-profile-trigger")).toBeVisible();
    const nav = page
      .locator("nav")
      .filter({ has: page.getByTestId("navbar-brand") });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollHeight - innerHeight,
      ),
    ).toBeGreaterThan(1000);
    const flowBefore = await nav.evaluate((el) => ({
      height: (el as HTMLElement).offsetHeight,
      next: (el.nextElementSibling as HTMLElement)?.offsetTop,
    }));
    await scrollFrames(page, 6, 50);
    await expect
      .poll(() => nav.evaluate((el) => el.getBoundingClientRect().bottom))
      .toBeLessThanOrEqual(0);
    await scrollFrames(page, -6, 12);
    await expect
      .poll(() => nav.evaluate((el) => el.getBoundingClientRect().top))
      .toBeCloseTo(0, 0);
    // Oscillation smaller than intentional travel must not restart the motion.
    for (let index = 0; index < 4; index++) {
      await scrollFrames(page, 6, 1);
      await scrollFrames(page, -6, 1);
    }
    await expect
      .poll(() => nav.evaluate((el) => el.getBoundingClientRect().top))
      .toBeCloseTo(0, 0);
    expect(
      await nav.evaluate((el) => ({
        height: (el as HTMLElement).offsetHeight,
        next: (el.nextElementSibling as HTMLElement)?.offsetTop,
      })),
    ).toEqual(flowBefore);
    await page.getByTestId("navbar-profile-trigger").focus();
    await scrollFrames(page, 6, 12);
    await expect
      .poll(() => nav.evaluate((el) => el.getBoundingClientRect().top))
      .toBeCloseTo(0, 0);
    await page.getByTestId("navbar-profile-trigger").click();
    await expect(page.getByTestId("user-menu-new-post")).toBeVisible();
    await scrollFrames(page, 6, 12);
    await expect
      .poll(() => nav.evaluate((el) => el.getBoundingClientRect().top))
      .toBeCloseTo(0, 0);
    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.locator("[data-slot=command-input]")).toBeVisible();
    if (width >= 768)
      await expect(page.locator("[data-slot=command-input]")).toBeFocused();
    await scrollFrames(page, 6, 12);
    await expect
      .poll(() => nav.evaluate((el) => el.getBoundingClientRect().top))
      .toBeCloseTo(0, 0);
    await page.keyboard.press("Escape");
    await page.evaluate(() => {
      (document.activeElement as HTMLElement)?.blur();
      window.scrollTo(0, 0);
    });
    await expect
      .poll(() => nav.evaluate((el) => el.getBoundingClientRect().top))
      .toBeCloseTo(0, 0);

    // Back restores the article's document offset programmatically. It must
    // not be interpreted as a new downward gesture that hides the chrome.
    await scrollFrames(page, 6, 50);
    await scrollFrames(page, -6, 12);
    await expect
      .poll(() => nav.evaluate((el) => el.getBoundingClientRect().top))
      .toBeCloseTo(0, 0);
    const savedScroll = await page.evaluate(() => scrollY);
    // The brand is already visible in the sticky bar. A locator click runs
    // scrollIntoView first, which can move the article to 0 before SvelteKit
    // saves its offset. Use the same pointer gesture as a reader here.
    const brandBox = await page.getByTestId("navbar-brand").boundingBox();
    if (!brandBox) throw new Error("Navbar brand has no rendered box");
    await page.mouse.click(
      brandBox.x + brandBox.width / 2,
      brandBox.y + brandBox.height / 2,
    );
    await expect(page).toHaveURL("/");
    await expect(page.getByTestId("homepage-shell")).toBeVisible();
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
    await page.goBack();
    await expect(page).toHaveURL(/hero-outline-fixture/);
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(savedScroll);
    await expect
      .poll(() => nav.evaluate((el) => el.getBoundingClientRect().top))
      .toBeCloseTo(0, 0);
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
    await scrollFrames(page, 6, 8);
    await expect
      .poll(() => nav.evaluate((el) => el.getBoundingClientRect().bottom))
      .toBeLessThanOrEqual(0);
  });
}

test("unread badges leave the avatar breathing room without overflowing narrow screens", async ({
  page,
}) => {
  const apiMocks = await installApiMocks(page, "authenticated", 75);
  await page.goto("/hero-user/hero-outline-fixture");
  const bell = page.getByTestId("navbar-notifications");
  await expect(bell).toContainText("75");
  const profile = page.getByTestId("navbar-profile-trigger");
  for (const width of [
    320, 360, 384, 390, 430, 640, 767, 768, 1024, 1440, 2560,
  ]) {
    await page.setViewportSize({ width, height: 900 });
    const geometry = await page.evaluate(() => {
      const bell = document.querySelector(
        '[data-testid="navbar-notifications"]',
      )!;
      const badge = bell.querySelector("span")!.getBoundingClientRect();
      const profile = document
        .querySelector('[data-testid="navbar-profile-trigger"]')!
        .getBoundingClientRect();
      const bellBox = bell.getBoundingClientRect();
      return {
        gap: profile.left - badge.right,
        vertical: profile.top - bellBox.top,
        right: profile.right,
        width: document.documentElement.clientWidth,
        documentWidth: document.documentElement.scrollWidth,
      };
    });
    expect(
      geometry.gap,
      `${width}px badge to avatar gap`,
    ).toBeGreaterThanOrEqual(12);
    expect(geometry.vertical).toBeCloseTo(0, 0);
    expect(geometry.right).toBeLessThanOrEqual(width);
    expect(geometry.documentWidth).toBe(geometry.width);
    expect(await profile.locator("button").count()).toBe(0);
    const search = page.getByRole("button", { name: "Search", exact: true });
    await expect(search.filter({ visible: true })).toHaveCount(1);
  }
  // Wider badge uses its extra width inward, never into the avatar's space.
  apiMocks.setUnreadCount(100);
  await page.reload();
  await expect(bell).toContainText("99+");
  await page.setViewportSize({ width: 320, height: 900 });
  const badgeBox = await bell.locator("span").boundingBox();
  const avatarBox = await profile.boundingBox();
  expect(avatarBox!.x - badgeBox!.x - badgeBox!.width).toBeGreaterThanOrEqual(
    12,
  );
});

test("reduced-motion topbar has no animated travel", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installApiMocks(page, "anonymous");
  await page.goto("/hero-user/hero-outline-fixture");
  await expect(page.getByTestId("navbar-auth-trigger")).toBeVisible();
  // Anonymous Sign In is already visible in SSR. Prove the navbar's client
  // handlers are live before sending a finite scroll gesture; a slow initial
  // hydration otherwise installs the action after that gesture has ended.
  const search = page.getByRole("button", { name: "Search", exact: true });
  const paletteInput = page.locator("[data-slot=command-input]");
  await expect(async () => {
    await search.filter({ visible: true }).click();
    await expect(paletteInput).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await page.keyboard.press("Escape");
  await expect(paletteInput).toHaveCount(0);
  // Escape restores focus to the trigger; release it so keyboard focus does
  // not intentionally pin the header while the test exercises scroll intent.
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
  const nav = page
    .locator("nav")
    .filter({ has: page.getByTestId("navbar-brand") });
  await scrollFrames(page, 6, 30);
  await expect
    .poll(() => nav.evaluate((el) => el.getBoundingClientRect().bottom))
    .toBeLessThanOrEqual(0);
  expect(
    await nav.evaluate((el) => getComputedStyle(el).transitionDuration),
  ).toBe("0s");
});
