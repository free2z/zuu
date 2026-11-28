import { expect, test } from "@playwright/test";

// Explicit inventory: keep diagnostics in the audited route matrix.
const ROUTES = ["/diagnostics"] as const;
for (const route of ROUTES) {
  for (const width of [320, 768, 1280]) {
    test(`${route} fits ${width}px with expanded text`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(route);
      await page.locator("[data-diagnostics-panel]").waitFor();
      await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
      const geometry = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
      expect(geometry.scroll).toBeLessThanOrEqual(geometry.width);
    });
  }
}
