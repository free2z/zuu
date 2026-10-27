import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * Posting a Converse post or a zPage comment ends -- visibly -- when the
 * server never answers, and a refusal shows the server's reason.
 *
 * Both used a raw `fetch(` until, so 's bound and error reading
 * (which live in `apiFetch` and the orval mutator) never reached them: a
 * POST the server accepted and never answered left "Posting..." up forever,
 * and a DRF field error (`{"content": [...]}`) became "Failed to post
 * comment". `tests/raw-write-fetch.test.mjs` fails on any new raw write;
 * this proves what a person sees.
 *
 * NEGATIVE CONTROLS (each run by restoring the origin/main version of the
 * one component, which still compiles, and re-running):
 *   - ConverseComposer.svelte with its raw fetch: the hung-post test never
 *     sees the timeout sentence and the button stays on "Posting...";
 *     the refusal test shows "Could not publish your post (HTTP 400)".
 *   - CommentForm.svelte with its raw fetch: same, with "Failed to post
 *     comment" instead of the server's sentence.
 */

// A cold `vite dev` compiles the zPage route on first request.
test.describe.configure({ timeout: 120_000 });

/** Kept in sync with API_WRITE_TIMEOUT_MS in src/lib/api/request-timeout.js. */
const WRITE_BOUND_MS = 30_000;
/** ApiTimeoutError's sentence for the 30 s class. */
const TIMED_OUT =
  "The server did not respond within 30 seconds. Check your connection and try again.";

const CREATOR = {
  id: 2078,
  username: "raw-write-user",
  full_name: "Raw Write User",
};

const ZPAGE = "/hero-user/hero-nav-a-fixture";

type Outcome = "hang" | { status: number; json: unknown };

/**
 * Signed in from the client's own snapshot, `/api/auth/user/` answered, and
 * every `POST /api/comments/...` handled by `outcome`. Everything else under
 * `/api/` falls through to the mock API (the zPage SSR and its reads), or
 * gets an empty list on `/converse`.
 */
async function signInAndRoute(page: Page, outcome: Outcome) {
  // Fake timers, so the 30 s bound elapses in milliseconds. The clock still
  // flows on its own after install; runFor only jumps it.
  await page.clock.install();
  await page.addInitScript((creator) => {
    localStorage.setItem(
      "auth",
      JSON.stringify({ isAuthenticated: true, creator, loading: false }),
    );
  }, CREATOR);
  await page.context().addCookies([
    {
      name: "sessionid",
      value: "raw-write-session",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);

  const posts: Route[] = [];
  // Predicate, not a "**/api/**" glob: Vite serves /src/lib/api/*.ts, which a
  // glob would also intercept.
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const request = route.request();
      const { pathname } = new URL(request.url());
      if (pathname === "/api/auth/user/") {
        await route.fulfill({ json: CREATOR });
        return;
      }
      if (
        pathname.startsWith("/api/comments/") &&
        request.method() === "POST"
      ) {
        posts.push(route);
        if (outcome === "hang") return; // Taken, and never answered.
        await route.fulfill(outcome);
        return;
      }
      if (pathname.startsWith("/api/comments/")) {
        await route.fulfill({
          json: { count: 0, next: null, previous: null, results: [] },
        });
        return;
      }
      await route.continue();
    },
  );
  return { posts };
}

async function openConverse(page: Page) {
  await page.goto("/converse");
  await expect(page.locator('main[data-hydrated="true"]')).toBeVisible();
  await page
    .getByRole("button", { name: "New conversation", exact: true })
    .click();
  const body = page.locator("#converse-content");
  await expect(body).toBeVisible({ timeout: 30_000 });
  await body.fill("gm from a stalled connection");
  return {
    body,
    post: page.getByRole("button", { name: "Post", exact: true }),
  };
}

async function openZpageCommentForm(page: Page) {
  await page.goto(ZPAGE);
  await expect(page.locator("main[data-scroll-scene]")).toHaveCount(1, {
    timeout: 60_000,
  });
  // The comment form is loaded when its section scrolls into view.
  const body = page.locator("#comment-content");
  await expect(async () => {
    await page.evaluate(() =>
      window.scrollTo(0, document.documentElement.scrollHeight),
    );
    await expect(body).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await body.fill("A comment the server never answers.");
  return {
    body,
    post: page.getByRole("button", { name: "Post", exact: true }),
    posting: page.getByRole("button", { name: "Posting..." }),
  };
}

test("a Converse post the server never answers fails visibly within the write bound", async ({
  page,
}) => {
  const { posts } = await signInAndRoute(page, "hang");
  const { body, post } = await openConverse(page);

  await post.click();
  await expect.poll(() => posts.length).toBe(1);
  await expect(post).toBeDisabled();

  // Just short of the bound: still waiting, nothing claimed yet.
  await page.clock.runFor(WRITE_BOUND_MS - 1_000);
  await expect(page.getByText(TIMED_OUT)).toHaveCount(0);

  // Past it. Before  nothing was armed to fire.
  await page.clock.runFor(1_500);
  await expect(page.getByTestId("payment-outcome-error")).toHaveText(
    TIMED_OUT,
    { timeout: 5_000 },
  );
  // The composer is usable again and the words are still there.
  await expect(post).toBeEnabled();
  await expect(body).toHaveValue("gm from a stalled connection");
  expect(posts).toHaveLength(1);
});

test("a refused Converse post shows the server's field error", async ({
  page,
}) => {
  await signInAndRoute(page, {
    status: 400,
    json: { content: ["Ensure this field has no more than 1000 characters."] },
  });
  const { post } = await openConverse(page);

  await post.click();
  await expect(
    page
      .getByTestId("payment-outcome-error")
      .getByText(
        "Content: Ensure this field has no more than 1000 characters.",
      ),
  ).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(/Could not publish your post/)).toHaveCount(0);
});

test("a zPage comment the server never answers fails visibly within the write bound", async ({
  page,
}) => {
  const { posts } = await signInAndRoute(page, "hang");
  const { body, post, posting } = await openZpageCommentForm(page);

  await post.click();
  await expect.poll(() => posts.length).toBe(1);
  await expect(posting).toBeVisible();

  await page.clock.runFor(WRITE_BOUND_MS - 1_000);
  await expect(page.getByText(TIMED_OUT)).toHaveCount(0);
  await expect(posting).toBeVisible();

  await page.clock.runFor(1_500);
  await expect(page.getByTestId("payment-outcome-error")).toHaveText(
    TIMED_OUT,
    { timeout: 5_000 },
  );
  await expect(posting).toHaveCount(0);
  await expect(post).toBeEnabled();
  await expect(body).toHaveValue("A comment the server never answers.");
  expect(posts).toHaveLength(1);
});

test("a refused zPage comment shows the server's reason, not 'Failed to post comment'", async ({
  page,
}) => {
  await signInAndRoute(page, {
    status: 400,
    json: { content: ["This field may not be blank."] },
  });
  const { post } = await openZpageCommentForm(page);

  await post.click();
  await expect(
    page
      .getByTestId("payment-outcome-error")
      .getByText("Content: This field may not be blank."),
  ).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Failed to post comment")).toHaveCount(0);
});

test("a sign-in the server never answers says so, not 'Login failed'", async ({
  page,
}) => {
  // "Login failed" after a timeout reads as a wrong password (codex review).
  await page.clock.install();
  let logins = 0;
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const request = route.request();
      const { pathname } = new URL(request.url());
      if (pathname === "/api/auth/login/" && request.method() === "POST") {
        logins += 1;
        return; // Taken, and never answered.
      }
      if (pathname === "/api/auth/user/") {
        await route.fulfill({
          status: 401,
          json: { detail: "Not authenticated" },
        });
        return;
      }
      await route.fulfill({ json: { count: 0, next: null, results: [] } });
    },
  );

  await page.goto("/login");
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator("#username")).toBeVisible({ timeout: 30_000 });
  await dialog.locator("#username").fill(CREATOR.username);
  await dialog.locator("#password").fill("correct-password");
  await dialog.getByRole("button", { name: "Log in" }).click();
  await expect.poll(() => logins).toBe(1);

  await page.clock.runFor(WRITE_BOUND_MS + 500);
  await expect(dialog.getByText(TIMED_OUT)).toBeVisible({ timeout: 5_000 });
  await expect(dialog.getByText("Login failed")).toHaveCount(0);
});

for (const target of ["Converse", "zPage"] as const) {
  test(`an unsigned visitor cannot open the ${target} raw-write editor`, async ({
    page,
  }) => {
    let posts = 0;
    await page.route(
      (url) => url.pathname.startsWith("/api/"),
      async (route) => {
        const { pathname } = new URL(route.request().url());
        if (pathname === "/api/auth/user/") {
          await route.fulfill({
            status: 401,
            json: { detail: "Not authenticated" },
          });
          return;
        }
        if (
          pathname.startsWith("/api/comments/") &&
          route.request().method() === "POST"
        ) {
          posts += 1;
          await route.fulfill({ status: 201, json: {} });
          return;
        }
        if (pathname.startsWith("/api/comments/")) {
          await route.fulfill({
            json: { count: 0, next: null, previous: null, results: [] },
          });
          return;
        }
        await route.continue();
      },
    );

    await page.goto(target === "Converse" ? "/converse" : ZPAGE);
    if (target === "Converse") {
      await expect(page.locator('main[data-hydrated="true"]')).toBeVisible();
      await page.getByRole("button", { name: "New conversation" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Log in to post" }),
      ).toBeVisible();
    } else {
      await page.evaluate(() =>
        window.scrollTo(0, document.documentElement.scrollHeight),
      );
      await expect(
        page.getByText("Log in to make a comment with 2Zs!"),
      ).toBeVisible();
    }
    await expect(
      page.locator(
        target === "Converse" ? "#converse-content" : "#comment-content",
      ),
    ).toHaveCount(0);
    expect(posts).toBe(0);
  });
}
