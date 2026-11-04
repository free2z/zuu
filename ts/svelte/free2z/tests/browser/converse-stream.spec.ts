import { expect, test, type Page, type Route } from "@playwright/test";

import {
  CONVERSE_STREAM_FIXTURE,
  type FixturePost,
} from "./converse-stream-fixture.mjs";
import { AUTH_STORE_LOADER } from "./dev-source-module";

/**
 * The microblog stream, in a real browser —.
 *
 * The node suite pins the pure functions and the source contracts. What it
 * cannot see is the wiring, and the wiring is where all three asked-for
 * behaviours actually live:
 *
 *   1. the feed renders EVERY post, not one card per thread;
 *   2. a filter change reaches the address bar, and a cold load of that
 *      address reproduces the same filtered feed;
 *   3. a phone can find `/converse` at all.
 *
 * The fixture is deliberately asymmetric — three roots and two replies — so
 * `view=stream` (five cards) and `view=threads` (three) give different answers
 * on identical data. A fixture where both render the same number could not
 * tell a regression from a fix.
 *
 * `PUBLIC_API_BASE_URL` is "" under playwright (see `playwright.config.ts`), so
 * the browser's API calls go to the app origin and are intercepted here, the
 * same way every other client-fetching spec in this directory does it.
 *
 * page one of the bare stream is SERVER-rendered:
 * `converse/+page.server.ts` fetches `/api/comments/?pagination=cursor` from
 * `PRIVATE_API_BASE_URL`, which is `tests/browser/mock-api.mjs` -- a request
 * no `page.route()` here can see. The mock serves the same fixture from the
 * shared `converse-stream-fixture.mjs`, so the five posts a spec sees on a
 * cold `/converse` came out of the HTML, and the browser-side route below
 * answers every LATER list request: a filter, load-more, a reload after a
 * revoked session. Any non-default URL (`?tags=`, `?subscribed=1`, `?sort=hot`)
 * is not server-rendered and still client-fetches page one.
 *
 * NEGATIVE CONTROLS (each run before trusting the suite):
 *   - forcing `const load = loadThreads` in `+page.svelte` turns the stream
 *     test red at 3 cards instead of 5;
 *   - dropping `goto(...)` out of `applyFilters` turns the round-trip test red;
 *   - removing `/converse` from `EXPLORE_LINKS` turns the mobile-menu test red
 *     on a missing link — not on a selector this PR introduced. (The first
 *     draft of that test used a page-wide `a[href="/converse"]` and passed
 *     anyway, because the navbar label is `hidden md:inline` and so is still
 *     in `textContent` at 390px. It is scoped to the sheet for that reason.)
 *   - `$: authenticated = $isAuthenticated` makes the signed-in `?subscribed=1`
 *     test red with TWO list requests, the first without the filter;
 *   - dropping the `if (!append) comments = []` error path leaves the previous
 *     query's five cards under the error banner;
 *   - taking viewer identity out of `requestKey` prevents the replacement
 *     request after a session/account change;
 *   - deleting `converse/+page.server.ts` turns the SSR test red on an HTML
 *     body with no posts in it, and dropping `ssrSatisfiedFiltersKey` out of
 *     the page turns it red on a duplicate client request for page one;
 *   - allowing session-bearing SSR adoption based only on cookie presence
 *     leaves Alice's private cards visible after the first Bob identity reply;
 *   - dropping the pending-search commit out of `applyFilters` navigates to
 *     `?sort=hot` with the typed `q=loud` silently discarded;
 *   - clearing the feed only inside the `waitingForAuth` branch instead of on
 *     an identity change leaves all five cards up through a stalled reload;
 *   - dropping `tags: parseTagList(tagDraft)` out of `applyFilters` navigates
 *     to `?view=threads` with the typed tag gone. That one only goes red once
 *     the blur and the click are dispatched in the SAME task — Playwright's
 *     own `.click()` lets the blur navigation settle first and hides it.
 */

const MOBILE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };

const FIXTURE: FixturePost[] = CONVERSE_STREAM_FIXTURE;

function listPayload(url: URL) {
  let results = FIXTURE;

  const tags = (url.searchParams.get("tags") || "")
    .split(",")
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean);
  if (tags.length) {
    results = results.filter((entry) =>
      tags.every((tag) => entry.tags.some((own) => own.toLowerCase() === tag)),
    );
  }

  const search = (url.searchParams.get("search") || "").trim().toLowerCase();
  if (search) {
    results = results.filter((entry) =>
      `${entry.headline} ${entry.content} ${entry.author.username}`
        .toLowerCase()
        .includes(search),
    );
  }

  if (url.searchParams.get("ordering") === "-tuzis") {
    results = [...results].sort((a, b) => b.tuzis - a.tuzis);
  }

  return { count: results.length, next: null, previous: null, results };
}

type FixtureOptions = {
  /** Milliseconds to hold `/api/auth/user/` before answering. */
  authDelayMs?: number;
  /** What `/api/auth/user/` eventually answers with. */
  creator?: { username: string } | null;
  /** Fail every `/api/comments/` list request after the first N. */
  failListAfter?: number;
  /** Hold every `/api/comments/` list request after the first N, forever. */
  stallListAfter?: number;
};

async function installConverseFixture(
  page: Page,
  options: FixtureOptions = {},
) {
  let listCalls = 0;
  await page.route("**/api/**", async (route: Route) => {
    const url = new URL(route.request().url());
    // `**/api/**` also matches the dev server's own module URLs — the
    // generated client lives at `/src/lib/api/comments/comments.ts`. Fulfilling
    // that with JSON makes the page fail to hydrate with a MIME-type error and
    // the whole route 500s, which looks exactly like an app bug and is not one.
    if (!url.pathname.startsWith("/api/")) {
      await route.continue();
      return;
    }
    const json = (body: unknown) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      });

    if (url.pathname === "/api/auth/user/") {
      if (options.authDelayMs) {
        await new Promise((resolve) =>
          setTimeout(resolve, options.authDelayMs),
        );
      }
      if (options.creator) {
        await json(options.creator);
      } else {
        await route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({ detail: "Authentication credentials." }),
        });
      }
      return;
    }

    if (url.pathname === "/api/comments/") {
      listCalls += 1;
      if (
        options.stallListAfter !== undefined &&
        listCalls > options.stallListAfter
      ) {
        // Never answered. A browser fetch has no timeout, so this is the
        // "rolling restart / stalled upstream" shape, not a slow response.
        return;
      }
      if (
        options.failListAfter !== undefined &&
        listCalls > options.failListAfter
      ) {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ detail: "boom" }),
        });
        return;
      }
      await json(listPayload(url));
      return;
    }

    const replies = url.pathname.match(/^\/api\/comments\/([^/]+)\/replies\/$/);
    if (replies) {
      await json({
        count: 0,
        next: null,
        results: FIXTURE.filter((entry) => entry.parent === replies[1]),
      });
      return;
    }

    const retrieve = url.pathname.match(/^\/api\/comments\/([^/]+)\/$/);
    if (retrieve) {
      const found = FIXTURE.find((entry) => entry.uuid === retrieve[1]);
      if (found) {
        await json(found);
        return;
      }
    }

    await json({ count: 0, next: null, results: [] });
  });
}

function cards(page: Page) {
  return page.locator('[data-testid="converse-feed"] > article');
}

async function gotoConverse(page: Page, query = "") {
  await page.goto(`/converse${query}`);
  // Page one is server-rendered for the bare URL, so the feed being visible
  // no longer means the page is interactive: a filter typed before hydration
  // reaches no handler and navigates nowhere. `data-hydrated` flips in the
  // page's onMount -- a state gate, not a sleep.
  await expect(page.locator('main[data-hydrated="true"]')).toBeAttached({
    timeout: 20_000,
  });
  await expect(page.locator('[data-testid="converse-feed"]')).toBeVisible({
    timeout: 20_000,
  });
}

// The first `/converse` render on a cold Vite worker -- an SSR page now, so
// the server transforms the whole feed component graph before answering --
// can consume most of Playwright's 30-second default. Same budget as
// navbar-notification-active.spec.ts, for the same reason.
test.describe.configure({ timeout: 90_000 });

// Playwright matches routes in reverse registration order, so a test that
// wants different behaviour just installs its own fixture on top of this one.
test.beforeEach(async ({ page }) => {
  await installConverseFixture(page);
});

function listRequestLog(page: Page) {
  const searches: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/comments/") searches.push(url.search);
  });
  return searches;
}

test("page one is server-rendered and the client does not fetch it again", async ({
  page,
  request,
}) => {
  //. Crawlers and first paint used to get an empty shell; `/` and
  // `/converse/[uuid]` both SSR and this was the one public feed that did
  // not. The raw HTML -- no JavaScript involved -- carries the posts...
  const response = await request.get("/converse");
  expect(response.status()).toBe(200);
  const html = await response.text();
  expect(html).toContain("ROOT-A-BODY");
  expect(html).toContain("REPLY-A2-BODY");
  expect(html).toContain("ROOT-C-BODY");
  //...and declares itself variant-aware, like the detail loader does.
  expect(response.headers()["vary"]).toMatch(/cookie/i);

  // In the browser the server page is adopted, not refetched: the bare
  // stream costs zero client list requests. (`/api/auth/user/` still runs.)
  await page.setViewportSize(DESKTOP);
  const listSearches = listRequestLog(page);
  await gotoConverse(page);
  await expect(cards(page)).toHaveCount(5);
  await page.waitForTimeout(500);
  expect(listSearches).toHaveLength(0);
});

test("a filtered URL is not server-rendered, and page one is fetched as a cursor stream", async ({
  page,
}) => {
  // The loader only ever answers the bare stream; anything else must load
  // client-side, and the default stream view opts into keyset pagination
  // rather than page numbers -- a post arriving mid-scroll must not shift
  // rows across a page boundary.
  await page.setViewportSize(DESKTOP);
  const listSearches = listRequestLog(page);
  await gotoConverse(page, "?tags=zcash");
  await expect(cards(page)).toHaveCount(1);
  expect(listSearches).toHaveLength(1);
  expect(listSearches[0]).toContain("pagination=cursor");
  expect(listSearches[0]).toContain("tags=zcash");
  expect(listSearches[0]).not.toContain("page=");
});

test("the default feed is the full stream, replies included", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  await gotoConverse(page);

  await expect(cards(page)).toHaveCount(5);
  // The replies are first-class cards. Under the digest they were folded into
  // their root and never appeared in the feed at all.
  await expect(page.getByText("REPLY-A1-BODY")).toBeVisible();
  await expect(page.getByText("REPLY-A2-BODY")).toBeVisible();
  await expect(page.getByText("ROOT-C-BODY")).toBeVisible();
});

test("the thread digest still exists, as an explicitly chosen view", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  await gotoConverse(page, "?view=threads");

  // Same five posts upstream, collapsed onto three roots.
  await expect(cards(page)).toHaveCount(3);
});

test("a tag filter reaches the URL and survives a reload", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await gotoConverse(page);
  await expect(cards(page)).toHaveCount(5);

  const tagInput = page.locator('[data-testid="converse-tag-filter"]');
  await tagInput.fill("zcash");
  await tagInput.press("Enter");

  // 1. The filter is in the address bar, so the view is linkable.
  await expect(page).toHaveURL(/[?&]tags=zcash\b/);
  // 2. It is actually applied.
  await expect(cards(page)).toHaveCount(1);
  await expect(page.getByText("ROOT-A-BODY")).toBeVisible();
  await expect(page.getByText("ROOT-B-BODY")).toHaveCount(0);

  // 3. The link works on its own — a cold load of that URL, not a re-render.
  const filteredUrl = page.url();
  await page.goto("about:blank");
  await page.goto(filteredUrl);
  await expect(page.locator('[data-testid="converse-feed"]')).toBeVisible({
    timeout: 20_000,
  });
  await expect(cards(page)).toHaveCount(1);
  await expect(page.getByText("ROOT-A-BODY")).toBeVisible();
  // The control that was set is still shown as set. A filter applied to the
  // data but not to the chrome reads as a broken page.
  await expect(tagInput).toHaveValue("zcash");
});

test("sort is linkable, and reaches the API as an ordering", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  const requested: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/comments/") requested.push(url.search);
  });

  await gotoConverse(page, "?sort=hot");

  await expect(cards(page)).toHaveCount(5);
  // `-tuzis`: the 99-tuzi post sorts first.
  await expect(cards(page).first()).toContainText("ROOT-B-BODY");
  expect(requested.some((search) => search.includes("ordering=-tuzis"))).toBe(
    true,
  );
});

test("the RSS feed is advertised and offered", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await gotoConverse(page);

  await expect(
    page.locator(
      'link[rel="alternate"][type="application/rss+xml"][href="/feeds/converse/recent.xml"]',
    ),
  ).toHaveCount(1);
  await expect(
    page.locator('[data-testid="converse-rss-link"]'),
  ).toHaveAttribute("href", "/feeds/converse/recent.xml");
});

test("the homepage advertises the feed as classic did", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await page.goto("/");
  await expect(
    page.locator(
      'link[rel="alternate"][type="application/rss+xml"][href="/feeds/converse/recent.xml"]',
    ),
  ).toHaveCount(1);
});

test("a phone can find the microblog from the menu", async ({ page }) => {
  await page.setViewportSize(MOBILE);
  await page.goto("/");

  const trigger = page.locator('[data-testid="navbar-mobile-menu"]');
  // Scoped to INSIDE the sheet. A page-wide `a[href="/converse"]` also matches
  // the navbar button, whose label is only `hidden md:inline` — present in
  // textContent at every width — so a page-wide locator passes even with
  // `/converse` removed from EXPLORE_LINKS. Verified: that is exactly what it
  // did before this selector was tightened.
  const menuLink = page.locator(
    '[data-testid="mobile-menu-scroll"] a[href="/converse"]',
  );
  // Retry the click so the test does not race SvelteKit hydration.
  await expect
    .poll(
      async () => {
        if ((await menuLink.count()) === 0) await trigger.click();
        return menuLink.count();
      },
      { timeout: 15_000 },
    )
    .toBeGreaterThan(0);

  const converseLink = menuLink.first();
  await expect(converseLink).toBeVisible();
  await expect(converseLink).toContainText("Converse");

  await converseLink.click();
  await expect(page).toHaveURL(/\/converse$/);
  await expect(page.locator('[data-testid="converse-feed"]')).toBeVisible({
    timeout: 20_000,
  });
});

test("a signed-in visitor on ?subscribed=1 is never told to sign in", async ({
  page,
  context,
}) => {
  // The three-state auth trap. `!$isAuthenticated` is also true for the
  // window before `/api/auth/user/` answers, so treating it as "anonymous"
  // renders the UNFILTERED firehose under a "sign in to filter this" notice —
  // to somebody who is already signed in — and then swaps it out.
  await page.setViewportSize(DESKTOP);
  await context.addCookies([
    {
      name: "sessionid",
      value: "converse-stream-fixture",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  await installConverseFixture(page, {
    authDelayMs: 1_200,
    creator: { username: "streamfixture" },
  });
  const listSearches = listRequestLog(page);

  await page.goto("/converse?subscribed=1");

  // While the answer is outstanding: no claim either way, and no feed built on
  // a guess.
  await page.waitForTimeout(400);
  await expect(
    page.locator('[data-testid="converse-subscribed-anon-notice"]'),
  ).toHaveCount(0);
  expect(listSearches).toHaveLength(0);

  await expect(page.locator('[data-testid="converse-feed"]')).toBeVisible({
    timeout: 20_000,
  });
  await expect(
    page.locator('[data-testid="converse-subscribed-anon-notice"]'),
  ).toHaveCount(0);

  // Exactly one list request, and it carried the filter.
  expect(listSearches).toHaveLength(1);
  expect(listSearches[0]).toContain("subscribed_to=true");
});

test("an anonymous visitor on ?subscribed=1 is told, and still gets a feed", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  const listSearches = listRequestLog(page);

  await gotoConverse(page, "?subscribed=1");

  // The backend ignores `subscribed_to` for an anonymous caller rather than
  // erroring, so the honest thing is to not send it and to say so.
  await expect(
    page.locator('[data-testid="converse-subscribed-anon-notice"]'),
  ).toBeVisible();
  await expect(cards(page)).toHaveCount(5);
  expect(listSearches.length).toBeGreaterThan(0);
  expect(
    listSearches.every((search) => !search.includes("subscribed_to")),
  ).toBe(true);
});

test("a failed filter request does not leave the previous results on screen", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  // The unfiltered page one is server-rendered (it never reaches this
  // route); every client list call -- the first is the filter -- 500s.
  await installConverseFixture(page, { failListAfter: 0 });

  await gotoConverse(page);
  await expect(cards(page)).toHaveCount(5);

  const tagInput = page.locator('[data-testid="converse-tag-filter"]');
  await tagInput.fill("zcash");
  await tagInput.press("Enter");

  await expect(page.getByRole("alert")).toBeVisible();
  // The URL, the tag badge and the input all say "zcash" now. Cards from the
  // previous, unfiltered query must not still be sitting under the banner
  // pretending to be the answer.
  await expect(page).toHaveURL(/[?&]tags=zcash\b/);
  await expect(cards(page)).toHaveCount(0);
  await expect(page.getByText("ROOT-B-BODY")).toHaveCount(0);
  //...and the empty state must not claim the platform has no conversations.
  await expect(page.getByText("No conversations found")).toHaveCount(0);
});

test("an ordinary stream reloads when the session is revoked", async ({
  page,
  context,
}) => {
  // Not just the Following filter: `scope_comments_to_visible_parents` widens
  // the queryset for an authenticated caller (their own drafts' threads, their
  // own private conversations). Leaving the previous identity's results on
  // screen after a session is revoked leaves that content in the DOM for
  // whoever picks the machine up next.
  await page.setViewportSize(DESKTOP);
  await context.addCookies([
    {
      name: "sessionid",
      value: "converse-stream-fixture",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  await installConverseFixture(page, {
    creator: { username: "streamfixture" },
  });
  const listSearches = listRequestLog(page);

  await gotoConverse(page);
  await expect(cards(page)).toHaveCount(5);
  // Cookie presence cannot attest this viewer, so authenticated SSR refreshes.
  await expect.poll(() => listSearches.length).toBe(1);

  // Revoke the session the way the auth store models a logout.
  await page.evaluate(
    // The loader waits for Vite's dev-time define globals before importing a
    // source module -- see tests/browser/dev-source-module.ts.
    async (loader) => {
      const { authStore } = await new Function(loader)();
      await authStore.handleAuthFailure(403);
    },
    AUTH_STORE_LOADER,
  );

  // Revocation must cause another request after the initial identity refresh.
  await expect.poll(() => listSearches.length, { timeout: 10_000 }).toBe(2);
});

test("a session revoked before the first auth answer discards the server page", async ({
  page,
  context,
}) => {
  // The SSR loader forwards the cookie, so page one is the COOKIE-HOLDER's
  // feed -- `scope_comments_to_visible_parents` widens it to their drafts'
  // threads and their private AI conversations. Revoke the session between
  // that render and the browser's first `/api/auth/user/` answer and the
  // client is anonymous while the HTML is not. Treating "same cookie" as
  // "same identity" leaves those cards up forever: the page believes the
  // server already answered this exact request, so nothing ever refetches.
  await page.setViewportSize(DESKTOP);
  await context.addCookies([
    {
      name: "sessionid",
      value: "converse-stream-fixture",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  // No `creator`: `/api/auth/user/` answers 403, i.e. the cookie the SSR
  // render was built with is no longer a session.
  await installConverseFixture(page);
  const listSearches = listRequestLog(page);

  await gotoConverse(page);

  // The identity the server rendered for is NOT the identity the browser
  // resolved, so the server page is dropped and page one is refetched as
  // this viewer. Session-bearing SSR always refreshes conservatively; only
  // the anonymous SSR control can attest its viewer without another request.
  await expect
    .poll(() => listSearches.length, { timeout: 10_000 })
    .toBeGreaterThan(0);
  expect(listSearches[0]).toContain("pagination=cursor");
  await expect(cards(page)).toHaveCount(5);
});

test("choosing a sort mid-search keeps the typed query", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await gotoConverse(page);

  const search = page.getByRole("searchbox", {
    name: "Search conversations",
  });
  await search.fill("loud");
  // Inside the 350ms debounce window, switch sort. The navigation must carry
  // the typed query rather than committing the old empty one and then having
  // the pending timer fire against a draft that has been reset.
  await page.getByRole("radio", { name: "Hot", exact: true }).click();

  await expect(page).toHaveURL(/[?&]q=loud\b/);
  await expect(page).toHaveURL(/[?&]sort=hot\b/);
  await expect(search).toHaveValue("loud");
  await expect(cards(page)).toHaveCount(1);
  await expect(page.getByText("ROOT-B-BODY")).toBeVisible();
});

test("a revoked session empties the feed immediately, not when the reload lands", async ({
  page,
  context,
}) => {
  // "loading" is not a bound: a browser fetch has no timeout and nginx allows
  // roughly 200s, so on a stalled reload the previous identity's cards would
  // stay on screen for minutes after the session was revoked — in front of
  // whoever picks the machine up next.
  await page.setViewportSize(DESKTOP);
  await context.addCookies([
    {
      name: "sessionid",
      value: "converse-stream-fixture",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  // Let the initial authenticated SSR refresh finish. The replacement after
  // revocation is the second client list request and never answers.
  await installConverseFixture(page, {
    creator: { username: "streamfixture" },
    stallListAfter: 1,
  });

  await gotoConverse(page);
  await expect(cards(page)).toHaveCount(5);

  await page.evaluate(
    // The loader waits for Vite's dev-time define globals before importing a
    // source module -- see tests/browser/dev-source-module.ts.
    async (loader) => {
      const { authStore } = await new Function(loader)();
      await authStore.handleAuthFailure(403);
    },
    AUTH_STORE_LOADER,
  );

  // The replacement request never answers. The old cards must be gone anyway.
  await expect(cards(page)).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByText("ROOT-A-BODY")).toHaveCount(0);
});

test("clicking a toggle with the tag box focused keeps the tag", async ({
  page,
}) => {
  // `blur` fires before `click`, so the input starts its own navigation and
  // the click then computes its patch from the pre-blur URL. Whichever lands
  // last has to carry both.
  await page.setViewportSize(DESKTOP);
  await gotoConverse(page);
  await expect(cards(page)).toHaveCount(5);

  await page.locator('[data-testid="converse-tag-filter"]').fill("zcash");
  // Blur and click in the SAME task. Playwright's own `.click()` lets the blur
  // navigation settle first, which hides the race entirely — the fix has to be
  // proven against the ordering the browser actually produces when a finger
  // lands on the toggle while the field has focus.
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="converse-tag-filter"]',
    );
    const toggle = Array.from(
      document.querySelectorAll<HTMLElement>('[role="radio"]'),
    ).find((element) => element.textContent?.trim() === "Threads");
    input?.blur();
    toggle?.click();
  });

  await expect(page).toHaveURL(/[?&]tags=zcash\b/);
  await expect(page).toHaveURL(/[?&]view=threads\b/);
  await expect(cards(page)).toHaveCount(1);
});

for (const moment of [
  "first identity answer",
  "later identity refresh",
  "late server answer",
]) {
  test(`account switch at ${moment} clears the prior viewer's feed before replacement`, async ({
    page,
    context,
  }) => {
    await context.addCookies([
      {
        name: "sessionid",
        value: "alice-ssr-session",
        domain: "127.0.0.1",
        path: "/",
      },
    ]);
    let viewer = "alice";
    let releaseAuth!: () => void;
    const heldAuth = new Promise<void>((resolve) => {
      releaseAuth = resolve;
    });
    let authStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      authStarted = resolve;
    });
    let releaseFeed!: () => void;
    const heldFeed = new Promise<void>((resolve) => {
      releaseFeed = resolve;
    });
    let releaseServer!: () => void;
    const heldServer = new Promise<void>((resolve) => {
      releaseServer = resolve;
    });
    let serverReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      serverReady = resolve;
    });
    let serverDelivered!: () => void;
    const delivered = new Promise<void>((resolve) => {
      serverDelivered = resolve;
    });
    if (moment === "late server answer")
      await page.route("**/converse/__data.json?*", async (route) => {
        const response = await route.fetch();
        expect(await response.text()).toContain("ALICE-PRIVATE-SSR-SENTINEL");
        serverReady();
        await heldServer;
        await route.fulfill({ response });
        serverDelivered();
      });
    const payload = (content: string) => ({
      count: 1,
      next: null,
      previous: null,
      results: [{ ...FIXTURE[0], content }],
    });
    await page.route("**/api/auth/user/", async (route) => {
      authStarted();
      if (moment === "first identity answer") await heldAuth;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: viewer === "alice" ? 1 : 2,
          username: viewer,
        }),
      });
    });
    await page.route("**/api/auth/login/", (route) =>
      route.fulfill({
        status: 200,
        headers: {
          "content-type": "application/json",
          "set-cookie": "sessionid=bob-session; Path=/; HttpOnly; SameSite=Lax",
        },
        body: "{}",
      }),
    );
    await page.route("**/api/comments/?*", async (route) => {
      const bob = (route.request().headers().cookie || "").includes(
        "sessionid=bob-session",
      );
      if (bob) await heldFeed;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          payload(bob ? "BOB-FEED-SENTINEL" : "ALICE-PRIVATE-SSR-SENTINEL"),
        ),
      });
    });
    const currentViewer = () =>
      page.evaluate(async (loader) => {
        const { authStore } = await new Function(loader)();
        let username: string | undefined;
        authStore.subscribe((state: { creator?: { username: string } }) => {
          username = state.creator?.username;
        })();
        return username;
      }, AUTH_STORE_LOADER);
    try {
      const response = await page.goto("/converse", {
        waitUntil: "domcontentloaded",
      });
      expect(await response!.text()).toContain("ALICE-PRIVATE-SSR-SENTINEL");
      await started;
      if (moment !== "first identity answer")
        await expect.poll(currentViewer).toBe("alice");
      await expect(
        page.getByText("ALICE-PRIVATE-SSR-SENTINEL", { exact: true }),
      ).toBeVisible();
      if (moment === "late server answer") {
        await page.evaluate(async () => {
          const modulePath =
            "/node_modules/@sveltejs/kit/src/runtime/app/navigation/client.js";
          const { invalidateAll } = await import(modulePath);
          void invalidateAll();
        });
        await ready;
      }
      // Model another tab's successful cookie-setting exchange, without
      // routing this document through an intermediate signed-out state.
      await page.evaluate(() =>
        fetch("/api/auth/login/", {
          method: "POST",
          credentials: "include",
          body: "{}",
        }),
      );
      expect(
        (await context.cookies()).find((cookie) => cookie.name === "sessionid")
          ?.value,
      ).toBe("bob-session");
      viewer = "bob";
      releaseAuth();
      if (moment !== "first identity answer")
        await page.evaluate(async (loader) => {
          const { authStore } = await new Function(loader)();
          await authStore.checkAuth({ force: true });
        }, AUTH_STORE_LOADER);
      await expect.poll(currentViewer).toBe("bob");
      await expect(
        page.getByText("ALICE-PRIVATE-SSR-SENTINEL", { exact: true }),
      ).toHaveCount(0);
      if (moment === "late server answer") {
        const serverResponse = page.waitForResponse((response) =>
          response.url().includes("/converse/__data.json"),
        );
        releaseServer();
        await delivered;
        await (await serverResponse).finished();
        await page.evaluate(
          () =>
            new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            ),
        );
        await expect(
          page.getByText("ALICE-PRIVATE-SSR-SENTINEL", { exact: true }),
        ).toHaveCount(0);
      }
      releaseFeed();
      await expect(
        page.getByText("BOB-FEED-SENTINEL", { exact: true }),
      ).toBeVisible();
    } finally {
      releaseAuth();
      releaseFeed();
      releaseServer();
    }
  });
}

test("an obsolete parent response cannot replace the current viewer's root cache", async ({
  page,
  context,
}) => {
  await context.addCookies([
    {
      name: "sessionid",
      value: "alice-ssr-session",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  let viewer = "alice";
  let oldStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    oldStarted = resolve;
  });
  let releaseOld!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  await page.route("**/api/auth/user/", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: viewer === "alice" ? 1 : 2,
        username: viewer,
      }),
    }),
  );
  await page.route("**/api/auth/login/", (route) =>
    route.fulfill({
      status: 200,
      headers: {
        "content-type": "application/json",
        "set-cookie": "sessionid=bob-session; Path=/; HttpOnly; SameSite=Lax",
      },
      body: "{}",
    }),
  );
  await page.route("**/api/comments/?*", (route) => {
    const filtered = new URL(route.request().url()).searchParams.has("search");
    const result =
      viewer === "alice" || filtered
        ? { ...FIXTURE[1], content: "child-only match" }
        : { ...FIXTURE[0], content: "CURRENT-PUBLIC-ROOT" };
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        count: 1,
        next: null,
        previous: null,
        results: [result],
      }),
    });
  });
  await page.route("**/api/comments/converse-root-a/", async (route) => {
    oldStarted();
    await held;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...FIXTURE[0], content: "OLD-PUBLIC-ROOT" }),
    });
  });
  try {
    await page.goto("/converse?view=threads");
    await started;
    await page.evaluate(() =>
      fetch("/api/auth/login/", {
        method: "POST",
        credentials: "include",
        body: "{}",
      }),
    );
    viewer = "bob";
    await page.evaluate(async (loader) => {
      const { authStore } = await new Function(loader)();
      await authStore.checkAuth({ force: true });
    }, AUTH_STORE_LOADER);
    await expect(
      page.getByText("CURRENT-PUBLIC-ROOT", { exact: true }),
    ).toBeVisible();
    const oldResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/comments/converse-root-a/",
    );
    releaseOld();
    await (await oldResponse).finished();
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    // Both snapshots concern a public root. This proves viewer-cache isolation,
    // without claiming that a private parent is visible in Bob's API queryset.
    const filteredResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === "/api/comments/" &&
        url.searchParams.get("search") === "child-only"
      );
    });
    await page
      .getByRole("searchbox", { name: "Search conversations" })
      .fill("child-only");
    await expect(page).toHaveURL(/q=child-only/);
    await (await filteredResponse).finished();
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await expect(
      page.getByText("CURRENT-PUBLIC-ROOT", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("OLD-PUBLIC-ROOT", { exact: true }),
    ).toHaveCount(0);
  } finally {
    releaseOld();
  }
});
