import { expect, test, type Page } from "@playwright/test";

import { decodePng } from "./png-pixels.mjs";
import { browserAppOrigin } from "./ports";

// A cold vite dev server compiles this route on first request.
test.describe.configure({ timeout: 90_000 });

const MOBILE_VIEWPORT = { width: 390, height: 844 };
const NARROW_MOBILE_VIEWPORT = { width: 320, height: 700 };
const TABLET_VIEWPORT = { width: 768, height: 1024 };
const DESKTOP_VIEWPORT = { width: 1280, height: 900 };

/**
 * `/trending` renders `ZpageCard`, the workhorse of the site — the same
 * component the homepage grid, the mobile feed, search, the profile and the
 * dashboard all use — and it is server-rendered with no cache, so the fixture
 * arrives on the first paint rather than after a client fetch.
 *
 * The fixture cover (`mock-api.mjs`) is 1600 x 400 — the shape the editor
 * forced on every upload until  — with a magenta bar pinned to each
 * extreme edge. `object-fit: cover`
 * in a 382x176 card keeps the centre 54% of the width and **both bars vanish**
 * which is exactly how a creator's wordmark rendered as "LLA". So the test
 * is a screenshot: are the two edges of the image still on screen?
 */
const FIXTURE_SESSION = "featured-image-fixture-session";
const TRENDING = "/trending";

async function useFixtureSession(page: Page) {
  await page.context().addCookies([
    {
      name: "sessionid",
      value: FIXTURE_SESSION,
      url: browserAppOrigin(),
    },
  ]);
}

/**
 * The frames actually on screen. Several routes render a mobile *and* a desktop
 * variant of the same list and hide one with `md:hidden` — indexing
 * `.featured-image` blind picks a `display: none` frame, whose screenshot is
 * empty and whose lazy image may never decode.
 */
function visibleFrames(page: Page) {
  return page.locator(".featured-image").filter({ visible: true });
}

/** Every visible frame has decoded its image and settled on a fit. */
async function framesReady(page: Page) {
  // A generous ceiling, not an arbitrary one: a cold vite dev server compiles
  // `/` on first request, which routinely exceeds the 5s default and fails as
  // "element(s) not found" rather than as the slow compile it is.
  await expect(visibleFrames(page).first()).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(() => {
    const frames = Array.from(
      document.querySelectorAll<HTMLElement>(".featured-image"),
    ).filter((frame) => frame.getBoundingClientRect().width > 0);
    if (frames.length === 0) return false;
    return frames.every((frame) => {
      const image = frame.querySelector<HTMLImageElement>(
        ".featured-image__plate img",
      );
      return !!image?.complete && image.naturalWidth > 0;
    });
  });
  // `SmoothImage` fades its skeleton out over 300ms *after* the image reports
  // loaded, and the skeleton is an opaque `bg-muted` panel — so a screenshot
  // taken on the next frame samples the skeleton, not the photograph. Wait for
  // the overlay to leave the DOM, which is what the transition's end does.
  await page.waitForFunction(() => {
    return (
      Array.from(
        document.querySelectorAll<HTMLElement>(".featured-image"),
      ).filter(
        (frame) =>
          frame.getBoundingClientRect().width > 0 &&
          frame.querySelector(".featured-image__plate > div"),
      ).length === 0
    );
  });
  // One frame, so the fit measurement has landed.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => resolve(null))),
  );
}

type Sample = { r: number; g: number; b: number };

/** The left- and right-most pixels on the horizontal centre-line of a frame. */
async function edgeSamples(
  page: Page,
  index: number,
): Promise<{ left: Sample; right: Sample }> {
  const shot = await visibleFrames(page).nth(index).screenshot();
  const png = decodePng(shot);
  const y = Math.floor(png.height / 2);
  const read = (x: number): Sample => {
    const offset = (y * png.width + x) * png.channels;
    return {
      r: png.data[offset],
      g: png.data[offset + 1],
      b: png.data[offset + 2],
    };
  };
  return { left: read(1), right: read(png.width - 2) };
}

/**
 * Magenta, allowing for the card's own gradient overlays and for the sub-pixel
 * softening at the edge of a scaled image. The failure being guarded is
 * categorical — the bar is either on screen or it is not — so a loose tolerance
 * costs nothing while a tight one would only make the test flaky.
 */
function expectEdgeBar(sample: Sample, where: string) {
  expect(
    sample.r > 110 && sample.b > 110 && sample.g < 110,
    `${where}: expected the magenta edge bar, got rgb(${sample.r}, ${sample.g}, ${sample.b})`,
  ).toBe(true);
}

for (const [name, viewport] of [
  ["narrow phone", NARROW_MOBILE_VIEWPORT],
  ["phone", MOBILE_VIEWPORT],
  ["tablet", TABLET_VIEWPORT],
  ["desktop", DESKTOP_VIEWPORT],
] as const) {
  test(`both edges of a 4:1 cover survive on every card at ${name} width`, async ({
    page,
  }) => {
    await useFixtureSession(page);
    await page.setViewportSize(viewport);
    await page.goto(TRENDING);
    await framesReady(page);

    const count = await visibleFrames(page).count();
    expect(count).toBeGreaterThan(0);

    for (let index = 0; index < count; index += 1) {
      const frame = visibleFrames(page).nth(index);
      await expect(frame).toHaveAttribute("data-featured-fit", "contain");

      const objectFit = await frame
        .locator(".featured-image__plate img")
        .evaluate((node) => getComputedStyle(node).objectFit);
      expect(objectFit).toBe("scale-down");

      const { left, right } = await edgeSamples(page, index);
      expectEdgeBar(left, `${name} card ${index} left edge`);
      expectEdgeBar(right, `${name} card ${index} right edge`);
    }
  });
}

test("the homepage's own featured renderers show the whole cover too", async ({
  page,
}) => {
  // `/` does not use ZpageCard for its two most prominent slots: the lead story
  // is a bespoke `aspect-2/1` frame and Popular Reads a bespoke 80px square.
  // Both were missed by a sweep of the card components, and the square one is
  // the worst crop on the site — 62% of the width. A test that only visits
  // /trending would keep missing them.
  await useFixtureSession(page);
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await page.goto("/");
  await framesReady(page);

  const count = await visibleFrames(page).count();
  expect(count).toBeGreaterThan(1);

  for (let index = 0; index < count; index += 1) {
    await expect(visibleFrames(page).nth(index)).toHaveAttribute(
      "data-featured-fit",
      "contain",
    );
    const { left, right } = await edgeSamples(page, index);
    expectEdgeBar(left, `homepage frame ${index} left edge`);
    expectEdgeBar(right, `homepage frame ${index} right edge`);
  }
});

test("hovering a card does not crop the edges back off", async ({ page }) => {
  // A `group-hover:scale-105` on a contained image crops it against the frame's
  // own `overflow: hidden` — so edge content visible at rest vanished the
  // moment a pointer touched the card. Caught by the codex review, not by a
  // screenshot, because no screenshot hovered.
  await useFixtureSession(page);
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await page.goto("/trending");
  await framesReady(page);

  const frame = visibleFrames(page).first();
  await frame.hover();
  // Long enough for any transition to have finished if one were reintroduced.
  await page.waitForTimeout(600);

  const { left, right } = await edgeSamples(page, 0);
  expectEdgeBar(left, "hovered card left edge");
  expectEdgeBar(right, "hovered card right edge");
});

test("the blurred pad fills the space the image does not, in both themes", async ({
  page,
}) => {
  await useFixtureSession(page);
  await page.setViewportSize(DESKTOP_VIEWPORT);

  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.goto(TRENDING);
    await framesReady(page);

    const geometry = await visibleFrames(page)
      .first()
      .evaluate((frame) => {
        const pad = frame.querySelector<HTMLElement>(".featured-image__pad");
        const inner = frame.querySelector<HTMLElement>(
          ".featured-image__pad-inner",
        );
        const image = frame.querySelector<HTMLImageElement>(
          ".featured-image__plate img",
        );
        const box = frame.getBoundingClientRect();
        const padBox = pad?.getBoundingClientRect();
        return {
          padDisplay: pad ? getComputedStyle(pad).display : "missing",
          padFilter: inner ? getComputedStyle(inner).filter : "",
          boxWidth: box.width,
          boxHeight: box.height,
          padWidth: padBox?.width ?? 0,
          padHeight: padBox?.height ?? 0,
          naturalWidth: image?.naturalWidth ?? 0,
          naturalHeight: image?.naturalHeight ?? 0,
        };
      });

    expect(geometry.padDisplay, theme).not.toBe("none");
    expect(geometry.padFilter, theme).toContain("blur");
    // The pad covers the whole box, so there is never a bare gap beside the
    // letterboxed image — in either theme, because it is derived from the
    // image rather than from a theme token.
    expect(geometry.padWidth, theme).toBeCloseTo(geometry.boxWidth, 0);
    expect(geometry.padHeight, theme).toBeCloseTo(geometry.boxHeight, 0);
    // And the image really is the 4:1 cover, not something the mock resized.
    expect(geometry.naturalWidth, theme).toBe(1600);
    expect(geometry.naturalHeight, theme).toBe(400);
  }
});

test("a cover that already matches its box is not letterboxed by a hairline", async ({
  page,
}) => {
  // The editor preview is a deliberate 4:1 box for a 4:1 cover. Padding that
  // would be a 0px band and would read as a rendering fault, so the fit snaps
  // back to cover — a crop of no pixels at all. Asserted through the same code
  // path the cards use, at the same place the threshold lives.
  await useFixtureSession(page);
  await page.setViewportSize(DESKTOP_VIEWPORT);
  await page.goto(TRENDING);
  await framesReady(page);

  // Re-measure the same frame in a 4:1 box and confirm the component re-decides
  // rather than latching on its first answer.
  await page
    .locator(".featured-image")
    .first()
    .evaluate((frame) => {
      const host = frame as HTMLElement;
      host.style.width = "800px";
      host.style.height = "200px";
    });

  await expect(visibleFrames(page).first()).toHaveAttribute(
    "data-featured-fit",
    "cover",
  );
});
