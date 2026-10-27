import { expect, test, type Page } from "@playwright/test";
import {
  CONVERSE_ROOT,
  DRAFT,
  GATED_THREAD,
  GATED_TEXT,
  MEMBERS,
  MOCK_API_ORIGIN,
  PUBLIC,
  READERS,
  THREAD,
  cardCalls,
  expectCookies,
  forbiddenFor,
  readerPage,
} from "./first-party-embed-card-surfaces.fixture";

test.describe.configure({ timeout: 120_000 });

// --- Comments on a zPage (browser-loaded) --------------------------------------

async function openComments(page: Page, path: string, count: number) {
  const response = await page.goto(path);
  expect(response?.status()).toBe(200);
  // Comments load when the section scrolls into view.
  await page
    .locator('section[aria-label="Discussion"]')
    .or(page.getByLabel("Loading discussion"))
    .first()
    .scrollIntoViewIfNeeded();
  const comments = page.locator(
    'section[aria-label="Discussion"] article[id^="comment-"]',
  );
  await expect(comments).toHaveCount(count, { timeout: 60_000 });
  return comments;
}

for (const { reader, session, visible } of READERS) {
  test(`comments: the ${reader} viewer — not the comment's author — decides which cards render`, async ({
    browser,
    request,
  }) => {
    await request.delete(`${MOCK_API_ORIGIN}/__requests`);
    const { context, page } = await readerPage(browser, session);
    try {
      const comments = await openComments(
        page,
        "/fp-card-user/fp-card-comments",
        4,
      );
      const resolved = comments.locator(".first-party-embed-resolved");
      await expect(resolved).toHaveCount(visible.length, { timeout: 30_000 });
      for (const title of visible) {
        await expect(resolved.filter({ hasText: title })).toHaveCount(1);
      }
      // Everything else is the one neutral card, never the content.
      await expect(
        comments.locator(".first-party-embed:not(.first-party-embed-resolved)"),
      ).toHaveCount(4 - visible.length);
      const html = await page.content();
      expect(
        forbiddenFor(visible).filter((text) => html.includes(text)),
      ).toEqual([]);

      // Asked by API identifier, once each, with THIS viewer's cookie.
      const calls = await cardCalls(request);
      expect(calls.map((call) => call.path.split("?")[0]).sort()).toEqual([
        `/api/comments/${GATED_THREAD}/`,
        "/api/zpage/fp-card-draft/",
        "/api/zpage/fp-card-public/",
        "/api/zpage/fp-card-subonly/",
      ]);
      await expectCookies(calls, session);
    } finally {
      await context.close();
    }
  });
}

test("comments: thirty comments × three embeds stay inside ONE page budget, shared targets fetched once", async ({
  browser,
  request,
}) => {
  await request.delete(`${MOCK_API_ORIGIN}/__requests`);
  const { context, page } = await readerPage(browser, null);
  try {
    const comments = await openComments(
      page,
      "/fp-card-user/fp-card-fanout",
      30,
    );
    const resolved = comments.locator(".first-party-embed-resolved");
    // Every comment shows the two shared cards; own cards only while the
    // page budget (16 calls = 2 shared + 14 own) lasts.
    await expect(resolved.filter({ hasText: PUBLIC })).toHaveCount(30, {
      timeout: 30_000,
    });
    await expect(resolved.filter({ hasText: "Shared card title" })).toHaveCount(
      30,
    );
    await expect(resolved.filter({ hasText: "Fan card" })).toHaveCount(14);
    // Settled: nothing more arrives.
    await page.waitForTimeout(1_000);
    await expect(resolved).toHaveCount(74);
    await expect(
      comments.locator(".first-party-embed:not(.first-party-embed-resolved)"),
    ).toHaveCount(16);

    const calls = await cardCalls(request);
    expect(calls).toHaveLength(16);
    const paths = calls.map((call) => call.path.split("?")[0]);
    expect(new Set(paths).size).toBe(16);
    expect(
      paths.filter((path) => path === "/api/zpage/fp-card-public/"),
    ).toHaveLength(1);
    expect(
      paths.filter((path) => path === "/api/zpage/fp-card-shared/"),
    ).toHaveLength(1);
  } finally {
    await context.close();
  }
});

test("comments: a client-side navigation is a new page view with its own budget", async ({
  browser,
  request,
}) => {
  await request.delete(`${MOCK_API_ORIGIN}/__requests`);
  const { context, page } = await readerPage(browser, null);
  try {
    const comments = await openComments(
      page,
      "/fp-card-user/fp-card-fanout",
      30,
    );
    const resolved = comments.locator(".first-party-embed-resolved");
    await expect(resolved).toHaveCount(74, { timeout: 30_000 });
    expect(await cardCalls(request)).toHaveLength(16);

    // Follow a card (a client-side route), then come back.
    await resolved.filter({ hasText: PUBLIC }).first().locator("a").click();
    await expect(page).toHaveURL(/\/fp-card-user\/fp-card-public$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/fp-card-user\/fp-card-fanout$/);
    const again = await openCommentsInPlace(page, 30);
    await expect(again.locator(".first-party-embed-resolved")).toHaveCount(74, {
      timeout: 30_000,
    });
    // The page view before was forgotten: the cards were resolved afresh,
    // inside a fresh budget of 16 — not served from the last page view — and
    // the page being left spent NOTHING of the next page's budget while it
    // was still mounted (the only other card-path call is the visited
    // article's own load, by its route).
    await page.waitForTimeout(1_000);
    const calls = (await cardCalls(request)).map((call) => call.path);
    expect(calls).toHaveLength(33);
    expect(calls[16]).toBe("/api/zpage/fp-card-public/?lang=en");
    expect(calls.slice(17)).toEqual(calls.slice(0, 16));
  } finally {
    await context.close();
  }
});

async function openCommentsInPlace(page: Page, count: number) {
  await page
    .locator('section[aria-label="Discussion"]')
    .or(page.getByLabel("Loading discussion"))
    .first()
    .scrollIntoViewIfNeeded();
  const comments = page.locator(
    'section[aria-label="Discussion"] article[id^="comment-"]',
  );
  await expect(comments).toHaveCount(count, { timeout: 60_000 });
  return comments;
}

test("comments: a card landing in one comment re-renders only that comment", async ({
  browser,
  request,
}) => {
  await request.delete(`${MOCK_API_ORIGIN}/__requests`);
  const { context, page } = await readerPage(browser, null);
  try {
    const comments = await openComments(
      page,
      "/fp-card-user/fp-card-rerender",
      3,
    );
    // The quick card is in; the slow one is still on its way.
    await expect(
      comments.locator(".first-party-embed-resolved", { hasText: PUBLIC }),
    ).toHaveCount(1, { timeout: 30_000 });
    await expect(
      comments.locator(".first-party-embed-resolved", {
        hasText: "Slow card title",
      }),
    ).toHaveCount(0);
    // Tag the live nodes of the OTHER bodies.
    await page.evaluate(() => {
      for (const node of document.querySelectorAll(
        'section[aria-label="Discussion"] .markdown-content',
      )) {
        (node.firstElementChild as unknown as { __kept?: boolean }).__kept =
          true;
      }
      const video = document.querySelector(
        'section[aria-label="Discussion"] video',
      ) as unknown as { __kept?: boolean } | null;
      if (video) video.__kept = true;
    });
    await expect(
      comments.locator(".first-party-embed-resolved", {
        hasText: "Slow card title",
      }),
    ).toHaveCount(1, { timeout: 30_000 });
    await page.waitForTimeout(300);
    const kept = await page.evaluate(() => {
      const bodies = [
        ...document.querySelectorAll(
          'section[aria-label="Discussion"] article[id^="comment-"]',
        ),
      ];
      return bodies.map((article) => {
        const first = article.querySelector(".markdown-content")
          ?.firstElementChild as unknown as { __kept?: boolean } | null;
        const video = article.querySelector("video") as unknown as {
          __kept?: boolean;
        } | null;
        return {
          text: article.textContent?.includes("Video comment.")
            ? "video"
            : article.textContent?.includes("Slow comment.")
              ? "slow"
              : "quick",
          body: first?.__kept === true,
          video: video ? video.__kept === true : null,
        };
      });
    });
    // The two bodies whose cards did not change kept their DOM (and the
    // video its element); only the slow comment was re-rendered.
    expect(kept.find((b) => b.text === "video")).toEqual({
      text: "video",
      body: true,
      video: true,
    });
    expect(kept.find((b) => b.text === "quick")?.body).toBe(true);
    expect(kept.find((b) => b.text === "slow")?.body).toBe(false);
  } finally {
    await context.close();
  }
});

// --- Converse (server-rendered root, browser-loaded replies) -------------------

const CONVERSE_EXPECT: Record<string, { root: string[]; replies: string[] }> = {
  anonymous: { root: [PUBLIC], replies: [PUBLIC] },
  stranger: { root: [PUBLIC], replies: [PUBLIC] },
  subscriber: { root: [PUBLIC, MEMBERS], replies: [THREAD, PUBLIC] },
  owner: { root: [PUBLIC, MEMBERS], replies: [DRAFT, THREAD, PUBLIC] },
};

for (const { reader, session } of READERS) {
  test(`converse: the ${reader} viewer gets exactly their cards in the SSR root and in the replies`, async ({
    browser,
    request,
  }) => {
    const expected = CONVERSE_EXPECT[reader];
    await request.delete(`${MOCK_API_ORIGIN}/__requests`);
    const { context, page } = await readerPage(browser, session);
    try {
      const response = await page.goto(`/converse/${CONVERSE_ROOT}`);
      expect(response?.status()).toBe(200);
      expect(response?.headers()["cache-control"]).toBe("private, no-cache");
      expect(response?.headers()["vary"]).toMatch(/cookie/i);
      // The root's cards are in the server's HTML itself.
      const ssr = (await response?.text()) ?? "";
      for (const title of expected.root) expect(ssr).toContain(title);
      expect(
        forbiddenFor(expected.root).filter((text) => ssr.includes(text)),
      ).toEqual([]);

      const root = page.locator(`#comment-${CONVERSE_ROOT}`);
      await expect(page.getByText("Reply two.")).toBeVisible({
        timeout: 60_000,
      });
      const all = page.locator("main .first-party-embed-resolved");
      await expect(all).toHaveCount(
        expected.root.length + expected.replies.length,
        { timeout: 30_000 },
      );
      for (const title of expected.root) {
        await expect(
          root
            .locator(".first-party-embed-resolved")
            .filter({ hasText: title }),
        ).not.toHaveCount(0);
      }
      const html = await page.content();
      const allVisible = [...expected.root, ...expected.replies];
      expect(
        forbiddenFor(allVisible).filter((text) => html.includes(text)),
      ).toEqual([]);

      // Anonymous: four targets, four calls — the public page is embedded by
      // the root (server) AND a reply (browser) and is fetched ONCE, the
      // browser reusing the server's seed. A session-bearing render's seed is
      // re-resolved by the browser once it knows who is signed in (a cookie
      // is not an identity), so the root's two targets are asked twice.
      await page.waitForTimeout(500);
      const calls = await cardCalls(request);
      const once = [
        `/api/comments/${GATED_THREAD}/`,
        "/api/zpage/fp-card-draft/",
        "/api/zpage/fp-card-public/",
        "/api/zpage/fp-card-subonly/",
      ];
      expect(calls.map((call) => call.path.split("?")[0]).sort()).toEqual(
        session
          ? [
              ...once,
              "/api/zpage/fp-card-public/",
              "/api/zpage/fp-card-subonly/",
            ].sort()
          : once,
      );
      await expectCookies(calls, session);
    } finally {
      await context.close();
    }
  });
}

test("navigation between UNSEEDED pages is a new page view too (layout wiring)", async ({
  browser,
  request,
}) => {
  // `/converse?sort=hot…` is loaded in the browser: its loader seeds
  // nothing, so only the layout's onNavigate/afterNavigate can start a new
  // page view here (review F4).
  await request.delete(`${MOCK_API_ORIGIN}/__requests`);
  const { context, page } = await readerPage(browser, null);
  await context.addCookies([
    { name: "fp-card-stream", value: "1", domain: "127.0.0.1", path: "/" },
  ]);
  try {
    await page.goto("/converse?sort=hot&posts=1");
    const resolved = page.locator(
      '[data-testid="converse-feed"] .first-party-embed-resolved',
    );
    await expect(resolved).toHaveCount(16, { timeout: 60_000 });
    await page.waitForTimeout(500);
    expect(await cardCalls(request)).toHaveLength(16);
    // Client-side navigation to another unseeded URL of the same route.
    await page
      .getByRole("button", {
        name: "Show standalone posts only",
        exact: true,
      })
      .click();
    await expect(page).toHaveURL(/\/converse\?sort=hot$/);
    await expect(resolved).toHaveCount(16, { timeout: 60_000 });
    await page.waitForTimeout(1_000);
    // A fresh page view: the same 16 resolved again, inside a fresh budget.
    const calls = (await cardCalls(request)).map((call) => call.path);
    expect(calls).toHaveLength(32);
    expect(calls.slice(16)).toEqual(calls.slice(0, 16));
  } finally {
    await context.close();
  }
});
