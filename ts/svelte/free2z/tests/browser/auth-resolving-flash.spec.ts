import { expect, test, type Page } from "@playwright/test";
import { browserAppOrigin } from "./ports";

// Issue  — on a hard load, a signed-in creator saw the navbar's **Sign
// In** button until `/api/auth/user/` answered. "Not resolved yet" and
// "authoritatively signed out" were the same state, and the UI rendered the
// most alarming reading of the ambiguity: you are logged out.
//
// The store's three-state machine is pinned in `tests/auth-status.test.mjs`.
// This file drives the real navbar: what is rendered while the session is
// unresolved, and that swapping the placeholder for either resolved control
// does not move the layout.

const NARROW_MOBILE_VIEWPORT = { width: 320, height: 700 };
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const DESKTOP_VIEWPORT = { width: 1280, height: 900 };
const GEOMETRY_TOLERANCE = 0.5;

const TEST_CREATOR = {
  id: 1140,
  username: "flashfree",
  full_name: "Flash Free",
};

type AuthAnswer = { status: number; body: unknown };

declare global {
  interface Window {
    __signInSightings: number[];
    __releaseMark: number;
  }
}

/**
 * Records every moment a **Sign In** trigger existed in the DOM.
 *
 * Polling from the test side can only ever prove "it was absent when I
 * looked" — the flash is ~200ms and a Playwright round-trip is long enough to
 * step right over it. A MutationObserver armed at document_start sees every
 * intermediate state the browser actually painted, which is the only way to
 * assert the button was *never* there.
 */
async function watchForSignInButton(page: Page) {
  await page.addInitScript(() => {
    window.__signInSightings = [];
    window.__releaseMark = Number.POSITIVE_INFINITY;
    const record = () => {
      if (document.querySelector('[data-testid="navbar-auth-trigger"]')) {
        window.__signInSightings.push(performance.now());
      }
    };
    const start = () => {
      record();
      new MutationObserver(record).observe(document.documentElement, {
        subtree: true,
        childList: true,
      });
    };
    if (document.documentElement) {
      start();
    } else {
      document.addEventListener("readystatechange", function once() {
        if (!document.documentElement) return;
        document.removeEventListener("readystatechange", once);
        start();
      });
    }
  });
}

/**
 * Installs a valid-looking session cookie and holds `/api/auth/user/` open
 * until the test releases it. No `localStorage.auth` snapshot: that is the
 * fresh-client case from the report, where the client has nothing to render
 * from and the server cookie is the only signal that a session may exist.
 */
async function installHeldSession(page: Page, { withCookie = true } = {}) {
  if (withCookie) {
    await page.context().addCookies([
      {
        name: "sessionid",
        value: "held-session-1140",
        url: browserAppOrigin(),
      },
    ]);
  }

  let releaseGate: (answer: AuthAnswer) => void = () => {};
  const gate = new Promise<AuthAnswer>((resolve) => {
    releaseGate = resolve;
  });

  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;

    // Vite serves source modules from paths such as /src/lib/api/config.ts.
    if (!pathname.startsWith("/api/")) {
      await route.continue();
      return;
    }

    if (pathname === "/api/auth/user/") {
      const answer = await gate;
      await route.fulfill({
        status: answer.status,
        contentType: "application/json",
        body: JSON.stringify(answer.body),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ count: 0, results: [] }),
    });
  });

  return async (status: number, body: unknown) => {
    await page.evaluate(() => {
      window.__releaseMark = performance.now();
    });
    releaseGate({ status, body });
  };
}

async function signInSightings(page: Page) {
  return page.evaluate(() => ({
    sightings: window.__signInSightings,
    releaseMark: window.__releaseMark,
  }));
}

test("a held session never renders Sign In, then resolves to the profile control", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await watchForSignInButton(page);
  const release = await installHeldSession(page);

  await page.goto("/");

  // The navbar itself is up — otherwise "no Sign In button" would pass
  // because nothing has rendered at all.
  await expect(page.getByTestId("navbar-brand")).toBeVisible();

  // Assert the ABSENCE of Sign In before the presence of the placeholder, so
  // that on unfixed `main` this test fails on the real defect rather than on a
  // selector that only the fix introduces.
  await expect(page.getByTestId("navbar-auth-trigger")).toHaveCount(0);
  // The footer also carries <nav> landmarks, so scope to the header bar.
  await expect(page.locator("nav").first()).not.toContainText("Sign In");

  const placeholder = page.getByTestId("navbar-auth-pending");
  await expect(placeholder).toBeVisible();

  await release(200, TEST_CREATOR);

  await expect(page.getByTestId("navbar-profile-trigger")).toBeVisible();
  await expect(placeholder).toHaveCount(0);

  const { sightings } = await signInSightings(page);
  expect(
    sightings,
    "a Sign In button existed in the DOM while the session was unresolved",
  ).toEqual([]);
});

test("the placeholder is inert: not a button, not focusable, no click target", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await installHeldSession(page);
  await page.goto("/");

  const placeholder = page.getByTestId("navbar-auth-pending");
  await expect(placeholder).toBeVisible();

  const shape = await placeholder.evaluate((el) => ({
    tag: el.tagName,
    role: el.getAttribute("role"),
    tabIndex: el.getAttribute("tabindex"),
    label: el.getAttribute("aria-label"),
    // A spinner that flickers in and out on a fast resolve is worse than a
    // quiet shape, so nothing here may animate.
    animation: getComputedStyle(el).animationName,
  }));

  expect(shape.tag).toBe("DIV");
  expect(shape.role).toBe("status");
  expect(shape.tabIndex).toBeNull();
  expect(shape.label && shape.label.length).toBeGreaterThan(0);
  expect(shape.animation).toBe("none");
  await expect(page.getByRole("button", { name: /sign in/i })).toHaveCount(0);
});

test("a stale session shows Sign In only after the 401 lands", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await watchForSignInButton(page);
  const release = await installHeldSession(page);

  await page.goto("/");

  await expect(page.getByTestId("navbar-brand")).toBeVisible();
  await expect(page.getByTestId("navbar-auth-trigger")).toHaveCount(0);
  await expect(page.getByTestId("navbar-auth-pending")).toBeVisible();

  await release(401, { detail: "Not authenticated" });

  const signIn = page.getByTestId("navbar-auth-trigger");
  await expect(signIn).toBeVisible();
  await expect(signIn).toContainText("Sign In");
  await expect(page.getByTestId("navbar-auth-pending")).toHaveCount(0);

  const { sightings, releaseMark } = await signInSightings(page);
  expect(sightings.length).toBeGreaterThan(0);
  expect(
    Math.min(...sightings),
    "Sign In appeared before the session was authoritatively anonymous",
  ).toBeGreaterThanOrEqual(releaseMark);
});

test("a visitor with no session cookie gets Sign In straight from the server", async ({
  page,
}) => {
  // The server-side half of the fix. Django session auth cannot authenticate a
  // request that carries no `sessionid`, so its absence is authoritative and
  // the SSR HTML resolves the anonymous case with no placeholder and no client
  // round-trip. Asserted against the raw response rather than the rendered
  // page: after hydration both paths agree, so only the bytes prove it.
  const response = await page.request.get("/");
  expect(response.status()).toBe(200);
  const html = await response.text();

  expect(html).toContain('data-testid="navbar-auth-trigger"');
  expect(html).not.toContain('data-testid="navbar-auth-pending"');
});

test("a visitor with a session cookie gets the placeholder from the server, never Sign In", async ({
  page,
}) => {
  await page.context().addCookies([
    {
      name: "sessionid",
      value: "ssr-session-1140",
      url: browserAppOrigin(),
    },
  ]);

  const response = await page.request.get("/");
  expect(response.status()).toBe(200);
  const html = await response.text();

  expect(html).not.toContain('data-testid="navbar-auth-trigger"');
  expect(html).toContain('data-testid="navbar-auth-pending"');
});

for (const viewport of [
  NARROW_MOBILE_VIEWPORT,
  MOBILE_VIEWPORT,
  DESKTOP_VIEWPORT,
]) {
  test(`resolving to the profile control shifts nothing at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const release = await installHeldSession(page);
    await page.goto("/");

    const nav = page.locator("nav").first();
    const placeholder = page.getByTestId("navbar-auth-pending");
    await expect(placeholder).toBeVisible();

    const before = await placeholder.boundingBox();
    const navBefore = await nav.boundingBox();
    expect(before).not.toBeNull();
    expect(navBefore).not.toBeNull();

    await release(200, TEST_CREATOR);

    const trigger = page.getByTestId("navbar-profile-trigger");
    await expect(trigger).toBeVisible();
    const after = await trigger.boundingBox();
    const navAfter = await nav.boundingBox();
    expect(after).not.toBeNull();
    expect(navAfter).not.toBeNull();

    // The whole point of the placeholder: swapping it for the control it
    // becomes must be a fill change, not a reflow. A content flash traded for
    // a layout shift is a worse bug, and Google measures the latter.
    expect(Math.abs(after!.x - before!.x)).toBeLessThanOrEqual(
      GEOMETRY_TOLERANCE,
    );
    expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(
      GEOMETRY_TOLERANCE,
    );
    expect(Math.abs(after!.width - before!.width)).toBeLessThanOrEqual(
      GEOMETRY_TOLERANCE,
    );
    expect(Math.abs(after!.height - before!.height)).toBeLessThanOrEqual(
      GEOMETRY_TOLERANCE,
    );
    expect(Math.abs(navAfter!.height - navBefore!.height)).toBeLessThanOrEqual(
      GEOMETRY_TOLERANCE,
    );

    // Nothing may overflow the viewport in either state.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth,
    );
    expect(overflow).toBeLessThanOrEqual(viewport.width);
  });

  test(`resolving to Sign In keeps the navbar the same height at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const release = await installHeldSession(page);
    await page.goto("/");

    const nav = page.locator("nav").first();
    const placeholder = page.getByTestId("navbar-auth-pending");
    await expect(placeholder).toBeVisible();

    const before = await placeholder.boundingBox();
    const navBefore = await nav.boundingBox();

    await release(401, { detail: "Not authenticated" });

    const signIn = page.getByTestId("navbar-auth-trigger");
    await expect(signIn).toBeVisible();
    const after = await signIn.boundingBox();
    const navAfter = await nav.boundingBox();

    // The stale-session path is the one case where the two controls are
    // genuinely different widths, so only the vertical axis can be pinned.
    // The navbar's own height — the number a layout shift is measured on —
    // must not move at all.
    expect(Math.abs(after!.height - before!.height)).toBeLessThanOrEqual(
      GEOMETRY_TOLERANCE,
    );
    expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(
      GEOMETRY_TOLERANCE,
    );
    expect(Math.abs(navAfter!.height - navBefore!.height)).toBeLessThanOrEqual(
      GEOMETRY_TOLERANCE,
    );

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth,
    );
    expect(overflow).toBeLessThanOrEqual(viewport.width);
  });
}

test("parallel SSR requests keep anonymous and session state isolated", async ({
  request,
}) => {
  await Promise.all(
    Array.from({ length: 20 }, async (_, index) => {
      const hasSession = index % 2 === 1;
      const response = await request.get(`/?isolation=${index}`, {
        headers: hasSession
          ? { cookie: `sessionid=ssr-isolation-${index}` }
          : {},
      });
      expect(response.status()).toBe(200);
      const html = await response.text();
      expect(html.includes('data-testid="navbar-auth-pending"')).toBe(
        hasSession,
      );
      expect(html.includes('data-testid="navbar-auth-trigger"')).toBe(
        !hasSession,
      );
    }),
  );
});
