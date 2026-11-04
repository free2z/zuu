import { expect, type Page } from "@playwright/test";

/**
 * Shared measurements for the mobile layout guards.
 *
 * The document-width half of this already existed inline in
 * `profile-dashboard-layout.spec.ts` and `homepage-layout.spec.ts`; it is
 * lifted here so the billing, settings and discovery guards assert exactly the
 * same thing rather than each inventing a near-miss of it.
 *
 * `splitWords` is the new one, and it exists because the guards that already
 * shipped could not see the defect this batch fixed. The profile page's guard
 * asserts `scrollWidth <= clientWidth` on each stat label — it catches copy
 * that is CLIPPED. The billing page had `overflow-wrap: anywhere` on the same
 * copy, so nothing clipped and nothing overflowed: the text simply broke
 * mid-word, and a 320px phone read "SUBSCRI/PTIONS", "TRANSA/CTIONS",
 * "BALANC/E" and a 2Z balance split over three lines as "64,6 / 72.2 / 3".
 * Every existing assertion passed on that.
 */

/**
 * The widths every mobile guard in this repo checks.
 *
 * 640, 768 and 1024 are not padding. They are Tailwind's `sm`, `md` and `lg`,
 * which is to say the exact widths where a responsive layout CHANGES — and a
 * suite that jumps 390 → 1280 tests neither side of any of them. The codex
 * review of this change found a real regression at exactly 640px that every
 * width in the old list passed: the billing grid went 2-up to 4-up there while
 * the tile went stacked to side-by-side at the same moment, leaving ~56px for
 * a 106px label.
 */
export const MOBILE_WIDTHS = [320, 360, 390] as const;
export const GUARD_WIDTHS = [...MOBILE_WIDTHS, 640, 768, 1024, 1280] as const;

/** Nothing may make the document wider than the viewport. */
export async function expectNoHorizontalScroll(page: Page, label: string) {
  const measured = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
    bodyContent: document.body.scrollWidth,
  }));
  expect(
    measured.content,
    `${label}: the document must not scroll horizontally`,
  ).toBeLessThanOrEqual(measured.viewport);
  expect(
    measured.bodyContent,
    `${label}: the body must not scroll horizontally`,
  ).toBeLessThanOrEqual(measured.viewport);
}

/**
 * Every word of the matched elements' text that the browser broke across more
 * than one line.
 *
 * Measured with a `Range` over each whitespace-delimited run inside a text
 * node: a word rendered on one line produces client rects that all share a
 * `top`, and a word split across lines produces rects at two or more different
 * `top`s. Wrapping BETWEEN words is fine and is not reported — UI copy may
 * wrap, it may not be cut in half.
 */
export async function splitWords(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const broken: { word: string; lines: number; text: string }[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      if (!el.offsetParent && el.offsetHeight === 0) continue;
      for (const node of Array.from(el.childNodes)) {
        if (node.nodeType !== Node.TEXT_NODE) continue;
        const text = node.textContent || "";
        const word = /\S+/g;
        let match: RegExpExecArray | null;
        while ((match = word.exec(text))) {
          const range = document.createRange();
          range.setStart(node, match.index);
          range.setEnd(node, match.index + match[0].length);
          const tops = new Set(
            Array.from(range.getClientRects()).map((r) => Math.round(r.top)),
          );
          if (tops.size > 1) {
            broken.push({
              word: match[0],
              lines: tops.size,
              text: text.trim().slice(0, 80),
            });
          }
        }
      }
    }
    return broken;
  }, selector);
}

/**
 * Interactive controls smaller than the WCAG 2.2 SC 2.5.8 (AA) 24px floor.
 * `selector` should match the actual control, not its wrapper.
 */
export async function undersizedTargets(page: Page, selector: string) {
  return page.evaluate((sel) => {
    return Array.from(document.querySelectorAll<HTMLElement>(sel))
      .filter((el) => el.getBoundingClientRect().width > 0)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName.toLowerCase(),
          name:
            el.getAttribute("aria-label") ||
            el.getAttribute("title") ||
            (el.textContent || "").trim().slice(0, 40),
          width: Math.round(r.width),
          height: Math.round(r.height),
        };
      })
      .filter((m) => m.width < 24 || m.height < 24);
  }, selector);
}
