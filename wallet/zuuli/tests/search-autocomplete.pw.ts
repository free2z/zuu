import { expect, test, type Page } from "@playwright/test";

const SEARCH_NAME = "Search creators, pages, and topics";

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

test.describe("locale-aware Search", () => {
  test.use({ locale: "es-ES" });

  test("keeps mixed suggestions bounded and selectable outside en-US", async ({
    page,
  }) => {
    await page.goto("/search");
    const input = globalSearch(page);
    await input.fill("privacy");
    const options = page.getByRole("option");
    await expect(options.first()).toBeVisible();
    expect(await options.count()).toBeLessThanOrEqual(8);
    await expect(input).toHaveAttribute("aria-autocomplete", "list");
  });
});
