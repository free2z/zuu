import { expect, test, type Page } from "@playwright/test";

const SEARCH_NAME = "Search creators, pages, and topics";
const SEARCH_NAME_ES = "Buscar creadores, páginas y temas";

function globalSearch(page: Page) {
  return page.getByRole("combobox", { name: SEARCH_NAME });
}

test("global Search offers mixed keyboard and screen-reader suggestions", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/search");

  const input = globalSearch(page);
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute("aria-expanded", "false");
  await expect(
    page.getByRole("listbox", { name: "Search suggestions" }),
  ).toHaveCount(0);
  await expect(page.locator("[data-suggestion-kind]")).toHaveCount(0);

  await input.fill("z");
  const listbox = page.getByRole("listbox", { name: "Search suggestions" });
  await expect(listbox).toBeVisible();
  await expect(input).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator('[data-suggestion-kind="topic"]')).not.toHaveCount(
    0,
  );
  await expect(
    page.locator('[data-suggestion-kind="creator"]'),
  ).not.toHaveCount(0);
  await expect(page.locator('[data-suggestion-kind="page"]')).not.toHaveCount(
    0,
  );

  await input.press("ArrowDown");
  const activeId = await input.getAttribute("aria-activedescendant");
  expect(activeId).toBeTruthy();
  await expect(page.locator(`[id="${activeId}"]`)).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await input.press("Escape");
  await expect(input).toHaveValue("z");
  await expect(input).toHaveAttribute("aria-expanded", "false");
  await expect(listbox).toHaveCount(0);

  await input.press("ArrowDown");
  await expect(listbox).toBeVisible();
  await input.press("Enter");
  await expect(page.getByLabel("Selected topics")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^Remove topic / }),
  ).toBeVisible();
  expect(new URL(page.url()).searchParams.getAll("topic")).toHaveLength(1);
  await expect(input).toHaveValue("");

  const viewport = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(viewport.scroll).toBeLessThanOrEqual(viewport.client);
});

test("global Search rejects an older response that resolves last and exposes a retryable error", async ({
  page,
}) => {
  await page.goto("/search");
  const input = globalSearch(page);

  // Invert the two search generations deterministically: the first creator
  // and page calls take 1.2s, while the second pair takes 10ms. This exercises
  // the production request-generation guard instead of merely clearing an
  // already-rendered list between sequential searches.
  await page.evaluate(() => {
    const nativeSetTimeout = window.setTimeout.bind(window);
    let searchCalls = 0;
    window.setTimeout = ((
      handler: TimerHandler,
      timeout?: number,
      ...args: unknown[]
    ) => {
      if (timeout === 200 || timeout === 220) {
        const delay = searchCalls < 2 ? 1_200 : 10;
        searchCalls += 1;
        return nativeSetTimeout(handler, delay, ...args);
      }
      return nativeSetTimeout(handler, timeout, ...args);
    }) as typeof window.setTimeout;
  });

  await input.fill("z");
  await page.waitForTimeout(350);
  await input.fill("privacy");
  const listbox = page.getByRole("listbox", { name: "Search suggestions" });
  await expect(listbox.getByRole("option").first()).toBeVisible();
  await expect(input).toHaveValue("privacy");
  await expect(listbox).toContainText("#privacy");

  // The delayed `z` response has resolved by now. It must not replace the
  // newer privacy generation or resurrect its topic suggestions.
  await page.waitForTimeout(1_000);
  await expect(input).toHaveValue("privacy");
  await expect(listbox).toContainText("#privacy");
  await expect(listbox).not.toContainText("#zcash");

  await page.evaluate(() => {
    sessionStorage.setItem("zuuli.mock.search-creators", "unavailable");
    sessionStorage.setItem("zuuli.mock.search-pages", "unavailable");
  });
  await input.fill("error-state");
  await expect(
    page.getByText("Search unavailable", { exact: true }).first(),
  ).toBeVisible();
  const retry = page.getByRole("button", { name: "Try again" }).first();
  await expect(retry).toBeVisible();

  await page.evaluate(() => {
    sessionStorage.removeItem("zuuli.mock.search-creators");
    sessionStorage.removeItem("zuuli.mock.search-pages");
  });
  await retry.click();
  await expect(page.getByText("No matches", { exact: true })).toBeVisible();
});

test("Articles replaces the topic wall with a quiet removable autocomplete", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 720 });
  await page.goto("/articles");

  await expect(page.locator('[aria-label="Filter by tag"]')).toHaveCount(0);
  const input = page.getByRole("combobox", { name: "Filter by topic" });
  await expect(input).toBeVisible();
  await expect(input).toHaveAttribute("aria-expanded", "false");
  await expect(
    page.getByRole("listbox", { name: "Topic suggestions" }),
  ).toHaveCount(0);

  await input.fill("pri");
  const listbox = page.getByRole("listbox", { name: "Topic suggestions" });
  await expect(listbox.getByRole("option").first()).toBeVisible();
  await input.press("ArrowDown");
  await input.press("Enter");
  await expect(page).toHaveURL(/\/articles\?tags=privacy$/);

  const remove = page.getByRole("button", { name: "Remove topic privacy" });
  await expect(remove).toBeVisible();
  const box = await remove.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  await remove.click();
  expect(new URL(page.url()).searchParams.has("tags")).toBe(false);

  await input.fill("pri");
  await expect(listbox).toBeVisible();
  await input.press("Escape");
  await expect(input).toHaveValue("pri");
  await expect(input).toHaveAttribute("aria-expanded", "false");

  await input.fill("zc");
  await expect(listbox).toBeVisible();
  await expect(listbox.getByRole("option")).toHaveCount(1);
  await expect(listbox.getByRole("option")).toContainText("zcash");

  const viewport = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(viewport.scroll).toBeLessThanOrEqual(viewport.client);
});

test("Articles exposes a retryable topic failure instead of misreporting an empty corpus", async ({
  page,
}) => {
  await page.addInitScript(() => {
    sessionStorage.setItem("zuuli.mock.article-topics", "unavailable-once");
  });
  await page.goto("/articles");

  const input = page.getByRole("combobox", { name: "Filter by topic" });
  await input.fill("pri");
  await expect(
    page.getByText("Topics unavailable", { exact: true }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Try again" }).first().click();
  await expect(
    page.getByRole("listbox", { name: "Topic suggestions" }),
  ).toContainText("privacy");
});

for (const width of [320, 360] as const) {
  for (const signedIn of [false, true]) {
    test(`${signedIn ? "signed-in" : "signed-out"} Search tabs remain operable while autocomplete loads and is empty at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 720 });
      await page.addInitScript((authenticated) => {
        const key = "zuuli.knox.token";
        if (authenticated) localStorage.setItem(key, "mock-knox-token");
        else localStorage.removeItem(key);
      }, signedIn);
      await page.goto("/search?q=no-results-for-this-query");

      const pagesTab = page.getByRole("tab", { name: /Pages/ });
      await pagesTab.click();
      await expect(pagesTab).toHaveAttribute("aria-selected", "true");
      await globalSearch(page).fill("still-no-results-for-this-query");
      await expect(page.getByText("No matches", { exact: true })).toBeVisible();

      const creatorsTab = page.getByRole("tab", { name: /Creators/ });
      await creatorsTab.click();
      await expect(creatorsTab).toHaveAttribute("aria-selected", "true");
      await expect(page.getByText("No matches", { exact: true })).toHaveCount(
        0,
      );
    });
  }
}

test("Search clears a pointer transaction released outside the route", async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 720 });
  await page.goto("/search?q=no-results-for-this-query");

  const input = globalSearch(page);
  const noMatches = page.getByText("No matches", { exact: true });
  await expect(noMatches).toBeVisible();

  const clearSearch = page.getByRole("button", { name: "Clear search" });
  const clearBounds = await clearSearch.boundingBox();
  const topBarBounds = await page.locator("[data-app-top-bar]").boundingBox();
  expect(clearBounds).not.toBeNull();
  expect(topBarBounds).not.toBeNull();
  await page.mouse.move(
    clearBounds!.x + clearBounds!.width / 2,
    clearBounds!.y + clearBounds!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    topBarBounds!.x + topBarBounds!.width / 2,
    topBarBounds!.y + topBarBounds!.height / 2,
  );
  await page.mouse.up();
  await expect(noMatches).toHaveCount(0);

  // Force a new keyboard focus transition even on browsers that keep the
  // pressed clear button from taking focus when released elsewhere.
  await page.getByRole("button", { name: "Log in" }).focus();
  await input.focus();
  await expect(noMatches).toBeVisible();
  await input.press("Tab");
  await expect(clearSearch).toBeFocused();
  await expect(noMatches).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(noMatches).toHaveCount(0);
});

test.describe("locale-aware Search", () => {
  test.use({ locale: "es-ES" });

  test("keeps mixed suggestions bounded and selectable outside en-US", async ({
    page,
  }) => {
    await page.goto("/search");
    const input = page.getByRole("combobox", { name: SEARCH_NAME_ES });
    await input.fill("privacy");
    const options = page.getByRole("option");
    await expect(options.first()).toBeVisible();
    expect(await options.count()).toBeLessThanOrEqual(8);
    await expect(input).toHaveAttribute("aria-autocomplete", "list");
  });
});
