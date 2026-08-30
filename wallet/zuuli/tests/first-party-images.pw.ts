import { expect, test, type Page } from "@playwright/test";

const ARTICLE = "/articles/remote-media-consent-audit";
const STRICT_KEY = "zuuli.strict-image-privacy";
const TRACKED_HOSTS = new Set([
  "free2z.cash",
  "media.free2z.cash",
  "free2z.cash.evil.example",
  "tracker.example",
]);
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function interceptImages(page: Page) {
  const requested: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (TRACKED_HOSTS.has(url.hostname)) requested.push(url.href);
  });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (!TRACKED_HOSTS.has(url.hostname)) {
      await route.continue();
      return;
    }

    if (url.pathname === "/uploadz/redirect-out") {
      await route.fulfill({
        status: 302,
        headers: {
          location: "https://tracker.example/pixel.svg",
          "access-control-allow-origin": "*",
        },
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: "image/png",
      headers: { "access-control-allow-origin": "*" },
      body: ONE_PIXEL_PNG,
    });
  });
  return requested;
}

test("trusted images auto-load as local bytes while lookalikes and redirect targets stay inert", async ({
  page,
}) => {
  const requested = await interceptImages(page);
  await page.goto(ARTICLE);

  await expect(
    page.locator('[data-first-party-media-loaded][data-remote-media-host="free2z.cash"]'),
  ).toBeVisible();
  await expect(
    page.locator('[data-first-party-media-loaded][data-remote-media-host="media.free2z.cash"]'),
  ).toBeVisible();

  const localSources = await page
    .locator("[data-first-party-media-loaded] img")
    .evaluateAll((images) => images.map((image) => image.getAttribute("src")));
  expect(localSources).toHaveLength(2);
  expect(localSources.every((source) => source?.startsWith("blob:"))).toBe(true);
  expect(
    await page.locator("[data-first-party-media-loaded] img").evaluateAll(
      (images) =>
        images.every(
          (image) =>
            (image as HTMLImageElement).complete &&
            (image as HTMLImageElement).naturalWidth > 0,
        ),
    ),
  ).toBe(true);

  await expect(
    page.locator('[data-first-party-media-unavailable][data-remote-media-host="free2z.cash"]'),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Load image from free2z.cash.evil.example",
    }),
  ).toBeVisible();

  expect(requested).toEqual(
    expect.arrayContaining([
      "https://free2z.cash/uploadz/canonical.svg",
      "https://media.free2z.cash/uploadz/subdomain.svg",
      "https://free2z.cash/uploadz/redirect-out",
    ]),
  );
  expect(requested.some((url) => new URL(url).hostname === "tracker.example")).toBe(
    false,
  );
  expect(
    requested.some(
      (url) => new URL(url).hostname === "free2z.cash.evil.example",
    ),
  ).toBe(false);
});

test("strict image privacy keeps every image inert before consent", async ({
  page,
}) => {
  await page.addInitScript(
    ({ key }) => localStorage.setItem(key, "1"),
    { key: STRICT_KEY },
  );
  const requested = await interceptImages(page);
  await page.goto(ARTICLE);

  const setting = page.getByRole("switch", { name: "Strict image privacy" });
  await expect(setting).toBeChecked();
  await expect(
    page.getByRole("button", { name: "Load image from free2z.cash" }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Load image from media.free2z.cash",
    }),
  ).toBeVisible();
  expect(requested).toEqual([]);

  const prematureSources = await page.evaluate((hosts) =>
    Array.from(document.querySelectorAll("img[src]"))
      .map((image) => image.getAttribute("src"))
      .filter((source): source is string => Boolean(source))
      .filter((source) => {
        try {
          return hosts.includes(new URL(source, location.href).hostname);
        } catch {
          return false;
        }
      }), [...TRACKED_HOSTS]);
  expect(prematureSources).toEqual([]);

  requested.length = 0;
  await page
    .locator(
      '[data-remote-media-consent][data-remote-media-host="free2z.cash"]',
    )
    .nth(1)
    .getByRole("button", { name: "Load image from free2z.cash" })
    .click();
  await expect(
    page.locator(
      '[data-first-party-media-unavailable][data-remote-media-host="free2z.cash"]',
    ),
  ).toBeVisible();
  expect(requested).toContain("https://free2z.cash/uploadz/redirect-out");
  expect(requested.some((url) => new URL(url).hostname === "tracker.example")).toBe(
    false,
  );
});

test("the setting is keyboard-operable, persistent, and contained in a narrow RTL locale", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await interceptImages(page);
  await page.goto(ARTICLE);
  await page.evaluate(() => {
    document.documentElement.lang = "ar";
    document.documentElement.dir = "rtl";
  });

  const setting = page.getByRole("switch", { name: "Strict image privacy" });
  await setting.focus();
  await page.keyboard.press("Space");
  await expect(setting).toBeChecked();
  expect(await page.evaluate((key) => localStorage.getItem(key), STRICT_KEY)).toBe("1");

  const geometry = await setting.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      viewport: document.documentElement.clientWidth,
    };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    320,
  );

  await page.reload();
  await expect(
    page.getByRole("switch", { name: "Strict image privacy" }),
  ).toBeChecked();
});
