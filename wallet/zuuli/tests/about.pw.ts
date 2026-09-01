import { expect, test } from "@playwright/test";
import { PSEUDO_ABOUT_MESSAGES } from "../src/lib/about-copy";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 760 });
  await page.goto("/about");
  await page.locator("[data-about-page]").waitFor();
});

test("About is keyboard and screen-reader usable at 320px", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "About & Feedback" })).toBeVisible();
  const card = page.locator("[data-about-build-card]");
  await expect(card.getByText("0.1.0", { exact: true })).toBeVisible();
  await expect(card.getByText("19", { exact: true })).toBeVisible();
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
  // Middle, tail-weighted truncation (see #829) — reuses truncateAddress's
  // default 8-head/10-tail split rather than a head-only prefix.
  expect(copied).toMatch(
    /^ZUULI\nVersion: 0\.1\.0\nBuild: 19\nRelease channel: Internal\nPlatform: Web\nSource commit: [0-9a-f]{8}…[0-9a-f]{10}$/,
  );
  expect(copied).not.toMatch(/wallet|balance|device|address|\/Users\//i);
});

test.describe("pseudo-expanded shipping locale", () => {
  test.use({ locale: "en-XA" });

  test("flows through navigation, page, formatter, and live status at 200%", async ({
    page,
  }) => {
    await page.addStyleTag({ content: "html { font-size: 200% !important; }" });
    await expect(
      page.getByRole("heading", { name: PSEUDO_ABOUT_MESSAGES.pageTitle }),
    ).toBeVisible();
    await expect(page.getByText(PSEUDO_ABOUT_MESSAGES.pageDescription)).toBeVisible();
    await expect(
      page.getByRole("heading", { name: PSEUDO_ABOUT_MESSAGES.buildHeading }),
    ).toBeVisible();

    const copy = page.getByRole("button", {
      name: PSEUDO_ABOUT_MESSAGES.copyAction,
    });
    await expect(copy).toBeVisible();
    expect((await copy.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await copy.focus();
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: new URL(page.url()).origin,
    });
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status")).toHaveText(
      PSEUDO_ABOUT_MESSAGES.copySuccess,
    );
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
      PSEUDO_ABOUT_MESSAGES.versionLabel,
    );

    // The app-shell navigation is driven by the i18n kernel (#797), which
    // only ships en/fr/es catalogs — it has no en-XA pseudo-locale entry, so
    // it falls back to the plain en-US navigation copy even while the About
    // page's own (still en-XA-aware) message block above is expanded.
    await page.locator('[data-navigation-id="more"]').click();
    await expect(
      page.getByRole("link", {
        name: "About and feedback",
      }),
    ).toBeVisible();

    const geometry = await page.evaluate(() => {
      const roots = [
        document.querySelector<HTMLElement>("[data-about-page]"),
        document.querySelector<HTMLElement>('[data-navigation-id="about"]'),
      ].filter((element): element is HTMLElement => element !== null);
      const surfaces = roots.flatMap((root) => [
        root,
        ...root.querySelectorAll<HTMLElement>("*"),
      ]);
      const overflowing = surfaces
        .filter((element) => element.scrollWidth > element.clientWidth + 1)
        .map((element) => ({
          tag: element.tagName,
          text: element.textContent?.trim().slice(0, 80),
        }));
      const frame = document.querySelector<HTMLElement>("[data-app-frame]");
      if (!frame) throw new Error("app frame unavailable");
      return {
        clientWidth: frame.clientWidth,
        scrollWidth: frame.scrollWidth,
        overflowing,
      };
    });
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
    expect(geometry.overflowing).toEqual([]);
  });
});
