import { expect, type Page } from "@playwright/test";

export const POPULATED_CREATOR_ROUTE = "/creator/zooko";

export async function expectPopulatedCreatorCatalog(page: Page) {
  const catalog = page.locator("[data-creator-pages]");

  await expect(catalog.locator(".creator-pages-grid")).toBeVisible();
  await expect(catalog.locator("[data-creator-page-card]")).toHaveCount(12);
  await expect(catalog.getByText("12 of 13", { exact: true })).toBeVisible();
  await expect(
    catalog.getByRole("button", { name: "Load more pages" }),
  ).toBeVisible();
}
