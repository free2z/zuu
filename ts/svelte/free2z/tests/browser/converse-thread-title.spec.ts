import { expect, test } from "@playwright/test";

/**
 * What a thread is called, when nobody typed a title —.
 *
 * The composer no longer asks for one, so `headline` is empty on everything
 * written from now on while historic rows still carry real ones. The page used
 * to fall back to the literal word "Conversation", which made every untitled
 * thread on the platform share one browser tab, one `og:title` and one search
 * result.
 *
 * `/converse/<uuid>` is server-rendered: its loader fetches the mock API
 * process (`tests/browser/mock-api.mjs`), which a `page.route()` in this file
 * cannot intercept. The two fixtures live there for that reason.
 *
 * NEGATIVE CONTROLS (each run by reverting the change and re-running):
 *   - restoring the old `displayTitle` (headline, else $t("converse.
 *     conversation")) turns the untitled case red with "Conversation • Free2Z";
 *   - `deriveConverseTitle` returning the body unconditionally turns the
 *     historic case red — a real headline must still win;
 *   - dropping the `<h1 class="sr-only">` turns the heading check red, on the
 *     page having no h1 at all.
 */

const DESKTOP = { width: 1280, height: 900 };

test("a historic post keeps its headline as the page's name", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  await page.goto("/converse/converse-titled-fixture");

  await expect(page).toHaveTitle("Shielded notes from 2023 • Free2Z");
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
    "content",
    "Shielded notes from 2023 • Free2Z",
  );
  //...and it is still rendered in the card.
  await expect(
    page.getByRole("heading", {
      name: "Shielded notes from 2023",
      level: 2,
    }),
  ).toBeVisible();
});

test("an untitled post is named after its opening line, not 'Conversation'", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  await page.goto("/converse/converse-untitled-fixture");

  const expected = "the shielded pool is bigger than it was last month";
  await expect(page).toHaveTitle(`${expected} • Free2Z`);
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
    "content",
    `${expected} • Free2Z`,
  );
  // Only the first line, and nothing from after the blank line.
  await expect(page).not.toHaveTitle(/nobody is talking/);
  await expect(page).not.toHaveTitle(/^Conversation/);

  // The page still has exactly one h1, and it is the derived title — the
  // visible headline heading is an h2 and this post has none at all.
  const h1s = page.locator("main h1");
  await expect(h1s).toHaveCount(1);
  await expect(h1s.first()).toHaveText(expected);
});

test("the thread page header is a back link and nothing else", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  await page.goto("/converse/converse-untitled-fixture");

  await expect(
    page.getByRole("link", { name: "Converse" }).first(),
  ).toBeVisible();
  await expect(page.getByText("Conversation thread")).toHaveCount(0);
  await expect(
    page.getByText("Read the full discussion or add your perspective."),
  ).toHaveCount(0);
});

test("the server-rendered thread carries a complete share card (#554)", async ({
  page,
}) => {
  // What a link unfurler sees: raw SSR HTML, no JavaScript. the
  // unfurlers reach this page instead of Django's comments/social.html, which
  // carried og:image and twitter:card; without them X/Slack/Discord show a
  // text-only card. NEGATIVE CONTROL: restoring the hand-written
  // <svelte:head> (title/description/og:type only) turns this red.
  const response = await page.request.get("/converse/converse-titled-fixture");
  expect(response.status()).toBe(200);
  const html = await response.text();
  expect(html).toMatch(/<meta property="og:image" content="https:\/\/[^"]+"/);
  expect(html).toContain(
    '<meta name="twitter:card" content="summary_large_image"',
  );
  expect(html).toMatch(/<meta name="twitter:image" content="https:\/\/[^"]+"/);
  expect(html).toMatch(
    /<meta property="og:url" content="https:\/\/[^"]+\/converse\/converse-titled-fixture"/,
  );
  expect(html).toContain(
    '<meta property="og:title" content="Shielded notes from 2023 • Free2Z"',
  );
});
