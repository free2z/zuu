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

test("global Search cancels stale suggestions and exposes a retryable error", async ({
  page,
}) => {
  await page.goto("/search");
  const input = globalSearch(page);

  await input.fill("z");
  await expect(
    page.getByRole("listbox", { name: "Search suggestions" }),
  ).toBeVisible();
  await input.fill("not-a-result");
  await expect(page.locator("[data-suggestion-kind]")).toHaveCount(0);
  await expect(page.getByText("No matches", { exact: true })).toBeVisible();

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
