import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 760 });
  await page.goto("/about");
  await page.locator("[data-about-page]").waitFor();
});

test("About is keyboard and screen-reader usable at 320px", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "About & Feedback" })).toBeVisible();
  const card = page.locator("[data-about-build-card]");
  await expect(card.getByText("0.1.0", { exact: true })).toBeVisible();
  await expect(card.getByText("17", { exact: true })).toBeVisible();
  await expect(card.getByText("Internal", { exact: true })).toBeVisible();
  await expect(card.getByText("Web", { exact: true })).toBeVisible();

  const copy = page.getByRole("button", { name: "Copy build info" });
  await copy.focus();
  await expect(copy).toBeFocused();
  const copyBox = await copy.boundingBox();
  expect(copyBox?.height).toBeGreaterThanOrEqual(44);

  await page.keyboard.press("Tab");
  const provenance = page.getByText("Build provenance", { exact: true });
  await expect(provenance).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Full source commit", { exact: true })).toBeVisible();

  const geometry = await page.locator("[data-app-frame]").evaluate((frame) => ({
    clientWidth: frame.clientWidth,
    scrollWidth: frame.scrollWidth,
  }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
});

test("copy uses the complete stable minimal block and announces completion", async ({
  page,
}) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(page.url()).origin,
  });
  await page.getByRole("button", { name: "Copy build info" }).click();
  await expect(page.getByRole("status")).toHaveText("Build info copied.");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toMatch(
    /^ZUULI\nVersion: 0\.1\.0\nBuild: 17\nChannel: Internal\nPlatform: Web\nSource commit: [0-9a-f]{12}$/,
  );
  expect(copied).not.toMatch(/wallet|balance|device|address|\/Users\//i);
});

test("enlarged and long localized copy wraps without horizontal clipping", async ({
  page,
}) => {
  await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
  await page.locator("[data-about-build-card]").evaluate((card) => {
    for (const element of card.querySelectorAll<HTMLElement>("dt, summary, button")) {
      element.textContent =
        "Ausführlich lokalisierte Build-Information für internationale Benutzeroberflächen";
    }
  });
  const geometry = await page.locator("[data-about-page]").evaluate((frame) => {
    const overflowing = [...frame.querySelectorAll<HTMLElement>("*")]
      .filter((element) => element.scrollWidth > element.clientWidth + 1)
      .map((element) => element.tagName);
    return {
      clientWidth: frame.clientWidth,
      scrollWidth: frame.scrollWidth,
      overflowing,
    };
  });
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
  expect(geometry.overflowing).toEqual([]);
});
