import { expect, test, type Page } from "@playwright/test";
import { decodePng } from "./png-pixels.mjs";

test.describe.configure({ timeout: 90_000 });

const ARTICLE = "/lightbox-user/markdown-image-lightbox-fixture";
const IMAGE_PATHS = {
  landscape: "/lightbox/landscape.svg",
  portrait: "/lightbox/portrait.svg",
  panorama: "/lightbox/panorama.svg",
  longCaption: "/lightbox/long-caption.svg",
  linked: "/lightbox/linked.svg",
  uploaded: "/uploadz/lightbox-upload.svg",
  broken: "/lightbox/broken.svg",
} as const;

const SVG_DIMENSIONS: Record<string, [number, number]> = {
  "/lightbox/landscape.svg": [1200, 800],
  "/lightbox/portrait.svg": [300, 1000],
  "/lightbox/panorama.svg": [3000, 400],
  "/lightbox/long-caption.svg": [900, 600],
  "/lightbox/linked.svg": [900, 600],
  "/uploadz/lightbox-upload.svg": [900, 600],
};

async function installImageFixtures(page: Page, requestedImages: string[]) {
  await page.route(
    /\/(?:lightbox\/.*|uploadz\/lightbox-upload)\.svg$/,
    async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === IMAGE_PATHS.broken) {
        await route.fulfill({ status: 404, body: "not found" });
        return;
      }

      const dimensions = SVG_DIMENSIONS[pathname];
      if (!dimensions) {
        await route.continue();
        return;
      }

      const [width, height] = dimensions;
      requestedImages.push(pathname);
      const artwork =
        pathname === IMAGE_PATHS.landscape
          ? `<rect width="${width}" height="${height}" fill="#dc2626"/><rect x="300" y="240" width="600" height="320" fill="#ffffff"/>`
          : `<rect width="${width}" height="${height}" fill="#d97706"/><circle cx="${width / 2}" cy="${height / 2}" r="${Math.min(width, height) / 4}" fill="#fef3c7"/>`;
      await route.fulfill({
        contentType: "image/svg+xml",
        body: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${artwork}</svg>`,
      });
    },
  );
}

async function openFixture(
  page: Page,
  viewport: { width: number; height: number },
) {
  await page.setViewportSize(viewport);
  const requestedImages: string[] = [];
  const allImageRequests: string[] = [];
  page.on("request", (request) => {
    if (!/^https?:$/.test(new URL(request.url()).protocol)) return;
    if (request.resourceType() === "image") {
      allImageRequests.push(new URL(request.url()).pathname);
    }
  });
  await installImageFixtures(page, requestedImages);
  await page.goto(ARTICLE);

  const content = page.locator(".markdown-content").first();
  await expect(content.locator(".markdown-image-trigger")).toHaveCount(6, {
    timeout: 60_000,
  });
  await expect(
    content.locator(".markdown-image-trigger img.markdown-embed-image"),
  ).toHaveCount(1);
  await expect(content.locator(".markdown-qrcode img")).toHaveCount(1);
  await expect(
    content.locator(".markdown-qrcode .markdown-image-trigger"),
  ).toHaveCount(0);
  await expect(content.locator("a img")).toHaveCount(1);
  await expect(content.locator("img[alt='broken lightbox image']")).toHaveCount(
    1,
  );
  await expect(
    page.getByRole("heading", { name: "External content blocked" }),
  ).toBeVisible();

  return { content, requestedImages, allImageRequests };
}

async function assertSharpImagePaint(page: Page) {
  const sharp = page.locator(
    '[data-testid="markdown-image-lightbox"] .markdown-image-lightbox__image',
  );
  const png = decodePng(await sharp.screenshot());
  let largestAdjacentChannelStep = 0;

  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const offset = (y * png.width + x) * png.channels;
      if (x + 1 < png.width) {
        const right = offset + png.channels;
        largestAdjacentChannelStep = Math.max(
          largestAdjacentChannelStep,
          ...Array.from({ length: 3 }, (_, channel) =>
            Math.abs(png.data[offset + channel] - png.data[right + channel]),
          ),
        );
      }
      if (y + 1 < png.height) {
        const below = offset + png.width * png.channels;
        largestAdjacentChannelStep = Math.max(
          largestAdjacentChannelStep,
          ...Array.from({ length: 3 }, (_, channel) =>
            Math.abs(png.data[offset + channel] - png.data[below + channel]),
          ),
        );
      }
    }
  }

  expect(
    largestAdjacentChannelStep,
    "the screenshot must contain a crisp edge from the sharp image, not only the blurred pad",
  ).toBeGreaterThan(100);
}

async function assertDialogGeometry(page: Page, imagePath: string) {
  const dialog = page.getByTestId("markdown-image-lightbox");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("role", "dialog");

  const geometry = await page.evaluate(() => {
    const image = document.querySelector<HTMLElement>(
      '[data-testid="markdown-image-lightbox"] .markdown-image-lightbox__image',
    );
    const dialog = document.querySelector<HTMLElement>(
      '[data-testid="markdown-image-lightbox"]',
    );
    if (!image || !dialog) throw new Error("Lightbox geometry is missing");
    const imageRect = image.getBoundingClientRect();
    const dialogRect = dialog.getBoundingClientRect();
    const style = getComputedStyle(image);
    return {
      image: {
        left: imageRect.left,
        top: imageRect.top,
        right: imageRect.right,
        bottom: imageRect.bottom,
        width: imageRect.width,
        height: imageRect.height,
      },
      dialog: {
        left: dialogRect.left,
        top: dialogRect.top,
        right: dialogRect.right,
        bottom: dialogRect.bottom,
      },
      viewport: { width: innerWidth, height: innerHeight },
      objectFit: style.objectFit,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      bodyOverflow: document.body.style.overflow,
    };
  });

  expect(geometry.objectFit).toBe("contain");
  expect(geometry.image.width).toBeGreaterThan(0);
  expect(geometry.image.height).toBeGreaterThan(0);
  expect(geometry.image.left, JSON.stringify(geometry)).toBeGreaterThanOrEqual(
    -1,
  );
  expect(geometry.image.top, JSON.stringify(geometry)).toBeGreaterThanOrEqual(
    -1,
  );
  expect(geometry.image.right, JSON.stringify(geometry)).toBeLessThanOrEqual(
    geometry.viewport.width + 1,
  );
  expect(geometry.image.bottom, JSON.stringify(geometry)).toBeLessThanOrEqual(
    geometry.viewport.height + 1,
  );
  expect(geometry.dialog.left).toBe(0);
  expect(geometry.dialog.top).toBe(0);
  expect(geometry.dialog.right).toBe(geometry.viewport.width);
  expect(geometry.dialog.bottom).toBe(geometry.viewport.height);
  expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewport.width);
  expect(geometry.bodyWidth).toBeLessThanOrEqual(geometry.viewport.width);
  expect(geometry.bodyOverflow).toBe("hidden");

  const urls = await page.evaluate(() => {
    const sharp = document.querySelector<HTMLImageElement>(
      '[data-testid="markdown-image-lightbox"] .markdown-image-lightbox__image',
    );
    const pad = document.querySelector<HTMLImageElement>(
      '[data-testid="markdown-image-lightbox"] .markdown-image-lightbox__pad-inner img',
    );
    const padInner = document.querySelector<HTMLElement>(
      '[data-testid="markdown-image-lightbox"] .markdown-image-lightbox__pad-inner',
    );
    return {
      sharp: sharp?.src,
      pad: pad?.src,
      padFilter: padInner ? getComputedStyle(padInner).filter : "",
      padWillChange: padInner ? getComputedStyle(padInner).willChange : "",
    };
  });
  const expectedUrl = new URL(imagePath, page.url()).href;
  expect(urls.sharp).toBe(expectedUrl);
  expect(urls.pad).toBe(expectedUrl);
  expect(urls.padFilter).toContain("blur");
  expect(urls.padWillChange).toBe("auto");

  if (imagePath === IMAGE_PATHS.landscape) {
    await assertSharpImagePaint(page);
  }

  const caption = page.locator(
    '[data-testid="markdown-image-lightbox"] .markdown-image-lightbox__caption',
  );
  if (await caption.count()) {
    const captionGeometry = await page.evaluate(() => {
      const image = document.querySelector<HTMLElement>(
        '[data-testid="markdown-image-lightbox"] .markdown-image-lightbox__image',
      );
      const caption = document.querySelector<HTMLElement>(
        '[data-testid="markdown-image-lightbox"] .markdown-image-lightbox__caption',
      );
      if (!image || !caption) throw new Error("Caption geometry is missing");
      const imageRect = image.getBoundingClientRect();
      const captionRect = caption.getBoundingClientRect();
      return {
        imageBottom: imageRect.bottom,
        captionTop: captionRect.top,
        captionBottom: captionRect.bottom,
        viewportHeight: innerHeight,
        captionHeight: captionRect.height,
      };
    });
    expect(captionGeometry.captionTop).toBeGreaterThanOrEqual(
      captionGeometry.imageBottom - 1,
    );
    expect(captionGeometry.captionBottom).toBeLessThanOrEqual(
      captionGeometry.viewportHeight + 1,
    );
    expect(captionGeometry.captionHeight).toBeLessThanOrEqual(80);
  }
}

async function closeAndAssertRestored(
  page: Page,
  trigger: ReturnType<Page["locator"]>,
) {
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("markdown-image-lightbox")).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => document.body.style.overflow))
    .toBe("");
}

test("desktop opens ordinary and uploaded Markdown images with whole-image geometry", async ({
  page,
}) => {
  const { content, requestedImages, allImageRequests } = await openFixture(
    page,
    {
      width: 1280,
      height: 900,
    },
  );

  const landscape = content.getByRole("button", {
    name: "landscape lightbox image",
  });
  await landscape.focus();
  await page.keyboard.press("Space");
  await assertDialogGeometry(page, IMAGE_PATHS.landscape);
  const closeButton = page.getByRole("button", { name: "Close", exact: true });
  await expect(closeButton).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(closeButton).toBeFocused();
  await closeButton.click();
  await expect(page.getByTestId("markdown-image-lightbox")).toHaveCount(0);
  await expect(landscape).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => document.body.style.overflow))
    .toBe("");

  const portrait = content.getByRole("button", {
    name: "portrait lightbox image",
  });
  await portrait.click();
  await assertDialogGeometry(page, IMAGE_PATHS.portrait);
  await closeAndAssertRestored(page, portrait);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await landscape.click();
  await assertDialogGeometry(page, IMAGE_PATHS.landscape);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const dialog = document.querySelector<HTMLElement>(
          '[data-testid="markdown-image-lightbox"]',
        );
        return dialog ? getComputedStyle(dialog).animationName : "missing";
      }),
    )
    .toBe("none");
  await closeAndAssertRestored(page, landscape);

  const uploaded = content.getByRole("button", { name: "Expanded image" });
  await uploaded.click();
  await assertDialogGeometry(page, IMAGE_PATHS.uploaded);
  await closeAndAssertRestored(page, uploaded);

  expect(new Set(requestedImages)).toEqual(
    new Set([
      IMAGE_PATHS.landscape,
      IMAGE_PATHS.portrait,
      IMAGE_PATHS.panorama,
      IMAGE_PATHS.longCaption,
      IMAGE_PATHS.uploaded,
      IMAGE_PATHS.linked,
    ]),
  );
  const allowedImagePaths = new Set([
    ...Object.keys(SVG_DIMENSIONS),
    IMAGE_PATHS.broken,
  ]);
  expect(
    [...new Set(allImageRequests)].filter(
      (pathname) => !allowedImagePaths.has(pathname),
    ),
  ).toEqual([]);
  expect(allImageRequests).not.toContain("/lightbox/landscape-thumbnail.svg");
});

test("mobile keeps a tall image and extreme panorama inside the safe viewport", async ({
  page,
}) => {
  const { content } = await openFixture(page, { width: 390, height: 844 });

  const panorama = content.getByRole("button", {
    name: "panorama lightbox image",
  });
  await panorama.click();
  await assertDialogGeometry(page, IMAGE_PATHS.panorama);
  await closeAndAssertRestored(page, panorama);

  const portrait = content.getByRole("button", {
    name: "portrait lightbox image",
  });
  await portrait.click();
  await assertDialogGeometry(page, IMAGE_PATHS.portrait);
  await closeAndAssertRestored(page, portrait);

  const longCaption = content.getByRole("button", {
    name: "Long caption ".repeat(150).trim(),
  });
  await longCaption.click();
  await assertDialogGeometry(page, IMAGE_PATHS.longCaption);
  await expect(page.getByRole("dialog")).toHaveAccessibleName(
    "Long caption ".repeat(150).trim(),
  );
  const caption = page.locator(".markdown-image-lightbox__caption");
  await expect(caption).toHaveCSS("cursor", "zoom-out");
  await caption.click();
  await expect(page.getByTestId("markdown-image-lightbox")).toHaveCount(0);
  await expect(longCaption).toBeFocused();
  await longCaption.click();
  await expect(page.getByTestId("markdown-image-lightbox")).toBeVisible();
  await closeAndAssertRestored(page, longCaption);
});

test("linked, QR, consent, and broken images keep their existing boundaries", async ({
  page,
}) => {
  const { content } = await openFixture(page, { width: 1280, height: 900 });

  const linked = content.locator("a img[alt='linked lightbox image']");
  await linked.click();
  await expect(page.getByTestId("markdown-image-lightbox")).toHaveCount(0);
  await expect(page.getByTestId("outbound-link-warning")).toBeVisible();
  await page.getByTestId("outbound-link-cancel").click();
  await expect(
    linked.locator(".."),
    "the authored link keeps focus",
  ).toBeFocused();

  const broken = content.locator("img[alt='broken lightbox image']");
  await broken.click();
  await expect(page.getByTestId("markdown-image-lightbox")).toHaveCount(0);

  const landscapeTrigger = content.getByRole("button", {
    name: "landscape lightbox image",
  });
  await landscapeTrigger.click();
  await expect(page.getByTestId("markdown-image-lightbox")).toBeVisible();
  const stage = page.locator(".markdown-image-lightbox__stage");
  await expect(page.locator(".markdown-image-lightbox__pad")).toHaveCSS(
    "cursor",
    "zoom-out",
  );
  await expect(stage).toHaveCSS("cursor", "zoom-out");
  await expect(page.locator(".markdown-image-lightbox__image")).toHaveCSS(
    "cursor",
    "default",
  );
  await stage.click({
    position: { x: 2, y: 2 },
  });
  await expect(page.getByTestId("markdown-image-lightbox")).toHaveCount(0);

  const qr = content.locator(".markdown-qrcode img");
  await qr.click();
  await expect(page.getByTestId("markdown-image-lightbox")).toHaveCount(0);
});

test("SSR keeps normal images, and lifecycle transitions remove the lightbox", async ({
  browser,
  page,
}) => {
  const noScriptContext = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 390, height: 844 },
  });
  const noScriptPage = await noScriptContext.newPage();
  await noScriptPage.goto(ARTICLE);
  await expect(noScriptPage.locator(".markdown-content img")).toHaveCount(7);
  await expect(noScriptPage.locator(".markdown-image-trigger")).toHaveCount(0);
  await expect(
    noScriptPage.getByText("Lightbox tail sentinel.", { exact: true }),
  ).toBeVisible();
  await noScriptContext.close();

  await page.addInitScript(() => {
    const descriptor = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "innerHTML",
    );
    if (!descriptor?.get || !descriptor.set) return;
    let writes = 0;
    Object.defineProperty(Element.prototype, "innerHTML", {
      configurable: descriptor.configurable,
      enumerable: descriptor.enumerable,
      get: descriptor.get,
      set(value) {
        if (
          this instanceof HTMLElement &&
          this.classList.contains("markdown-content")
        ) {
          writes += 1;
        }
        descriptor.set!.call(this, value);
      },
    });
    (
      window as Window & { markdownContentInnerHTMLWrites?: () => number }
    ).markdownContentInnerHTMLWrites = () => writes;
  });

  const { content } = await openFixture(page, { width: 390, height: 844 });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & {
              markdownContentInnerHTMLWrites?: () => number;
            }
          ).markdownContentInnerHTMLWrites?.() ?? -1,
      ),
    )
    .toBe(0);

  const landscape = content.getByRole("button", {
    name: "landscape lightbox image",
  });
  await landscape.click();
  await expect(page.getByTestId("markdown-image-lightbox")).toBeVisible();

  await page.locator("html").evaluate((node) => node.classList.add("dark"));
  await expect(page.getByTestId("markdown-image-lightbox")).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => document.body.style.overflow))
    .toBe("");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window & {
              markdownContentInnerHTMLWrites?: () => number;
            }
          ).markdownContentInnerHTMLWrites?.() ?? 0,
      ),
    )
    .toBeGreaterThan(0);
  await page.locator("html").evaluate((node) => node.classList.remove("dark"));

  await expect(content.locator(".markdown-image-trigger")).toHaveCount(6);
  await landscape.click();
  await expect(page.getByTestId("markdown-image-lightbox")).toBeVisible();
  await page.evaluate(() => {
    const backButton = [...document.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Back to Homepage"),
    );
    if (!backButton) throw new Error("article back button is missing");
    backButton.click();
  });
  await page.waitForURL(/\/$/);
  await expect(page.getByTestId("markdown-image-lightbox")).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => document.body.style.overflow))
    .toBe("");
  await expect(page.locator(".markdown-image-lightbox__close")).toHaveCount(0);
});
