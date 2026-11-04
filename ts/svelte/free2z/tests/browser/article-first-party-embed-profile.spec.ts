import {
  expect,
  test,
  type Browser,
  type Page,
  type Route,
} from "@playwright/test";
import {
  DRAFT,
  MEMBERS,
  MOCK_API_ORIGIN,
  PUBLIC,
  READERS,
  cardCalls,
  expectCookies,
  forbiddenFor,
  readerPage,
} from "./first-party-embed-card-surfaces.fixture";

/** Profile bio and editor preview coverage for first-party embeds. */
test.describe.configure({ timeout: 120_000 });

// --- Profile bio (server-rendered) ----------------------------------------------

const BIO_EXPECT: Record<string, string[]> = {
  anonymous: [PUBLIC],
  stranger: [PUBLIC],
  subscriber: [PUBLIC, MEMBERS],
  owner: [PUBLIC, MEMBERS, DRAFT],
};

for (const { reader, session } of READERS) {
  test(`bio: the ${reader} reader's server-rendered profile carries exactly their cards`, async ({
    browser,
    request,
  }) => {
    const visible = BIO_EXPECT[reader];
    await request.delete(`${MOCK_API_ORIGIN}/__requests`);
    const { context, page } = await readerPage(browser, session, false);
    try {
      const response = await page.goto("/fp-card-user");
      expect(response?.status()).toBe(200);
      expect(response?.headers()["cache-control"]).toMatch(/private/);
      expect(response?.headers()["vary"]).toMatch(/cookie/i);
      const resolved = page.locator(
        ".markdown-content .first-party-embed-resolved",
      );
      await expect(resolved).toHaveCount(visible.length);
      for (const title of visible) {
        await expect(resolved.filter({ hasText: title })).toHaveCount(1);
      }
      await expect(
        page.locator(
          ".markdown-content .first-party-embed:not(.first-party-embed-resolved)",
        ),
      ).toHaveCount(3 - visible.length);
      // Nothing gated in the markup OR the serialized page data.
      const html = await page.content();
      expect(
        forbiddenFor(visible).filter((text) => html.includes(text)),
      ).toEqual([]);
      const calls = await cardCalls(request);
      expect(calls).toHaveLength(3);
      await expectCookies(calls, session);
    } finally {
      await context.close();
    }
  });
}

for (const { reader, session, expectedCalls, cachedAuth } of [
  { reader: "anonymous", session: null, expectedCalls: 3, cachedAuth: false },
  // A session-bearing seed is re-resolved as the browser's own viewer.
  {
    reader: "subscriber",
    session: "fp-card-subscriber",
    expectedCalls: 6,
    cachedAuth: false,
  },
  // A RETURNING signed-in reader: `localStorage.auth` rehydrates the
  // identity synchronously, so it is already `user:…` when the page seeds
  // (review F1 — this row flashed 2 → 0 → 2 before the fix).
  {
    reader: "subscriber with cached auth",
    session: "fp-card-subscriber",
    expectedCalls: 6,
    cachedAuth: true,
  },
] as const) {
  test(`bio: hydration keeps the server's cards (${reader}) and never flashes them`, async ({
    browser,
    request,
  }) => {
    await request.delete(`${MOCK_API_ORIGIN}/__requests`);
    const { context, page } = await readerPage(browser, session);
    const errors: string[] = [];
    page.on("console", (message) => {
      if (/hydrat/i.test(message.text())) errors.push(message.text());
    });
    const cardsVisible = session ? 2 : 1;
    try {
      if (cachedAuth) {
        await page.addInitScript(() => {
          localStorage.setItem(
            "auth",
            JSON.stringify({
              status: "authenticated",
              isAuthenticated: true,
              loading: false,
              creator: {
                username: "fp-card-subscriber-user",
                full_name: "Card Subscriber",
                stars: ["fp-card-user"],
              },
            }),
          );
        });
      }
      // Watch the count from the first parse: once there, it must not drop.
      await page.addInitScript(() => {
        const w = window as unknown as { __cardCounts: number[] };
        w.__cardCounts = [];
        new MutationObserver(() =>
          w.__cardCounts.push(
            document.querySelectorAll(
              ".markdown-content .first-party-embed-resolved",
            ).length,
          ),
        ).observe(document, { subtree: true, childList: true });
      });
      await page.goto("/fp-card-user");
      const resolved = page.locator(
        ".markdown-content .first-party-embed-resolved",
      );
      await expect(resolved).toHaveCount(cardsVisible);
      await page.waitForFunction(() => document.readyState === "complete");
      await page.waitForTimeout(2_000);
      await expect(resolved).toHaveCount(cardsVisible);
      const calls = await cardCalls(request);
      // Anonymous: the browser repeats nothing. Signed in: the server's
      // three calls once more, from the browser, as its own viewer.
      expect(calls).toHaveLength(expectedCalls);
      await expectCookies(calls, session);
      expect(errors).toEqual([]);
      const counts = await page.evaluate(
        () => (window as unknown as { __cardCounts: number[] }).__cardCounts,
      );
      const first = counts.findIndex((n) => n === cardsVisible);
      expect(first).toBeGreaterThanOrEqual(0);
      expect(counts.slice(first).every((n) => n === cardsVisible)).toBe(true);
    } finally {
      await context.close();
    }
  });
}

// --- Editor preview (page.route: the editor's API is stubbed in the browser) ---

const EDITOR_OWNER = {
  id: 2029,
  username: "fp-editor-owner",
  full_name: "Editor Owner",
};
const EDITOR_STRANGER = {
  id: 2030,
  username: "fp-editor-stranger",
  full_name: "Editor Stranger",
};
const EDITOR_ARTICLE = "fp-editor-host";
const OWNER_DRAFT_TITLE = "OWNER-DRAFT-TITLE";
const OWNER_DRAFT_BODY = "OWNER-DRAFT-BODY";

function editorArticle(creator: typeof EDITOR_OWNER, content = "Intro.") {
  return {
    id: 2029,
    free2zaddr: EDITOR_ARTICLE,
    vanity: EDITOR_ARTICLE,
    title: "Editor host",
    description: "",
    canonical_url: "",
    content,
    tags: [],
    category: "TECHNOLOGY",
    // A draft, so the editor autosaves it (the non-leak assertion reads the
    // save that actually went out).
    is_published: false,
    variant_is_published: false,
    is_subscriber_only: false,
    publish_at: null,
    p2paddr: "",
    creator,
    source_language: "en",
    requested_language: "en",
    actual_language: "en",
    fallback_used: false,
    available_languages: ["en"],
    created_at: "2026-09-21T00:00:00Z",
    updated_at: "2026-09-21T00:00:00Z",
    published_at: "2026-09-21T00:00:00Z",
  };
}

type EditorLog = {
  cards: { path: string; cookie: string }[];
  writes: string[];
};

async function stubEditor(page: Page, creator: typeof EDITOR_OWNER) {
  const log: EditorLog = { cards: [], writes: [] };
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route: Route) => {
      const request = route.request();
      const { pathname } = new URL(request.url());
      const headers = await request.allHeaders();
      if (request.method() !== "GET" && request.method() !== "HEAD") {
        log.writes.push(
          `${request.method()} ${pathname} ${request.postData() ?? ""}`,
        );
      }
      if (pathname === "/api/auth/user/") {
        await route.fulfill({ json: creator });
        return;
      }
      if (pathname === `/api/zpage/${EDITOR_ARTICLE}/`) {
        const body =
          request.method() === "GET"
            ? editorArticle(creator)
            : {
                ...editorArticle(creator),
                ...JSON.parse(request.postData() || "{}"),
              };
        await route.fulfill({ json: body });
        return;
      }
      const card = pathname.match(/^\/api\/zpage\/([^/]+)\/$/);
      if (card) {
        log.cards.push({ path: pathname, cookie: headers.cookie ?? "" });
        // The owner's own DRAFT: the API answers it to its owner only.
        if (
          card[1] === "own-draft" &&
          (headers.cookie ?? "").includes("sessionid=fp-editor-owner-session")
        ) {
          await route.fulfill({
            json: {
              ...editorArticle(EDITOR_OWNER),
              free2zaddr: "own-draft-addr",
              vanity: "own-draft",
              title: OWNER_DRAFT_TITLE,
              content: OWNER_DRAFT_BODY,
              is_published: false,
              variant_is_published: false,
            },
          });
          return;
        }
        await route.fulfill({ status: 404, json: { detail: "Not found." } });
        return;
      }
      await route.fulfill({ json: { count: 0, results: [] } });
    },
  );
  return log;
}

async function openEditor(
  browser: Browser,
  session: string,
  creator: typeof EDITOR_OWNER,
) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  await context.addCookies([
    { name: "sessionid", value: session, domain: "127.0.0.1", path: "/" },
  ]);
  const page = await context.newPage();
  const log = await stubEditor(page, creator);
  await page.goto(`/edit?id=${EDITOR_ARTICLE}`);
  const body = page.locator("textarea.writing-area-textarea");
  await expect(body).toHaveValue("Intro.", { timeout: 90_000 });
  await page.getByLabel("Split", { exact: true }).click();
  const preview = page.locator("article.preview-content");
  await expect(preview).toBeVisible();
  return { context, page, log, body, preview };
}

async function typeOwnDraftEmbed(
  page: Page,
  body: ReturnType<Page["locator"]>,
) {
  await body.click();
  await body.press("End");
  // The closing `]` first, then the identifier one key at a time — faster
  // than the debounce, so only the finished identifier may ever be looked up.
  await body.pressSequentially(
    "\n\n::embed[https://free2z.cash/fp-editor-owner/o]",
    {
      delay: 5,
    },
  );
  await body.press("ArrowLeft");
  await body.pressSequentially("wn-draft", { delay: 60 });
}

test("editor preview: debounced, as the author, cached for the session — and the owner's draft card goes nowhere else", async ({
  browser,
}) => {
  const { context, page, log, body, preview } = await openEditor(
    browser,
    "fp-editor-owner-session",
    EDITOR_OWNER,
  );
  try {
    await typeOwnDraftEmbed(page, body);
    const card = preview.locator(".first-party-embed-resolved");
    await expect(card).toHaveCount(1, { timeout: 10_000 });
    await expect(card).toContainText(OWNER_DRAFT_TITLE);

    // Debounced: the half-typed identifiers (`o`, `ow`, … `own-draf`) were
    // never looked up; the finished one was, once, with the author's cookie.
    expect(log.cards.map((call) => call.path)).toEqual([
      "/api/zpage/own-draft/",
    ]);
    expect(log.cards[0].cookie).toContain("sessionid=fp-editor-owner-session");

    // Cached for the session: more typing and preview toggles re-render the
    // card without asking again.
    await body.press("End");
    await body.pressSequentially("\n\nMore words.", { delay: 20 });
    await page.getByLabel("Write", { exact: true }).click();
    await page.getByLabel("Preview", { exact: true }).click();
    await expect(preview.locator(".first-party-embed-resolved")).toContainText(
      OWNER_DRAFT_TITLE,
    );
    await page.waitForTimeout(1_500);
    expect(log.cards).toHaveLength(1);

    // Never persisted: the editor has saved by now (autosave), and no write
    // carries the draft's title or body — it saves markdown, the embed
    // directive, not the card — and nothing is kept in browser storage.
    await expect
      .poll(() => log.writes.length, { timeout: 15_000 })
      .toBeGreaterThan(0);
    for (const write of log.writes) {
      expect(write).not.toContain(OWNER_DRAFT_TITLE);
      expect(write).not.toContain(OWNER_DRAFT_BODY);
    }
    expect(
      log.writes.some((write) => write.includes("fp-editor-owner/own-draft")),
    ).toBe(true);
    const stored = await page.evaluate(() =>
      JSON.stringify([{ ...localStorage }, { ...sessionStorage }]),
    );
    expect(stored).not.toContain(OWNER_DRAFT_TITLE);
    expect(stored).not.toContain(OWNER_DRAFT_BODY);
  } finally {
    await context.close();
  }
});

test("editor preview: another author embedding the same draft sees only the neutral card", async ({
  browser,
}) => {
  const { context, page, log, body, preview } = await openEditor(
    browser,
    "fp-editor-stranger-session",
    EDITOR_STRANGER,
  );
  try {
    await typeOwnDraftEmbed(page, body);
    await expect.poll(() => log.cards.length, { timeout: 10_000 }).toBe(1);
    await expect(preview.locator(".first-party-embed-zpage")).toHaveCount(1);
    await expect(preview.locator(".first-party-embed-resolved")).toHaveCount(0);
    expect(await page.content()).not.toContain(OWNER_DRAFT_TITLE);
    expect(log.cards[0].cookie).toContain(
      "sessionid=fp-editor-stranger-session",
    );
  } finally {
    await context.close();
  }
});
