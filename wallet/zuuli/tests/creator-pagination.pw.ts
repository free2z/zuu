import { expect, test, type Page } from "@playwright/test";

function viewport(page: Page) {
  return page.locator("[data-scroll-area-viewport]");
}

test("all creator pages remain loaded and positioned across reader back navigation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 640 });
  await page.goto("/creator/zooko");

  const cards = page.locator("[data-creator-page-card]");
  await expect(page.getByText("13 pages", { exact: true })).toBeVisible();
  await expect(cards).toHaveCount(12);
  await expect(page.getByText("12 of 13", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Load more pages" }).click();
  await expect(cards).toHaveCount(13);
  await expect(page.getByText("13 of 13", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Load more pages" }),
  ).toHaveCount(0);

  const scroller = viewport(page);
  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight - element.clientHeight - 120;
  });
  const lastPageLink = cards.last().getByRole("link");
  // Capture the position after Playwright has made the destination fully
  // actionable. Otherwise click() may legitimately nudge a partially visible
  // link and the router should restore that later departure offset instead.
  await lastPageLink.scrollIntoViewIfNeeded();
  const savedOffset = await scroller.evaluate((element) => element.scrollTop);
  expect(savedOffset).toBeGreaterThan(500);

  await lastPageLink.click();
  await expect(page).toHaveURL(/\/articles\//);
  await page.goBack();
  await expect(page).toHaveURL(/\/creator\/zooko$/);
  await expect(cards).toHaveCount(13);
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollTop))
    .toBeCloseTo(savedOffset, 0);
});

for (const scenario of ["fail-once", "empty-once"] as const) {
  test(`${scenario} creator catalog load is explicit and retryable`, async ({
    page,
  }) => {
    await page.addInitScript((mockScenario) => {
      sessionStorage.setItem("zuuli.mock.creator-pages", mockScenario);
    }, scenario);
    await page.goto("/creator/zooko");

    await expect(
      page.getByRole("alert").getByText("Couldn't load this creator's pages"),
    ).toBeVisible();
    await expect(page.getByText("No pages yet")).toHaveCount(0);
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.locator("[data-creator-page-card]")).toHaveCount(12);
    await expect(page.getByText("12 of 13", { exact: true })).toBeVisible();
  });
}
