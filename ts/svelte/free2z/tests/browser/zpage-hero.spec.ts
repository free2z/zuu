import { expect, test, type Page } from "@playwright/test";

import {
  annulusAround,
  decodePng,
  contrastRatio,
  differenceMask,
  maskCoverage,
  parseCssColor,
  worstContrastInMask,
} from "./png-pixels.mjs";

// A cold vite dev server compiles this route on first request.
test.describe.configure({ timeout: 90_000 });

const BRIGHT = "/hero-user/hero-bright-fixture";
const DARK = "/hero-user/hero-dark-fixture";
const PANO = "/hero-user/hero-pano-fixture";
const STORED_COVER = "/hero-user/hero-cover-fixture";
const PHOTO_COVER = "/hero-user/hero-photo-fixture";
const TINY = "/hero-user/hero-tiny-fixture";
const LONG_TITLE = "/hero-user/hero-longtitle-fixture";
const OUTLINE = "/hero-user/hero-outline-fixture";
const NO_IMAGE = "/hero-user/hero-none-fixture";
const GATED = "/hero-user/hero-gated-fixture";

const BODY_SENTINEL = "hero-body-sentinel";

const READING_PROGRESS = "--reading-progress";

const EDITORIAL_HERO_GEOMETRY = {
  mobile: { min: 17 * 16, preferred: 0.44, max: 28 * 16, fallback: 22 * 16 },
  tablet: { min: 19 * 16, preferred: 0.48, max: 32 * 16, fallback: 24 * 16 },
  desktop: {
    min: 21 * 16,
    preferred: 0.52,
    max: 34 * 16,
    fallback: 26 * 16,
  },
} as const;

function editorialHeroGeometry(viewport: { width: number; height: number }) {
  const token =
    viewport.width < 640
      ? EDITORIAL_HERO_GEOMETRY.mobile
      : viewport.width < 1024
        ? EDITORIAL_HERO_GEOMETRY.tablet
        : EDITORIAL_HERO_GEOMETRY.desktop;
  return {
    token,
    expected: Math.min(
      token.max,
      Math.max(token.min, viewport.height * token.preferred),
    ),
  };
}

/** Remove the supported-unit override so the live stylesheet uses its rem
 * fallback. */
async function removeSvhOverride(page: Page) {
  return page.evaluate(() => {
    let removed = 0;

    function clearSvhDeclarations(rule: CSSRule) {
      if (rule instanceof CSSStyleRule) {
        if (
          rule.style
            .getPropertyValue("--f2z-editorial-hero-height")
            .includes("svh")
        ) {
          rule.style.removeProperty("--f2z-editorial-hero-height");
        }
        return;
      }
      if ("cssRules" in rule) {
        const nestedRules = (rule as CSSGroupingRule).cssRules;
        for (let index = 0; index < nestedRules.length; index += 1) {
          clearSvhDeclarations(nestedRules[index]);
        }
      }
    }

    function removeFrom(container: CSSStyleSheet | CSSGroupingRule) {
      for (let index = container.cssRules.length - 1; index >= 0; index -= 1) {
        const rule = container.cssRules[index];
        if (rule instanceof CSSStyleRule) {
          clearSvhDeclarations(rule);
          continue;
        }
        if (
          rule instanceof CSSSupportsRule &&
          rule.conditionText.includes("svh")
        ) {
          // Clearing the declarations first keeps Chromium's computed-style
          // cache from retaining the custom-property value after the
          // grouping rule is removed through CSSOM.
          clearSvhDeclarations(rule);
          container.deleteRule(index);
          removed += 1;
          continue;
        }
        if ("cssRules" in rule) {
          removeFrom(rule as CSSGroupingRule);
        }
      }
    }

    for (const stylesheet of Array.from(document.styleSheets)) {
      const wasDisabled = stylesheet.disabled;
      const removedBefore = removed;
      let replaced = false;
      try {
        // Toggling the sheet forces Chromium to discard computed custom
        // property values that were cached while the nested support rule was
        // still active.
        stylesheet.disabled = true;
        removeFrom(stylesheet);
        if (
          removed > removedBefore &&
          (stylesheet.ownerNode instanceof HTMLStyleElement ||
            stylesheet.ownerNode instanceof HTMLLinkElement)
        ) {
          // CSSOM deletion can leave a computed custom property cached on the
          // original sheet. Reparse the rules we just kept into a fresh style
          // node so the fallback cascade is observable like it is in an
          // engine without svh support.
          const owner = stylesheet.ownerNode;
          const replacement = document.createElement("style");
          replacement.media = owner.media;
          replacement.textContent = Array.from(stylesheet.cssRules)
            .map((rule) => rule.cssText)
            .join("\n");
          owner.replaceWith(replacement);
          replaced = true;
        }
      } catch {
        // Ignore cross-origin sheets; the app stylesheet is same-origin.
      } finally {
        if (!replaced) stylesheet.disabled = wasDisabled;
      }
    }
    return {
      removed,
      value: getComputedStyle(document.documentElement)
        .getPropertyValue("--f2z-editorial-hero-height")
        .trim(),
    };
  });
}

async function readHeroGeometry(page: Page) {
  return page.locator("section.zhero").evaluate((node) => {
    const style = getComputedStyle(node);
    const box = node.getBoundingClientRect();
    return {
      minHeight: Number.parseFloat(style.minHeight),
      heroHeightToken: style
        .getPropertyValue("--f2z-editorial-hero-height")
        .trim(),
      width: box.width,
      height: box.height,
    };
  });
}

/** Wait for either implementation so the same regression can reject the old hero. */
async function sceneLive(page: Page) {
  await page.waitForFunction(
    () =>
      !!document.querySelector<HTMLElement>(".reading-progress")?.style
        .transform ||
      !!document
        .querySelector<HTMLElement>("main[data-hero-visible]")
        ?.style.getPropertyValue("--reading-progress"),
  );
}

/**
 * The document has stopped changing shape.
 *
 * Sampling `documentElement.scrollHeight` every frame after `heroReady`
 * returned caught the outline fixture shrinking by 629px (12611 -> 11982) in
 * half of the runs — a late reflow of ~10,000px of prose. Geometry read before
 * that lands is geometry of a page that is about to become a different page.
 *
 * Bounded and best-effort, unlike `sceneLive`: "the page stopped moving" is
 * measurement hygiene, not a contract, and a page that never stops moving
 * should still be asserted against — loudly — rather than time the test out.
 * Left unbounded this became a new way to burn the whole 90s budget under a
 * widened module-load window, because Vite kept streaming modules and the
 * document kept resizing.
 */
async function layoutSettled(page: Page) {
  await page.evaluate(() => {
    (window as any).__stableFor = 0;
    (window as any).__lastShape = null;
  });

  await page
    .waitForFunction(
      // Three consecutive agreeing observations at 100ms polling, not two
      // adjacent frames. Two frames span ~32ms, and the codex review is right
      // that a delayed Svelte task or a streamed component can hold the
      // document still for that long and then reflow it — so this requires
      // ~300ms of quiet, which is a window rather than an instant, without
      // being a fixed sleep: a page that settles immediately still leaves in
      // ~300ms and a page that keeps moving keeps resetting the counter.
      () => {
        const article = document.querySelector("article");
        const hero = document.querySelector("section.zhero");
        const shape = [
          document.documentElement.scrollHeight,
          Math.round(article?.getBoundingClientRect().height ?? -1),
          Math.round(hero?.getBoundingClientRect().height ?? -1),
        ].join("|");

        const previous = (window as any).__lastShape;
        (window as any).__lastShape = shape;
        (window as any).__stableFor =
          previous === shape ? (window as any).__stableFor + 1 : 0;
        return (window as any).__stableFor >= 3;
      },
      undefined,
      { polling: 100, timeout: 10_000 },
    )
    .catch(() => undefined);
}

/**
 * Wait out the CSS transitions running on one element.
 *
 * Scoped to a selector, never `document.getAnimations()`: this page carries at
 * least one infinite animation, whose `finished` promise never resolves, and
 * awaiting the document-wide list burned the full 90s test budget when tried.
 */
async function animationsFinished(page: Page, selector: string) {
  await page.evaluate(async (target) => {
    const node = document.querySelector(target);
    if (!node) return;
    await Promise.all(
      node
        .getAnimations({ subtree: true })
        // A cancelled or replaced animation rejects; that is still "not
        // running", which is all this needs to know.
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  }, selector);
}

/** The hero image, the fonts, the scroll scene and the layout are all ready. */
async function heroReady(page: Page) {
  await expect(page.locator(".hero-media")).toBeVisible();

  // `decode()` on top of `complete`: `complete` only says the bytes arrived,
  // and / made the hero's height depend on the image's real aspect
  // ratio, so the frame that ratio reaches layout in is the one that matters.
  await page.waitForFunction(
    async () => {
      const image =
        document.querySelector<HTMLImageElement>(".hero-media__img");
      if (!image?.complete || !(image.naturalWidth > 0)) return false;
      try {
        await image.decode();
      } catch {
        // A decode failure is a rendering concern, not a readiness one; the
        // bytes are here either way and other tests assert what is painted.
      }
      return true;
    },
    undefined,
    { polling: 100 },
  );

  // A font swap reflows every paragraph under the hero.
  await page.evaluate(async () => {
    await document.fonts?.ready;
  });

  await sceneLive(page);
  await layoutSettled(page);
}

async function scrollTo(page: Page, top: number) {
  await sceneLive(page);
  await page.evaluate((y) => window.scrollTo(0, y), top);
  await page.waitForFunction((y) => {
    const wanted = Math.min(
      y,
      Math.max(0, document.documentElement.scrollHeight - innerHeight),
    );
    if (Math.abs(scrollY - wanted) <= 2) return true;
    window.scrollTo(0, y);
    return false;
  }, top);
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
}

async function published(page: Page, _property: string): Promise<number> {
  return page.locator(".reading-progress").evaluate((node) => {
    if (!(node as HTMLElement).style.transform)
      throw new Error("Reading progress not initialized");
    return new DOMMatrix(getComputedStyle(node).transform).a;
  });
}

async function heroExit(page: Page) {
  return page.locator("section.zhero").evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return Math.min(1, Math.max(0, -rect.top / rect.height));
  });
}

async function sceneAtRest(page: Page) {
  await sceneLive(page);
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
}

/**
 * Turn the glyph pad off (or back on) for the whole headline subtree.
 *
 * Set INLINE rather than through `addStyleTag`, and that is not a style
 * preference. An inline `!important` outranks a stylesheet `!important`
 * whatever the rule's specificity, so this cannot be quietly defeated by a
 * future production rule that is more specific than whatever selector a test
 * happened to write. Getting that wrong once already produced a full page of
 * plausible, entirely wrong measurements.
 */
async function padOff(page: Page, off: boolean) {
  await page.evaluate((disable) => {
    for (const node of document.querySelectorAll<HTMLElement>(
      ".zhero__content, .zhero__content *",
    )) {
      if (disable) {
        node.style.setProperty("filter", "none", "important");
        node.style.setProperty("text-shadow", "none", "important");
      } else {
        node.style.removeProperty("filter");
        node.style.removeProperty("text-shadow");
      }
    }
  }, off);
}

/**
 * The worst contrast the background immediately AROUND a run of text has
 * against that text's own colour.
 *
 * Why this and not "the worst pixel in the element's box", which is what this
 * file measured while the headline sat on a band: with a band, every pixel in
 * the box was backing, so the box was the claim. With a pad generated from the
 * letterforms there IS no backing between the words — that is the entire point
 * of the change, and the photograph showing through there is the feature. The
 * claim that survives is local: within `radius` pixels of every glyph, the
 * reader must have 4.5:1.
 *
 * `radius` is 3, which is about one stroke width of the hero's body copy at
 * 16px. A pad that does not carry the requirement across a full stroke-width
 * of surround is not backing the letterform, it is outlining it. The profile
 * at 1/2/4px is reported in the PR rather than hidden: at 4px the same CSS
 * measures 4.64:1 at its worst, so 3px is not sitting on a cliff.
 *
 * The mask cannot be "pixels that look like the text colour": white text over
 * a near-white cover is the exact case the matrix exists for. It is a
 * DIFFERENCE of two renders with the pad off — the text in a colour nothing
 * else in the frame uses, and the text transparent — so it is the true glyph
 * coverage, antialiasing included, whatever is underneath.
 */
async function worstContrastAroundText(
  page: Page,
  selector: string,
  radius = 3,
) {
  const target = page.locator(selector).first();
  const box = await target.boundingBox();
  if (!box) throw new Error(`no box for ${selector}`);
  // The navbar is sticky over the top ~64px; sampling under it measures the
  // navbar, not the hero.
  const top = Math.max(box.y, 72);
  const height = Math.min(
    box.height - (top - box.y),
    page.viewportSize()!.height - top,
  );
  if (height <= 4) return null;
  const clip = { x: box.x, y: top, width: box.width, height };

  const color = parseCssColor(
    await target.evaluate((node) => getComputedStyle(node).color),
  );

  const painted = decodePng(await page.screenshot({ clip }));

  // The mask is built by RECOLOURING the text, and several elements in this
  // block carry Tailwind's `transition-colors`. A colour transition means the
  // marked render can be caught part way to magenta and the blank render part
  // way to transparent, which quietly loses whole glyph pixels from the mask —
  // they then land in the annulus at their full text colour and the probe
  // reports 1.20:1 on an element that is perfectly legible. Observed on the
  // author link before this was added.
  const stillColours = await page.addStyleTag({
    content: `*, *::before, *::after {
      transition: none !important;
      animation: none !important;
    }`,
  });

  await padOff(page, true);
  const markedTag = await page.addStyleTag({
    content: `${selector} { color: #ff00ff !important; }`,
  });
  const marked = decodePng(await page.screenshot({ clip }));
  await markedTag.evaluate((node) => (node as Element).remove());
  const blankTag = await page.addStyleTag({
    content: `${selector} { color: transparent !important; }`,
  });
  const blank = decodePng(await page.screenshot({ clip }));
  await blankTag.evaluate((node) => (node as Element).remove());
  await padOff(page, false);
  await stillColours.evaluate((node) => (node as Element).remove());

  const glyphs = differenceMask(marked, blank, 10);
  const coverage = maskCoverage(glyphs) / (painted.width * painted.height);
  // A mask that covers nothing, or everything, is a broken measurement rather
  // than a legible or an illegible hero — fail loudly instead of reporting a
  // number derived from it.
  expect(
    coverage,
    `glyph mask covers ${(coverage * 100).toFixed(1)}% of ${selector}'s box — the probe is not measuring text`,
  ).toBeGreaterThan(0.02);
  expect(coverage).toBeLessThan(0.7);

  const ring = annulusAround(glyphs, painted.width, painted.height, radius);
  const { ratio, pixel, samples } = worstContrastInMask(painted, ring, color);
  expect(samples, "the annulus around the glyphs is empty").toBeGreaterThan(
    100,
  );
  return { ratio, pixel, color };
}

/**
 * Mean luminance of a column of the hero that no glyph can be in.
 *
 * `.zhero__content` is `mx-auto max-w-5xl` with `lg:px-8`, so at a 1024px
 * viewport the text starts at x=32 and this column is clear of it at every
 * scroll position. Clipped below the sticky navbar's live bottom edge: the
 * navbar is opaque and would otherwise average into rows that have nothing to
 * do with the hero.
 */
async function heroGutterLuminance(page: Page) {
  const window_ = await page.evaluate(() => {
    const hero = document
      .querySelector("section.zhero")!
      .getBoundingClientRect();
    const nav = document.querySelector("nav")?.getBoundingClientRect();
    return {
      top: Math.round(Math.max(0, hero.top, nav ? nav.bottom : 0)),
      bottom: Math.round(hero.bottom),
    };
  });
  const height = window_.bottom - window_.top;
  if (height < 8) return null;
  const png = decodePng(
    await page.screenshot({
      clip: { x: 8, y: window_.top, width: 16, height },
    }),
  );
  let sum = 0;
  for (let index = 0; index < png.data.length; index += png.channels) {
    sum +=
      0.2126 * png.data[index] +
      0.7152 * png.data[index + 1] +
      0.0722 * png.data[index + 2];
  }
  return { mean: sum / (png.width * png.height), height };
}

/**
 * Scroll to a fraction of the hero height. The hero sits
 * below the navbar, so `scrollTo(heroHeight * 0.8)` lands at exit ~0.7.
 */
async function scrollToExit(page: Page, fraction: number) {
  const geometry = await page.locator("section.zhero").evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { top: rect.top + window.scrollY, height: rect.height };
  });
  await scrollTo(page, Math.round(geometry.top + fraction * geometry.height));
  await sceneAtRest(page);
  expect(
    await heroExit(page),
    `asked for exit ${fraction} and the scene published something else`,
  ).toBeCloseTo(fraction, 1);
}

// ---------------------------------------------------------------------------
// 1. The content and hero must survive without
//    it — this is the  /  contract, re-asserted for the hero.
// ---------------------------------------------------------------------------

test.describe("a crawler with no JavaScript", () => {
  test.use({
    javaScriptEnabled: false,
    userAgent:
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  });

  test("still receives the title, the body and the hero image", async ({
    page,
  }) => {
    await page.goto(BRIGHT);

    // The headline and the prose are in the server's markup, not in a
    // hydration payload.
    await expect(page.locator("h1")).toHaveText("Bright hero fixture");
    const text = await page.evaluate(() =>
      document.body.innerText.replace(/\s+/g, " "),
    );
    expect(text).toContain("Bright hero fixture");
    expect(text).toContain(BODY_SENTINEL);

    // The hero image is server-rendered too, with the loading hints that make
    // it a usable LCP element rather than a deferred decoration.
    const image = page.locator(".hero-media__img");
    await expect(image).toHaveAttribute("fetchpriority", "high");
    await expect(image).toHaveAttribute("loading", "eager");
    await expect(image).toHaveAttribute("alt", "Bright hero fixture image");

    // Nothing has published a scroll position, so every animated declaration
    // sits at its rest value and the hero is a correctly composed still.
    const transform = await page
      .locator(".hero-media__plate")
      .evaluate((node) => getComputedStyle(node).transform);
    expect(["none", "matrix(1, 0, 0, 1, 0, 0)"]).toContain(transform);
  });

  test("an article with no featured image degrades to a clean title", async ({
    page,
  }) => {
    await page.goto(NO_IMAGE);

    await expect(page.locator("h1")).toHaveText("No image hero fixture");
    // No media layers at all, rather than an empty band where they would be.
    await expect(page.locator(".hero-media")).toHaveCount(0);
    //...and no reserved hero height either: the section is exactly its
    // content, so the byline sits where it would on any other page.
    const heroHeight = await page
      .locator("section.zhero")
      .evaluate((node) => node.getBoundingClientRect().height);
    expect(heroHeight).toBeLessThan(360);

    const text = await page.evaluate(() => document.body.innerText);
    expect(text).toContain(BODY_SENTINEL);
  });
});

// ---------------------------------------------------------------------------
// 2. prefers-reduced-motion is an accessibility requirement, not an option.
// ---------------------------------------------------------------------------

test.describe("prefers-reduced-motion: reduce", () => {
  // `page.emulateMedia`, not `test.use({ reducedMotion })`: this version of
  // @playwright/test omits `reducedMotion` from its test-options type even
  // though the browser context supports it, and `npm run check` type-checks
  // this directory. Emulating per page also exercises the live `matchMedia`
  // change listener, which is the path a reader toggling the OS setting takes.
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
  });

  test("the hero does not move at any scroll position", async ({ page }) => {
    await page.goto(BRIGHT);
    await heroReady(page);

    for (const offset of [0, 120, 260, 420, 900]) {
      await scrollTo(page, offset);

      const state = await page.evaluate(() => {
        const plate = document.querySelector<HTMLElement>(".hero-media__plate");
        const veil = document.querySelector<HTMLElement>(".hero-media__veil");
        const headline =
          document.querySelector<HTMLElement>(".zhero__headline");
        const styles = (node: HTMLElement | null) =>
          node ? getComputedStyle(node) : null;
        return {
          plate: styles(plate)?.transform,
          veil: styles(veil)?.opacity,
          headlineTransform: styles(headline)?.transform,
          headlineOpacity: styles(headline)?.opacity,
        };
      });

      const still = ["none", "matrix(1, 0, 0, 1, 0, 0)"];
      expect(still, `plate moved at scrollY=${offset}`).toContain(state.plate);
      expect(still, `headline moved at scrollY=${offset}`).toContain(
        state.headlineTransform,
      );
      expect(Number(state.veil), `veil ramped at scrollY=${offset}`).toBe(0);
      expect(
        Number(state.headlineOpacity),
        `headline faded at scrollY=${offset}`,
      ).toBe(1);
    }
  });

  test("the reading-progress bar still tracks the reader", async ({ page }) => {
    // Reduced motion suppresses decorative motion, not the reader's own
    // position indicator.
    await page.goto(BRIGHT);
    await heroReady(page);
    await scrollTo(page, 0);
    // This is the reading that most needed the strict reader: at the top of the
    // document the correct answer *is* ~0, so an unpublished property and a
    // healthy page are indistinguishable through `|| "0"` and the assertion
    // below would have passed on a page that never hydrated.
    const atTop = await published(page, READING_PROGRESS);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForFunction(() => {
      const bar = document.querySelector(".reading-progress");
      return bar && new DOMMatrix(getComputedStyle(bar).transform).a > 0.5;
    });
    expect(atTop).toBeLessThan(0.2);
  });
});

// ---------------------------------------------------------------------------
// 3. The effect itself.
// ---------------------------------------------------------------------------

for (const fixture of [BRIGHT, PANO]) {
  test(`scrolling leaves ${fixture} static without main style invalidation`, async ({
    page,
  }) => {
    await page.goto(fixture);
    await heroReady(page);
    await page.evaluate(() => {
      (window as any).__heroMutations = 0;
      const observer = new MutationObserver((records) => {
        (window as any).__heroMutations += records.length;
      });
      observer.observe(
        document.querySelector(
          "main[data-scroll-scene], main[data-hero-visible]",
        )!,
        {
          attributes: true,
          attributeFilter: ["style"],
        },
      );
      observer.observe(document.querySelector("section.zhero")!, {
        attributes: true,
        subtree: true,
        attributeFilter: ["style"],
      });
      (window as any).__heroObserver = observer;
    });
    for (const offset of [180, 300, 700, 100, 0]) {
      await scrollTo(page, offset);
      const styles = await page
        .locator(".hero-media__plate, .zhero__headline, .zhero__content")
        .evaluateAll((nodes) =>
          nodes.map((node) => {
            const style = getComputedStyle(node);
            return {
              transform: style.transform,
              opacity: style.opacity,
              willChange: style.willChange,
            };
          }),
        );
      for (const style of styles) {
        expect(style.transform).toBe("none");
        expect(style.opacity).toBe("1");
        expect(style.willChange).toBe("auto");
      }
    }
    expect(await page.evaluate(() => (window as any).__heroMutations)).toBe(0);
    await page.evaluate(() => (window as any).__heroObserver.disconnect());
  });
}

//"on a fast return to the top the title can remain absent for about a
// second and then appear or snap into place; slow reverse scrolling looks
// uneven." The causes were all machinery that ran on the way back IN: a spring
// that lagged the scroll, a dissolve keyed to it, inherited custom properties
// rewritten on <main> every frame, and an IntersectionObserver that handed the
// title's layer hints back only once the hero was already re-entering.
// removed all of it. The test above samples a warm hero at a handful of
// settled offsets; this one is the trajectory the report describes. It starts
// far enough below the hero that nothing of it is in the viewport, reverses,
// and reads the hero on EVERY frame of the way back — and, separately, on the
// very first frame after a jump to the top. A frame-time assertion would be
// hardware-dependent; this pins the property that makes the frames cheap:
// nothing about the hero is a function of time or of scroll.
for (const fixture of [BRIGHT, PANO]) {
  test(`${fixture}: a cold re-entry paints the resting hero on every frame`, async ({
    page,
  }) => {
    await page.goto(fixture);
    await heroReady(page);
    await layoutSettled(page);

    const result = await page.evaluate(async () => {
      const nextFrame = () =>
        new Promise<number>((resolve) => requestAnimationFrame(resolve));
      const hero = document.querySelector<HTMLElement>("section.zhero")!;
      // The ARTICLE <main> (the one `scrollScene` runs on), not the layout's
      // outer <main>: `document.querySelector("main")` finds the wrapper,
      // whose attributes nothing on the zPage ever writes, so a mutation guard
      // on it can never fail.
      const main = hero.closest<HTMLElement>("main");
      if (!main) throw new Error("hero is not inside a <main>");
      const tracked = [
        ".hero-media__plate",
        ".hero-media__bloom",
        ".hero-media__veil",
        ".zhero__headline",
        ".zhero__content",
        ".zhero__content h1",
      ].map((selector) => {
        const node = hero.querySelector<HTMLElement>(selector);
        if (!node) throw new Error(`hero has no ${selector}`);
        return [selector, node] as const;
      });

      // Everything the reader sees, expressed relative to the hero's own box so
      // that scrolling the document — which legitimately moves the whole hero —
      // is not itself a difference.
      function snapshot() {
        const heroTop = hero.getBoundingClientRect().top;
        return tracked.map(([selector, node]) => {
          const style = getComputedStyle(node);
          // `contain` fit sets the veil `display: none`; a box that is not
          // rendered has a viewport-origin rect, not one relative to the hero.
          if (node.getClientRects().length === 0) {
            return `${selector}|not rendered|${style.display}`;
          }
          const rect = node.getBoundingClientRect();
          return [
            selector,
            Math.round((rect.top - heroTop) * 10) / 10,
            Math.round(rect.height * 10) / 10,
            style.transform,
            style.opacity,
            style.willChange,
            style.visibility,
          ].join("|");
        });
      }

      window.scrollTo(0, 0);
      await nextFrame();
      await nextFrame();
      const rest = snapshot();
      const heroHeight = hero.getBoundingClientRect().height;
      const far = Math.min(
        document.documentElement.scrollHeight - innerHeight,
        Math.round(heroHeight + 3 * innerHeight),
      );

      let mutations = 0;
      const observer = new MutationObserver((records) => {
        mutations += records.length;
      });
      // <main> itself (not its subtree: the reading bar lives in there and is
      // supposed to move) and the hero's entire subtree, every attribute.
      observer.observe(main, { attributes: true });
      observer.observe(hero, { attributes: true, subtree: true });

      const differences: string[] = [];
      let animated = 0;
      let samples = 0;
      let partlyVisible = 0;
      function check(label: string) {
        samples += 1;
        animated += hero.getAnimations({ subtree: true }).length;
        const rect = hero.getBoundingClientRect();
        if (rect.bottom > 0 && rect.top < 0) partlyVisible += 1;
        const now = snapshot();
        now.forEach((line, index) => {
          if (line !== rest[index] && differences.length < 6) {
            differences.push(`${label}: ${line} (rest ${rest[index]})`);
          }
        });
      }

      async function goCold() {
        window.scrollTo(0, far);
        // Long enough for an observer callback and any off-screen release
        // to have run: the state the report starts from.
        for (let i = 0; i < 20; i += 1) await nextFrame();
      }

      // 1. A continuous reverse gesture, one step per frame, through the hero.
      await goCold();
      const coldScrollY = scrollY;
      const step = Math.max(8, Math.round(heroHeight / 12));
      for (let y = far - step; y > -step; y -= step) {
        window.scrollTo(0, Math.max(0, y));
        await nextFrame();
        check(`reverse scrollY=${scrollY}`);
      }

      // 2. A jump to the top after the stream has gone quiet: the FIRST frame
      //    must already be the resting hero.
      await goCold();
      window.scrollTo(0, 0);
      await nextFrame();
      check("first frame after jump");
      for (let i = 0; i < 10; i += 1) {
        await nextFrame();
        check(`frame ${i + 2} after jump`);
      }

      observer.disconnect();
      return {
        coldScrollY,
        heroHeight,
        samples,
        partlyVisible,
        animated,
        mutations,
        differences,
      };
    });

    // The harness itself: the page really was long enough to leave the hero
    // entirely behind, and the walk back really crossed it frame by frame.
    expect(result.coldScrollY).toBeGreaterThan(result.heroHeight * 2);
    expect(result.partlyVisible).toBeGreaterThanOrEqual(8);

    expect(
      result.differences,
      "the hero drew something other than its resting state on the way back",
    ).toEqual([]);
    expect(result.animated, "a hero animation ran during re-entry").toBe(0);
    expect(
      result.mutations,
      "re-entry rewrote hero or <main> attributes (layer hints, custom properties, visibility flags)",
    ).toBe(0);
  });
}

test("recomputes the image fit when hero geometry settles late", async ({
  page,
}) => {
  // The geometry is chosen so both expectations are settled answers of
  // `chooseHeroFit` at a *measured* box, not defaults. PANO is 4000x300 and
  // this suite's viewport is 390x844, so the hero section is ~390px wide:
  //
  //   - forced to 12rem (192px), the contained image renders ~390x29 — 15% of
  //     the box height, above IMAGE_FIT.minContainFraction, so `contain` is
  //     the settled answer while the forced rule below is live;
  //   - at the section's natural clamp(17rem, 44svh, 28rem) height (~371px),
  //     the same render is under 8% of the box — a ribbon — so the settled
  //     answer flips to `cover`.
  //
  // `cover` can therefore only appear if the component re-measures AFTER the
  // section has grown. The race is made deterministic rather than sampled:
  //
  //   - ResizeObserver is muted globally. A live observer would re-measure on
  //     the geometry change itself and let the old implementation — which only
  //     measures once per one-shot trigger — pass without doing any of the
  //     work this regression exists for.
  //   - document.fonts is replaced with a promise this test controls. With
  //     observers muted it is the fixed component's one remaining re-measure
  //     path (the font-settled pass), and holding it shut guarantees nothing
  //     measures after the style is removed until this test releases it.
  //   - The image bytes are held back until hydration has run. Hydration's
  //     complete-check and the load event both fire while the forced rule is
  //     live, so every measurement lands at 192px; a cold dev server that
  //     hydrated after the release would otherwise let the old component's
  //     one-shot read see the final geometry and pass vacuously.
  await page.addInitScript(() => {
    class QuietResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }

    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      value: QuietResizeObserver,
    });

    let resolveFonts: (() => void) | undefined;
    const fontsReady = new Promise<void>((resolve) => {
      resolveFonts = resolve;
    });
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { ready: fontsReady },
    });
    Object.defineProperty(window, "__resolveHeroFonts", {
      configurable: true,
      value: () => resolveFonts?.(),
    });

    const style = document.createElement("style");
    style.id = "hero-fit-early-layout";
    style.textContent =
      "section.zhero.zhero--media { height: 12rem !important; min-height: 12rem !important; }";
    // At addInitScript time Chromium has neither document.head nor
    // documentElement yet, so attaching waits for the document to grow them.
    const attach = () => {
      const root = document.head ?? document.documentElement;
      if (!root) return false;
      root.append(style);
      return true;
    };
    if (!attach()) {
      const documentObserver = new MutationObserver((_, observer) => {
        if (attach()) observer.disconnect();
      });
      documentObserver.observe(document, { childList: true });
    }
  });

  let releaseImage: (() => void) | undefined;
  const imageGate = new Promise<void>((resolve) => {
    releaseImage = resolve;
  });
  await page.route(/\/fixture-hero\.svg/, async (route) => {
    await imageGate;
    await route.continue();
  });

  // `domcontentloaded`, not the default `load`: the hero image is being held
  // back below, and `load` waits for it.
  await page.goto(PANO, { waitUntil: "domcontentloaded" });

  // Probe: the injected rule reached the document at all. An init script that
  // silently failed to attach its <style> would make everything below pass
  // against a page that never reproduced the bug.
  await page.waitForFunction(() =>
    Boolean(document.getElementById("hero-fit-early-layout")),
  );

  // Hydration gate: a published scroll scene proves the route's components
  // have mounted. The image bytes are still held back, so no fit measurement
  // can have happened yet — everything below measures inside the window.
  await sceneLive(page);

  releaseImage?.();
  await page.waitForFunction(() => {
    const image = document.querySelector<HTMLImageElement>(".hero-media__img");
    return !!image?.complete && image.naturalWidth > 0;
  });
  // Two frames: the load-triggered read runs on rAF and once more on the
  // frame after, so both passes land inside the short-height window.
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(null))),
      ),
  );

  // Probe: the forced layout is what those reads actually saw...
  const earlyHeroHeight = await page
    .locator("section.zhero")
    .evaluate((node) => node.getBoundingClientRect().height);
  expect(earlyHeroHeight).toBe(192);
  //...and what they measured was the settled answer for it.
  await expect(page.locator(".hero-media")).toHaveAttribute(
    "data-hero-fit",
    "contain",
  );

  // Grow the section and release the font-settled re-measure in one step,
  // before heroReady: post- that helper awaits document.fonts.ready,
  // which here is deliberately the promise this test owns.
  await page.evaluate(() => {
    document.getElementById("hero-fit-early-layout")?.remove();
    (
      window as typeof window & { __resolveHeroFonts?: () => void }
    ).__resolveHeroFonts?.();
  });

  await heroReady(page);
  const settledHeroHeight = await page
    .locator("section.zhero")
    .evaluate((node) => node.getBoundingClientRect().height);
  expect(settledHeroHeight).toBeGreaterThan(earlyHeroHeight);
  await expect(page.locator(".hero-media")).toHaveAttribute(
    "data-hero-fit",
    "cover",
  );
});

test("no layout is read for the article while scrolling", async ({ page }) => {
  // The rule the whole implementation is built around. `scrollScene` measures
  // the article on resize only; if a refactor ever puts a `getBoundingClientRect`
  // back into the scroll path, this is where it shows up.
  //
  // Patched with `evaluate` rather than `addInitScript` on purpose: an init
  // script does not share a JavaScript realm with the application's own
  // modules, so it counts nothing they do. The control assertion below is what
  // proves this patch is actually in the app's path.
  await page.goto(BRIGHT);
  await heroReady(page);

  await page.evaluate(() => {
    (window as any).__articleRectReads = 0;
    const original = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      if (this.matches?.("article")) {
        (window as any).__articleRectReads += 1;
      }
      return original.apply(this);
    };
  });

  const readCount = () =>
    page.evaluate(() => (window as any).__articleRectReads as number);

  // Control: a resize *must* re-measure the article. If this is 0 the patch is
  // not in the app's path and the assertion below would pass vacuously.
  await page.setViewportSize({ width: 380, height: 800 });
  await page.waitForFunction(() => (window as any).__articleRectReads > 0);
  expect(await readCount()).toBeGreaterThan(0);

  await page.evaluate(() => {
    (window as any).__articleRectReads = 0;
  });

  const steps = 40;
  await page.evaluate(async (count) => {
    for (let i = 1; i <= count; i += 1) {
      window.scrollTo(0, i * 12);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }, steps);

  const during = await readCount();
  // Zero in practice; the allowance is for a mobile-chrome resize landing
  // mid-run, which legitimately re-measures.
  expect(
    during,
    `${during} article layout reads across ${steps} scroll frames`,
  ).toBeLessThan(4);

  //...and the effect was genuinely live while doing so.
  expect(await published(page, READING_PROGRESS)).toBeGreaterThan(0);
});

test("the blurred layer costs no extra bytes and LCP stays the hero image", async ({
  page,
}) => {
  // The bloom is a second `<img>`. Pointing it at a smaller variant would be
  // the obvious optimisation and is exactly the trap: a second URL is a second
  // request, and — being an image element of comparable size — a second LCP
  // candidate that resolves later than the one being optimised for. Same
  // sources means one request and one candidate.
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("fixture-hero.svg"))
      requests.push(request.url());
  });

  await page.goto(BRIGHT);
  await heroReady(page);
  await page.waitForTimeout(600);

  expect(new Set(requests).size, `distinct hero image URLs: ${requests}`).toBe(
    1,
  );
  expect(requests.length, "the hero image was fetched more than once").toBe(1);

  // Deliberately not asserting which element Chrome reports as LCP: these
  // fixtures are flat generated SVGs, and Chrome excludes low-entropy images
  // from LCP candidacy, so the answer here would be an artefact of the fixture
  // rather than of the hero. The loading hints on the real element are asserted
  // in the no-JavaScript test above; what matters here is that the bloom did
  // not introduce a second, later-arriving candidate at all.
  const bloom = page.locator(".hero-media__bloom img");
  await expect(bloom).toHaveCount(1);
  expect(
    await bloom.getAttribute("src"),
    "the bloom must share the plate's source exactly",
  ).toBe(await page.locator(".hero-media__img").getAttribute("src"));
});

test("expanding the outline re-measures the reading progress", async ({
  page,
}) => {
  // Found by the codex adversarial review. An element's *position* can change
  // without its *size* changing: the table of contents sits between the hero
  // and the article, and expanding its outline pushes the article hundreds of
  // pixels down the document while the article's own box is untouched. A
  // `ResizeObserver` on the article alone never fires for that, so the cached
  // document-space bottom goes stale and the reading bar finishes early.
  await page.goto(OUTLINE);
  await heroReady(page);
  await scrollTo(page, 1200);

  //  waited here for `--reading-progress` to become greater than zero.
  // That is now covered upstream, for every property and every test in this
  // file, by the `sceneLive()` gate inside `scrollTo` and `heroReady` — and it
  // is covered as "the scene has published", which is a claim that stays true
  // at scroll positions where zero is the honest answer.
  const before = await published(page, READING_PROGRESS);
  expect(before, "pick a scroll position with somewhere to go").toBeGreaterThan(
    0.05,
  );

  const toggle = page.getByRole("button", { name: /on this page/i }).first();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");

  // The panel opens on a 200ms `grid-template-rows` transition, so the article
  // slides down over several frames. Wait for that specific transition and then
  // for the document to stop changing shape, rather than sleeping for a
  // wall-clock guess at how long both take.
  await animationsFinished(page, ".toc-inline-panel");
  await layoutSettled(page);

  // The article now ends further down the document, so the same scroll
  // position is a smaller fraction of the way through it.
  const after = await published(page, READING_PROGRESS);
  expect(
    after,
    `progress did not respond to the article moving (${before} -> ${after})`,
  ).toBeLessThan(before - 0.01);

  //...and the sharper form: the cached metric agrees with live geometry.
  //
  // Both numbers come out of one `evaluate`: scroll anchoring can move
  // `window.scrollY` while the outline expands, and reading them in two
  // round-trips compares a published value against a live value computed at a
  // different scroll position. (Raised by the codex review.)
  const drift = await page.evaluate(() => {
    const bar = document.querySelector<HTMLElement>(".reading-progress");
    const article = document.querySelector("article");
    const scrollY = window.scrollY;
    const bottom = (article?.getBoundingClientRect().bottom ?? 0) + scrollY;
    const span = bottom - window.innerHeight;
    const raw = bar?.style.transform
      ? new DOMMatrix(getComputedStyle(bar).transform).a
      : null;
    return {
      scrollY,
      live: span > 0 ? Math.min(1, Math.max(0, scrollY / span)) : 1,
      published: raw,
    };
  });
  expect(
    drift.published,
    "--reading-progress was never published — the scroll scene is not live",
  ).not.toBeNull();
  expect(
    Math.abs((drift.published as number) - drift.live),
    `cached reading progress drifted from reality: ${JSON.stringify(drift)}`,
  ).toBeLessThan(0.01);
});

test("the hero reserves its space, so nothing shifts", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__cls = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as any[]) {
        if (!entry.hadRecentInput) (window as any).__cls += entry.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  });

  await page.goto(BRIGHT);
  await heroReady(page);
  await page.waitForTimeout(400);

  const cls = await page.evaluate(() => (window as any).__cls as number);
  // Google's "good" threshold is 0.1; a hero that reserved nothing scores far
  // above it the moment the image decodes.
  expect(cls).toBeLessThan(0.1);
});

// ---------------------------------------------------------------------------
// 4. The readability guarantee, measured off real pixels.
// ---------------------------------------------------------------------------

test("the headline is painted above the hero's scrim layers", async ({
  page,
}) => {
  // This exists because of a bug that every other kind of assertion missed.
  // `.hero-media` is `position: absolute`, which does NOT create a stacking
  // context, so its five internal layers (`z-index: 1..5`) resolved against an
  // ancestor and painted *over* the headline. The title was in the DOM, in the
  // accessibility tree, correctly styled, and a contrast probe of the region
  // read a perfect ratio — because it was probing the scrim that was covering
  // it. A human saw a black rectangle.
  //
  // The only assertion that catches that: the text has to change pixels.
  // `pointer-events: none` on the media layers means even `elementFromPoint`
  // reports the headline, so hit-testing cannot be trusted here either.
  await page.goto(BRIGHT);
  await heroReady(page);

  const box = await page.locator("h1").boundingBox();
  if (!box) throw new Error("no headline box");
  const clip = { x: box.x, y: box.y, width: box.width, height: box.height };

  const painted = decodePng(await page.screenshot({ clip }));
  const styleTag = await page.addStyleTag({
    content: ".zhero__headline h1 { color: transparent !important; }",
  });
  const blank = decodePng(await page.screenshot({ clip }));
  await styleTag.evaluate((node) => (node as Element).remove());

  let differing = 0;
  for (let index = 0; index < painted.data.length; index += painted.channels) {
    if (painted.data[index] !== blank.data[index]) differing += 1;
  }
  const total = painted.width * painted.height;
  expect(
    differing / total,
    "the headline's glyphs changed almost no pixels — something is painted over it",
  ).toBeGreaterThan(0.05);
});

/**
 * The `contain`-fit headline paints NO full-width layer over the cover.
 *
 * This is the owner's complaint stated directly, and it replaces "the band's
 * top edge is a gradient, not a line". That test measured how gently a band
 * arrived; the answer to the report was that a band arriving gently is still a
 * band. On the reference zPage it covered the character's body, the book and
 * the hands, and 's long ramp gave none of them back.
 *
 * Two halves, because either alone can pass on a broken tree:
 *
 *   1. Computed style — there is no `::before` box, no `backdrop-filter`
 *      anywhere in the headline, and the block itself has no background image
 *      or colour. This catches a band that is present but happens to be
 *      invisible on this fixture.
 *   2. Pixels — neutralising every background the headline could paint changes
 *      NOTHING, because there is nothing to neutralise. That is the same probe
 *      the band test used, run for the opposite answer, so a reintroduced band
 *      fails here whatever element it is painted on.
 *
 * The positive control is the third assertion: the column must actually read
 * as the near-white photograph. Without it, a hero that failed to render its
 * image at all would satisfy both halves.
 *
 * Dark scheme over the near-white fixture, at a 1024px viewport so the x=8
 * column sits outside `.zhero__content`'s `lg:px-8` and contains no glyph and
 * no pad. On `origin/main` this column reads ~10 luminance under the band and
 * removing the band swings it by ~175; here it reads ~250 and removing
 * nothing swings it by ~0.
 */
test.describe("the contain-fit headline paints nothing over the cover", () => {
  test.use({ colorScheme: "dark", viewport: { width: 1024, height: 1000 } });

  test("no band, no backdrop filter, and the photograph is whole", async ({
    page,
  }) => {
    await page.goto(BRIGHT);
    await heroReady(page);
    await expect(page.locator(".hero-media")).toHaveAttribute(
      "data-hero-fit",
      "contain",
    );

    const layers = await page.evaluate(() => {
      const headline = document.querySelector<HTMLElement>(".zhero__headline")!;
      const content = document.querySelector<HTMLElement>(".zhero__content")!;
      const before = getComputedStyle(headline, "::before");
      return {
        beforeContent: before.content,
        beforeBackgroundImage: before.backgroundImage,
        headlineBackgroundImage: getComputedStyle(headline).backgroundImage,
        headlineBackgroundColor: getComputedStyle(headline).backgroundColor,
        contentBackgroundImage: getComputedStyle(content).backgroundImage,
        backdrops: [
          getComputedStyle(headline).backdropFilter,
          before.backdropFilter,
          getComputedStyle(content).backdropFilter,
        ],
      };
    });

    // `content: none` is what a pseudo-element that was never generated
    // reports; a live `::before` reports `""` (or its string).
    expect(
      layers.beforeContent,
      "the contain-fit headline still generates a ::before — that is the band",
    ).toBe("none");
    expect(layers.headlineBackgroundImage).toBe("none");
    expect(
      ["rgba(0, 0, 0, 0)", "transparent"],
      `the headline block still paints ${layers.headlineBackgroundColor}`,
    ).toContain(layers.headlineBackgroundColor);
    expect(layers.contentBackgroundImage).toBe("none");
    for (const backdrop of layers.backdrops) {
      expect(backdrop, "a backdrop-filter survived the band's removal").toBe(
        "none",
      );
    }

    // Neutralises any background the headline could paint, wherever it lives:
    // the block, a pseudo-element, or the content wrapper.
    const bandOff = `
      .zhero__headline, .zhero__headline::before, .zhero__content {
        background: transparent !important;
        -webkit-backdrop-filter: none !important;
        backdrop-filter: none !important;
      }
    `;

    const painted = await heroGutterLuminance(page);
    expect(painted, "the hero is not visible at rest").not.toBeNull();
    const styleTag = await page.addStyleTag({ content: bandOff });
    const bare = await heroGutterLuminance(page);
    await styleTag.evaluate((node) => (node as Element).remove());

    expect(
      Math.abs(bare!.mean - painted!.mean),
      `removing the headline's background changed the hero by ` +
        `${Math.abs(bare!.mean - painted!.mean).toFixed(1)} luminance — it has one`,
    ).toBeLessThanOrEqual(2);

    // Positive control, and the owner's requirement stated as a number: the
    // near-white cover is what is on screen. Under the band this column read
    // ~10.
    expect(
      painted!.mean,
      `the hero's gutter reads ${painted!.mean.toFixed(0)} luminance — ` +
        `something is still covering the photograph`,
    ).toBeGreaterThan(140);
  });
});

/**
 * The headline's treatment reaches only as far as its own blur radius.
 *
 * The band version of this test forced the band opaque and checked the back
 * arrow still changed pixels, because the band's lead-in genuinely reached the
 * topbar on a five-line title: it painted over the controls AND took them as
 * the backdrop its `blur(14px)` operated on, leaving them soft, washed and —
 * thanks to `pointer-events: none` — still clickable.
 *
 * The half of that hazard which was structural is gone with the band and is
 * pinned above ("no backdrop-filter"). What replaces the other half is the
 * property that made the band unbounded in the first place: a band's reach is
 * whatever its geometry says (7rem, here, and it could have been anything),
 * while a pad's reach is its widest shadow radius and nothing else.
 *
 * So: the rows just ABOVE the first line of the headline must be bare
 * photograph. The widest radius is 12px, so 16px of clearance is measured from
 * 28px to 12px above the `h1`'s box — far enough out that the pad cannot be
 * there, close enough that the band demonstrably was: 's mask reaches
 * full strength 1.25rem (20px) above the `h1`'s top edge, so on `origin/main`
 * this strip is solid `--background` and reads ~10 luminance against the
 * ~250 it reads here.
 *
 * The five-line-title fixture, because it is the case where the headline
 * starts highest in the photograph, and the dark theme over the near-white
 * cover, because there a wash is a ~175-point swing rather than a rounding
 * error.
 */
test.describe("the headline's treatment stays inside its own radius", () => {
  test.use({ colorScheme: "dark" });

  test("the rows above the first line are bare photograph", async ({
    page,
  }) => {
    await page.goto(LONG_TITLE);
    await heroReady(page);
    await expect(page.locator(".hero-media")).toHaveAttribute(
      "data-hero-fit",
      "contain",
    );

    const headingBox = await page.locator("h1").boundingBox();
    if (!headingBox) throw new Error("no headline box");
    const topbarBottom = await page
      .locator("section.zhero button")
      .first()
      .evaluate((node) => node.getBoundingClientRect().bottom);

    const strip = {
      x: 0,
      y: Math.round(headingBox.y - 28),
      width: page.viewportSize()!.width,
      height: 16,
    };
    // The probe has to be measuring the cover, not the topbar row: on a short
    // hero those can overlap, and a strip that contains the back button reads
    // dark for a reason that has nothing to do with the headline.
    expect(
      strip.y,
      "the strip overlaps the topbar controls — it is measuring the wrong rows",
    ).toBeGreaterThan(topbarBottom);

    const png = decodePng(await page.screenshot({ clip: strip }));
    let sum = 0;
    for (let index = 0; index < png.data.length; index += png.channels) {
      sum +=
        0.2126 * png.data[index] +
        0.7152 * png.data[index + 1] +
        0.0722 * png.data[index + 2];
    }
    const mean = sum / (png.width * png.height);
    expect(
      mean,
      `the 16px of cover ending 12px above the headline averages ` +
        `${mean.toFixed(0)} luminance over a near-white image — the ` +
        `headline's treatment reaches further than its own blur radius`,
    ).toBeGreaterThan(140);

    //...and the back arrow is still painted. Carried over from the band
    // version unchanged: a layer sitting ON the control leaves its box
    // uniform, so hiding the icon then changes nothing. It passed before this
    // change too — the topbar's `z-10` is what makes it true and that is not
    // what moved — but deleting a live guard on the way past is how the next
    // change to this area gets to break it silently.
    const box = await page
      .locator("section.zhero button")
      .first()
      .boundingBox();
    if (!box) throw new Error("no back button box");
    const clip = {
      x: Math.round(box.x),
      y: Math.round(box.y),
      width: Math.round(box.width),
      height: Math.round(box.height),
    };
    const painted = decodePng(await page.screenshot({ clip }));
    const hideIcon = await page.addStyleTag({
      content: `section.zhero button svg { opacity: 0 !important; }`,
    });
    const blank = decodePng(await page.screenshot({ clip }));
    await hideIcon.evaluate((node) => (node as Element).remove());

    let differing = 0;
    for (
      let index = 0;
      index < painted.data.length;
      index += painted.channels
    ) {
      if (painted.data[index] !== blank.data[index]) differing += 1;
    }
    const total = painted.width * painted.height;
    expect(
      differing / total,
      "the back arrow changed almost no pixels — something is painted over the topbar",
    ).toBeGreaterThan(0.01);
  });
});

/** The image remains unobscured while the static text and controls stay opaque.
 * Hiding the image is a positive control for the gutter pixel measurement. */
test.describe("the photograph stays whole and the text remains opaque", () => {
  test.use({ colorScheme: "dark", viewport: { width: 1024, height: 1000 } });

  test("the gutter is photograph at every exit and controls stay visible", async ({
    page,
  }) => {
    await page.goto(BRIGHT);
    await heroReady(page);
    await expect(page.locator(".hero-media")).toHaveAttribute(
      "data-hero-fit",
      "contain",
    );

    const contentOpacity = () =>
      page
        .locator(".zhero__content")
        .evaluate((node) => Number(getComputedStyle(node).opacity));

    // Positive control: the gutter really is showing the hero's image.
    await scrollToExit(page, 0);
    const withImage = await heroGutterLuminance(page);
    expect(withImage, "the hero is not visible at rest").not.toBeNull();
    const mediaOff = await page.addStyleTag({
      content: `.hero-media { display: none !important; }`,
    });
    const withoutImage = await heroGutterLuminance(page);
    await mediaOff.evaluate((node) => (node as Element).remove());
    expect(
      Math.abs(withImage!.mean - withoutImage!.mean),
      "hiding the hero image changed nothing — the probe is measuring the wrong pixels",
    ).toBeGreaterThan(60);

    for (const exit of [0, 0.45, 0.8]) {
      await scrollToExit(page, exit);
      const gutter = await heroGutterLuminance(page);
      expect(gutter, `the hero is not visible at ${exit} exit`).not.toBeNull();
      // Dark theme, near-white cover: anything under this is a layer between
      // the reader and the picture. Under 's band this read ~10 at rest
      // and ~10 at 0.45.
      expect(
        gutter!.mean,
        `at ${exit} exit the hero's gutter reads ${gutter!.mean.toFixed(0)} ` +
          `luminance — something is covering the photograph`,
      ).toBeGreaterThan(140);
    }

    for (const exit of [0.45, 0.8]) {
      await scrollToExit(page, exit);
      expect(
        await contentOpacity(),
        "hero controls must remain fully visible",
      ).toBe(1);
    }
  });
});

/**
 * The hero's bottom rows show the picture, at every exit.
 *
 * The inverse of the assertion that used to live here, and the inversion IS
 * the change. The old one demanded those rows stay DARK: the band overhung the
 * hero's bottom edge by 3rem so the parallax — headline lifting 1.25rem, plate
 * drifting 5% down — could not part the two and expose a hard-edged strip of
 * sharp image between them. That was a real defect of a design where the
 * bottom of the picture was covered; with nothing covering it there is no edge
 * to open, and demanding darkness down there would now be demanding the bug
 * the owner reported.
 *
 * So the same rows, the same exits, the opposite threshold: over the near-white
 * fixture in the dark theme the hero's last 20px must READ as the photograph.
 * Sampled full width, because the strip in the original report ran edge to
 * edge and a narrow column can sit in the one place it does not.
 */
test.describe("the bottom of the cover is visible, not covered", () => {
  test.use({ colorScheme: "dark" });

  test("the hero's bottom rows read as photograph while it exits", async ({
    page,
  }) => {
    await page.goto(BRIGHT);
    await heroReady(page);
    await expect(page.locator(".hero-media")).toHaveAttribute(
      "data-hero-fit",
      "contain",
    );

    const heroHeight = await page
      .locator("section.zhero")
      .evaluate((node) => node.getBoundingClientRect().height);

    for (const fraction of [0, 0.15, 0.3, 0.45]) {
      await scrollTo(page, Math.round(heroHeight * fraction));
      await sceneAtRest(page);

      const box = await page.locator("section.zhero").evaluate((node) => {
        const rect = node.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, height: rect.height };
      });

      // The hero's last 20px — below `.zhero__content`'s own 2rem of bottom
      // padding, so no glyph and no pad is in them.
      const height = 20;
      const y = Math.round(box.bottom - height);
      if (y < 0) continue;

      const png = decodePng(
        await page.screenshot({
          clip: { x: 0, y, width: page.viewportSize()!.width, height },
        }),
      );

      // The MEAN, not the brightest pixel: a single bright pixel would let a
      // 99%-covered strip pass. Under 's band this averaged ~10.
      let sum = 0;
      for (let index = 0; index < png.data.length; index += png.channels) {
        sum +=
          0.2126 * png.data[index] +
          0.7152 * png.data[index + 1] +
          0.0722 * png.data[index + 2];
      }
      const mean = sum / (png.width * png.height);

      expect(
        mean,
        `at ${Math.round(fraction * 100)}% exit the hero's last ${height}px ` +
          `average ${mean.toFixed(0)} luminance over a near-white cover — ` +
          `the bottom of the picture is still behind something`,
      ).toBeGreaterThan(140);
    }
  });
});

/**
 * The contrast matrix — the whole safety argument for this area of the code.
 *
 * Thresholds and sample points are UNCHANGED from the band: >= 4.5:1 at exits
 * 0, 0.15, 0.30 and 0.45, over a near-white and a near-black cover, in both
 * themes. What changed is how "the background" is obtained, and it had to.
 *
 * A whole-box probe would sample the intentionally unpadded photograph
 * between words. Instead, build a glyph mask with BOTH the text shadows and
 * local filters disabled, then measure the painted backing around that mask.
 * Disabling only filters would leave text shadows in the blank render and
 * corrupt the mask.
 *
 * So the claim is stated locally instead: within 3px of every glyph the reader
 * gets 4.5:1. See `worstContrastAroundText` for why 3px and how the glyph mask
 * is recovered. The photograph BETWEEN the words is deliberately not in the
 * claim — showing it is the change.
 *
 * The description is measured too, and it is not a bonus: regular-weight
 * `text-muted-foreground` over a photograph is the weak spot a pad exposes and
 * a band hid. It could not be padded to 4.5:1 at any density a halo can reach
 * (the light theme needs a ~92% pad everywhere), which is why the hero's
 * secondary text moved to `--f2z-text-secondary`. A test that only ever
 * measured the bold `h1` would have let that ship.
 */
for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`headline contrast (${colorScheme})`, () => {
    test.use({ colorScheme });

    for (const [name, url, fallbackFont] of [
      ["a near-white image", BRIGHT],
      ["a near-black image", DARK],
      [
        "a near-white image behind boost and ZEC chips",
        "/hero-user/hero-chips-bright-fixture",
      ],
      [
        "a near-black image behind boost and ZEC chips",
        "/hero-user/hero-chips-dark-fixture",
      ],
      // A five-line title reaches far up into the photograph, where a scrim
      // anchored to a percentage of the hero has nothing left to give. It is
      // still the worst case for the pad, for a different reason: more glyphs
      // means more chances to find a thin one. It measures 6.08:1 where the
      // one-line title measures 8.45:1.
      ["a near-white image under a five-line title", LONG_TITLE],
      // The supported Arial fallback has thinner glyph raster coverage than
      // macOS's system font. It exposed a real Linux contrast failure.
      ["a near-black image in the Arial fallback font", DARK, "Arial"],
      [
        "a near-white image under a long title in the Arial fallback font",
        LONG_TITLE,
        "Arial",
      ],
    ] as const) {
      test(`stays legible over ${name}`, async ({ page }) => {
        await page.goto(url);
        if (fallbackFont) {
          await page.addStyleTag({
            content: `:root { --f2z-font-base: ${fallbackFont}, sans-serif; }`,
          });
        }
        await heroReady(page);
        await expect(page.locator(".hero-media")).toHaveAttribute(
          "data-hero-fit",
          "contain",
        );

        // The byline is addressed by a utility class below, which is exactly
        // the kind of selector that silently starts matching something else.
        // Prove it is the date and read-time before measuring it.
        await expect(
          page.locator(".zhero__content .text-xs").first(),
          "the byline probe is not pointed at the date/read-time line",
        ).toContainText(/min read|\d{4}/);
        //...and the author probe at the name, not at the avatar link that
        // carries the same `rel="author"` one element earlier. The name link
        // is no longer childless --  wrapped the display name in `<bdi>`,
        // because it is arbitrary user text sitting in a row of LTR chrome --
        // so the discriminator is what the AVATAR link wraps: an `<img>`, or a
        // `<div>` with the initial when there is no avatar. `:not(:has(*))`
        // matched nothing at all after that change, and this assertion is
        // exactly why it was caught rather than silently measuring the wrong
        // element.
        await expect(
          page.locator('.zhero__content a[rel="author"]:not(:has(img, div))'),
          "the author probe must match exactly the name link",
        ).toHaveCount(1);

        const heroHeight = await page
          .locator("section.zhero")
          .evaluate((node) => node.getBoundingClientRect().height);

        const contrastSamples: {
          selector: string;
          fraction: number;
          ratio: number;
        }[] = [];
        for (const fraction of [0, 0.15, 0.3, 0.45]) {
          await scrollTo(page, Math.round(heroHeight * fraction));
          // Not optional: the pairing this probe does is defeated by a spring
          // that is still travelling. See `sceneAtRest`.
          await sceneAtRest(page);

          const chipProbes = url.includes("hero-chips-")
            ? ([
                ['[data-testid="zpage-hero-score"]', "the boost score chip"],
                ['[data-testid="zpage-hero-raised"]', "the ZEC raised chip"],
              ] as const)
            : [];
          for (const [selector, what] of [
            ["h1", "the headline"],
            [".zhero__content p", "the description"],
            // The byline's date and read-time: a bare 12px `<span>` with
            // nothing behind it, and the thing the band was silently backing.
            // Added because the codex review pointed out the pad rule's
            // original selector covered the paragraphs only, on the false
            // premise that the byline "sits on its own box"; measured, it was
            // at 4.19:1 with the matrix green, because the matrix only ever
            // looked at the `h1` and the description.
            [".zhero__content .text-xs", "the byline"],
            // The author name, for the same reason one round later: the codex
            // review's second pass noted it is a 14px `<a>` and so is covered
            // by neither the paragraph nor the span rule. Measured it does not
            // need one — semibold at 14px it reads 14.42 / 11.82 / 9.14 / 6.99
            // at 1/2/3/4px, well clear of the line — so the CSS is unchanged
            // and this is here purely so that stops being an unwatched claim.
            // `:not(:has(img, div))` is what separates it from the avatar
            // link beside it, which carries the same `rel` and wraps either an
            // `<img>` or the initial's `<div>`. It used to be `:not(:has(*))`;
            // the name link now contains a `<bdi>`.
            [
              '.zhero__content a[rel="author"]:not(:has(img, div))',
              "the author link",
            ],
            ...chipProbes,
          ] as const) {
            const measured = await worstContrastAroundText(page, selector);
            if (!measured) continue;
            contrastSamples.push({ selector, fraction, ratio: measured.ratio });
            expect(
              measured.ratio,
              `${colorScheme} / ${name} / ${what} at ` +
                `${Math.round(fraction * 100)}% exit: worst pixel within 3px ` +
                `of a glyph is rgb(${measured.pixel}) against ` +
                `rgb(${measured.color})`,
            ).toBeGreaterThanOrEqual(4.5);
          }
        }
        if (url.includes("hero-chips-")) {
          for (const selector of [
            '[data-testid="zpage-hero-score"]',
            '[data-testid="zpage-hero-raised"]',
          ]) {
            expect(
              contrastSamples.some(
                (sample) =>
                  sample.selector === selector && sample.fraction === 0,
              ),
              `the visible ${selector} must be measured`,
            ).toBe(true);
          }
        }
        await test.info().attach("glyph-contrast", {
          body: JSON.stringify(contrastSamples),
          contentType: "application/json",
        });
      });
    }
  });
}

/**
 * The pad is `var(--background)`, so it is a DIFFERENT colour in each theme.
 *
 * The failure this exists for is specific and would ship an unreadable page:
 * the light theme is `--foreground: #18181b` on `--background: #fafafa`, so
 * the headline text is dark there. A pad hardcoded to black — the obvious
 * thing to write, and the thing that looks right in every dark-mode screenshot
 * is black-on-black in the light theme. Every other assertion in this file
 * runs in both themes and would still pass, because a black pad over a
 * near-BLACK cover measures fine and a near-white cover in the light theme
 * needs no pad at all.
 *
 * Assert the resolved text-shadow colour and that the large content wrapper
 * has no GPU filter: the former protects legibility, the latter protects the
 * headed 120 Hz rendering path that a headless 60 Hz CI run did not expose.
 */
test("the glyph pad resolves from --background in both themes", async ({
  browser,
}) => {
  const read = async (colorScheme: "light" | "dark") => {
    const context = await browser.newContext({ colorScheme });
    const page = await context.newPage();
    await page.goto(BRIGHT);
    await heroReady(page);
    const state = await page.evaluate(() => {
      const content = document.querySelector<HTMLElement>(".zhero__content")!;
      const paragraph =
        document.querySelector<HTMLElement>(".zhero__content p");
      // Resolve the tokens through a real element rather than reading the
      // custom property: `getPropertyValue("--background")` can hand back
      // `var(--f2z-bg-primary)`, which is a token, not a colour.
      const probe = document.createElement("div");
      probe.style.display = "none";
      probe.style.color = "var(--muted-foreground)";
      probe.style.backgroundColor = "var(--background)";
      document.body.append(probe);
      const probed = getComputedStyle(probe);
      const resolved = {
        background: probed.backgroundColor,
        muted: probed.color,
      };
      probe.remove();
      return {
        filter: getComputedStyle(content).filter,
        textShadow: getComputedStyle(content).textShadow,
        paragraphFilter: paragraph
          ? getComputedStyle(paragraph).filter
          : "none",
        paragraphShadow: paragraph
          ? getComputedStyle(paragraph).textShadow
          : "none",
        background: resolved.background,
        descriptionColor: paragraph ? getComputedStyle(paragraph).color : "",
        rootMuted: resolved.muted,
      };
    });
    await context.close();
    return state;
  };

  const [light, dark] = await Promise.all([read("light"), read("dark")]);

  for (const [scheme, state] of [
    ["light", light],
    ["dark", dark],
  ] as const) {
    // GPU drop-shadow passes caused the headed 120 Hz first-scroll stalls.
    expect(state.filter, `${scheme}: headline has a live GPU filter`).toBe(
      "none",
    );
    expect(
      state.paragraphFilter,
      `${scheme}: thin description carries no local pad`,
    ).toMatch(/drop-shadow\(/);
    expect(
      state.textShadow,
      `${scheme}: headline carries no glyph pad`,
    ).not.toBe("none");
    expect(
      state.paragraphShadow,
      `${scheme}: description carries no glyph pad`,
    ).toBe(state.textShadow);

    const padColor = parseCssColor(/rgba?\([^)]*\)/.exec(state.textShadow)![0]);
    const background = parseCssColor(state.background);
    expect(
      padColor,
      `${scheme}: pad rgb(${padColor}) is not --background rgb(${background})`,
    ).toEqual(background);
  }

  //...and the two themes really do resolve to different colours, which is the
  // assertion a hardcoded black cannot satisfy.
  expect(light.textShadow).not.toBe(dark.textShadow);
  expect(light.background).not.toBe(dark.background);

  // The hero's secondary text is raised off `--muted-foreground` in `contain`
  // fit. Pinned here because the mechanism is Tailwind's `@theme inline`
  // resolving `var(--muted-foreground)` at the using element: if that ever
  // stops being true the description silently falls back to a colour that
  // cannot be padded to 4.5:1 in the light theme.
  for (const [scheme, state] of [
    ["light", light],
    ["dark", dark],
  ] as const) {
    expect(
      parseCssColor(state.descriptionColor),
      `${scheme}: the hero description is still --muted-foreground ` +
        `(${state.rootMuted}), which cannot carry 4.5:1 over a photograph`,
    ).not.toEqual(parseCssColor(state.rootMuted));
  }
});

// Opaque controls already pair primary foreground/background. Photograph
// backing would instead shadow their labels with the opposite theme token.
for (const colorScheme of ["light", "dark"] as const) {
  test(`opaque hero controls keep clean contrast in ${colorScheme}`, async ({
    browser,
  }) => {
    const context = await browser.newContext({ colorScheme });
    const page = await context.newPage();
    await page.goto("/hero-user/hero-chips-bright-fixture");
    await heroReady(page);
    const controls = [
      page.locator('.zhero__content a[rel="author"] > div'),
      page
        .locator(".zhero__content")
        .getByRole("button", { name: "Subscribe", exact: true }),
    ];
    for (const control of controls) {
      await expect(control).toBeVisible();
      await expect(control).toHaveCSS("text-shadow", "none");
      const colors = await control.evaluate((node) => {
        const style = getComputedStyle(node);
        return { color: style.color, background: style.backgroundColor };
      });
      expect(
        contrastRatio(
          parseCssColor(colors.color),
          parseCssColor(colors.background),
        ),
      ).toBeGreaterThanOrEqual(4.5);
    }
    await context.close();
  });
}

test("light and dark really are different renders", async ({ browser }) => {
  // Guards the matrix above from silently testing one theme twice.
  const read = async (colorScheme: "light" | "dark") => {
    const context = await browser.newContext({ colorScheme });
    const page = await context.newPage();
    await page.goto(BRIGHT);
    await heroReady(page);
    const background = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue(
        "--background",
      ),
    );
    await context.close();
    return background.trim();
  };

  const [light, dark] = await Promise.all([read("light"), read("dark")]);
  expect(light).not.toBe("");
  expect(light).not.toBe(dark);
});

// ---------------------------------------------------------------------------
// 5. The image is whatever the creator uploaded.
// ---------------------------------------------------------------------------

test("a panorama is letterboxed on a wide hero", async ({ page }) => {
  // Desktop, because on the project's default 390px phone viewport the same
  // panorama is deliberately *cropped* instead: letterboxed it would be a 29px
  // ribbon, which is worse than a crop of the real photograph. See
  // `HERO_FIT.minLetterboxFraction`.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(PANO);
  await heroReady(page);
  await expect(page.locator(".hero-media")).toHaveAttribute(
    "data-hero-fit",
    "contain",
  );
  // The blurred enlargement moves behind the image and fills the letterbox.
  const bloomZ = await page
    .locator(".hero-media__bloom")
    .evaluate((node) => getComputedStyle(node).zIndex);
  const plateZ = await page
    .locator(".hero-media__plate")
    .evaluate((node) => getComputedStyle(node).zIndex);
  expect(Number(bloomZ)).toBeLessThan(Number(plateZ));
});

test("a panorama is cropped rather than letterboxed on a phone", async ({
  page,
}) => {
  await page.goto(PANO);
  await heroReady(page);
  await expect(page.locator(".hero-media")).toHaveAttribute(
    "data-hero-fit",
    "cover",
  );
});

test("an image too small to enlarge is letterboxed too", async ({ page }) => {
  await page.goto(TINY);
  await heroReady(page);
  await expect(page.locator(".hero-media")).toHaveAttribute(
    "data-hero-fit",
    "contain",
  );
  // And the hero still occupies its reserved height rather than collapsing to
  // the 96x64 image.
  const heroHeight = await page
    .locator("section.zhero")
    .evaluate((node) => node.getBoundingClientRect().height);
  expect(heroHeight).toBeGreaterThan(240);
});

test("even a normal landscape photograph is shown whole", async ({ page }) => {
  // This used to assert `cover`, and that is the change: a full-bleed crop
  // flatters a photograph and destroys a title card, and nothing in the product
  // can tell the two apart. Covering this 16:9 fixture in the hero throws away
  // 40% of its height. See `IMAGE_FIT` in `$lib/utils/image-fit`.
  await page.goto(BRIGHT);
  await heroReady(page);
  await expect(page.locator(".hero-media")).toHaveAttribute(
    "data-hero-fit",
    "contain",
  );
  // The blurred enlargement moves behind the image and fills the letterbox.
  const bloomZ = await page
    .locator(".hero-media__bloom")
    .evaluate((node) => getComputedStyle(node).zIndex);
  const plateZ = await page
    .locator(".hero-media__plate")
    .evaluate((node) => getComputedStyle(node).zIndex);
  expect(Number(bloomZ)).toBeLessThan(Number(plateZ));
});

// ---------------------------------------------------------------------------
// 6. Gating is upstream of all of this and must stay that way.
// ---------------------------------------------------------------------------

/**
 * Does the fixture's magenta edge bar appear in the outer fifth of each side of
 * the hero?
 *
 * The fixture cover carries a magenta bar on each of its extreme edges. Covered,
 * the hero shows the middle ~55% of a 1600x400 image and neither bar is on
 * screen anywhere. Contained, both land inside the outer fifth — the image is
 * centred, so a gutter of blurred pad can sit outside them, which is why this
 * scans a band rather than sampling the literal edge pixel the card test uses.
 *
 * Two details make it robust rather than lucky:
 *
 *   - It scans several rows around the vertical centre. On a phone the
 *     contained image is a ~98px strip in the middle of a ~500px hero, so a row
 *     chosen by a fixed fraction of the *hero* misses it entirely.
 *   - It tests magenta as a *hue* (`r` and `b` both well clear of `g`) rather
 *     than by absolute channel values, because the hero's scrim blends whatever
 *     is underneath toward `--background` by an amount that depends on the row
 *     and the theme. Blending toward any neutral preserves the hue; the image's
 *     own green body (#3f6212) fails it decisively.
 */
async function heroEdgeBars(page: Page, edgeFraction = 0.2) {
  const shot = await page.locator(".hero-media").screenshot();
  const png = decodePng(shot);
  const isMagenta = (x: number, y: number) => {
    const offset = (y * png.width + x) * png.channels;
    const [r, g, b] = [
      png.data[offset],
      png.data[offset + 1],
      png.data[offset + 2],
    ];
    return r - g > 40 && b - g > 40;
  };
  const band = Math.floor(png.width * edgeFraction);
  const rows = [0.44, 0.48, 0.5, 0.52, 0.56].map((fraction) =>
    Math.floor(png.height * fraction),
  );
  let left = false;
  let right = false;
  for (const y of rows) {
    for (let x = 0; x < band; x += 1) if (isMagenta(x, y)) left = true;
    for (let x = png.width - band; x < png.width; x += 1) {
      if (isMagenta(x, y)) right = true;
    }
  }
  return { left, right };
}

test("the 1600x400 cover the editor stores is shown whole on the hero", async ({
  page,
}) => {
  // The case the whole change exists for: this is the only shape the product
  // stores, and covering it in the hero threw away 39% of the width — the ends
  // where a creator's wordmark lives. Asserted in pixels, not just in the fit
  // attribute, and on the *same* fixture image the card surfaces use.
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(STORED_COVER);
    await heroReady(page);
    await expect(page.locator(".hero-media")).toHaveAttribute(
      "data-hero-fit",
      "contain",
    );

    const { left, right } = await heroEdgeBars(page);
    expect(left, `hero left edge bar missing at ${viewport.width}px`).toBe(
      true,
    );
    expect(right, `hero right edge bar missing at ${viewport.width}px`).toBe(
      true,
    );
  }
});

test("the published hero keeps its responsive geometry token", async ({
  page,
}) => {
  const cases = [
    { label: "mobile lower clamp", viewport: { width: 390, height: 500 } },
    { label: "mobile preferred clamp", viewport: { width: 390, height: 844 } },
    { label: "mobile upper clamp", viewport: { width: 390, height: 1200 } },
    { label: "just below 640px", viewport: { width: 639, height: 900 } },
    { label: "at 640px", viewport: { width: 640, height: 900 } },
    { label: "tablet lower clamp", viewport: { width: 768, height: 600 } },
    {
      label: "tablet preferred clamp",
      viewport: { width: 768, height: 1024 },
    },
    { label: "tablet upper clamp", viewport: { width: 768, height: 1200 } },
    { label: "desktop lower clamp", viewport: { width: 1024, height: 600 } },
    {
      label: "desktop preferred clamp",
      viewport: { width: 1440, height: 900 },
    },
    { label: "desktop upper clamp", viewport: { width: 1440, height: 1200 } },
  ];

  for (const { label, viewport } of cases) {
    await page.setViewportSize(viewport);
    await page.goto(STORED_COVER);
    await heroReady(page);

    const geometry = await readHeroGeometry(page);
    const { expected } = editorialHeroGeometry(viewport);

    expect(geometry.minHeight, label).toBeCloseTo(expected, 0);
    // CSSOM can retain a sub-pixel rounding remainder (e.g. 371.359375px for
    // a 371.36px preferred value). That is equivalent geometry, not a short
    // hero, so compare with a tiny CSS-pixel tolerance.
    expect(geometry.height).toBeGreaterThanOrEqual(geometry.minHeight - 0.01);
    expect(geometry.width).toBeGreaterThan(0);
  }
});

test("the published hero keeps its rem fallback without svh support", async ({
  page,
}) => {
  const cases = [
    { viewport: { width: 390, height: 844 } },
    { viewport: { width: 640, height: 900 } },
    { viewport: { width: 1024, height: 900 } },
  ];

  for (const { viewport } of cases) {
    await page.setViewportSize(viewport);
    await page.goto(STORED_COVER);
    await heroReady(page);

    // Chromium supports svh, so first verify the shipped @supports rule is
    // present. Chromium has no switch for disabling one viewport unit, so then
    // remove the supported-unit override to simulate an older engine that
    // skips that block; the computed token below observes the shipped rem
    // fallback. Vite can split the same support block across multiple sheets,
    // so the count is deliberately only a presence check; the computed token
    // below is the behavior under test.
    const removed = await removeSvhOverride(page);
    expect(removed.removed).toBeGreaterThanOrEqual(1);
    expect(removed.value).not.toContain("svh");
    expect(removed.value).toContain("rem");

    const { token } = editorialHeroGeometry(viewport);
    const geometry = await readHeroGeometry(page);
    // Negative control: removing the rem declarations from globals.css leaves
    // this var() invalid, so the observed min-height no longer matches the
    // fallback token and this assertion fails against that hero.
    expect(geometry.heroHeightToken).not.toContain("svh");
    expect(geometry.minHeight).toBeCloseTo(token.fallback, 0);
  }
});

test("a subscriber-only zPage keeps its hero and withholds its body", async ({
  page,
}) => {
  await page.goto(GATED);
  await heroReady(page);

  await expect(page.locator("h1")).toHaveText("Gated hero fixture");
  await expect(
    page.getByRole("heading", { name: "Subscriber-only story" }),
  ).toBeVisible();

  const text = await page.evaluate(() => document.body.innerText);
  expect(text).not.toContain(BODY_SENTINEL);
});
