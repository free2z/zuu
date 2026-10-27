import { expect, test, type Page } from "@playwright/test";

import { browserAppOrigin } from "./ports";

// A creator buys an Arabic translation and the reader gets it laid out
// left-to-right. `grep -rn 'dir=' src` returned nothing at all before
// this: not handled badly, absent. / had already made `<html lang>`
// name the CONTENT's language, and `lang` and `dir` are independent attributes,
// so the page was correctly labelled Arabic and still wrong.
//
// What these specs assert is RENDERED DIRECTION — `getComputedStyle().direction`
// and, for the ordering case, real x coordinates. A `dir` attribute in the
// markup is the mechanism, not the outcome; a class name or a config value would
// be neither. The fixture body is deliberately MIXED, because pure Arabic passes
// under `dir="auto"` too and `auto` is the wrong answer for this content.

// A cold vite dev server compiles this route on first request.
test.describe.configure({ timeout: 90_000 });

// TWO fixtures, split by SSR cost rather than by coverage.
//
// `HEAVY` renders highlight.js, KaTeX and an autolink server-side on every
// request, and one zPage render is three backend calls — so pointing all eight
// tests at it issued ~24 backend requests from this file alone, and a burst like
// that is what saturates SSR here. Only the two assertions that are ABOUT code
// and math need it. The rest are about prose direction, the chrome and bidi
// ordering, and `LIGHT` serves them the heavy body's FIRST PARAGRAPH — identical
// tokens for the ordering measurement, nothing compiled.
//
// Kept as separate tests rather than merged into one navigation: merging would
// mean the first failing assertion prevents the rest from running, so one
// regression would hide two others.
const HEAVY = "/rtl-fixture-user/rtl-direction-fixture";
const LIGHT = "/rtl-fixture-user/rtl-direction-light-fixture";
const ARTICLE = LIGHT;
const ARABIC_TITLE = "تمويل تطوير Zcash إلى الأبد";
const ENGLISH_TITLE = "Fund Zcash Development Forever. Entitle Nobody.";
const HEBREW_TITLE = "ממן את פיתוח Zcash";
// Deliberately OPENS with a Latin run, which is what `dir="auto"` gets wrong.
const FARSI_TITLE = "Zcash برای همیشه";

// The three tokens of the body's first paragraph. Their LEFT-TO-RIGHT SCREEN
// ORDER inverts between a right-to-left base direction and a left-to-right one,
// which is what makes measuring them a test rather than an observation.
const FIRST = "أول";
const LATIN = "Zcash";
const LAST = "آخر";

test.beforeAll(async ({ browser }) => {
  test.setTimeout(60_000);
  const context = await browser.newContext({ javaScriptEnabled: true });
  const warmPage = await context.newPage();
  // `browserAppOrigin()`, never a port literal: the pair is DERIVED
  // from the worktree path unless overridden, so the old fixed default would
  // point at whatever another agent happens to be running — and
  // `tests/playwright-ports.test.mjs` fails on the literal, comment included.
  await warmPage.goto(`${browserAppOrigin()}${ARTICLE}`);
  await expect(warmPage.locator("h1")).toContainText(ENGLISH_TITLE, {
    timeout: 60_000,
  });
  await context.close();
});

/** The direction the browser RESOLVED for one element, not the attribute. */
function resolvedDirection(page: Page, selector: string) {
  return page
    .locator(selector)
    .first()
    .evaluate((element) => getComputedStyle(element).direction);
}

test.describe("the server-rendered markup declares per-block direction", () => {
  test.use({ javaScriptEnabled: false });

  test("the article's own text is rtl and the page's chrome is not", async ({
    page,
  }) => {
    await page.goto(`${ARTICLE}?lang=ar`);
    await expect(page.locator("h1")).toContainText(ARABIC_TITLE);

    // The content, on the same elements `lang` is on.
    expect(await resolvedDirection(page, "article")).toBe("rtl");
    expect(await resolvedDirection(page, "h1")).toBe("rtl");
    await expect(page.locator("article").first()).toHaveAttribute("lang", "ar");
    // The attribute VALUE too, not only the resolved direction. Computed
    // direction alone is satisfied by `dir="auto"` whenever the text happens to
    // open with a strong RTL character, so a mutation that replaces every
    // language-derived answer with `auto` slips past geometry on most fixtures —
    // 's suite pairs the two for exactly this reason and it is the cheaper
    // half of the guard.
    await expect(page.locator("article").first()).toHaveAttribute("dir", "rtl");
    await expect(page.locator("h1").first()).toHaveAttribute("dir", "rtl");

    // The chrome. `<html>` is deliberately untouched — an Arabic article does
    // not entitle us to flip an English-reading visitor's navbar, which is the
    // same reason `<html lang>` was the wrong single knob in. RTL product
    // UI is  and explicitly out of scope here.
    expect(await resolvedDirection(page, "html")).toBe("ltr");
    expect(await resolvedDirection(page, "nav")).toBe("ltr");
    //...including the language switcher, which sits inches from the headline.
    expect(await resolvedDirection(page, "#article-language")).toBe("ltr");
    await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  });

  test("code and URLs stay left-to-right inside the Arabic prose", async ({
    page,
  }) => {
    // HEAVY: this test is the one whose subject IS the fenced block, the autolink,
    // the inline code span and the rendered math.
    await page.goto(`${HEAVY}?lang=ar`);
    await expect(page.locator("h1")).toContainText(ARABIC_TITLE);

    // A fenced block. This is the case a blanket `dir="rtl"` on the container
    // gets wrong: `npm run build && echo done` reorders around its neutral
    // characters and the whole block right-aligns.
    const pre = page.locator("article pre").first();
    await expect(pre).toContainText("npm run build");
    expect(await pre.evaluate((el) => getComputedStyle(el).direction)).toBe(
      "ltr",
    );
    // Isolated as well as re-based — that is the half a `direction: ltr` class
    // would miss, and the half that matters mid-sentence.
    expect(await pre.evaluate((el) => getComputedStyle(el).unicodeBidi)).toBe(
      "isolate",
    );

    // A bare URL in the middle of a sentence.
    const link = page.locator('article a[href^="https://example.com"]').first();
    expect(await link.evaluate((el) => getComputedStyle(el).direction)).toBe(
      "ltr",
    );

    // Rendered math. KaTeX emits nested inline-BLOCK groups (`.base`, `.mord`,
    //...) and its stylesheet sets no `direction` at all, so under an RTL base
    // those atomic boxes reorder and `a = b + c` is DISPLAYED as a different
    // equation — silently, because every glyph is still present. Codex
    // adversarial review; an equation is notation, not language.
    const math = page.locator("article .math").first();
    await expect(math).toBeVisible();
    // The LAYOUT first, because that is the damage: the terms have to come out
    // in reading order left to right. Without the isolate this array comes back
    // descending, i.e. `a = b + c` rendered as `c + b = a`.
    const terms = await math.evaluate((element) =>
      [...element.querySelectorAll(".mord, .mbin, .mrel")].map(
        (node) => node.getBoundingClientRect().left,
      ),
    );
    expect(terms.length).toBeGreaterThanOrEqual(3);
    for (let index = 1; index < terms.length; index += 1) {
      expect(terms[index]).toBeGreaterThan(terms[index - 1]);
    }
    expect(await math.evaluate((el) => getComputedStyle(el).direction)).toBe(
      "ltr",
    );

    // An inline code span resolves its own direction rather than inheriting
    // the paragraph's, so `--flag=value` is not reordered.
    const codeSpan = page.locator("article :not(pre) > code").first();
    await expect(codeSpan).toHaveText("--flag=value");
    expect(
      await codeSpan.evaluate((el) => getComputedStyle(el).direction),
    ).toBe("ltr");
    expect(
      await codeSpan.evaluate((el) => getComputedStyle(el).unicodeBidi),
    ).toBe("isolate");
  });

  test("a Latin run inside Arabic prose is ordered correctly", async ({
    page,
  }) => {
    await page.goto(`${ARTICLE}?lang=ar`);
    await expect(page.locator("h1")).toContainText(ARABIC_TITLE);

    // Measured, not inferred. With a right-to-left base the first token of
    // `أول Zcash آخر` is the RIGHTMOST one on screen and the last is the
    // leftmost; with a left-to-right base that order is exactly reversed. So
    // this one assertion distinguishes the two implementations, and it is the
    // thing the issue asks to be proved about mixed content.
    const x = await page.evaluate(
      ([first, latin, last]) => {
        const paragraph = document.querySelector("article .markdown-content p");
        if (!paragraph) throw new Error("no rendered paragraph");
        const node = paragraph.firstChild;
        if (!node || node.nodeType !== Node.TEXT_NODE) {
          throw new Error("the paragraph is not one text node");
        }
        const text = node.textContent || "";
        const leftOf = (needle: string) => {
          const start = text.indexOf(needle);
          if (start < 0) throw new Error(`missing ${needle} in ${text}`);
          const range = document.createRange();
          range.setStart(node, start);
          range.setEnd(node, start + needle.length);
          return range.getBoundingClientRect().left;
        };
        return {
          first: leftOf(first),
          latin: leftOf(latin),
          last: leftOf(last),
        };
      },
      [FIRST, LATIN, LAST],
    );

    expect(x.first).toBeGreaterThan(x.latin);
    expect(x.latin).toBeGreaterThan(x.last);
  });

  test("the same URL in English is left-to-right", async ({ page }) => {
    // Direction is a property of the variant, not a constant on the route.
    await page.goto(ARTICLE);
    await expect(page.locator("h1")).toContainText(ENGLISH_TITLE);
    expect(await resolvedDirection(page, "article")).toBe("ltr");
    expect(await resolvedDirection(page, "h1")).toBe("ltr");
    // `"ltr"` stated, not merely observed: an English article resolves `ltr`
    // under `dir="auto"` as well, so only the attribute distinguishes "we know
    // this is left-to-right" from "we guessed and got lucky".
    await expect(page.locator("article").first()).toHaveAttribute("dir", "ltr");
    await expect(page.locator("h1").first()).toHaveAttribute("dir", "ltr");
  });

  test("a variant that OPENS with a Latin run is still right-to-left", async ({
    page,
  }) => {
    // The reason `dir="auto"` is not the fix, and the one case the rest of this
    // file cannot see. `auto` reads the first strong character: this Farsi
    // article starts with "Zcash", so the heuristic lays the whole thing out
    // left-to-right — left-aligned, with its punctuation on the wrong end —
    // while the language tag says outright that it is Farsi.
    //
    // An article about this product opening with "Zcash" or `2Z` is the normal
    // case here, not a contrived one. Every assertion below passes under `auto`
    // for the Arabic variant above, which is exactly why this variant exists:
    // the suite was green against `contentDirectionAttribute` hard-wired to
    // `"auto"` until this test was added.
    await page.goto(`${ARTICLE}?lang=fa`);
    await expect(page.locator("h1")).toContainText(FARSI_TITLE);

    expect(await resolvedDirection(page, "article")).toBe("rtl");
    expect(await resolvedDirection(page, "h1")).toBe("rtl");
    await expect(page.locator("article").first()).toHaveAttribute("lang", "fa");
    await expect(page.locator("article").first()).toHaveAttribute("dir", "rtl");

    //...and the paragraph really is laid out right-to-left: the Latin run it
    // opens with ends up on the RIGHT, which is where the first token of an
    // RTL paragraph belongs.
    const x = await page.evaluate(
      ([latin, last]) => {
        const paragraph = document.querySelector("article .markdown-content p");
        if (!paragraph) throw new Error("no rendered paragraph");
        const node = paragraph.firstChild;
        if (!node || node.nodeType !== Node.TEXT_NODE) {
          throw new Error("the paragraph is not one text node");
        }
        const text = node.textContent || "";
        const leftOf = (needle: string) => {
          const start = text.indexOf(needle);
          if (start < 0) throw new Error(`missing ${needle} in ${text}`);
          const range = document.createRange();
          range.setStart(node, start);
          range.setEnd(node, start + needle.length);
          return range.getBoundingClientRect().left;
        };
        const box = paragraph.getBoundingClientRect();
        return { latin: leftOf(latin), last: leftOf(last), right: box.right };
      },
      [LATIN, LAST],
    );
    expect(x.latin).toBeGreaterThan(x.last);
    // Flush against the paragraph's own right edge, because `text-align: start`
    // in a right-to-left paragraph is the right edge.
    expect(x.right - x.latin).toBeLessThan(120);
  });

  test("Hebrew works too, and nothing names it", async ({ page }) => {
    // The implementation lists scripts, never languages, so a second RTL
    // language needs no second code path.
    await page.goto(`${ARTICLE}?lang=he`);
    await expect(page.locator("h1")).toContainText(HEBREW_TITLE);
    expect(await resolvedDirection(page, "article")).toBe("rtl");
    await expect(page.locator("article").first()).toHaveAttribute("lang", "he");
  });
});

test("hydration keeps the article rtl and the code block ltr", async ({
  page,
}) => {
  // The client pipeline REBUILDS every code block — it wraps the `<pre>` in a
  // shell it creates itself and mounts the copy/wrap chrome into it. A shell
  // that inherits the article's direction sends that chrome and the line-number
  // gutter to the other side the moment the page hydrates, while the code inside
  // it stays put. SSR-only assertions cannot see that.
  // HEAVY: there is no code-block shell to rebuild without a fenced block.
  await page.goto(`${HEAVY}?lang=ar`);
  await expect(page.locator("h1")).toContainText(ARABIC_TITLE);
  const shell = page.locator("article .code-block-shell").first();
  await expect(shell).toBeVisible();

  expect(await resolvedDirection(page, "article")).toBe("rtl");
  expect(await shell.evaluate((el) => getComputedStyle(el).direction)).toBe(
    "ltr",
  );
  expect(
    await shell
      .locator("pre")
      .first()
      .evaluate((el) => getComputedStyle(el).direction),
  ).toBe("ltr");
  // Chrome is still chrome after hydration.
  expect(await resolvedDirection(page, "nav")).toBe("ltr");
});

test("switching the UI language does not change the article's direction", async ({
  page,
}) => {
  // The mirror of 's `<html lang>` control, and the reason `dir` belongs on
  // the content: the reader's product-UI choice must not reach the article.
  await page.goto(`${ARTICLE}?lang=ar`);
  await expect(page.locator("h1")).toContainText(ARABIC_TITLE);
  expect(await resolvedDirection(page, "article")).toBe("rtl");

  await page.evaluate(() => {
    document.cookie = "free2z-locale=es; Path=/; Max-Age=600; SameSite=Lax";
  });
  await page.reload();
  await expect(page.locator("h1")).toContainText(ARABIC_TITLE);
  expect(await resolvedDirection(page, "article")).toBe("rtl");
  expect(await resolvedDirection(page, "nav")).toBe("ltr");
});
