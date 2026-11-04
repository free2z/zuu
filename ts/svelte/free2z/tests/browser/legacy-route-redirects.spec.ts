import { expect, test, type Page } from "@playwright/test";

//  the retired classic-UI paths, exercised over real HTTP against the
// real SvelteKit router.
//
// The unit suite (tests/legacy-routes.test.mjs) calls each route handler
// directly, which proves what the handler DOES but not that the handler is
// ever reached: `[username]` is a greedy one-segment route and `[username]/
// [vanity]` resolves on the vanity alone, so "is my new static route actually
// matched?" is a routing question, not a handler question. Every assertion
// here would pass trivially if these paths still fell through — the mock
// backend answers /api/creator/<anything>/ with 200 — so a 301/302/410 is
// itself the proof that the literal route won.
//
// It also pins the other half of the brief: each redirect must land on a 200,
// not on another redirect and not on a 404.

const FIXTURE_SESSION = "billing-fixture-session";
const FIXTURE_CSRF = "billing-fixture-csrf";
const FIXTURE_USER = "fixtureowner";

async function authenticate(page: Page) {
  await page.context().addCookies([
    {
      name: "sessionid",
      value: FIXTURE_SESSION,
      domain: "127.0.0.1",
      path: "/",
    },
    { name: "csrftoken", value: FIXTURE_CSRF, domain: "127.0.0.1", path: "/" },
  ]);
}

// Client-side `/api` calls go through the dev server's proxy to a Django that
// is not running here, and a destination page that hangs on one of them
// (`/search`, `/edit`) would time out the navigation for reasons unrelated to
// routing. SSR loads are unaffected: they fetch PRIVATE_API_BASE_URL, i.e.
// the mock backend, directly. Same shape as nav-create-and-search.spec.ts.
test.beforeEach(async ({ page }) => {
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
        body: JSON.stringify({ username: FIXTURE_USER }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ count: 0, results: [] }),
    });
  });
});

/** The unfollowed first response for `path`, so the status is observable. */
async function firstHop(page: Page, path: string) {
  return page.request.get(path, { maxRedirects: 0 });
}

/** Follow `path` to its destination and return `pathname + search`. */
async function landsOn(page: Page, path: string) {
  const response = await page.goto(path);
  expect(response, path).not.toBeNull();
  expect(response!.status(), `${path} must land on a 200`).toBe(200);
  const url = new URL(page.url());
  return `${url.pathname}${url.search}`;
}

test("/creator/<x> is an article first, then the classic profile link (#554)", async ({
  page,
}) => {
  // Django's card tier answered `/creator/<x>` vanity FIRST
  // (`legacy_creator_social`): an article whose vanity is <x> wins, and only
  // otherwise is it the classic profile link. Unfurlers reach SvelteKit since
  //, so both halves must hold here.
  //
  // First in this file, so it pays the dev server's cold compile of the
  // article route; measured at ~24s against the default 30s budget.
  test.slow();
  const profile = await firstHop(
    page,
    "/creator/creator-legacy-profile-fixture?lang=es",
  );
  expect(profile.status()).toBe(301);
  // The query survives, as it does on the article canonicalization.
  expect(profile.headers()["location"]).toBe(
    "/creator-legacy-profile-fixture?lang=es",
  );

  // An article owns this vanity: the existing resolver's canonicalizing 301
  // to the article's real owner, never the profile fallback.
  const article = await firstHop(page, "/creator/ssr-body-fixture");
  expect(article.status()).toBe(301);
  expect(article.headers()["location"]).toMatch(/^\/[^/]+\/ssr-body-fixture/);
  expect(article.headers()["location"]).not.toBe("/ssr-body-fixture");
});

test("/find permanently moves to the search route and lands on a 200", async ({
  page,
}) => {
  // The destination is this suite's first visit to `/search`, whose module
  // graph the dev server compiles on demand — measured at ~28s cold against
  // the default 30s budget. Triple it rather than let a compile time decide
  // whether a routing assertion passes.
  test.slow();

  const hop = await firstHop(page, "/find?search=zcash");
  expect(hop.status()).toBe(301);
  expect(hop.headers()["location"]).toBe("/search?q=zcash");
  // Permanent for search engines, not sticky in the browser: classic still
  // owns /find and cannot serve /search.
  expect(hop.headers()["cache-control"]).toBe("no-store");

  expect(await landsOn(page, "/find?search=zcash")).toBe("/search?q=zcash");
});

test("a query-less /find lands on the browsable listing", async ({ page }) => {
  // `/find` with no text query was a listing, not a search box. `/search`
  // with no `q` is an empty form that declares itself noindex, so the
  // query-less shapes go to `/trending` instead.
  for (const path of ["/find", "/find?ordering=-updated_at"]) {
    const hop = await firstHop(page, path);
    expect(hop.status(), path).toBe(301);
    expect(hop.headers()["location"], path).toBe("/trending");
    expect(await landsOn(page, path), path).toBe("/trending");
  }
});

test("a classic tag link keeps its filter through the /find hop", async ({
  page,
}) => {
  // `/search?tag=` applies a real tag filter now, so this no longer
  // has to drop the parameter on the floor and send the visitor to /trending.
  //
  // ONE hop, not two. `/search?tag=` itself 301s to the topic hub, so
  // going through it would make this a 301 -> 301 chain; `findDestination`
  // names the hub directly. The fixture slug is one `tests/browser/mock-api.mjs`
  // resolves, because the hub is SERVER-rendered — the `page.route` intercept
  // above never sees its request, and a slug with no live pages is a real 404.
  const hop = await firstHop(page, "/find?tags=ssr-tag-fixture");
  expect(hop.status()).toBe(301);
  expect(hop.headers()["location"]).toBe("/tag/ssr-tag-fixture");
  expect(await landsOn(page, "/find?tags=ssr-tag-fixture")).toBe(
    "/tag/ssr-tag-fixture",
  );
});

test("a multi-tag classic link keeps the /search destination", async ({
  page,
}) => {
  // Classic emitted comma-joined tags and the API ANDs them. A hub is one
  // tag, so this is the case that must NOT be redirected into one — the AND
  // would be silently dropped and the visitor would get a wider result set
  // than the link promised.
  const hop = await firstHop(page, "/find?tags=video,zcash");
  expect(hop.status()).toBe(301);
  expect(hop.headers()["location"]).toBe("/search?tag=video%2Czcash");
});

test("a made-up public path is a real SvelteKit 404", async ({ page }) => {
  const response = await page.goto("/stage-cutover-missing-1502");
  expect(response).not.toBeNull();
  expect(response!.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("404");
});

test("/begin and /begin/alt permanently move to the sign-up modal", async ({
  page,
}) => {
  for (const path of ["/begin", "/begin/alt"]) {
    const hop = await firstHop(page, path);
    expect(hop.status(), path).toBe(301);
    expect(hop.headers()["location"], path).toBe("/login?view=signup");
    expect(hop.headers()["cache-control"], path).toBe("no-store");
    expect(await landsOn(page, path), path).toBe("/login?view=signup");
  }

  // The destination must actually offer a way in. The old `/?login=true`
  // sentinel — retired everywhere by  — did not: nothing read it.
  await page.goto("/begin");
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("/edit/<id> permanently moves to the query-string editor", async ({
  page,
}) => {
  await authenticate(page);

  const hop = await firstHop(page, "/edit/42");
  expect(hop.status()).toBe(301);
  expect(hop.headers()["location"]).toBe("/edit?id=42");
  expect(hop.headers()["cache-control"]).toBe("no-store");

  expect(await landsOn(page, "/edit/42")).toBe("/edit?id=42");
});

test("signed-in classic profile paths reach the caller's own dashboard", async ({
  page,
}) => {
  await authenticate(page);

  const cases: [string, string][] = [
    ["/profile", `/${FIXTURE_USER}/dashboard/profile`],
    ["/profile/kyc", `/${FIXTURE_USER}/dashboard/kyc`],
    ["/profile/uploads", `/${FIXTURE_USER}/dashboard/media`],
    ["/events", `/${FIXTURE_USER}/dashboard/notifications`],
  ];

  for (const [path, destination] of cases) {
    const hop = await firstHop(page, path);
    // 302, never 301: the destination is derived from the session cookie,
    // which is not in Cloud CDN's cache key.
    expect(hop.status(), path).toBe(302);
    expect(hop.headers()["location"], path).toBe(destination);
    expect(hop.headers()["cache-control"], path).toBe("private, no-store");
    expect(hop.headers()["vary"], path).toContain("Cookie");

    expect(await landsOn(page, path), path).toBe(destination);
  }
});

test("anonymous classic profile paths offer the login modal, not a 404", async ({
  page,
}) => {
  for (const path of [
    "/profile",
    "/profile/kyc",
    "/profile/uploads",
    "/events",
  ]) {
    const destination = `/login?next=${encodeURIComponent(path)}`;
    const hop = await firstHop(page, path);
    expect(hop.status(), path).toBe(302);
    expect(hop.headers()["location"], path).toBe(destination);
    expect(await landsOn(page, path), path).toBe(destination);
    // A URL alone is not an entry point — the modal has to be on screen.
    await expect(page.getByRole("dialog"), path).toBeVisible();
  }
});

test("retired classic-only paths answer 410 Gone", async ({ page }) => {
  const paths = [
    "/ai",
    "/ai/public",
    // The shape /feeds/ai/recent.xml published into feed readers. Three
    // segments with a literal middle, so it cannot be a creator URL.
    "/ai/conversation/3f9a1c2e-0000-4000-8000-abcdefabcdef",
    "/ai/conversation/anything/deeper",
    "/tools/p2pe2e",
    "/tools/p2pe2e/old-meeting-id",
    // Storytime's backend data remains, but its orphaned classic read/editor
    // surfaces have no Svelte replacement. These exact three/four-segment
    // shapes retire without claiming the real `storytime` creator's root or
    // two-segment vanity namespace.
    "/storytime/fixtureowner/shared-story?from=old-share",
    "/storytime/edit/fixtureowner/shared-story?from=old-editor",
  ];

  for (const path of paths) {
    const response = await page.goto(path);
    expect(response, path).not.toBeNull();
    // Not 404 (which invites retries) and not 301 (a soft-404 to Google).
    expect(response!.status(), path).toBe(410);
    // 410 is heuristically cacheable, so a browser must not remember this
    // across a pinned-image rollback. Asserted over real HTTP because it
    // depends on `setHeaders` surviving a thrown error.
    expect(response!.headers()["cache-control"], path).toBe("no-store");
  }

  // The error page must say "retired", not "Unknown Error / contact support".
  await page.goto("/ai");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("410");
  await expect(
    page.getByText(/retired/i).first(),
    "the 410 copy must explain the feature is gone",
  ).toBeVisible();
});

test("a live creator's namespace is never answered by a retirement rule", async ({
  page,
}) => {
  // `Storytime` is a real creator (GET /api/creator/storytime/ -> 200, three
  // published zPages). An earlier revision of this PR answered 410 for
  // /storytime and everything beneath it, which would have taken that profile
  // and every one of their zPage URLs with it.
  //
  // Each path is asserted as the exact answer the creator routes give.
  // "Not 410/301/302" also passed on a 500 -- and /storytime WAS a 500 here,
  // because the mock's catch-all body is not a creator. `mock-api.mjs` now
  // serves a real creator for `storytime`, so the profile renders and its name
  // is the proof `[username]` served it.
  const profile = await firstHop(page, "/storytime");
  expect(profile.status()).toBe(200);
  expect(await profile.text()).toContain("Routing fixture storytime");

  const article = await firstHop(page, "/storytime/a-published-story");
  expect(article.status()).toBe(200);
  expect(await article.text()).toContain("Legacy collision fixture");

  // The exact classic shapes above are safe to retire because `ai` and
  // `tools` are reserved usernames. Nearby paths must still reach the
  // `[username]/[vanity]` resolver instead of being swallowed by a namespace
  // catch-all -- and the resolver's own signature is the canonicalizing 301
  // to the article's real owner, which no retirement rule produces.
  for (const path of ["/ai/a-published-story", "/tools/a-published-story"]) {
    const hop = await firstHop(page, path);
    expect(hop.status(), path).toBe(301);
    expect(hop.headers()["location"], path).toBe(
      "/storytime/a-published-story",
    );
  }

  // Real built-router controls for the exact collision a source inventory
  // cannot see. These three literal middles belong to `[username]`; the
  // retired classic Storytime display matcher must release all of them.
  const legacyZpage = await firstHop(
    page,
    "/storytime/zpage/a-published-story?from=historic",
  );
  expect(legacyZpage.status()).toBe(301);
  expect(legacyZpage.headers()["location"]).toBe(
    "/storytime/a-published-story?from=historic",
  );
  const privateCall = await firstHop(
    page,
    "/storytime/private/private-stream-secret",
  );
  expect(privateCall.status()).toBe(200);
  expect(await privateCall.text()).toContain("Private call with storytime");
  // Anonymous: the creator dashboard's own login bounce, not a retirement.
  const dashboard = await firstHop(page, "/storytime/dashboard/profile");
  expect(dashboard.status()).toBe(302);
  expect(dashboard.headers()["location"]).toBe(
    "/login?next=%2Fstorytime%2Fdashboard%2Fprofile",
  );
});

test("Storytime retirement is browser-state independent", async ({ page }) => {
  const path = "/storytime/fixtureowner/shared-story?from=shared-link";
  for (const [persona, headers] of [
    ["cookie-less", {}],
    ["stale-cookie", { Cookie: "f2z_ui=new" }],
    ["authenticated", { Cookie: `sessionid=${FIXTURE_SESSION}` }],
    ["search crawler", { "User-Agent": "Googlebot/2.1" }],
  ] as const) {
    const response = await page.request.get(path, {
      headers,
      maxRedirects: 0,
    });
    expect(response.status(), persona).toBe(410);
    expect(response.headers()["cache-control"], persona).toBe("no-store");
    expect(response.headers()["location"], persona).toBeUndefined();
  }
});

test("the greedy creator route still wins for everything else", async ({
  page,
}) => {
  // The control for every assertion above: an ordinary one-segment path — and
  // a near-miss like `/finding` — must still be served by [username], so the
  // new literal routes narrowed nothing they should not have.
  //
  // Asserted as the rendered profile. This used to be "not one of MY
  // statuses", because the mock's catch-all body made [username] 500 -- and a
  // 500 satisfied it. `mock-api.mjs` now serves these three as real creators.
  for (const path of ["/an-ordinary-creator", "/finding", "/beginner"]) {
    const hop = await firstHop(page, path);
    expect(hop.status(), path).toBe(200);
    expect(await hop.text(), path).toContain(
      `Routing fixture ${path.slice(1)}`,
    );
  }
});

const UNIMPLEMENTED_PROJECT = "/projects/does-not-exist-project-1475";

test("unimplemented projects return 404 without fabricated page or social metadata", async ({
  page,
}) => {
  for (const userAgent of ["Mozilla/5.0", "Twitterbot/1.0"]) {
    const response = await page.request.get(UNIMPLEMENTED_PROJECT, {
      headers: { "User-Agent": userAgent },
    });
    expect(response.status()).toBe(404);
    const html = await response.text();
    expect(html).not.toContain("Project does-not-exist-project-1475");
    expect(html).not.toContain("View project does-not-exist-project-1475");
    expect(html).not.toMatch(/<(?:meta|link)[^>]*(?:canonical|og:|twitter:)/);
  }
  await page.goto(UNIMPLEMENTED_PROJECT);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("404");
  await expect(
    page.getByRole("button", { name: /^(Contribute|Share)$/ }),
  ).toHaveCount(0);
});

test("a shared checkout link carries a complete, noindexed share card (#554)", async ({
  page,
}) => {
  // Raw SSR, as an unfurler sees it. Django's checkout_social served the site
  // card with noindex until  moved unfurlers to SvelteKit. NEGATIVE
  // CONTROL: the previous hand-written <svelte:head> (title + description
  // only) turns this red.
  const response = await page.request.get("/checkout/ref-554");
  expect(response.status()).toBe(200);
  const html = await response.text();
  expect(html).toMatch(/<meta property="og:image" content="https:\/\/[^"]+"/);
  expect(html).toContain(
    '<meta name="twitter:card" content="summary_large_image"',
  );
  expect(html).toContain('<meta property="og:title" content="Checkout ref-554');
  expect(html).toMatch(/<meta name="robots" content="noindex/);
});
