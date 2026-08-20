import { expect, test, type Page } from "@playwright/test";

const ARTICLE = "/articles/remote-media-consent-audit";
const OBSERVED_HOSTS = new Set([
  "cover.media.test",
  "redirect-target.media.test",
  "inline.media.test",
  "protocol.media.test",
  "encoded.media.test",
  "video.media.test",
  "audio.media.test",
  "www.youtube-nocookie.com",
  "player.vimeo.com",
  "comment.media.test",
  "comment-video.media.test",
]);

interface ObservedRequest {
  url: string;
  hostname: string;
  referer?: string;
}

async function observeRemoteMedia(page: Page): Promise<ObservedRequest[]> {
  const observed: ObservedRequest[] = [];
  page.on("request", (request) => {
    const target = new URL(request.url());
    if (!OBSERVED_HOSTS.has(target.hostname)) return;
    observed.push({
      url: target.href,
      hostname: target.hostname,
      referer: request.headers().referer,
    });
  });
  await page.route("**/*", async (route) => {
    const request = route.request();
    const target = new URL(request.url());
    if (!OBSERVED_HOSTS.has(target.hostname)) {
      await route.continue();
      return;
    }

    if (
      target.hostname === "cover.media.test" &&
      target.pathname === "/redirect"
    ) {
      await route.fulfill({
        status: 302,
        headers: {
          location: "https://redirect-target.media.test/final.svg",
          "cache-control": "no-store",
        },
      });
      return;
    }

    if (
      target.hostname === "www.youtube-nocookie.com" ||
      target.hostname === "player.vimeo.com"
    ) {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><title>consented provider fixture</title>",
      });
      return;
    }

    const isAudio = target.pathname.endsWith(".ogg");
    const isVideo = target.pathname.endsWith(".webm");
    await route.fulfill({
      status: 200,
      contentType: isAudio
        ? "audio/ogg"
        : isVideo
          ? "video/webm"
          : "image/svg+xml",
      body:
        isAudio || isVideo
          ? ""
          : '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="18"/>',
    });
  });
  return observed;
}

function requestsTo(observed: ObservedRequest[], hostname: string) {
  return observed.filter((request) => request.hostname === hostname);
}

const MEDIA_CASES = [
  {
    name: "cover redirect",
    buttonName: "Load image from cover.media.test",
    hostname: "cover.media.test",
    expectedUrls: [
      "https://cover.media.test/redirect",
      "https://redirect-target.media.test/final.svg",
    ],
    element: "img",
  },
  {
    name: "inline image",
    buttonName: "Load image from inline.media.test",
    hostname: "inline.media.test",
    expectedUrls: ["https://inline.media.test/pixel.png"],
    element: "img",
  },
  {
    name: "protocol-relative image",
    buttonName: "Load image from protocol.media.test",
    hostname: "protocol.media.test",
    expectedUrls: ["https://protocol.media.test/pixel.png"],
    element: "img",
  },
  {
    name: "encoded image",
    buttonName: "Load image from encoded.media.test",
    hostname: "encoded.media.test",
    expectedUrls: ["https://encoded.media.test/%70ixel.png"],
    element: "img",
  },
  {
    name: "YouTube embed",
    buttonName: "Load video from www.youtube-nocookie.com",
    hostname: "www.youtube-nocookie.com",
    expectedUrls: ["https://www.youtube-nocookie.com/embed/PrivacyAudit01"],
    element: "iframe",
  },
  {
    name: "Vimeo embed",
    buttonName: "Load video from player.vimeo.com",
    hostname: "player.vimeo.com",
    expectedUrls: ["https://player.vimeo.com/video/123456789"],
    element: "iframe",
  },
  {
    name: "direct video",
    buttonName: "Load video from video.media.test",
    hostname: "video.media.test",
    expectedUrls: ["https://video.media.test/clip.webm"],
    element: "video",
  },
  {
    name: "direct audio",
    buttonName: "Load audio from audio.media.test",
    hostname: "audio.media.test",
    expectedUrls: ["https://audio.media.test/clip.ogg"],
    element: "audio",
  },
  {
    name: "comment image",
    buttonName: "Load image from comment.media.test",
    hostname: "comment.media.test",
    expectedUrls: ["https://comment.media.test/pixel.png"],
    element: "img",
  },
  {
    name: "comment video",
    buttonName: "Load video from comment-video.media.test",
    hostname: "comment-video.media.test",
    expectedUrls: ["https://comment-video.media.test/clip.webm"],
    element: "video",
  },
] as const;

test("all article and comment media start inert and consent stays item-scoped", async ({
  page,
}) => {
  const observed = await observeRemoteMedia(page);
  await page.goto(ARTICLE);
  await expect(page.getByRole("heading", { name: "Comments" })).toBeVisible();

  for (const { hostname } of MEDIA_CASES) {
    await expect(
      page.locator(`[data-remote-media-host="${hostname}"]`).first(),
    ).toBeVisible();
  }

  await page.waitForTimeout(300);
  expect(observed).toEqual([]);
  const prematureMedia = await page.evaluate(
    (hosts) => {
      const attributes = ["src", "poster"];
      return Array.from(
        document.querySelectorAll<HTMLElement>(
          "img[src], iframe[src], audio[src], video[src], source[src], [poster]",
        ),
      )
        .flatMap((element) =>
          attributes.map((attribute) => element.getAttribute(attribute)),
        )
        .filter((value): value is string => Boolean(value))
        .filter((value) => {
          try {
            return hosts.includes(
              new URL(value, window.location.href).hostname,
            );
          } catch {
            return false;
          }
        });
    },
    [...OBSERVED_HOSTS],
  );
  expect(prematureMedia).toEqual([]);

  await page
    .getByRole("button", { name: "Load image from inline.media.test" })
    .click();
  await expect
    .poll(() => requestsTo(observed, "inline.media.test").length)
    .toBe(1);
  expect(observed).toHaveLength(1);
  expect(observed[0].url).toBe("https://inline.media.test/pixel.png");
  expect(observed[0].referer).toBeUndefined();

  // Consent for one image must not authorize any sibling media.
  for (const { hostname } of MEDIA_CASES) {
    if (hostname === "inline.media.test") continue;
    expect(requestsTo(observed, hostname), hostname).toEqual([]);
  }

  // No consent is remembered across an unmount/remount of the same article.
  await page.goto("/articles");
  observed.length = 0;
  await page.goto(ARTICLE);
  await expect(page.getByRole("heading", { name: "Comments" })).toBeVisible();
  await page.waitForTimeout(300);
  expect(observed).toEqual([]);
});

for (const media of MEDIA_CASES) {
  test(`${media.name} requests only its exact destination after consent`, async ({
    page,
  }) => {
    // Every media assertion gets its own page/document lifecycle. This keeps
    // iframe and native-media resource scheduling from earlier consented items
    // from influencing whether Chromium starts the request under CI load.
    const observed = await observeRemoteMedia(page);
    await page.goto(ARTICLE);
    await expect(page.getByRole("heading", { name: "Comments" })).toBeVisible();

    const placeholder = page
      .locator(
        `[data-remote-media-consent][data-remote-media-host="${media.hostname}"]`,
      )
      .first();
    await expect(placeholder).toBeVisible();
    await expect(
      placeholder.locator(
        "img[src], iframe[src], audio[src], video[src], source[src], [poster]",
      ),
    ).toHaveCount(0);
    await page.waitForTimeout(100);
    expect(observed).toEqual([]);

    await page.getByRole("button", { name: media.buttonName }).first().click();
    const terminalUrl = media.expectedUrls.at(-1)!;
    await expect
      .poll(
        () => observed.filter((request) => request.url === terminalUrl).length,
        { message: terminalUrl },
      )
      .toBeGreaterThan(0);

    expect(observed.map((request) => request.url)).toEqual(
      expect.arrayContaining([...media.expectedUrls]),
    );
    expect(
      observed.every(
        (request) =>
          media.expectedUrls.includes(
            request.url as (typeof media.expectedUrls)[number],
          ) && request.referer === undefined,
      ),
    ).toBe(true);

    const loaded = page
      .locator(
        `[data-remote-media-loaded][data-remote-media-host="${media.hostname}"]`,
      )
      .first();
    await expect(loaded.locator(media.element)).toHaveAttribute(
      "src",
      media.expectedUrls[0],
    );
    if (media.element === "img" || media.element === "iframe") {
      await expect(loaded.locator(media.element)).toHaveAttribute(
        "referrerpolicy",
        "no-referrer",
      );
    }
  });
}

test("320px placeholders stay contained, named, and tappable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  const observed = await observeRemoteMedia(page);
  await page.goto(ARTICLE);
  await expect(page.getByRole("heading", { name: "Comments" })).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Load video from comment-video.media.test",
    }),
  ).toBeVisible();

  const routeViewport = page.locator("[data-scroll-area-viewport]");
  await expect(routeViewport).toHaveCount(1);

  const geometry = await routeViewport.evaluate((viewport) => {
    const bounds = viewport.getBoundingClientRect();
    const controls = Array.from(
      viewport.querySelectorAll<HTMLElement>(
        "[data-remote-media-consent] button",
      ),
    ).map((button) => {
      const rect = button.getBoundingClientRect();
      return {
        width: rect.width,
        height: rect.height,
        left: rect.left,
        right: rect.right,
      };
    });
    return {
      clientWidth: viewport.clientWidth,
      scrollWidth: viewport.scrollWidth,
      left: bounds.left,
      right: bounds.right,
      controls,
    };
  });

  expect(geometry.scrollWidth).toBe(geometry.clientWidth);
  expect(geometry.controls.length).toBeGreaterThanOrEqual(10);
  for (const control of geometry.controls) {
    expect(control.height).toBeGreaterThanOrEqual(44);
    expect(control.width).toBeGreaterThanOrEqual(44);
    expect(control.left).toBeGreaterThanOrEqual(geometry.left);
    expect(control.right).toBeLessThanOrEqual(geometry.right);
  }
  expect(observed).toEqual([]);
});

test("a card consent click loads only its cover and never navigates", async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 1280 });
  const observed = await observeRemoteMedia(page);
  await page.goto("/search?q=Remote%20Media%20Consent%20Audit");

  const result = page
    .getByRole("link", { name: "Read “Remote Media Consent Audit”" })
    .last();
  await expect(result).toBeVisible();
  const before = page.url();
  await page
    .getByRole("button", { name: "Load image from cover.media.test" })
    .click();

  await expect
    .poll(() => requestsTo(observed, "redirect-target.media.test").length)
    .toBe(1);
  expect(page.url()).toBe(before);
  await expect(result).toBeVisible();
  expect(
    observed.every(
      (request) =>
        request.hostname === "cover.media.test" ||
        request.hostname === "redirect-target.media.test",
    ),
  ).toBe(true);
});
