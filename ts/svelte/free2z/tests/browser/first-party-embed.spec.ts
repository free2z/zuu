import { expect, test, type Page, type Request } from "@playwright/test";

/**
 *  `::embed[https://free2z.cash/…]` of our OWN content used to go
 * through the third-party path: a "load external content?" card for the site
 * the reader is already on, then a round trip to Iframely. It must now render
 * natively, with no consent card and no Iframely request, while a third-party
 * embed on the same page still gates.
 *
 * The fixture (tests/browser/mock-api.mjs, `first-party-embed-fixture`) holds
 * a first-party video, audio, PDF, image, members-only image and page link,
 * plus one YouTube embed as the in-page control.
 */

// A cold vite dev server compiles this route on first request.
test.describe.configure({ timeout: 90_000 });

const ARTICLE = "/fp-embed-user/first-party-embed-fixture";
const UPLOADS = "/uploadz/public/fp-embed-user";
const MEMBERS_IMAGE = "/uploadz/fp-embed-user/members-only.png";

// 1x1 opaque PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function consentPrompts(page: Page) {
  return page.getByRole("heading", { name: "External content blocked" });
}

/**
 * Serve the public upload bytes and refuse the members-only one the way nginx
 * `auth_request` does for a reader without access (401, no body). Records
 * every request so the assertions are about what the browser really asked for.
 */
async function routeUploads(page: Page) {
  const requests: string[] = [];
  page.on("request", (request: Request) => requests.push(request.url()));

  await page.route("**/uploadz/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === MEMBERS_IMAGE) {
      await route.fulfill({ status: 401, body: "" });
      return;
    }
    if (url.pathname.endsWith(".png")) {
      await route.fulfill({ status: 200, contentType: "image/png", body: PNG });
      return;
    }
    await route.fulfill({ status: 404, body: "" });
  });
  // Iframely must never be contacted; if it is, answer so a request cannot
  // hang the page — the assertion on `requests` is what fails the test.
  await page.route(/iframe\.ly/, (route) =>
    route.fulfill({ status: 500, body: "" }),
  );
  return requests;
}

test("same-origin media renders natively with no consent card and no Iframely request", async ({
  page,
}) => {
  const requests = await routeUploads(page);
  await page.goto(ARTICLE);

  // The in-page control: the YouTube embed is the ONLY consent card.
  await expect(consentPrompts(page)).toHaveCount(1, { timeout: 30_000 });

  // Video / audio: the existing first-party players, on root-relative paths.
  await expect(
    page.locator(`video:has(source[src="${UPLOADS}/talk.mp4"])`),
  ).toHaveCount(1, { timeout: 30_000 });
  await expect(page.locator(`audio[src="${UPLOADS}/episode.mp3"]`)).toHaveCount(
    1,
    { timeout: 30_000 },
  );

  // PDF: a first-party link card, never a frame.
  const pdfCard = page.locator(
    `.first-party-embed-pdf a[href="${UPLOADS}/w-9.pdf"]`,
  );
  await expect(pdfCard).toBeVisible();
  await expect(pdfCard).toContainText("w-9.pdf");
  await expect(pdfCard).toContainText("PDF");

  // Image: rendered, and actually decoded (positive control for the members
  // case below).
  const image = page.locator(`img[src="${UPLOADS}/photo.png"]`);
  await expect(image).toHaveCount(1);
  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth), {
      timeout: 15_000,
    })
    .toBe(1);

  // Our own page: a plain link.
  await expect(
    page.locator(
      '.first-party-embed-zpage a[href="https://free2z.cash/fp-embed-user/another-article"]',
    ),
  ).toBeVisible();

  // No frame of any first-party route exists anywhere in the article.
  await expect(
    page.locator("article iframe, .markdown-content iframe"),
  ).toHaveCount(0);

  // Give any deferred embed work time to fire before asserting an absence.
  await page.waitForTimeout(1500);
  expect(requests.filter((url) => /iframe\.ly/.test(url))).toEqual([]);
  // And nothing first-party was fetched from free2z.cash itself: the page
  // loads our uploads from its OWN origin, with the reader's own session.
  expect(
    requests.filter((url) => url.startsWith("https://free2z.cash")),
  ).toEqual([]);
});

test("with embed consent already granted, first-party embeds still never reach Iframely", async ({
  page,
}) => {
  // The test above is necessary but not sufficient: WITHOUT consent Iframely
  // is never called, on main or here, so "0 iframe.ly requests" there proves
  // only that the gate held. Here the reader has granted global consent (and
  // trusted free2z.cash) before the page loads — the state in which main
  // shipped every free2z.cash PDF/image/page URL to cdn.iframe.ly. Negative
  // control recorded in the PR: with origin/main's renderer, ExternalEmbed and
  // privacy store this test fails on the Iframely assertion.
  await page.addInitScript(() => {
    try {
      localStorage.setItem("globalEmbedConsent", "true");
      localStorage.setItem(
        "trustedEmbedDomains",
        JSON.stringify(["free2z.cash"]),
      );
      localStorage.setItem("trustedEmbedDomain:free2z.cash", "true");
    } catch {
      // storage unavailable: the assertions below would then prove nothing,
      // so the consent check at the end fails loudly instead.
    }
  });
  const requests = await routeUploads(page);
  // The YouTube control now loads (consent granted); keep it off the network.
  await page.route(/youtube\.com|ytimg\.com|googlevideo\.com/, (route) =>
    route.fulfill({ status: 204, body: "" }),
  );
  await page.goto(ARTICLE);

  // Consent really is granted: the third-party control is no longer gated.
  await expect(
    page.locator('iframe[src^="https://www.youtube.com/embed/"]'),
  ).toHaveCount(1, { timeout: 30_000 });
  await expect(consentPrompts(page)).toHaveCount(0);

  // Asserted FIRST, so the negative control fails on the thing this test
  // exists for (main sends every first-party URL here) and not on markup.
  await page.waitForTimeout(2000);
  expect(requests.filter((url) => /iframe\.ly/.test(url))).toEqual([]);

  // First-party content rendered natively, as without consent.
  await expect(
    page.locator(`.first-party-embed-pdf a[href="${UPLOADS}/w-9.pdf"]`),
  ).toBeVisible();
  await expect(page.locator(`img[src="${UPLOADS}/photo.png"]`)).toHaveCount(1);
  // The only frame is the third-party player; nothing first-party is framed.
  const frameSources = await page
    .locator(".markdown-content iframe")
    .evaluateAll((frames) =>
      frames.map((frame) => frame.getAttribute("src") || ""),
    );
  expect(
    frameSources.filter((src) => !src.startsWith("https://www.youtube.com/")),
  ).toEqual([]);
});

test("a members-only upload embedded for a reader without access renders no content", async ({
  page,
}) => {
  const requests = await routeUploads(page);
  await page.goto(ARTICLE);

  const members = page.locator(`img[src="${MEMBERS_IMAGE}"]`);
  await expect(members).toHaveCount(1, { timeout: 30_000 });

  // The browser asked with the reader's own credentials, same origin, and the
  // server refused: no bytes, so nothing decoded.
  await expect
    .poll(
      () => requests.some((url) => new URL(url).pathname === MEMBERS_IMAGE),
      {
        timeout: 15_000,
      },
    )
    .toBe(true);
  await expect
    .poll(() =>
      members.evaluate(
        (img: HTMLImageElement) => img.complete && img.naturalWidth === 0,
      ),
    )
    .toBe(true);

  // And the refusal did not fall back to anything that could show it another
  // way: no consent card for it, no frame, no Iframely.
  await expect(consentPrompts(page)).toHaveCount(1);
  await expect(page.locator(".markdown-content iframe")).toHaveCount(0);
  expect(requests.filter((url) => /iframe\.ly/.test(url))).toEqual([]);
});

test("SSR already renders first-party embeds, so hydration cannot flash a consent card", async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  try {
    await page.goto(ARTICLE);
    await expect(
      page.locator(`.first-party-embed-pdf a[href="${UPLOADS}/w-9.pdf"]`),
    ).toHaveCount(1, { timeout: 30_000 });
    await expect(
      page.locator(`video:has(source[src="${UPLOADS}/talk.mp4"])`),
    ).toHaveCount(1);
    await expect(page.locator(`img[src="${UPLOADS}/photo.png"]`)).toHaveCount(
      1,
    );
    // The only thing waiting on the client is the third-party embed.
    await expect(page.locator("[data-embed-url]")).toHaveCount(1);
    await expect(
      page.locator(
        '[data-embed-url="https://www.youtube.com/watch?v=dQw4w9WgXcQ"]',
      ),
    ).toHaveCount(1);
  } finally {
    await context.close();
  }
});
