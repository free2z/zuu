import { expect, test, type Page } from "@playwright/test";
import { browserMockApiOrigin } from "./ports";

// A cold vite dev server compiles this route on first request, which alone can
// approach the default per-test budget.
test.describe.configure({ timeout: 90_000 });

const ARTICLE = "/audio-preload-user/audio-preload-fixture";

// Kept in sync with tests/browser/mock-api.mjs. The mock server's origin
// differs from the app's by port, so what it serves is genuinely third party
// to the page under test.
const MOCK_API_ORIGIN = browserMockApiOrigin();
const THIRD_PARTY_AUDIO_URL = `${MOCK_API_ORIGIN}/third-party-audio/probe.wav`;
const THIRD_PARTY_VIDEO_URL = `${MOCK_API_ORIGIN}/third-party-video/probe.mp4`;
const SAME_ORIGIN_AUDIO_PATH = "/uploadz/audio-preload-fixture.wav";
const SAME_ORIGIN_VIDEO_PATH = "/uploadz/video-consent-fixture.mp4";

type ProbeHits = { audioHits: number; videoHits: number };

/** The tracker host's own view of how many media requests it received. */
async function probeHits(): Promise<ProbeHits> {
  const response = await fetch(`${MOCK_API_ORIGIN}/__media-probe`);
  return (await response.json()) as ProbeHits;
}

async function resetProbe(): Promise<void> {
  await fetch(`${MOCK_API_ORIGIN}/__media-probe`, { method: "DELETE" });
}

function consentPrompts(page: Page) {
  return page.getByRole("heading", { name: "External content blocked" });
}

function audioFor(page: Page, src: string) {
  return page.locator(`audio[src="${src}"]`);
}

function videoFor(page: Page, src: string) {
  return page.locator(`video:has(source[src="${src}"])`);
}

/** Click a real link so the root layout's consent-scope hooks run. */
async function clickThrough(page: Page, target: string) {
  const token = `spa-nav-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const expected = new URL(target, page.url()).href;
  await page.evaluate(
    ({ href, token }) => {
      const link = document.createElement("a");
      link.href = href;
      link.textContent = "spa-nav";
      link.dataset.spaNav = token;
      document.body.append(link);
    },
    { href: target, token },
  );
  const link = page.locator(`[data-spa-nav="${token}"]`);
  await Promise.all([page.waitForURL(expected), link.click()]);
  await link.evaluate((node) => node.remove()).catch(() => {});
}

test.beforeEach(async () => {
  await resetProbe();
});

test("SSR withholds the third-party video source before hydration", async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();

  try {
    await page.goto(ARTICLE);

    // The URL may cross SSR as inert data for client-side classification, but
    // it must never arrive in a live source sink that a crawler/browser can
    // fetch before the consent component exists.
    await expect(
      page.locator(`source[src="${THIRD_PARTY_VIDEO_URL}"]`),
    ).toHaveCount(0, { timeout: 30_000 });
    await expect(
      page.locator(
        `.video-embed-placeholder[data-video-url="${THIRD_PARTY_VIDEO_URL}"]`,
      ),
    ).toHaveCount(1, { timeout: 30_000 });
    expect(await probeHits()).toEqual({ audioHits: 0, videoHits: 0 });
  } finally {
    await context.close();
  }
});

test("third-party audio and video have no live URL until Load once", async ({
  page,
}) => {
  const requestedMediaUrls: string[] = [];
  page.on("request", (request) => {
    if (/\.(?:wav|mp4)(?:[?#]|$)/.test(request.url())) {
      requestedMediaUrls.push(request.url());
    }
  });

  await page.goto(ARTICLE);

  // Both direct third-party files use ExternalEmbed's existing consent card.
  // Critically, the media elements do not merely carry preload="none": neither
  // live src sink exists at all before consent.
  await expect(consentPrompts(page)).toHaveCount(2, { timeout: 30_000 });
  await expect(audioFor(page, THIRD_PARTY_AUDIO_URL)).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(videoFor(page, THIRD_PARTY_VIDEO_URL)).toHaveCount(0, {
    timeout: 30_000,
  });

  // Same-origin hosted media keeps the established UX and needs no prompt.
  await expect(audioFor(page, SAME_ORIGIN_AUDIO_PATH)).toHaveAttribute(
    "preload",
    "metadata",
    { timeout: 30_000 },
  );
  await expect(videoFor(page, SAME_ORIGIN_VIDEO_PATH)).toHaveAttribute(
    "preload",
    "metadata",
    { timeout: 30_000 },
  );

  // Give metadata loading enough room that a zero is not a scheduling race.
  await page.waitForTimeout(1500);
  expect(requestedMediaUrls).not.toContain(THIRD_PARTY_AUDIO_URL);
  expect(requestedMediaUrls).not.toContain(THIRD_PARTY_VIDEO_URL);
  expect(await probeHits()).toEqual({ audioHits: 0, videoHits: 0 });

  const appOrigin = new URL(page.url()).origin;
  const sameOriginAudioUrl = new URL(SAME_ORIGIN_AUDIO_PATH, appOrigin).href;
  const sameOriginVideoUrl = new URL(SAME_ORIGIN_VIDEO_PATH, appOrigin).href;
  await expect
    .poll(
      () =>
        requestedMediaUrls.includes(sameOriginAudioUrl) &&
        requestedMediaUrls.includes(sameOriginVideoUrl),
      { timeout: 15_000 },
    )
    .toBe(true);

  // A one-time domain grant is shared by both media embeds, just like it is by
  // ordinary ExternalEmbed instances. Mounting with metadata preload makes the
  // grant observable from the tracker side without a second play gesture.
  await page.getByRole("button", { name: "Load once" }).first().click();
  await expect(consentPrompts(page)).toHaveCount(0, { timeout: 30_000 });
  await expect(audioFor(page, THIRD_PARTY_AUDIO_URL)).toHaveAttribute(
    "preload",
    "metadata",
    { timeout: 30_000 },
  );
  await expect(videoFor(page, THIRD_PARTY_VIDEO_URL)).toHaveAttribute(
    "preload",
    "metadata",
    { timeout: 30_000 },
  );
  await expect
    .poll(
      async () => {
        const hits = await probeHits();
        return hits.audioHits > 0 && hits.videoHits > 0;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
});

test("one-time direct-media consent is spent after leaving the logical page", async ({
  page,
}) => {
  await page.goto(ARTICLE);
  await expect(consentPrompts(page)).toHaveCount(2, { timeout: 30_000 });

  await page.getByRole("button", { name: "Load once" }).first().click();
  await expect(audioFor(page, THIRD_PARTY_AUDIO_URL)).toBeAttached({
    timeout: 30_000,
  });
  await expect(videoFor(page, THIRD_PARTY_VIDEO_URL)).toBeAttached({
    timeout: 30_000,
  });

  await clickThrough(page, "/");
  await resetProbe();
  await clickThrough(page, ARTICLE);

  await expect(consentPrompts(page)).toHaveCount(2, { timeout: 30_000 });
  await expect(audioFor(page, THIRD_PARTY_AUDIO_URL)).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(videoFor(page, THIRD_PARTY_VIDEO_URL)).toHaveCount(0, {
    timeout: 30_000,
  });
  await page.waitForTimeout(1500);
  expect(await probeHits()).toEqual({ audioHits: 0, videoHits: 0 });
});
