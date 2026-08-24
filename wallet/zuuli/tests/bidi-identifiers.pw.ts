import { expect, test } from "@playwright/test";

// Deliberately independent of the wallet fixture and truncateAddress(). A
// changed fixture or implementation must not rewrite this oracle for itself.
const FULL_ADDRESS =
  "u1l8xunezsvpntq2snz67h6md2eq09u09vv3xh6z8kqvxg7pdvz4qc9x2u84kqmpc0mz0kmvexz";
const SHORT_ADDRESS = "u1l8xune…0mz0kmvexz";

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

  await page.evaluate(() => {
    document.documentElement.dir = "rtl";
  });
  expect(
    await shortened.evaluate((element) => getComputedStyle(element).direction),
  ).toBe("ltr");

  const origin = new URL(page.url()).origin;
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
    origin,
  });
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(FULL_ADDRESS);

  await page.goto("/wallet/receive");
  await page.evaluate(() => {
    document.documentElement.dir = "rtl";
  });
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
});
