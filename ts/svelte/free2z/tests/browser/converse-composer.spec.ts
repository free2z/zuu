import { expect, test, type Locator, type Page } from "@playwright/test";

// Two things, in a real browser, because neither is visible to `npm run check`
// or to the node suite:
//
//    the composer used to strip the shared Input/Textarea chrome with
//   utility overrides (`border-0 bg-transparent px-0 shadow-none
//   focus-visible:ring-0`). Because `cn()` is tailwind-merge, which only
//   de-dupes classes that share a variant prefix, the bare `bg-transparent`
//   never cancelled the components' `dark:bg-input/30`: the dark-mode fill kept
//   painting while the border, padding and focus ring disappeared, leaving a
//   half-styled field on a themed card. Asserted against resolved computed
//   styles rather than class strings.
//
//    the elegance pass. The composer is present on arrival rather than
//   behind a "Start a conversation" toggle, it no longer asks for a title, and
//   a post therefore has to reach `POST /api/comments/` with an empty headline
//   and come back in the stream. The node suite pins the source contract; only
//   a browser can prove the wire.
//
// NEGATIVE CONTROLS (each run by reverting the change and re-running):
//   - wrapping <ConverseComposer/> in `{#if composerOpen}` again turns "the
//     composer is on screen the moment the page is" red on a missing textarea;
//   - restoring the `<Input id="converse-headline">` block turns "no title
//     field" red;
//   - sending `headline: content` instead of `headline: ""` turns the
//     round-trip test red on the request body;
//   - `border-0 focus-visible:ring-0` on the fields turns the chrome and
//     focus-indicator assertions red.

const DESKTOP_VIEWPORT = { width: 1280, height: 900 };

// A computed `box-shadow` is never the string "none" once Tailwind's ring
// variables are in play: it resolves to a stack of layers, most of them fully
// transparent and zero-size. Return only the layers that actually paint, so a
// focus ring can be told apart from the decoration that was already there.
function visibleShadowLayers(boxShadow: string): string[] {
  if (!boxShadow || boxShadow === "none") return [];

  // Split on top-level commas only -- colour functions contain their own.
  const layers: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of boxShadow) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      layers.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  layers.push(current);

  return layers
    .map((layer) => layer.trim())
    .filter((layer) => {
      const hasGeometry = (layer.match(/-?\d*\.?\d+px/g) ?? []).some(
        (length) => parseFloat(length) !== 0,
      );
      // `oklab(... / 0)` and `rgba(r, g, b, 0)` are both fully transparent.
      const alpha =
        layer.match(/\/\s*(\d*\.?\d+)\s*\)/)?.[1] ??
        layer.match(
          /rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\)/,
        )?.[1];
      return hasGeometry && (alpha === undefined || parseFloat(alpha) > 0);
    });
}

type FocusPaint = {
  boxShadow: string;
  outlineStyle: string;
  outlineWidth: number;
  borderWidth: number;
  borderColor: string;
};

function readFocusPaint(field: Locator): Promise<FocusPaint> {
  return field.evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      boxShadow: s.boxShadow,
      outlineStyle: s.outlineStyle,
      outlineWidth: parseFloat(s.outlineWidth) || 0,
      borderWidth: parseFloat(s.borderTopWidth) || 0,
      borderColor: s.borderTopColor,
    };
  });
}

// Focusing must add something a sighted keyboard user can see. Every simpler
// formulation of this check false-passes on the broken markup:
//   - "box-shadow is not none": the shared Input carries `shadow-xs` at rest.
//   - "box-shadow string changed": focus reserializes a transparent zero-size
//     layer (rgba -> oklab) while painting nothing.
//   - "a painting layer exists while focused": `shadow-xs` is a painting layer
//     and is there whether or not a ring was drawn.
//   - "border colour changed": focus recolours a border that `border-0` has
//     already collapsed to zero width.
// So: require a painted shadow layer that was NOT present at rest, a real
// outline, or a recolour of a border that actually has width.
function expectVisibleFocusIndicator(
  label: string,
  resting: FocusPaint,
  focused: FocusPaint,
) {
  const restingLayers = visibleShadowLayers(resting.boxShadow);
  const focusedLayers = visibleShadowLayers(focused.boxShadow);

  const gainedRing = focusedLayers.some(
    (layer) => !restingLayers.includes(layer),
  );
  const gainedOutline =
    focused.outlineStyle !== "none" && focused.outlineWidth > 0;
  const gainedBorder =
    focused.borderWidth > 0 && focused.borderColor !== resting.borderColor;

  expect(
    gainedRing || gainedOutline || gainedBorder,
    `focusing the ${label} field must paint a visible indicator (resting=${JSON.stringify(
      resting,
    )} focused=${JSON.stringify(focused)})`,
  ).toBe(true);
}

const TEST_CREATOR = {
  id: 826,
  username: "converse-test-user",
  full_name: "Converse Test User",
};

type CreatedPost = {
  headline: unknown;
  content: unknown;
  tuzis: unknown;
  parent: unknown;
};

/**
 * A session plus a mutable one-post feed, so a submitted post can actually
 * come back from the list endpoint the way it does in production.
 */
async function installAuthenticatedDarkSession(
  page: Page,
  failSettlement = false,
) {
  const created: CreatedPost[] = [];
  const feed: unknown[] = [];

  await page.addInitScript((creator) => {
    localStorage.setItem("mode-watcher-mode", "dark");
    localStorage.setItem(
      "auth",
      JSON.stringify({ isAuthenticated: true, creator, loading: false }),
    );
  }, TEST_CREATOR);

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    // `**/api/**` also matches the dev server's own module URLs — the
    // generated client lives at `/src/lib/api/comments/comments.ts`.
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
    if (pathname === "/api/comments/" && request.method() === "POST") {
      const body = JSON.parse(request.postData() || "{}") as CreatedPost;
      created.push(body);
      const post = {
        uuid: `created-${created.length}`,
        parent: null,
        headline: body.headline,
        content: body.content,
        tuzis: body.tuzis,
        num_children: "0",
        tags: [],
        content_url: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        author: { username: TEST_CREATOR.username, avatar_image: null },
      };
      feed.unshift(post);
      if (failSettlement) {
        await page.evaluate(() => {
          const removeItem = Storage.prototype.removeItem;
          Storage.prototype.removeItem = function (key: string) {
            if (key.startsWith("f2z:intent:")) {
              throw new DOMException(
                "Storage became read-only",
                "SecurityError",
              );
            }
            removeItem.call(this, key);
          };
        });
      }
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(post),
      });
      return;
    }
    if (pathname === "/api/comments/") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ count: feed.length, next: null, results: feed }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ count: 0, next: null, results: [] }),
    });
  });

  return { created };
}

test("converse composer fields keep the themed input chrome in dark mode", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await installAuthenticatedDarkSession(page);
  await page.goto("/converse");

  const body = page.locator("#converse-content");
  const amount = page.locator("#converse-weight");

  // No toggle to press: the composer is part of the page. Only hydration is
  // waited for, and that is what the generous timeout is.
  await expect(body).toBeVisible({ timeout: 20_000 });
  await expect(amount).toBeVisible();

  for (const [label, field] of [
    ["body", body],
    ["amount", amount],
  ] as const) {
    const box = await field.evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        borderTopWidth: parseFloat(s.borderTopWidth),
        paddingLeft: parseFloat(s.paddingLeft),
        borderRadius: parseFloat(s.borderTopLeftRadius),
      };
    });

    // A visible border, real horizontal padding and a rounded corner: the
    // shared input surface, not a bare box with a stray dark-mode fill.
    expect(box.borderTopWidth, label).toBeGreaterThan(0);
    expect(box.paddingLeft, label).toBeGreaterThan(0);
    expect(box.borderRadius, label).toBeGreaterThan(0);
  }

  // `border-0` plus `focus-visible:ring-0` on top of the components'
  // `outline-none` left the fields with no visible focus indicator at all.
  // Both are checked: they carry separate class lists and regress separately.
  const restingBody = await readFocusPaint(body);
  const restingAmount = await readFocusPaint(amount);

  // Keyboard focus, not programmatic.focus(): `focus-visible` is what the
  // component styles key off, and it does not match a scripted focus(). The
  // RSS link is the last focusable thing before the composer, so tabbing from
  // it lands on the body field.
  await page.locator('[data-testid="converse-rss-link"]').focus();
  await page.keyboard.press("Tab");
  await expect(body).toBeFocused();
  const focusedBody = await readFocusPaint(body);

  for (const testId of [
    "converse-insert-trigger",
    "converse-image-trigger",
    "converse-video-trigger",
  ]) {
    await page.keyboard.press("Tab");
    await expect(page.getByTestId(testId)).toBeFocused();
  }
  await page.keyboard.press("Tab");
  await expect(amount).toBeFocused();
  const focusedAmount = await readFocusPaint(amount);

  expectVisibleFocusIndicator("body", restingBody, focusedBody);
  expectVisibleFocusIndicator("amount", restingAmount, focusedAmount);
});

test("the composer is on screen the moment the page is, and asks for no title", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await installAuthenticatedDarkSession(page);
  await page.goto("/converse");

  // Nothing clicked.
  await expect(page.locator("#converse-content")).toBeVisible({
    timeout: 20_000,
  });
  await expect(
    page.locator("[aria-controls='conversation-composer']"),
  ).toHaveCount(0);
  await expect(page.locator("#converse-headline")).toHaveCount(0);

  // Controls that lost their visible label kept their accessible one.
  await expect(page.getByLabel("Back with")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Subscribe by RSS" }),
  ).toBeVisible();
  // The permanent "0/1,000" is gone from the resting composer; the exact
  // count is still exposed to assistive tech.
  await expect(
    page.locator('[data-testid="converse-character-counter"]'),
  ).toHaveCount(0);
  await expect(page.getByText("0 characters used out of 1,000")).toBeAttached();
});

test("a post with no title round-trips: empty headline on the wire, card in the stream", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  const { created } = await installAuthenticatedDarkSession(page);
  await page.goto("/converse");

  const body = page.locator("#converse-content");
  await expect(body).toBeVisible({ timeout: 20_000 });

  await body.fill("gm, no title required");
  await page.getByRole("button", { name: "Post", exact: true }).click();

  // The card the user just wrote is in the feed.
  await expect(
    page.locator('[data-testid="converse-feed"] > article', {
      hasText: "gm, no title required",
    }),
  ).toHaveCount(1, { timeout: 20_000 });

  //...and what actually went on the wire carried no title. `headline` is
  // still a field on `CommentCreateSerializer`; this UI simply sends it empty.
  expect(created).toHaveLength(1);
  expect(created[0].headline).toBe("");
  expect(created[0].content).toBe("gm, no title required");
  expect(created[0].tuzis).toBe(1);

  // The box is empty again, ready for the next one.
  await expect(body).toHaveValue("");
});

test("a signed-in creator on a cold load is never told to log in", async ({
  page,
  context,
}) => {
  // The three-state auth trap, which this PR made load-bearing: the
  // composer used to hide behind a toggle, so `!$currentUser` was only ever
  // read after a click. Rendered unconditionally, it is also rendered during
  // SSR — where the auth store is always `unknown`  — and a two-state
  // read there tells a creator holding a valid session cookie to "Log in to
  // post" until `/api/auth/user/` answers.
  //
  // No localStorage snapshot here on purpose: this is the first visit from a
  // machine that has the cookie and nothing else.
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await context.addCookies([
    {
      name: "sessionid",
      value: "converse-composer-fixture",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);

  const loginPromptSeen: number[] = [];
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (!pathname.startsWith("/api/")) {
      await route.continue();
      return;
    }
    if (pathname === "/api/auth/user/") {
      // Slower than any grace period this composer might be tempted to invent
      // for itself. The auth store's own budget before it settles is
      // AUTH_CHECK_TIMEOUT_MS (8s) x three attempts; a shorter local deadline
      // would fire in the middle of that, as a false logged-out state, and a
      // 1.2s delay here would not notice.
      await new Promise((resolve) => setTimeout(resolve, 4_000));
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
      body: JSON.stringify({ count: 0, next: null, results: [] }),
    });
  });

  await page.goto("/converse");

  // Poll across the whole unresolved window rather than sampling the end
  // state, which is green either way.
  const prompt = page.locator('[data-testid="converse-login-prompt"]');
  for (let i = 0; i < 45; i += 1) {
    loginPromptSeen.push(await prompt.count());
    await page.waitForTimeout(100);
  }
  expect(
    loginPromptSeen.filter((count) => count > 0),
    "the composer claimed the visitor was logged out while auth was pending",
  ).toEqual([]);

  await expect(page.locator("#converse-content")).toBeVisible({
    timeout: 20_000,
  });
});

test("a visitor with no session cookie gets the log-in prompt immediately", async ({
  page,
}) => {
  // The other half of the same contract: `hasSession === false` resolves
  // synchronously on the server, so an anonymous visitor must NOT be made to
  // wait 2.5s behind a pending placeholder for an answer already known.
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (!pathname.startsWith("/api/")) {
      await route.continue();
      return;
    }
    if (pathname === "/api/auth/user/") {
      await route.fulfill({ status: 403, body: "{}" });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ count: 0, next: null, results: [] }),
    });
  });

  const response = await page.goto("/converse");
  // In the server-rendered HTML, before a single byte of JavaScript runs.
  expect(await response!.text()).toContain(
    'data-testid="converse-login-prompt"',
  );
  await expect(
    page.locator('[data-testid="converse-login-prompt"]'),
  ).toBeVisible();
  await expect(
    page.locator('[data-testid="converse-composer-pending"]'),
  ).toHaveCount(0);
});

// ---------------------------------------------------------------------------
//  "Log in to post" used to be a link to `/?login=true`, which nothing
// read: the visitor lost /converse and got no login. It is now a button that
// opens the shared sign-in modal IN PLACE. These tests pin the whole contract
// in a real browser: the URL, the history length and the document itself are
// untouched; dismissing returns focus to the prompt; and both the password
// and the MFA branch end with the composer where the prompt was, on /converse.
//
// NEGATIVE CONTROLS: restoring `href="/?login=true"` on the prompt turns the
// first test red on the URL (and on the document marker, since a navigation
// replaces the window); removing `on:back`/`captchaResult` from AuthModalHost
// turns the MFA test red on the request body.

type LoginCall = { body: Record<string, string> };

/**
 * An anonymous visitor whose password is accepted. `mfa` makes the FIRST
 * login attempt come back asking for an OTP, the way Django does, so the
 * second carries `otp_token` (and the same `captcha_result`).
 */
async function installAnonymousLoginMocks(page: Page, { mfa = false } = {}) {
  const logins: LoginCall[] = [];
  let authenticated = false;

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
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
    if (pathname === "/api/auth/login/" && request.method() === "POST") {
      const body = JSON.parse(request.postData() || "{}");
      logins.push({ body });
      if (mfa && logins.length === 1) {
        await route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ non_field_errors: ["Invalid OTP token"] }),
        });
        return;
      }
      authenticated = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ key: "session" }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ count: 0, next: null, results: [] }),
    });
  });

  return { logins };
}

/**
 * The prompt is server-rendered and, until hydration, a plain link to
 * `/login?next=/converse` — the progressive fallback. The in-place contract
 * is a property of the hydrated page, so wait for the first client-side
 * session check (the root layout fires it on mount) before clicking.
 */
async function gotoHydrated(page: Page, path: string) {
  await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes("/api/auth/user/"),
    ),
    page.goto(path),
  ]);
}

/** A marker only the CURRENT document carries: a navigation or reload loses it. */
async function markDocument(page: Page) {
  await page.evaluate(() => {
    (window as any).__f2zSameDocument = "converse-composer";
  });
}

function documentMarker(page: Page) {
  return page.evaluate(() => (window as any).__f2zSameDocument ?? null);
}

test("Log in to post opens the auth dialog in place: same URL, same history, same document", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await installAnonymousLoginMocks(page);
  await gotoHydrated(page, "/converse");

  const prompt = page.locator('[data-testid="converse-login-prompt"]');
  await expect(prompt).toBeVisible();
  await markDocument(page);
  const historyBefore = await page.evaluate(() => history.length);

  await prompt.click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("#username")).toBeVisible();
  // Nothing about where the visitor is has changed.
  expect(new URL(page.url()).pathname).toBe("/converse");
  expect(new URL(page.url()).search).toBe("");
  expect(await page.evaluate(() => history.length)).toBe(historyBefore);
  expect(await documentMarker(page)).toBe("converse-composer");

  // Dismissing hands focus back to the control that opened it.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(prompt).toBeFocused();
  expect(new URL(page.url()).pathname).toBe("/converse");
});

test("a password login from the prompt stays on /converse and swaps in the composer", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  const { logins } = await installAnonymousLoginMocks(page);
  await gotoHydrated(page, "/converse");

  await page.locator('[data-testid="converse-login-prompt"]').click();
  await markDocument(page);
  const dialog = page.getByRole("dialog");
  await dialog.locator("#username").fill(TEST_CREATOR.username);
  await dialog.locator("#password").fill("correct-password");
  await dialog.getByRole("button", { name: "Log in" }).click();

  // The composer is where the prompt was, in the same document.
  await expect(page.locator("#converse-content")).toBeVisible({
    timeout: 20_000,
  });
  await expect(
    page.locator('[data-testid="converse-login-prompt"]'),
  ).toHaveCount(0);
  await expect(dialog).toBeHidden();
  expect(new URL(page.url()).pathname).toBe("/converse");
  expect(await documentMarker(page)).toBe("converse-composer");
  expect(logins).toHaveLength(1);
  expect(logins[0].body).toEqual({
    username: TEST_CREATOR.username,
    password: "correct-password",
    captcha_result: "test",
  });
});

test("the MFA branch from the prompt keeps captcha_result and also ends on /converse", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  const { logins } = await installAnonymousLoginMocks(page, { mfa: true });
  await gotoHydrated(page, "/converse");

  await page.locator('[data-testid="converse-login-prompt"]').click();
  await markDocument(page);
  const dialog = page.getByRole("dialog");
  await dialog.locator("#username").fill(TEST_CREATOR.username);
  await dialog.locator("#password").fill("correct-password");
  await dialog.getByRole("button", { name: "Log in" }).click();

  // The OTP step, opened by the shared host — not a component-local copy.
  const otp = page.locator("#otpCode");
  await expect(otp).toBeVisible();
  await otp.fill("123456");
  await page.getByRole("button", { name: "Verify" }).click();

  await expect(page.locator("#converse-content")).toBeVisible({
    timeout: 20_000,
  });
  expect(new URL(page.url()).pathname).toBe("/converse");
  expect(await documentMarker(page)).toBe("converse-composer");
  expect(logins).toHaveLength(2);
  expect(logins[1].body).toEqual({
    username: TEST_CREATOR.username,
    password: "correct-password",
    captcha_result: "test",
    otp_token: "123456",
  });
});

test("a paid post remains visible when settlement storage fails", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP_VIEWPORT);
  const { created } = await installAuthenticatedDarkSession(page, true);
  await page.goto("/converse");
  const body = page.locator("#converse-content");
  await expect(body).toBeVisible({ timeout: 20_000 });
  await body.fill("confirmed despite storage failure");
  await page.getByRole("button", { name: "Post", exact: true }).click();
  await expect(
    page.locator('[data-testid="converse-feed"] > article', {
      hasText: "confirmed despite storage failure",
    }),
  ).toHaveCount(1, { timeout: 20_000 });
  await expect(body).toHaveValue("");
  await expect(
    page
      .getByTestId("payment-outcome-error")
      .getByText("Browser storage could not save this outcome.", {
        exact: false,
      }),
  ).toBeVisible();
  expect(created).toHaveLength(1);
});

test("mobile composing preserves a paid draft across dismissals and resizing", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.addInitScript(() => {
    const viewport = new EventTarget();
    Object.defineProperties(viewport, {
      height: {
        get: () => (window as any).__keyboardHeight ?? window.innerHeight,
      },
      offsetTop: { get: () => (window as any).__keyboardOffset ?? 0 },
    });
    Object.defineProperty(window, "visualViewport", { get: () => viewport });
    (window as any).__keyboardViewport = viewport;
  });
  const { created } = await installAuthenticatedDarkSession(page);
  await page.goto("/converse");
  await expect(page.locator('main[data-hydrated="true"]')).toBeVisible();
  const body = page.locator("#converse-content");
  await expect(body).toBeHidden();
  const fab = page.getByRole("button", { name: "New conversation" });
  const fabBox = await fab.boundingBox();
  expect(fabBox!.y).toBeGreaterThan(350);
  expect(fabBox!.y + fabBox!.height).toBeLessThanOrEqual(684);
  await page.evaluate(() =>
    document.documentElement.style.setProperty(
      "--f2z-bottom-dock-height",
      "80px",
    ),
  );
  await expect
    .poll(async () => (await fab.boundingBox())!.y)
    .toBe(fabBox!.y - 80);
  await page.evaluate(() =>
    document.documentElement.style.removeProperty("--f2z-bottom-dock-height"),
  );
  await fab.click();
  const dialog = page.getByRole("dialog", { name: "New conversation" });
  await expect(dialog).toBeVisible();
  const sheetBox = await dialog.boundingBox();
  expect(sheetBox!.y + sheetBox!.height).toBe(700);
  await expect(body).toBeFocused();
  await body.fill("/bol");
  const commands = page.getByRole("listbox", { name: "Commands" });
  await expect(commands).toBeVisible();
  await body.press("Escape");
  await expect(commands).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(body).toBeFocused();
  await body.selectText();
  const bold = page.getByRole("button", { name: "Bold", exact: true });
  const toolbar = bold.locator("xpath=..");
  await expect(bold).toBeVisible();
  const initialToolbarBox = await toolbar.boundingBox();
  await page.evaluate(() => {
    (window as any).__keyboardHeight = 400;
    (window as any).__keyboardViewport.dispatchEvent(new Event("resize"));
  });
  await expect
    .poll(async () => {
      const box = await dialog.boundingBox();
      return box!.y + box!.height;
    })
    .toBe(400);
  // Only visualViewport changed: the layout viewport remains 700px tall.
  // An open selection toolbar must follow the relocated editor without a
  // new selection event, keeping the selected draft and focus intact.
  expect(await page.evaluate(() => window.innerHeight)).toBe(700);
  await expect
    .poll(async () => (await toolbar.boundingBox())!.y)
    .toBeLessThan(initialToolbarBox!.y);
  await expect
    .poll(async () => {
      const box = await toolbar.boundingBox();
      return box!.y + box!.height - (await body.boundingBox())!.y;
    })
    .toBeLessThanOrEqual(1);
  const keyboardToolbarBox = await toolbar.boundingBox();
  expect(keyboardToolbarBox!.y).toBeGreaterThanOrEqual(8);
  expect(
    keyboardToolbarBox!.y + keyboardToolbarBox!.height,
  ).toBeLessThanOrEqual(392);
  await expect(body).toHaveValue("/bol");
  expect(
    await body.evaluate((el: HTMLTextAreaElement) => [
      el.selectionStart,
      el.selectionEnd,
    ]),
  ).toEqual([0, 4]);
  await expect(body).toBeFocused();
  for (const control of [
    page.getByLabel("Back with"),
    page.getByRole("button", { name: "Post", exact: true }),
  ]) {
    const box = await control.boundingBox();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(400);
  }
  await page.evaluate(() => {
    (window as any).__keyboardOffset = 30;
    (window as any).__keyboardViewport.dispatchEvent(new Event("scroll"));
  });
  await expect
    .poll(async () => {
      const box = await dialog.boundingBox();
      return box!.y + box!.height;
    })
    .toBe(430);
  await expect
    .poll(async () =>
      Math.abs((await toolbar.boundingBox())!.y - (keyboardToolbarBox!.y + 30)),
    )
    .toBeLessThanOrEqual(2);
  await page.evaluate(() => {
    (window as any).__keyboardHeight = 250;
    (window as any).__keyboardOffset = 200;
    (window as any).__keyboardViewport.dispatchEvent(new Event("scroll"));
  });
  await expect
    .poll(async () => (await toolbar.boundingBox())!.y)
    .toBeGreaterThanOrEqual(208);
  const pannedToolbarBox = await toolbar.boundingBox();
  expect(pannedToolbarBox!.y + pannedToolbarBox!.height).toBeLessThanOrEqual(
    442,
  );
  await expect(body).toHaveValue("/bol");
  expect(
    await body.evaluate((el: HTMLTextAreaElement) => [
      el.selectionStart,
      el.selectionEnd,
    ]),
  ).toEqual([0, 4]);
  await page.evaluate(() => {
    (window as any).__keyboardHeight = undefined;
    (window as any).__keyboardOffset = 0;
    (window as any).__keyboardViewport.dispatchEvent(new Event("resize"));
  });
  await body.fill("mobile draft survives");
  const amount = page.getByLabel("Back with");
  await amount.fill("10000");
  await expect
    .poll(() => amount.evaluate((el) => el.scrollWidth - el.clientWidth))
    .toBeLessThanOrEqual(0);
  await body.focus();
  await expect
    .poll(() => amount.evaluate((el) => el.scrollWidth - el.clientWidth))
    .toBeLessThanOrEqual(0);
  await page.getByLabel("Back with").fill("7");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(fab).toBeFocused();
  await fab.click();
  await expect(body).toHaveValue("mobile draft survives");
  await expect(page.getByLabel("Back with")).toHaveValue("7");
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await page.evaluate(() => {
    (window as any).__keyboardViewport.dispatchEvent(new Event("resize"));
  });
  await expect(bold).toHaveCount(0);
  await page.keyboard.press("Escape");
  await fab.click();
  await expect(
    dialog.getByRole("button", { name: "Close", exact: true }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await expect(body).toBeVisible();
  await expect(fab).toBeHidden();
  await expect(body).toHaveValue("mobile draft survives");
  await page.setViewportSize({ width: 320, height: 700 });
  await expect(body).toBeHidden();
  await fab.click();
  await page.getByRole("button", { name: "Post", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.locator('[data-testid="converse-feed"] > article', {
      hasText: "mobile draft survives",
    }),
  ).toHaveCount(1);
  expect(created).toHaveLength(1);
  expect(created[0].content).toBe("mobile draft survives");
  expect(created[0].tuzis).toBe(7);
  await expect(page.getByText("Posted", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close notification" }).click();
  await fab.click();
  await expect(body).toHaveValue("");
});

test("mobile filters fit a narrow phone and keep tag and author filters in the URL", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await installAuthenticatedDarkSession(page);
  await page.goto("/converse");
  await expect(page.locator('main[data-hydrated="true"]')).toBeVisible();
  const filters = page.getByRole("region", { name: "Conversation filters" });
  const tagInput = page.getByTestId("converse-tag-filter");
  await expect(tagInput).toHaveCount(1);
  await expect(tagInput).toBeVisible();
  await tagInput.fill("zcash");
  await tagInput.press("Enter");
  await expect(page).toHaveURL(/[?&]tags=zcash/);
  const search = page.getByRole("searchbox", { name: "Search conversations" });
  await tagInput.fill("zcash, ");
  await search.fill("zero ");
  await expect(page).toHaveURL(/[?&]q=zero(?:&|$)/);
  await expect(search).toHaveValue("zero ");
  await expect(tagInput).toHaveValue("zcash, ");
  await search.pressSequentially("knowledge");
  await expect(page).toHaveURL(/[?&]q=zero(?:\+|%20)knowledge(?:&|$)/);
  await expect(search).toHaveValue("zero knowledge");
  await expect(tagInput).toHaveValue("zcash, ");
  await tagInput.press("End");
  await tagInput.pressSequentially("art");
  await expect(tagInput).toHaveValue("zcash, art");
  await search.fill("loud");
  await page
    .getByRole("button", { name: "Sort conversations: New", exact: true })
    .click();
  await expect(page).toHaveURL(/[?&]sort=hot/);
  await expect(page).toHaveURL(/[?&]q=loud/);
  await expect(search).toHaveValue("loud");
  await expect(page).toHaveURL(/[?&]tags=zcash/);
  await page
    .getByRole("button", { name: "Feed layout: Stream", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Show standalone posts only", exact: true })
    .click();
  await page.getByRole("button", { name: "Everyone", exact: true }).click();
  await expect(page).toHaveURL(/[?&]view=threads/);
  await expect(page).toHaveURL(/[?&]posts=1/);
  await expect(page).toHaveURL(/[?&]subscribed=1/);
  await expect(page).toHaveURL(/[?&]tags=zcash%2Cart/);
  await page.reload();
  await expect(tagInput).toBeVisible();
  await expect(tagInput).toHaveValue("zcash, art");
  await expect(search).toHaveValue("loud");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);
  for (const button of await filters.getByRole("button").all()) {
    if (!(await button.isVisible())) continue;
    const box = await button.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(320);
  }

  // The actual navbar link creates a history entry while this component
  // stays mounted. It must discard a pending search, as must Back/Forward.
  await search.fill("discarded-on-link");
  await page.getByTestId("navbar-converse").click();
  await expect(page).toHaveURL(/\/converse$/);
  await expect(search).toHaveValue("");
  await page.waitForTimeout(450);
  await expect(page).toHaveURL(/\/converse$/);
  await search.fill("uncommitted");
  await page.goBack();
  await expect(search).toHaveValue("loud");
  await expect(tagInput).toHaveValue("zcash, art");
  await page.waitForTimeout(450);
  await expect(page).toHaveURL(/[?&]q=loud/);
  await page.goForward();
  await expect(search).toHaveValue("");
  await search.fill("same-url-pending");
  await page.getByTestId("navbar-converse").click();
  await page.waitForTimeout(450);
  await expect(page).toHaveURL(/\/converse$/);
  await expect(search).toHaveValue("");
});

test("mobile sign-in from the composer keeps the conversation sheet usable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installAnonymousLoginMocks(page);
  await gotoHydrated(page, "/converse");
  await page.getByRole("button", { name: "New conversation" }).click();
  await page.getByTestId("converse-login-prompt").click();
  const login = page
    .getByRole("dialog")
    .filter({ has: page.locator("#username") });
  await expect(login).toBeVisible();
  await login.locator("#username").fill(TEST_CREATOR.username);
  await login.locator("#password").fill("correct-password");
  await login.getByRole("button", { name: "Log in" }).click();
  await expect(page.locator("#converse-content")).toBeVisible({
    timeout: 20_000,
  });
  expect(new URL(page.url()).pathname).toBe("/converse");
  await page
    .getByRole("dialog", { name: "New conversation" })
    .getByRole("button", { name: "Close" })
    .click();
  await expect(
    page.getByRole("button", { name: "New conversation" }),
  ).toBeFocused();
});
