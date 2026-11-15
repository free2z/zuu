import { expect, test } from "@playwright/test";

test("theme, controls, and effect utilities render with the wallet design", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/about");
  const card = page.locator("[data-about-build-card]");
  await expect(card).toBeVisible();
  const styles = await card.evaluate((el) => {
    const s = getComputedStyle(el);
    return { background: s.backgroundColor, shadow: s.boxShadow, radius: s.borderRadius };
  });
  expect(styles.background).toBe("rgb(26, 26, 26)");
  expect(styles.shadow).toContain("0px 1px 2px");
  expect(styles.radius).not.toBe("0px");
  const button = page.getByRole("button", { name: "Copy build info" });
  await expect(button).toHaveCSS("cursor", "pointer");
  expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await button.focus();
  await page.emulateMedia({ forcedColors: "active" });
  await expect(button).toHaveCSS("outline-style", "solid");
  await page.emulateMedia({ forcedColors: "none" });
  await page.evaluate(() => {
    const sample = document.createElement("div");
    sample.id = "tailwind-style-probe";
    sample.innerHTML = '<div class="backdrop-blur-xs animate-slide-up min-tap"></div>';
    document.body.append(sample);
  });
  const probe = page.locator("#tailwind-style-probe > div");
  await expect(probe).toHaveCSS("backdrop-filter", /blur\(4px\)/);
  await expect(probe).toHaveCSS("animation-name", "slide-up");
  await expect(probe).toHaveCSS("min-width", "44px");
});
