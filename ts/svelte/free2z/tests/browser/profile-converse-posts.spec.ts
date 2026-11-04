import { expect, test, type Page, type Route } from "@playwright/test";

import { conversePost } from "./converse-stream-fixture.mjs";

/**
 * The profile Posts tab, in a real browser.
 *
 * This suite exists because of one specific defect that already shipped on
 * this surface and was caught by a human read rather than by any test:
 *
 *   `Tabs.Content` is NOT lazy. bits-ui renders every panel and marks the
 *   inactive ones `hidden`, so a bare `<ProfileConversePosts />` inside the
 *   closed Posts panel mounted on EVERY profile view -- owner, visitor and
 *   crawler alike -- and its `onMount` fired
 *   `GET /api/comments/?author=...&pagination=cursor`, a full unindexed
 *   `count()` over `comments_comment`, on every hit of the most-crawled page
 *   type on the site. Two code comments asserted the opposite.
 *
 * The fix is the `{#if publicPostsOpened}` / `{#if ownerPostsOpened}` latch in
 * `[username]/+page.svelte`. Its only regression guard until now was a set of
 * regexes over the source TEXT in `converse-discovery.test.mjs`, which cannot
 * fail for the reason that matters: extract the two mount sites into a
 * wrapper component, or change how the latch settles on first render, and
 * every regex still matches while every profile view resumes the query.
 *
 * So the assertions here are deliberately about OBSERVED BEHAVIOUR:
 *
 *   1. a cold public profile renders no posts panel AT ALL -- not even a
 *      hidden one in the SSR HTML -- and fires zero `/api/comments/` requests;
 *   2. opening the tab fires exactly one, and the cards render;
 *   3. tabbing away and back fires no second one (the latch is the deliberate
 *      other half of the fix, and nothing proved it);
 *   4. "Load more posts" continues by opaque `cursor`, never by `page=`.
 *
 * Two independent things have to hold for (1), because each covers the other's
 * blind spot:
 *
 *   - **the panel is absent from the DOM**, not merely `hidden`. That is a
 *     structural fact of the SSR HTML, so no timing can flatter it — but a
 *     future panel that mounts empty and fetches anyway would satisfy it.
 *   - **no `/api/comments/` request has been made once the page is proven
 *     interactive.** The proof is opening the article Tag filter: its popover
 *     only responds to a click after SvelteKit hydrates, and an eagerly
 *     mounted panel dispatches its `onMount` fetch during that same hydration,
 *     strictly earlier. A `"CLICK"` sentinel then goes into the same log the
 *     route handler writes, so the tab's own request is ordered after it.
 *
 * The first draft asserted only the sentinel ordering, and it was NOT enough:
 * `expect(tab).toBeVisible()` is satisfied by the SSR HTML, so the sentinel
 * landed BEFORE hydration and the defect's request was logged after it. The
 * suite passed against the exact bug. That is why the hydration gate below is
 * a real interaction and not a visibility check.
 *
 * NEGATIVE CONTROLS (each run against this file before trusting it):
 *   - deleting `{#if publicPostsOpened}` from `[username]/+page.svelte` (the
 *     exact defect) turns test (1) red twice over: the panel is present in the
 *     cold DOM, and — with that structural assertion removed to check the other
 *     half separately — a `/api/comments/` request is already logged once the
 *     page is interactive, before the tab is ever clicked;
 *   - replacing the latch with `{#if publicTab === "posts"}` turns test (3)
 *     red at TWO requests -- the panel is torn down on the way to Articles and
 *     refetches on the way back;
 *   - dropping `params.cursor = pageToken` out of `converseListParams` turns
 *     test (4) red on a second request that repeats page one;
 *   - dropping `content_type__isnull` out of the `posts` branch turns the
 *     wire-shape assertion in (2) red.
 *
 * `tagfilterfixture` is reused as the profile because `mock-api.mjs` already
 * answers `/api/creator/tagfilterfixture/` and
 * `/api/zpage/?username=tagfilterfixture` for it, so the page renders its
 * public two-tab view without a new server fixture. Only `/api/comments/` is
 * intercepted here; everything else continues to the mock API, which is what
 * makes "zero comments requests" a statement about the real page rather than
 * about a stubbed one.
 */

const PROFILE_USER = "tagfilterfixture";
const PROFILE_URL = `/${PROFILE_USER}`;
const DESKTOP = { width: 1280, height: 900 };

// `ProfileConversePosts` asks for `page_size=12`. Fourteen posts is one full
// page plus a short second one, so `next` is non-null exactly once and the
// load-more affordance appears exactly once.
const PAGE_SIZE = 12;
const POSTS = Array.from({ length: 14 }, (_, index) =>
  conversePost(`profile-post-${index}`, `PROFILE-POST-BODY-${index}`, {
    author: { username: PROFILE_USER, avatar_image: null },
  }),
);

// The opaque continuation token. The client must echo this VALUE back as
// `cursor=`; it must never synthesise a `page=` of its own.
const NEXT_CURSOR = "cD0yMDI2LTA4LTIwVDEyOjAwOjAwWiZ1PXByb2ZpbGUtcG9zdC0xMQ";

type Log = string[];

/**
 * Records every browser-side `/api/comments/` list request and answers it from
 * the fixture. Everything else -- including the dev server's own
 * `/src/lib/api/...` module URLs, which `**\/api\/**` also matches -- is
 * continued untouched.
 */
async function installCommentsRoute(page: Page): Promise<Log> {
  const log: Log = [];
  await page.route("**/api/**", async (route: Route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== "/api/comments/") {
      await route.continue();
      return;
    }
    log.push(url.search);
    const cursor = url.searchParams.get("cursor");
    const results = cursor ? POSTS.slice(PAGE_SIZE) : POSTS.slice(0, PAGE_SIZE);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        count: POSTS.length,
        // Same shape DRF emits: an absolute URL whose `cursor` parameter is
        // the token. The client extracts the VALUE, never the whole URL.
        next: cursor
          ? null
          : `http://127.0.0.1:8000/api/comments/?author=${PROFILE_USER}&cursor=${NEXT_CURSOR}&pagination=cursor&page_size=${PAGE_SIZE}`,
        previous: null,
        results,
      }),
    });
  });
  return log;
}

const postsTab = (page: Page) => page.getByTestId("profile-posts-tab");
const articlesTab = (page: Page) =>
  page.getByRole("tab", { name: /Latest Articles/i });
const feed = (page: Page) => page.getByTestId("profile-posts-feed");
const cards = (page: Page) =>
  page.locator('[data-testid="profile-posts-feed"] > article');

/**
 * Block until the page is genuinely interactive, using a control that has
 * nothing to do with the Posts tab: the article Tag filter is a popover whose
 * trigger does nothing at all until SvelteKit hydrates, so `aria-expanded`
 * flipping is proof that hydration finished — and therefore that any
 * mount-time fetch on this page has already been dispatched.
 *
 * A visibility check on SSR markup proves nothing here; see the header note.
 */
async function waitForHydration(page: Page) {
  const trigger = page.getByRole("combobox", { name: "Tag", exact: true });
  await expect(trigger).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(
      async () => {
        if ((await trigger.getAttribute("aria-expanded")) !== "true") {
          await trigger.click();
        }
        return trigger.getAttribute("aria-expanded");
      },
      { timeout: 30_000 },
    )
    .toBe("true");
  // Put the popover away again so it cannot cover the tab list.
  await page.keyboard.press("Escape");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
}

/**
 * Open the Posts tab, retrying the click because a click that lands before
 * SvelteKit hydrates is simply lost. Re-clicking an already-open tab is a
 * no-op for the latch, so the retry cannot itself cause a second mount.
 */
async function openPostsTab(page: Page) {
  const tab = postsTab(page);
  await expect(tab).toBeVisible({ timeout: 20_000 });
  await expect(async () => {
    await tab.click();
    await expect(feed(page)).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
}

// A cold Vite worker server-renders and then transforms the whole profile
// component graph; the first navigation here can consume most of Playwright's
// 30-second default before the browser begins hydrating.
test.describe.configure({ timeout: 90_000 });

test.beforeEach(async ({ page }) => {
  // No session: this is the PUBLIC profile view, the one crawlers see and the
  // one the defect was worst on.
  await page.context().clearCookies();
  await page.setViewportSize(DESKTOP);
});

test("a public profile mounts no posts panel and fires no comments query until the tab is opened", async ({
  page,
}) => {
  const log = await installCommentsRoute(page);
  await page.goto(PROFILE_URL);

  // The articles tab has to be on screen, or the assertions below are being
  // taken against an error page.
  await expect(articlesTab(page)).toBeVisible({ timeout: 20_000 });

  // The race-free half: an eagerly mounted panel is present in the DOM from
  // the SSR HTML onwards, merely `hidden`. Absence is a structural fact that
  // no timing can flatter.
  await expect(
    feed(page),
    "the posts panel must not exist at all before the tab is opened",
  ).toHaveCount(0);

  // The behavioural half. Hydration is finished by the time this returns, so
  // an `onMount` fetch from an eagerly mounted panel would already be logged.
  await waitForHydration(page);
  expect(
    log,
    "a fully interactive public profile must cost no /api/comments/ request",
  ).toEqual([]);

  log.push("CLICK");
  await openPostsTab(page);
  await expect(cards(page)).toHaveCount(PAGE_SIZE, { timeout: 20_000 });

  const requests = log.filter((entry) => entry !== "CLICK");
  expect(
    log[0],
    "no /api/comments/ request may precede the click that opens the tab",
  ).toBe("CLICK");
  expect(requests, "opening the tab costs exactly one request").toHaveLength(1);

  //...and that one request is this creator's standalone posts, cursored.
  const params = new URLSearchParams(requests[0]);
  expect(params.get("author")).toBe(PROFILE_USER);
  expect(params.get("pagination")).toBe("cursor");
  expect(params.get("parent__isnull")).toBe("true");
  expect(params.get("content_type__isnull")).toBe("true");
  expect(params.get("ordering")).toBe("-created_at");
  expect(params.get("page_size")).toBe(String(PAGE_SIZE));
  // `page` and `cursor` are mutually exclusive on the backend, and page one
  // carries no cursor.
  expect(params.has("page")).toBe(false);
  expect(params.has("cursor")).toBe(false);

  // The cards are really this creator's posts, not an empty state that would
  // satisfy every count above.
  await expect(cards(page).first()).toContainText("PROFILE-POST-BODY-0");
});

test("tabbing away from Posts and back does not refetch", async ({ page }) => {
  const log = await installCommentsRoute(page);
  await page.goto(PROFILE_URL);
  await openPostsTab(page);
  await expect(cards(page)).toHaveCount(PAGE_SIZE, { timeout: 20_000 });
  expect(log).toHaveLength(1);

  await articlesTab(page).click();
  await expect(page.getByTestId("profile-posts-feed")).toBeHidden();

  await postsTab(page).click();
  await expect(feed(page)).toBeVisible();
  await expect(cards(page)).toHaveCount(PAGE_SIZE);

  // The latch is the deliberate second half of the fix: lazy on FIRST open,
  // but never torn down and refetched afterwards. A `{#if tab === "posts"}`
  // guard would read as correct and would double this.
  expect(
    log,
    "returning to an already-loaded Posts tab must cost no request",
  ).toHaveLength(1);
});

test("Load more posts continues by cursor, never by page number", async ({
  page,
}) => {
  const log = await installCommentsRoute(page);
  await page.goto(PROFILE_URL);
  await openPostsTab(page);
  await expect(cards(page)).toHaveCount(PAGE_SIZE, { timeout: 20_000 });

  const loadMore = page.getByTestId("profile-posts-load-more");
  await expect(loadMore).toBeVisible();
  await loadMore.click();

  await expect(cards(page)).toHaveCount(POSTS.length, { timeout: 20_000 });
  expect(log).toHaveLength(2);

  const params = new URLSearchParams(log[1]);
  expect(
    params.get("cursor"),
    "the second page must echo the opaque token out of `next`, not the URL",
  ).toBe(NEXT_CURSOR);
  expect(params.get("pagination")).toBe("cursor");
  expect(params.get("author")).toBe(PROFILE_USER);
  expect(
    params.has("page"),
    "`page` and `cursor` are mutually exclusive on the backend",
  ).toBe(false);

  // The second page appended rather than replaced, and the feed knows it has
  // reached the end.
  await expect(cards(page).first()).toContainText("PROFILE-POST-BODY-0");
  await expect(cards(page).last()).toContainText("PROFILE-POST-BODY-13");
  await expect(loadMore).toHaveCount(0);
});
