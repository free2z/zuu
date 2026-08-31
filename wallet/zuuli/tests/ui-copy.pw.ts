import { expect, test, type Page } from "@playwright/test";

const WIDTHS = [320, 360] as const;
const REMOVED_EXPLAINERS =
  /semantic search|ranked by meaning|search(?:ing)?[^.]*by meaning|backed by free2z zpages/i;

test.use({ locale: "de-DE" });

async function expandText(page: Page) {
  await page.addStyleTag({
    content:
      "main h1, main input[role='searchbox'] { font-size: 200% !important; line-height: 1.25 !important; }",
  });
}

async function expectCopyFits(page: Page, searchName: string) {
  const audit = await page.evaluate((accessibleName) => {
    const frame = document.querySelector<HTMLElement>(
      "main.app-scroll-content, main[data-route-frame]",
    );
    if (!frame) throw new Error("route frame is missing");
    const failures = [];
    const viewportWidth = document.documentElement.clientWidth;
    const heading = frame.querySelector<HTMLElement>("h1");
    const search = frame.querySelector<HTMLInputElement>(
      `input[aria-label="${accessibleName}"]`,
    );

    for (const element of [heading]) {
      if (!element) {
        failures.push("heading is missing");
        continue;
      }
      const rect = element.getBoundingClientRect();
      if (rect.left < -1 || rect.right > viewportWidth + 1) {
        failures.push(`${element.tagName} leaves the viewport`);
      }
      if (element.scrollWidth > element.clientWidth + 1) {
        failures.push(`${element.tagName} clips horizontally`);
      }
      if (element.scrollHeight > element.clientHeight + 1) {
        failures.push(`${element.tagName} clips vertically`);
      }
    }

    if (!search) {
      failures.push("search input is missing");
    } else {
      const style = getComputedStyle(search);
      const context = document.createElement("canvas").getContext("2d");
      if (!context) throw new Error("canvas text measurement is unavailable");
      context.font = style.font;
      const placeholderWidth = context.measureText(search.placeholder).width;
      const availableWidth =
        search.clientWidth -
        Number.parseFloat(style.paddingLeft) -
        Number.parseFloat(style.paddingRight);
      if (placeholderWidth > availableWidth + 1) {
        failures.push("search placeholder does not fit");
      }
      const rect = search.getBoundingClientRect();
      if (rect.left < -1 || rect.right > viewportWidth + 1) {
        failures.push("search input leaves the viewport");
      }
    }

    return {
      failures,
      frameClientWidth: frame.clientWidth,
      frameScrollWidth: frame.scrollWidth,
      pageClientWidth: document.documentElement.clientWidth,
      pageScrollWidth: document.documentElement.scrollWidth,
    };
  }, searchName);

  expect(audit.pageScrollWidth).toBeLessThanOrEqual(audit.pageClientWidth + 1);
  expect(audit.frameScrollWidth).toBeLessThanOrEqual(audit.frameClientWidth + 1);
  expect(audit.failures).toEqual([]);
}

for (const width of WIDTHS) {
  test(`Search copy stays quiet and readable at ${width}px with expanded text`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 760 });
    await page.goto("/search");
    await expect(page.getByRole("heading", { name: "Search" })).toBeVisible();
    await expect(
      page.getByRole("combobox", {
        name: "Search creators, pages, and topics",
      }),
    ).toBeVisible();
    await expect(page.getByText(REMOVED_EXPLAINERS)).toHaveCount(0);
    await expect(page.locator("h1").locator("xpath=..").locator("p")).toHaveCount(0);

    await expandText(page);
    await expectCopyFits(page, "Search creators, pages, and topics");

    await page.goto("/articles");
    const articleSearch = page.getByRole("searchbox", {
      name: "Search articles",
    });
    await expect(articleSearch).toHaveAttribute("placeholder", "Search");
    await expect(page.getByText(REMOVED_EXPLAINERS)).toHaveCount(0);
    await expect(articleSearch.locator("xpath=../following-sibling::p")).toHaveCount(0);

    await expandText(page);
    await expectCopyFits(page, "Search articles");
  });
}

test("changed Search copy resolves through the accepted locale catalog", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 760 });
  await page.addInitScript(() => {
    window.localStorage.setItem("free2z-locale", "es");
  });
  await page.goto("/search");

  await expect(page.getByRole("heading", { name: "Buscar" })).toBeVisible();
  const search = page.getByRole("combobox", {
    name: "Buscar creadores, páginas y temas",
  });
  await expect(search).toHaveAttribute("placeholder", "Buscar");
  await expect(page.getByText("Buscar en todo free2z")).toBeVisible();
  await expect(page.getByText(REMOVED_EXPLAINERS)).toHaveCount(0);

  await page.goto("/articles");
  await expect(
    page.getByRole("searchbox", { name: "Buscar artículos" }),
  ).toHaveAttribute("placeholder", "Buscar");
});
