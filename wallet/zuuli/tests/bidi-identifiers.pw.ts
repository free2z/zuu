import { expect, test, type Page } from "@playwright/test";

// Deliberately independent of the wallet fixture and truncateAddress(). A
// changed fixture or implementation must not rewrite this oracle for itself.
const FULL_ADDRESS =
  "u1l8xunezsvpntq2snz67h6md2eq09u09vv3xh6z8kqvxg7pdvz4qc9x2u84kqmpc0mz0kmvexz";
const SHORT_ADDRESS = "u1l8xune…0mz0kmvexz";

async function useLocale(page: Page, locale: string) {
  await page.evaluate((nextLocale: string) => {
    document.documentElement.lang = nextLocale;
  }, locale);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dir))
    .toBe(locale.startsWith("ar") ? "rtl" : "ltr");
}

test("wallet identifiers remain inspectable, copy whole, and isolate inside RTL", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.addInitScript(() => {
    localStorage.setItem("zuuli.knox.token", "mock-knox-token");
  });
  await page.goto("/wallet");

  const shortened = page.locator(`bdi[title="${FULL_ADDRESS}"]`).first();
  await expect(shortened).toHaveText(SHORT_ADDRESS);
  await expect(shortened).toHaveAttribute("dir", "ltr");
  expect(await shortened.evaluate((element) => element.tagName)).toBe("BDI");

  await useLocale(page, "ar-EG");
  await expect(page.locator("html")).toHaveAttribute("lang", "ar-EG");
  expect(
    await shortened.evaluate((element) => getComputedStyle(element).direction),
  ).toBe("ltr");

  const numeric = page.locator(".bidi-number:visible").first();
  await expect(numeric).toBeVisible();
  expect(
    await numeric.evaluate((element) => ({
      direction: getComputedStyle(element).direction,
      unicodeBidi: getComputedStyle(element).unicodeBidi,
    })),
  ).toEqual({ direction: "ltr", unicodeBidi: "isolate" });

  const origin = new URL(page.url()).origin;
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
    origin,
  });
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(FULL_ADDRESS);

  await page.goto("/wallet/receive");
  await useLocale(page, "ar-EG");
  const full = page.locator(`bdi[title="${FULL_ADDRESS}"]`);
  await expect(full).toHaveText(FULL_ADDRESS);
  await expect(full).toHaveAttribute("dir", "ltr");

  const geometry = await full.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      direction: getComputedStyle(element).direction,
      left: rect.left,
      right: rect.right,
      viewport: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    };
  });
  expect(geometry.direction).toBe("ltr");
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
  expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewport);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);

  await useLocale(page, "en-US");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
});

test("RTL mirrors desktop and mobile navigation, adornments, and dialogs", async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("zuuli.knox.token", "mock-knox-token");
  });
  await page.setViewportSize({ width: 1024, height: 720 });
  await page.goto("/");
  await useLocale(page, "ar-EG");

  const sidebar = page.locator(".app-sidebar");
  const sidebarGeometry = await sidebar.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      left: rect.left,
      right: rect.right,
      borderInlineEndWidth: style.borderInlineEndWidth,
      viewport: window.innerWidth,
    };
  });
  expect(sidebarGeometry.left).toBeGreaterThan(sidebarGeometry.viewport / 2);
  expect(sidebarGeometry.right).toBe(sidebarGeometry.viewport);
  expect(sidebarGeometry.borderInlineEndWidth).toBe("1px");

  // The TopBar search field was this file's RTL leading-icon subject; #904
  // phase 4 removed it with the route it entered. The 2Z chip is the
  // surviving TopBar control with a leading icon beside text, so it takes
  // over the same mirroring assertion.
  await expect(page.getByRole("search")).toHaveCount(0);

  await page.getByRole("link", { name: "Zcash wallet" }).click();
  const backIcon = page.getByRole("button", { name: "Go back" }).locator("svg");
  await expect(backIcon).toBeVisible();
  expect(
    await backIcon.evaluate((element) => getComputedStyle(element).transform),
  ).toMatch(/^matrix\(-1, 0, 0, 1,/);

  await page.setViewportSize({ width: 320, height: 568 });
  const home = page.locator('[data-navigation-id="home"]');
  const more = page.locator('[data-navigation-id="more"]');
  const [homeBox, moreBox] = await Promise.all([
    home.boundingBox(),
    more.boundingBox(),
  ]);
  expect(homeBox).not.toBeNull();
  expect(moreBox).not.toBeNull();
  expect(homeBox!.x).toBeGreaterThan(moreBox!.x);

  await more.click();
  const mobileDialog = page.locator("[data-mobile-more-dialog]");
  await expect(mobileDialog).toBeVisible();
  const dialogBox = await mobileDialog.boundingBox();
  expect(dialogBox).not.toBeNull();
  expect(Math.abs(dialogBox!.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(dialogBox!.width - 320)).toBeLessThanOrEqual(1);

  const close = mobileDialog.getByRole("button", { name: "Close" });
  const closeBox = await close.boundingBox();
  expect(closeBox).not.toBeNull();
  expect(closeBox!.x + closeBox!.width / 2).toBeLessThan(160);
});
