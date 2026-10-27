import { expect, test, type Page } from "@playwright/test";
import { browserMockApiOrigin } from "./ports";

/**
 * `/tag/<slug>` must SERVER-RENDER its results.
 *
 * This is the assertion the whole issue turns on. `/search?tag=` already
 * showed the same pages to a human and nothing at all to a crawler, because
 * the results were fetched from the browser — so a hub that renders
 * client-side only is exactly as invisible as the page it replaces, while
 * looking completely fine in a browser. Asserting a 200 would not catch it;
 * these tests assert the RENDERED MARKUP with JavaScript disabled.
 *
 * Fixtures live in `tests/browser/mock-api.mjs` (`TAG_HUB_FIXTURES`).
 */

// A cold vite dev server compiles this route on first request.
test.describe.configure({ timeout: 90_000 });

// Whatever port THIS run's mock API actually bound. The suite's ports default
// to a pair derived from the worktree path, so two agents' runs no longer
// contend for one; never hardcode one here.
const MOCK_API_ORIGIN = browserMockApiOrigin();
const HUB = "/tag/ssr-tag-fixture";
const SENTINEL = "ssr-tag-hub-sentinel";

/**
 * Visible text as a browser computes it. Deliberately NOT a regex over the
 * response body — Tailwind class names carry `<` and `>` inside attribute
 * values, so naive tag-stripping both under- and over-counts. With
 * `javaScriptEnabled: false` this DOM is exactly the server's markup.
 */
function visibleText(page: Page) {
  return page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
}

function metaContent(page: Page, name: string) {
  return page.locator(`meta[name="${name}"]`).first().getAttribute("content");
}

function linkHref(page: Page, rel: string) {
  return page.locator(`link[rel="${rel}"]`).first().getAttribute("href");
}

test.describe("server-rendered tag hub (no JavaScript)", () => {
  // GPTBot, ClaudeBot, PerplexityBot, CCBot and Meta-ExternalAgent execute no
  // JavaScript at all, and Googlebot only does so in a deferred second wave.
  test.use({
    javaScriptEnabled: false,
    userAgent:
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  });

  test("a crawler that runs no JavaScript receives the tag's pages", async ({
    page,
  }) => {
    const response = await page.goto(HUB);
    expect(response?.status()).toBe(200);

    const text = await visibleText(page);

    // The tag itself, as an h1 — not just somewhere in the chrome.
    await expect(page.locator("h1")).toContainText("ssr-tag-fixture");
    // The RESULTS. This is the line that fails if the route ever goes back to
    // fetching client-side: the shell renders, the heading renders, and the
    // list is empty.
    expect(text).toContain(SENTINEL);
    expect(text).toContain(`${SENTINEL} 0`);
    expect(text).toContain(`${SENTINEL} 11`);
    // 12 rows on page 1 of 15 (TAG_PAGE_SIZE), so row 12 belongs to page 2.
    expect(text).not.toContain(`${SENTINEL} 12`);
    // And the whole-queryset count, not the length of one page.
    await expect(page.getByTestId("tag-hub-count")).toContainText("15");

    const links = await page
      .locator(`a[href^="/ssrtaghubfixturecreator/"]`)
      .count();
    expect(links).toBeGreaterThanOrEqual(12);
  });

  test("a populated hub is indexable and self-canonical", async ({ page }) => {
    await page.goto(HUB);

    // `index, follow, …` — the DEFAULT_ROBOTS string, i.e. not noindex. The
    // `/search?tag=` URLs Google reported were excluded by exactly this tag.
    expect(await metaContent(page, "robots")).toMatch(/^index,\s*follow/);
    expect(await linkHref(page, "canonical")).toBe(
      "https://free2z.cash/tag/ssr-tag-fixture",
    );
    // A description that is neither empty nor the site boilerplate.
    expect(await metaContent(page, "description")).toContain("ssr-tag-fixture");
    // OG/Twitter, because a topic hub is a shareable URL.
    expect(
      await page
        .locator('meta[property="og:url"]')
        .first()
        .getAttribute("content"),
    ).toBe("https://free2z.cash/tag/ssr-tag-fixture");
    expect(await metaContent(page, "twitter:card")).toBe("summary_large_image");
  });

  test("a paginated slice is self-canonical, noindex, and links prev/next", async ({
    page,
  }) => {
    await page.goto(`${HUB}?page=2`);

    const text = await visibleText(page);
    expect(text).toContain(`${SENTINEL} 12`);
    expect(text).not.toContain(`${SENTINEL} 0:`);

    expect(await metaContent(page, "robots")).toBe("noindex, follow");
    // SELF-canonical, not a canonical pointing at page 1: a canonical that
    // names different content is ignored, and `rel=prev` is the signal that is
    // actually about pagination.
    expect(await linkHref(page, "canonical")).toBe(
      "https://free2z.cash/tag/ssr-tag-fixture?page=2",
    );
    expect(await linkHref(page, "prev")).toBe(
      "https://free2z.cash/tag/ssr-tag-fixture",
    );
    expect(await page.locator('link[rel="next"]').count()).toBe(0);
  });

  test("a hub below the quality gate renders but is not indexable", async ({
    page,
  }) => {
    const response = await page.goto("/tag/ssr-thin-fixture");
    expect(response?.status()).toBe(200);

    // Still a real page for a human, still linking out.
    expect(await visibleText(page)).toContain(SENTINEL);
    // But not one we ask Google to index. Revert the gate — make
    // `indexable` unconditional — and this assertion is what fails.
    expect(await metaContent(page, "robots")).toBe("noindex, follow");
  });

  test("a tag with no live pages is a 404, not a thin 200", async ({
    page,
  }) => {
    // The shape the backend returns once the only creator carrying a tag is
    // deactivated. An empty 200 would be a soft-404 on a URL we
    // put in the sitemap.
    const response = await page.goto("/tag/ssr-banned-fixture");
    expect(response?.status()).toBe(404);
    expect(await visibleText(page)).not.toContain(SENTINEL);
  });

  test("colliding spellings browse together and say so", async ({ page }) => {
    await page.goto("/tag/ssr-collide-fixture");

    await expect(page.locator("h1")).toContainText("SSR Collide Fixture");
    // The second spelling is disclosed rather than silently merged — it is the
    // only way a reader can see why a page tagged `ssr/collide/fixture` is
    // here.
    await expect(page.getByTestId("tag-hub-count")).toContainText(
      "ssr/collide/fixture",
    );
    expect(await visibleText(page)).toContain(SENTINEL);
  });

  test("the complete hub reaches the API as one bounded server filter", async ({
    page,
    request,
  }) => {
    await request.delete(`${MOCK_API_ORIGIN}/__requests`);
    await page.goto("/tag/ssr-collide-fixture");

    const requests = (await (
      await request.get(`${MOCK_API_ORIGIN}/__requests`)
    ).json()) as { path: string }[];
    const listed = requests.find(
      (entry) =>
        entry.path.startsWith("/api/zpage/") && entry.path.includes("hub_slug"),
    );
    expect(listed, "the hub never listed anything").toBeTruthy();

    const params = new URL(listed!.path, MOCK_API_ORIGIN).searchParams;
    expect(params.get("hub_slug")).toBe("ssr-collide-fixture");
    expect(params.getAll("any_tags")).toEqual([]);
  });

  test("a non-canonical or aliased slug redirects to the canonical hub", async ({
    page,
  }) => {
    // Case, separators and a trailing form are all links somebody will write,
    // and each would otherwise be a second URL over one result set.
    await page.goto("/tag/SSR-Tag-Fixture");
    expect(new URL(page.url()).pathname).toBe("/tag/ssr-tag-fixture");

    // A spelling  merged away is still a URL Google holds.
    await page.goto("/tag/ssr-alias-fixture");
    expect(new URL(page.url()).pathname).toBe("/tag/ssr-tag-fixture");

    // Slug cleanup must not silently throw away the requested result slice.
    await page.goto("/tag/SSR-Tag-Fixture?page=2");
    expect(new URL(page.url()).pathname).toBe("/tag/ssr-tag-fixture");
    expect(new URL(page.url()).search).toBe("?page=2");
  });

  test("a live casefold alias redirects to the canonical union", async ({
    page,
  }) => {
    await page.goto("/tag/ssr-strasse-fixture");

    expect(new URL(page.url()).pathname).toBe("/tag/ssr-stra%C3%9Fe-fixture");
    await expect(page.locator("h1")).toContainText("SSR Straße Fixture");
    await expect(page.getByTestId("tag-hub-count")).toContainText("4");
    expect(await visibleText(page)).toContain(`${SENTINEL} 0`);
    expect(await visibleText(page)).toContain(`${SENTINEL} 3`);
    expect(await metaContent(page, "robots")).toMatch(/^index,\s*follow/);
    expect(await linkHref(page, "canonical")).toBe(
      "https://free2z.cash/tag/ssr-stra%C3%9Fe-fixture",
    );
  });

  test("/search?tag=X 301s to the hub but keeps ?q= working", async ({
    page,
  }) => {
    await page.goto("/search?tag=ssr-tag-fixture");
    const redirected = new URL(page.url());
    expect(redirected.pathname).toBe("/tag/ssr-tag-fixture");

    // A text query combined with a tag is a two-axis filter the hub cannot
    // express. Redirecting it would silently drop the visitor's query.
    await page.goto("/search?q=memo&tag=ssr-tag-fixture");
    const kept = new URL(page.url());
    expect(kept.pathname).toBe("/search");
    expect(kept.searchParams.get("q")).toBe("memo");
    expect(kept.searchParams.get("tag")).toBe("ssr-tag-fixture");
  });
});
