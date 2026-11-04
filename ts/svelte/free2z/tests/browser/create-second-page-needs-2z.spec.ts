import { expect, test } from "@playwright/test";

/**
 * A creator who already has a zPage and holds under 1 2Z opens /edit and
 * writes a second one.
 *
 * The server answers with the platform's ordinary `402
 * insufficient_funds`. What this pins on the editor's side:
 * - the refusal is a notice that says what is needed, what they have, that the
 *   draft is not saved, and the two ways forward: their existing page (where
 *   a gift usually follows) and Buy 2Z, both in a new tab so the unsaved
 *   draft is not left behind;
 * - autosave stops re-sending a create the server will refuse identically;
 * - the creator's own save still goes out (they may have been gifted or
 *   bought 2Z meanwhile), and a success clears the notice.
 *
 * Named to sort among the early specs rather than the `editor-*` block, which
 * is already the heaviest shard (CLAUDE.md, ).
 */

test.setTimeout(120_000);

/** AUTOSAVE_DELAY in src/routes/edit/+page.svelte. */
const AUTOSAVE_DELAY_MS = 2_500;

const CREATOR = {
  id: 2612,
  username: "second-page-writer",
  full_name: "Second Page Writer",
};

const REFUSAL = {
  code: "insufficient_funds",
  cost: "1.000",
  balance: "0.000",
  shortfall: "1.000",
  action: "page_create",
  detail:
    "Your first zPage is free. To start another one you need at least 1 2Z. Members can gift you 2Z, or you can buy 2Z.",
};

function pageFor(payload: Record<string, unknown>) {
  return {
    id: 2612,
    free2zaddr: "second-page",
    vanity: "",
    title: payload.title || "",
    description: "",
    canonical_url: "",
    content: payload.content || "",
    tags: [],
    p2paddr: "",
    featured_image: null,
    is_published: false,
    is_subscriber_only: false,
    publish_at: null,
    creator: CREATOR,
    source_language: "en",
    actual_language: "en",
    requested_language: "en",
    available_languages: ["en"],
    variant_is_published: false,
    created_at: "2026-10-07T13:11:43Z",
    updated_at: "2026-10-07T13:11:43Z",
  };
}

test("a second page below 1 2Z gets the ways forward, and autosave stops re-sending it", async ({
  page,
}) => {
  await page.clock.install();

  const posts: string[] = [];
  let funded = false;

  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const request = route.request();
      const { pathname } = new URL(request.url());
      const method = request.method();

      if (pathname === "/api/auth/user/") {
        await route.fulfill({ json: CREATOR });
        return;
      }

      if (pathname === "/api/zpage/" && method === "POST") {
        const body = request.postData() || "";
        posts.push(body);
        const signal = { "Idempotency-Key-Honored": "true" };
        if (!funded) {
          await route.fulfill({ status: 402, headers: signal, json: REFUSAL });
          return;
        }
        await route.fulfill({
          status: 201,
          headers: signal,
          json: pageFor(JSON.parse(body || "{}")),
        });
        return;
      }

      if (pathname.startsWith("/api/zpage/") && method === "PUT") {
        await route.fulfill({
          status: 200,
          json: pageFor(JSON.parse(request.postData() || "{}")),
        });
        return;
      }

      await route.fulfill({ json: { count: 0, results: [] } });
    },
  );

  await page.goto("/edit");
  const body = page.locator("textarea.writing-area-textarea");
  await expect(body).toBeVisible({ timeout: 30_000 });

  await page.locator("textarea").first().fill("My second article");
  await body.fill("The first words of a second page.");
  await page.clock.runFor(AUTOSAVE_DELAY_MS + 500);
  await expect.poll(() => posts.length).toBe(1);

  const notice = page.getByTestId("editor-second-page-needs-2z");
  await expect(notice).toBeVisible({ timeout: 10_000 });
  await expect(notice).toContainText(
    "To start another one you need at least 1 2Z, and you have 0 2Z.",
  );
  await expect(notice).toContainText("This draft is not saved yet");
  // Never the retired word. The save status names this reason, not a
  // generic failure.
  await expect(notice).not.toContainText(/tuzi/i);
  await expect(
    page.getByText("Starting another zPage needs 1 2Z.", { exact: false }),
  ).toBeVisible();

  const buy = page.getByTestId("editor-second-page-buy");
  await expect(buy).toHaveAttribute("href", "/buy-2z");
  await expect(buy).toHaveAttribute("target", "_blank");
  const pages = page.getByTestId("editor-second-page-your-pages");
  await expect(pages).toHaveAttribute("href", /\/dashboard\/pages$/);
  await expect(pages).toHaveAttribute("target", "_blank");

  // The creator keeps typing. Autosave must not re-send the refused create:
  // each would be one more identical refusal (and one more failed write on
  // the alert), and it would tell the creator nothing new.
  await body.fill("The first words of a second page, and some more.");
  await page.clock.runFor(AUTOSAVE_DELAY_MS * 8);
  await page.waitForTimeout(1_000);
  expect(posts.length, "autosave re-sent a create refused for 2Z").toBe(1);
  await expect(notice).toBeVisible();

  // They were gifted 2Z in the other tab. Their own save goes out, succeeds,
  // and the notice is gone.
  funded = true;
  await page.keyboard.press("Control+s");
  await expect.poll(() => posts.length, { timeout: 10_000 }).toBe(2);
  expect(JSON.parse(posts[1]).content).toBe(
    "The first words of a second page, and some more.",
  );
  await expect(notice).toHaveCount(0, { timeout: 10_000 });
});
