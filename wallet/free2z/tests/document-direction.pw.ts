/**
 * #940: proof that free2z's RTL support is live rather than compiled-and-dead.
 *
 * Before this change nothing in the app ever wrote `<html dir>`: `index.html`
 * pinned `dir="ltr"` and no module touched it, so the twenty-four `rtl:`
 * variants in this tree shipped as CSS that no locale could ever select —
 * exactly the defect #934 found in e2e2z. `rtl-source-policy.mjs` now asserts
 * that `installDocumentDirection()` runs before the root renders, but that is a
 * source contract; this file asserts the runtime consequence in a real browser:
 * a locale change reaches `<html dir>`, and the compiled `rtl:` rule then
 * actually matches a rendered element.
 */
import { expect, test } from "@playwright/test";

test("a locale change reaches <html dir> and the rtl: variants really apply", async ({
  page,
}) => {
  await page.goto("/login");

  const guest = page.getByRole("link", { name: "Continue as guest" });
  await expect(guest).toBeVisible();
  const arrow = guest.locator("svg").last();

  // The bootstrap baseline: English resolves to LTR and the icon is unmirrored.
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(arrow).toHaveCSS("scale", "none");
  const baseline = await arrow.evaluate((element) => element.getScreenCTM()!.a);
  expect(baseline).toBeGreaterThan(0);

  // The i18n kernel owns `<html lang>` and writes it exactly this way; the
  // observer installed in main.tsx is the only thing that derives `dir` from it.
  await page.evaluate(() => {
    document.documentElement.lang = "ar";
  });

  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(arrow).toHaveCSS("scale", "-1 1");
  await expect.poll(() => arrow.evaluate((element) => element.getScreenCTM()!.a)).toBeCloseTo(-baseline);

  // And back, so the observer is proven to track the locale rather than to have
  // flipped once.
  await page.evaluate(() => {
    document.documentElement.lang = "en";
  });

  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(arrow).toHaveCSS("scale", "none");
  await expect.poll(() => arrow.evaluate((element) => element.getScreenCTM()!.a)).toBeCloseTo(baseline);
});
