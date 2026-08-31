import { expect, test, type Page } from "@playwright/test";

const SEARCH_NAME = "Search creators, pages, and topics";
const VIEWPORTS = [
  { name: "phone", width: 320, height: 568 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1280, height: 800 },
] as const;

async function enterSearch(page: Page, width: number) {
  await page.goto("/");
  const topBar = page.locator("[data-app-top-bar]");

  if (width < 640) {
    await topBar.getByRole("link", { name: "Search", exact: true }).click();
  } else {
    const globalSearch = topBar.getByRole("searchbox", { name: SEARCH_NAME });
    await globalSearch.fill("alpha route");
    await globalSearch.press("Enter");
  }

  await expect(page).toHaveURL(
    width < 640 ? /\/search$/ : /\/search\?q=alpha(?:\+|%20)route$/,
  );
}

async function expectSingleRouteSearch(page: Page) {
  const input = page.getByRole("combobox", { name: SEARCH_NAME });
  const topBar = page.locator("[data-app-top-bar]");

  await expect(input).toHaveCount(1);
  await expect(input).toBeVisible();
  await expect(
    topBar.getByRole("searchbox", { name: SEARCH_NAME }),
  ).toHaveCount(0);
  await expect(topBar.getByLabel("Search", { exact: true })).toHaveCount(0);
  await expect(input).toHaveAttribute("data-custom-search-clear", "true");
  await expect(input).toHaveAttribute("type", "text");
  await expect(input).toHaveAttribute("aria-autocomplete", "list");
  await expect(input).toHaveAttribute("inputmode", "search");
  return input;
}

for (const viewport of VIEWPORTS) {
  test(
    `${viewport.name} Search has one route-backed interaction`,
    async ({ page }) => {
      await page.setViewportSize(viewport);
      await enterSearch(page, viewport.width);

      const input = await expectSingleRouteSearch(page);
      await expect(input).toBeFocused();

      if (viewport.width < 640) {
        await input.fill("alpha route");
        await expect(page).toHaveURL(/\/search\?q=alpha(?:\+|%20)route$/);
      } else {
        await expect(input).toHaveValue("alpha route");
      }

      await input.fill("beta history");
      await expect(page).toHaveURL(/\/search\?q=beta(?:\+|%20)history$/);

      await page.goBack();
      await expect(page).toHaveURL(/\/$/);
      await page.goForward();
      await expect(page).toHaveURL(/\/search\?q=beta(?:\+|%20)history$/);
      await expect(await expectSingleRouteSearch(page)).toHaveValue(
        "beta history",
      );

      const clear = page.getByRole("button", { name: "Clear search" });
      await expect(clear).toHaveCount(1);
      const clearBox = await clear.boundingBox();
      expect(clearBox).not.toBeNull();
      expect(clearBox!.width).toBeGreaterThanOrEqual(44);
      expect(clearBox!.height).toBeGreaterThanOrEqual(44);

      const clearPresentation = await input.evaluate((element) => {
        const inputRect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          inputRight: inputRect.right,
          editableRight:
            inputRect.right -
            Number.parseFloat(style.paddingRight) -
            Number.parseFloat(style.borderRightWidth),
          documentClientWidth: document.documentElement.clientWidth,
          documentScrollWidth: document.documentElement.scrollWidth,
        };
      });
      expect(clearBox!.x).toBeGreaterThanOrEqual(
        clearPresentation.editableRight - 0.5,
      );
      expect(clearBox!.x + clearBox!.width).toBeLessThanOrEqual(
        clearPresentation.inputRight + 0.5,
      );
      expect(clearPresentation.documentScrollWidth).toBeLessThanOrEqual(
        clearPresentation.documentClientWidth,
      );

      await input.focus();
      await page.keyboard.press("Tab");
      await expect(clear).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/\/search$/);
      await expect(input).toHaveValue("");
      await expect(input).toBeFocused();
      await expect(clear).toHaveCount(0);
      await expect(
        page.getByText("Search all of free2z", { exact: true }),
      ).toBeVisible();

      await page.goBack();
      await expect(page).toHaveURL(/\/$/);
      await page.goForward();
      await expect(page).toHaveURL(/\/search$/);
      await expect(await expectSingleRouteSearch(page)).toHaveValue("");

      await page.goto("/search?tab=pages&q=direct%20query");
      const directInput = await expectSingleRouteSearch(page);
      await expect(directInput).toHaveValue("direct query");
      await page.getByRole("button", { name: "Clear search" }).click();
      await expect(page).toHaveURL(/\/search\?tab=pages$/);
      await expect(directInput).toHaveValue("");

      // Articles uses the same explicit-clear compound-input contract. A text
      // input with search keyboard hints cannot acquire Chromium/WebKit's
      // anonymous native cancel beside the accessible ZUULI action.
      await page.goto("/articles");
      const articleSearch = page.getByRole("searchbox", {
        name: "Search articles",
      });
      await articleSearch.fill("shielded publishing");
      await expect(articleSearch).toHaveAttribute("type", "text");
      await expect(articleSearch).toHaveAttribute("inputmode", "search");
      await expect(articleSearch).toHaveAttribute(
        "data-custom-search-clear",
        "true",
      );
      await expect(
        page.getByRole("button", { name: "Clear search" }),
      ).toHaveCount(1);
    },
  );
}
