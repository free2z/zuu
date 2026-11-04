import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type Page,
} from "@playwright/test";
import { browserMockApiOrigin } from "./ports";

/**
 *  part 2 — `::embed[]` of a zPage or converse thread is a TEXT card from
 * our own API, resolved during SSR with the READER's cookie, or one neutral
 * link card. This drives the real SvelteKit server against the mock API
 * (`fp-card-*` fixtures in mock-api.mjs), whose embedded targets answer per
 * reader the way the real backend does (the backend rule itself is pinned
 * against Postgres in py/dj/apps/g12f/test_first_party_embed_card_contract.py).
 *
 * JavaScript is DISABLED for the matrix: what is asserted is the server's own
 * HTML — including the serialized page data hydration would read — so a
 * gated title or body anywhere in the response is a failure, rendered or not.
 */

test.describe.configure({ timeout: 90_000 });

const MOCK_API_ORIGIN = browserMockApiOrigin();
const MATRIX = "/fp-card-user/fp-card-matrix";
const GATED_TEXT = [
  "Members card title",
  "MEMBERS-ONLY-BODY",
  "Draft card title",
  "DRAFT-ONLY-BODY",
  "Members thread headline",
  "MEMBERS-THREAD-BODY",
];

type Upstream = { path: string; cookie: string | null };

async function upstream(request: APIRequestContext): Promise<Upstream[]> {
  return (await request.get(`${MOCK_API_ORIGIN}/__requests`)).json();
}

async function readerPage(browser: Browser, session: string | null) {
  const context = await browser.newContext({ javaScriptEnabled: false });
  if (session) {
    await context.addCookies([
      { name: "sessionid", value: session, domain: "127.0.0.1", path: "/" },
    ]);
  }
  return { context, page: await context.newPage() };
}

const resolved = (page: Page) =>
  page.locator(".markdown-content .first-party-embed-resolved");

for (const [reader, session, visible, forbidden] of [
  ["anonymous", null, ["Public card title"], GATED_TEXT],
  [
    "subscriber",
    "fp-card-subscriber",
    ["Public card title", "Members card title", "Members thread headline"],
    ["Draft card title", "DRAFT-ONLY-BODY"],
  ],
  [
    "owner",
    "fp-card-owner",
    [
      "Public card title",
      "Members card title",
      "Draft card title",
      "Members thread headline",
    ],
    [],
  ],
] as const) {
  test(`SSR matrix: the ${reader} reader gets exactly the cards they could open`, async ({
    browser,
    request,
  }) => {
    await request.delete(`${MOCK_API_ORIGIN}/__requests`);
    const { context, page } = await readerPage(browser, session);
    try {
      const response = await page.goto(MATRIX);
      expect(response?.status()).toBe(200);
      // Per-reader HTML never enters a shared cache.
      expect(response?.headers()["cache-control"]).toBe("private, no-cache");
      expect(response?.headers()["vary"]).toMatch(/cookie/i);

      await expect(resolved(page)).toHaveCount(visible.length, {
        timeout: 30_000,
      });
      for (const title of visible) {
        await expect(resolved(page).filter({ hasText: title })).toHaveCount(1);
      }

      // Everything the reader could NOT open is the one neutral link card,
      // pointing at exactly the path its label shows.
      const neutral = page.locator(
        ".markdown-content .first-party-embed:not(.first-party-embed-resolved) a",
      );
      await expect(neutral).toHaveCount(4 - visible.length);
      for (const link of await neutral.all()) {
        const href = await link.getAttribute("href");
        expect(href).toBe(`https://${await link.textContent()}`);
      }

      // Nothing gated anywhere in the response — markup OR page data.
      const html = await page.content();
      expect(forbidden.filter((text) => html.includes(text))).toEqual([]);

      // The cards were asked for with THIS reader's cookie, by API
      // identifier — never by fetching the embedded route.
      const cardCalls = (await upstream(request)).filter(
        (call) =>
          /^\/api\/zpage\/fp-card-(public|subonly|draft)\//.test(call.path) ||
          call.path.startsWith("/api/comments/1c8b4d2f-"),
      );
      expect(cardCalls).toHaveLength(4);
      for (const call of cardCalls) {
        if (session) expect(call.cookie).toContain(`sessionid=${session}`);
        else expect(call.cookie ?? "").not.toContain("sessionid=");
      }
    } finally {
      await context.close();
    }
  });
}

test("lookalike and other-route embeds never borrow a card, and their labels show where they go", async ({
  browser,
  request,
}) => {
  await request.delete(`${MOCK_API_ORIGIN}/__requests`);
  const { context, page } = await readerPage(browser, null);
  try {
    await page.goto("/fp-card-user/fp-card-extra");
    // The one legitimate target: a public converse thread.
    await expect(resolved(page)).toHaveCount(1, { timeout: 30_000 });
    await expect(resolved(page)).toContainText("Public thread headline");

    // `/accounts/logout/?next=//evil.example` is the zPage SHAPE, and the API
    // does hold a `logout` page — but by someone else, so no card, and the
    // link drops the author's `?next=`.
    const logout = page.locator(
      '.first-party-embed-zpage a[href="https://free2z.cash/accounts/logout"]',
    );
    await expect(logout).toHaveText("free2z.cash/accounts/logout");
    expect(await page.content()).not.toContain("Borrowed card title");

    // An edit route is not a zPage; another environment is linked as itself;
    // a redirect route shows its whole destination, query included.
    await expect(
      page.locator(
        '.first-party-embed-page a[href="https://free2z.cash/fp-card-user/fp-card-public/edit"]',
      ),
    ).toHaveText("free2z.cash/fp-card-user/fp-card-public/edit");
    await expect(
      page.locator(
        '.first-party-embed-zpage a[href="https://stage.free2z.cash/fp-card-user/fp-card-public"]',
      ),
    ).toHaveText("stage.free2z.cash/fp-card-user/fp-card-public");
    await expect(
      page.locator(
        '.first-party-embed-page a[href="https://free2z.cash/login?next=//evil.example"]',
      ),
    ).toHaveText("free2z.cash/login?next=//evil.example");

    const paths = (await upstream(request))
      .map((call) => call.path)
      .filter((path) => /^\/api\/(zpage|comments)\//.test(path));
    // Asked the API for the logout IDENTIFIER, never the route; never looked
    // up the edit route, the stage URL or the login route at all.
    expect(paths).toContain("/api/zpage/logout/?lang=en");
    expect(
      paths.some((path) => /logout\/\?next|evil|\/edit|login/.test(path)),
    ).toBe(false);
    expect(
      paths.filter((path) => path.startsWith("/api/zpage/fp-card-public/")),
    ).toEqual([]);
  } finally {
    await context.close();
  }
});

test("the per-page cap bounds SSR fan-out: six embeds, four API calls, four cards", async ({
  browser,
  request,
}) => {
  await request.delete(`${MOCK_API_ORIGIN}/__requests`);
  const { context, page } = await readerPage(browser, null);
  try {
    await page.goto("/fp-card-user/fp-card-cap");
    await expect(resolved(page)).toHaveCount(4, { timeout: 30_000 });
    await expect(
      page.locator(".markdown-content .first-party-embed-zpage"),
    ).toHaveCount(6);
    const capCalls = (await upstream(request)).filter((call) =>
      /^\/api\/zpage\/fp-card-cap-\d\//.test(call.path),
    );
    expect(capCalls.map((call) => call.path.split("?")[0]).sort()).toEqual([
      "/api/zpage/fp-card-cap-0/",
      "/api/zpage/fp-card-cap-1/",
      "/api/zpage/fp-card-cap-2/",
      "/api/zpage/fp-card-cap-3/",
    ]);
  } finally {
    await context.close();
  }
});

test("self-embed and A↔B embeds render one level deep with one call each", async ({
  browser,
  request,
}) => {
  const { context, page } = await readerPage(browser, null);
  try {
    await request.delete(`${MOCK_API_ORIGIN}/__requests`);
    await page.goto("/fp-card-user/fp-card-self");
    await expect(resolved(page)).toHaveCount(1, { timeout: 30_000 });
    await expect(resolved(page).locator("a")).toHaveCount(1);
    let calls = (await upstream(request)).filter((call) =>
      call.path.startsWith("/api/zpage/fp-card-self/"),
    );
    // One for the article itself, one for its card of itself. No more.
    expect(calls).toHaveLength(2);

    await request.delete(`${MOCK_API_ORIGIN}/__requests`);
    await page.goto("/fp-card-user/fp-card-a");
    await expect(resolved(page)).toHaveCount(1, { timeout: 30_000 });
    await expect(resolved(page)).toContainText("B card title");
    // B's own embed of A is only text inside B's card: no nested card or link.
    await expect(resolved(page).locator("a")).toHaveCount(1);
    await expect(resolved(page).locator(".first-party-embed")).toHaveCount(0);
    calls = await upstream(request);
    expect(
      calls.filter((call) => call.path.startsWith("/api/zpage/fp-card-a/")),
    ).toHaveLength(1);
    expect(
      calls.filter((call) => call.path.startsWith("/api/zpage/fp-card-b/")),
    ).toHaveLength(1);
  } finally {
    await context.close();
  }
});

test("hydration keeps the server's cards, and a card is an ordinary internal link", async ({
  page,
  context,
}) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  const requests: string[] = [];
  page.on("request", (req) => requests.push(req.url()));
  await context.addCookies([
    {
      name: "sessionid",
      value: "fp-card-subscriber",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  await page.goto(MATRIX);
  await expect(resolved(page)).toHaveCount(3, { timeout: 30_000 });
  // Hydrated (the app is interactive) and still exactly the server's cards.
  // (`networkidle` never settles here: the app keeps live connections open.)
  await page.waitForLoadState("load");
  await page.waitForTimeout(2000);
  await expect(resolved(page)).toHaveCount(3);
  expect(errors.filter((text) => /hydrat/i.test(text))).toEqual([]);
  // No consent card, no frame, no Iframely for our own content.
  await expect(
    page.getByRole("heading", { name: "External content blocked" }),
  ).toHaveCount(0);
  await expect(page.locator(".markdown-content iframe")).toHaveCount(0);
  expect(requests.filter((url) => /iframe\.ly/.test(url))).toEqual([]);

  await resolved(page)
    .filter({ hasText: "Public card title" })
    .locator("a")
    .click();
  await expect(page).toHaveURL(/\/fp-card-user\/fp-card-public$/);
});
