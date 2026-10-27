import { expect, test, type Locator, type Page } from "@playwright/test";

// The image picker is portalled at the end of the document. A `relative`
// utility at its call site used to win over the shared dialog's `fixed`
// utility in tailwind-merge, placing the picker in document flow near the end
// of a long editor instead of in the current viewport. These tests use the
// real /edit insert flow from a scrolled article so the regression cannot be
// hidden by a component harness that has no document scroll.

const VIEWPORTS = [
  { name: "desktop", size: { width: 1280, height: 900 } },
  { name: "mobile", size: { width: 390, height: 667 } },
] as const;

const TEST_CREATOR = {
  id: 4244,
  username: "image-dialog-user",
  full_name: "Image Dialog User",
};

const CLOUD_IMAGES = Array.from({ length: 20 }, (_, index) => ({
  id: index + 1,
  title: `Cloud image ${index + 1}`,
  name: `cloud-image-${index + 1}.png`,
  mime_type: "image/png",
  access: "public",
  url: "data:image/png;base64,iVBORw0KGgo=",
  thumbnail: "data:image/png;base64,iVBORw0KGgo=",
}));

async function installApiMocks(page: Page) {
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;

    // Vite serves source modules from paths such as /src/lib/api/config.ts.
    if (!pathname.startsWith("/api/")) {
      await route.continue();
      return;
    }

    if (pathname === "/api/auth/user/") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(TEST_CREATOR),
      });
      return;
    }

    if (pathname === "/api/myuploads/") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          count: CLOUD_IMAGES.length,
          next: null,
          results: CLOUD_IMAGES,
        }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ count: 0, next: null, results: [] }),
    });
  });
}

async function gotoEditor(page: Page) {
  await installApiMocks(page);
  await page.goto("/edit");

  const body = page.locator("textarea.writing-area-textarea");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await expect(body).toBeVisible({ timeout: 5_000 });
      return body;
    } catch {
      await page.reload();
    }
  }

  await expect(body).toBeVisible();
  return body;
}

async function openImageDialogAfterScrolling(
  page: Page,
  mode: "write" | "split" = "write",
) {
  const body = await gotoEditor(page);

  if (mode === "split") {
    await page
      .getByRole("button", { name: "Split", exact: true })
      .first()
      .click();
  }

  const longArticle = Array.from(
    { length: 80 },
    (_, index) =>
      `Paragraph ${index + 1}: enough content to scroll the editor.`,
  ).join("\n\n");

  await body.fill(longArticle);
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollHeight > window.innerHeight * 2,
      ),
    )
    .toBe(true);

  await page.evaluate(() =>
    window.scrollTo(0, document.documentElement.scrollHeight),
  );
  await expect
    .poll(() => page.evaluate(() => window.scrollY))
    .toBeGreaterThan(0);

  const trigger = page.getByTestId("editor-insert-trigger");
  await trigger.click();
  await page.locator("#editor-command-menu").getByText("Image").first().click();

  const dialog = page.locator('[data-slot="dialog-content"]');
  await expect(dialog).toBeVisible();

  return { body, dialog, trigger };
}

async function expectInsideViewport(dialog: Locator, page: Page) {
  const geometry = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);

    return {
      position: style.position,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      left: rect.left,
      centerX: rect.left + rect.width / 2,
      centerY: rect.top + rect.height / 2,
    };
  });
  const viewport = page.viewportSize()!;

  expect(geometry.position).toBe("fixed");
  expect(geometry.top).toBeGreaterThanOrEqual(15);
  expect(geometry.left).toBeGreaterThanOrEqual(15);
  expect(geometry.bottom).toBeLessThanOrEqual(viewport.height - 15);
  expect(geometry.right).toBeLessThanOrEqual(viewport.width - 15);
  expect(Math.abs(geometry.centerX - viewport.width / 2)).toBeLessThanOrEqual(
    1,
  );
  expect(Math.abs(geometry.centerY - viewport.height / 2)).toBeLessThanOrEqual(
    1,
  );
}

for (const viewport of VIEWPORTS) {
  test(`Add Image stays fixed and contained in the scrolled ${viewport.name} viewport`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport.size);
    // The production report came from desktop Split mode; mobile covers the
    // default Write mode. Preview has no composer or insert control by design.
    const mode = viewport.name === "desktop" ? "split" : "write";
    const { dialog } = await openImageDialogAfterScrolling(page, mode);

    await expectInsideViewport(dialog, page);
    await expect(
      dialog.getByRole("heading", { name: "Add Image" }),
    ).toBeVisible();
    await expect(dialog.getByRole("tab", { name: "Device" })).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Select Images" }),
    ).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Close" })).toBeVisible();

    await dialog.locator('input[type="file"]').setInputFiles({
      name: "viewport-proof.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    });
    const insert = dialog.getByRole("button", { name: "Insert Selected" });
    await expect(insert).toBeVisible();

    const insertBox = await insert.boundingBox();
    expect(insertBox).not.toBeNull();
    expect(insertBox!.y + insertBox!.height).toBeLessThanOrEqual(
      viewport.size.height,
    );

    const backgroundScrollY = await page.evaluate(() => window.scrollY);
    await dialog.getByRole("tab", { name: "Your Cloud" }).click();
    const results = dialog.locator("[data-media-results]");
    await expect(results).toBeVisible();
    await expect(
      dialog.getByText("Cloud image 20", { exact: true }),
    ).toHaveCount(1);
    const scrollState = await results.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      overflowY: getComputedStyle(element).overflowY,
    }));
    expect(scrollState.overflowY).toBe("auto");
    expect(scrollState.scrollHeight).toBeGreaterThan(scrollState.clientHeight);

    const lastCloudImage = dialog.getByRole("button", {
      name: /Cloud image 20/,
    });
    await lastCloudImage.scrollIntoViewIfNeeded();
    await expect(lastCloudImage).toBeVisible();
    expect(await page.evaluate(() => window.scrollY)).toBe(backgroundScrollY);
    await expectInsideViewport(dialog, page);
  });
}

test("Add Image traps focus, locks the page, and restores the invoking control", async ({
  page,
}) => {
  await page.setViewportSize(VIEWPORTS[0].size);
  const { body, dialog } = await openImageDialogAfterScrolling(page);
  const scrollY = await page.evaluate(() => window.scrollY);

  await expect(page.locator("body")).toHaveCSS("overflow", "hidden");
  await page.mouse.wheel(0, 1_000);
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);

  for (let index = 0; index < 12; index += 1) {
    await page.keyboard.press("Tab");
    expect(
      await dialog.evaluate((element) =>
        element.contains(document.activeElement),
      ),
    ).toBe(true);
  }

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  // The insert command deliberately parks focus in the writing area before
  // opening the picker; the command menu item itself is transient and is gone
  // by the time the dialog closes.
  await expect(body).toBeFocused();
  await expect(page.locator("body")).not.toHaveCSS("overflow", "hidden");
});
