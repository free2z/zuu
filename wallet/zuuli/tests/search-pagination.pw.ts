import { expect, test, type Page } from "@playwright/test";

function viewport(page: Page) {
  return page.locator("[data-scroll-area-viewport]");
}

async function useSearchScenarios(page: Page, creators: string, pages: string) {
  await page.addInitScript(
    ({ creatorScenario, pageScenario }) => {
      sessionStorage.setItem("zuuli.mock.search-creators", creatorScenario);
      sessionStorage.setItem("zuuli.mock.search-pages", pageScenario);
    },
    { creatorScenario: creators, pageScenario: pages },
  );
}

test("every result remains loaded with its tab and scroll position across back navigation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 640 });
  await useSearchScenarios(page, "small-pages", "small-pages");
  await page.goto("/search?q=a");

  const creatorResults = page.locator("[data-search-creator-result]");
  await expect(creatorResults).toHaveCount(2);
  await expect(page.getByRole("tab", { name: /Creators/ })).toContainText("4");
  await page.getByRole("button", { name: "Load more creators" }).click();
  await expect(creatorResults).toHaveCount(4);
  await expect(
    page.getByText("4 of 4 creators", { exact: true }),
  ).toBeVisible();

  await page.getByRole("tab", { name: /Pages/ }).click();
  await expect(page).toHaveURL(/\/search\?q=a&tab=pages$/);
  const pageResults = page.locator("[data-search-page-result]");
  await expect(pageResults).toHaveCount(2);
  const pagesTab = page.getByRole("tab", { name: /Pages/ });
  const pageTotal = Number(await pagesTab.locator("span").last().textContent());
  expect(pageTotal).toBeGreaterThan(2);

  let expected = 2;
  while (expected < pageTotal) {
    await page.getByRole("button", { name: "Load more pages" }).click();
    expected = Math.min(expected + 2, pageTotal);
    await expect(pageResults).toHaveCount(expected);
  }
  await expect(
    page.getByText(`${pageTotal} of ${pageTotal} pages`, { exact: true }),
  ).toBeVisible();

  const scroller = viewport(page);
  const savedOffset = await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight - element.clientHeight - 100;
    return element.scrollTop;
  });
  expect(savedOffset).toBeGreaterThan(1_000);

  await pageResults.last().getByRole("link").click();
  await expect(page).toHaveURL(/\/articles\//);
  await page.goBack();
  await expect(page).toHaveURL(/\/search\?q=a&tab=pages$/);
  await expect(pageResults).toHaveCount(pageTotal);
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollTop))
    .toBeCloseTo(savedOffset, 0);

  await page.getByRole("tab", { name: /Creators/ }).click();
  await expect(creatorResults).toHaveCount(4);
  await expect(page.getByRole("searchbox")).toHaveValue("a");
});

test("a fully duplicated page advances to later unique results", async ({
  page,
}) => {
  await useSearchScenarios(page, "duplicate-page", "small-pages");
  await page.goto("/search?q=a");

  const creators = page.locator("[data-search-creator-result]");
  await expect(creators).toHaveCount(2);
  await page.getByRole("button", { name: "Load more creators" }).click();
  await expect(creators).toHaveCount(2);
  await page.getByRole("button", { name: "Load more creators" }).click();
  await expect(page.locator("[data-search-creator-result]")).toHaveCount(4);
  await expect(
    page.getByText("4 of 4 creators", { exact: true }),
  ).toBeVisible();
});

test("count drift and tied-row skips retain the valid terminal results", async ({
  page,
}) => {
  await useSearchScenarios(page, "count-drift", "skip-row");
  await page.goto("/search?q=a");

  const creators = page.locator("[data-search-creator-result]");
  await expect(creators).toHaveCount(2);
  await page.getByRole("button", { name: "Load more creators" }).click();
  await expect(creators).toHaveCount(4);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("4 of 5 creators", { exact: true })).toBeVisible();

  await page.getByRole("tab", { name: /Pages/ }).click();
  const pages = page.locator("[data-search-page-result]");
  await expect(pages).toHaveCount(2);
  const pageTotal = Number(
    await page
      .getByRole("tab", { name: /Pages/ })
      .locator("span")
      .last()
      .textContent(),
  );
  let expected = 2;
  while (expected < pageTotal - 1) {
    await page.getByRole("button", { name: "Load more pages" }).click();
    expected = Math.min(expected + 2, pageTotal - 1);
    await expect(pages).toHaveCount(expected);
  }
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(
    page.getByText(`${pageTotal - 1} of ${pageTotal} pages`, { exact: true }),
  ).toBeVisible();
});

test("overlapping backend pages are deduplicated without losing order", async ({
  page,
}) => {
  await useSearchScenarios(page, "overlap", "small-pages");
  await page.goto("/search?q=a");

  const creators = page.locator("[data-search-creator-result]");
  await expect(creators).toHaveCount(2);
  await page.getByRole("button", { name: "Load more creators" }).click();
  await expect(creators).toHaveCount(3);
  await page.getByRole("button", { name: "Load more creators" }).click();
  await expect(creators).toHaveCount(4);
  const destinations = await creators.evaluateAll((links) =>
    links.map((link) => link.getAttribute("href")),
  );
  expect(new Set(destinations).size).toBe(4);
  await expect(
    page.getByText("4 of 4 creators", { exact: true }),
  ).toBeVisible();
});
