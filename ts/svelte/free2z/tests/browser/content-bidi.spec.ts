import { expect, test, type Page } from "@playwright/test";

import { browserAppOrigin } from "./ports";

// We have been selling AI translations into `ar`, `he`, `fa` and `ur` and
// rendering them in a container that was never told it is right-to-left
// (item 5).  taught the reader route to serve the variant
// and to declare it in `lang`; it stopped one attribute short of laying it out.
//
// Everything here is measured, not photographed. The load-bearing assertion is
// WHERE THE SENTENCE-FINAL PUNCTUATION LANDS: in an Arabic title, `!` belongs
// at the left end of the line, and in an LTR container it renders at the right
// end. That is a real reader-visible defect, it is a single `getClientRects`
// call away, and reverting the `dir` attribute turns it red.
//
// A cold vite dev server compiles this route on first request.
test.describe.configure({ timeout: 90_000 });

const ARTICLE = "/bidi-fixture-user/bidi-fixture";
const UNKNOWN = "/bidi-fixture-user/bidi-und-fixture";

const ARABIC_TITLE = "مرحبا بالعالم!";
const HEBREW_TITLE = "שלום עולם!";

test.beforeAll(async ({ browser }) => {
  test.setTimeout(60_000);
  const context = await browser.newContext({ javaScriptEnabled: true });
  const warmPage = await context.newPage();
  // `browserAppOrigin()`, never a literal or an env fallback: the
  // suite's ports are derived per worktree, and a spec that guesses one tests
  // against a server that is not there and reports it as a product failure.
  await warmPage.goto(`${browserAppOrigin()}${ARTICLE}`);
  await expect(warmPage.locator("h1")).toContainText("Hello world!", {
    timeout: 60_000,
  });
  await context.close();
});

/**
 * Where does one character sit inside its own element's text run?
 *
 * Returns the fraction of the way across the run, 0 at the left edge and 1 at
 * the right. A sentence-final `!` in correctly laid-out Arabic is near 0; in an
 * LTR container it is near 1. Deliberately relative to the TEXT, not to the
 * element box, so it does not silently become an assertion about `text-align`.
 */
async function markPosition(page: Page, selector: string, needle: string) {
  return page.evaluate(
    ([sel, mark]) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`no element for ${sel}`);
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        const index = node.data.indexOf(mark);
        if (index < 0) continue;
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + 1);
        const glyph = range.getBoundingClientRect();
        range.selectNodeContents(node);
        const run = range.getBoundingClientRect();
        if (run.width === 0) continue;
        return (glyph.left + glyph.width / 2 - run.left) / run.width;
      }
      throw new Error(`no "${mark}" in ${sel}`);
    },
    [selector, needle] as const,
  );
}

// ---------------------------------------------------------------------------
// 1. The server's first paint, not a correction applied after hydration.
// ---------------------------------------------------------------------------

test.describe("the served variant is laid out in its own direction", () => {
  // `javaScriptEnabled: false` means the DOM read here is exactly the bytes the
  // server produced. The whole point of item 1 is that `dir` is in the first
  // painted HTML: a crawler, a reader on a slow connection and a reader with
  // JavaScript off all see the same article, and none of them waits for
  // hydration to find out which way it runs.
  test.use({ javaScriptEnabled: false });

  test("an Arabic variant is right-to-left in the SSR markup", async ({
    page,
  }) => {
    await page.goto(`${ARTICLE}?lang=ar`);

    // The container the defect was about, plus the two places the article's
    // own words appear outside it.
    await expect(page.locator("article").first()).toHaveAttribute("dir", "rtl");
    await expect(page.locator("article").first()).toHaveAttribute("lang", "ar");
    await expect(page.locator("h1").first()).toHaveAttribute("dir", "rtl");

    //...and it is the used value, not just an attribute that lost to a
    // stylesheet somewhere.
    const direction = await page
      .locator("article")
      .first()
      .evaluate((node) => getComputedStyle(node).direction);
    expect(direction).toBe("rtl");
  });

  test("sentence-final punctuation lands on the correct end", async ({
    page,
  }) => {
    await page.goto(`${ARTICLE}?lang=ar`);

    // THE assertion. Without `dir`, the `!` in `مرحبا بالعالم!` renders at the
    // far right of the headline — measured at 0.94 of the way across the run on
    // main, and at 0.03 with the fix.
    expect(await markPosition(page, "h1", "!")).toBeLessThan(0.2);
    // The body is the same story: an Arabic paragraph's full stop belongs at
    // the left. This one reads through `.markdown-content`, so it also proves
    // the direction reaches the rendered markdown and not only the wrapper.
    expect(await markPosition(page, ".markdown-content p", ".")).toBeLessThan(
      0.2,
    );

    // Hebrew is a second script through the same path, so a fix that only ever
    // looked at one language cannot pass.
    await page.goto(`${ARTICLE}?lang=he`);
    await expect(page.locator("h1").first()).toContainText(HEBREW_TITLE);
    expect(await markPosition(page, "h1", "!")).toBeLessThan(0.2);
  });

  test("program text stays left-to-right inside an RTL article", async ({
    page,
  }) => {
    // Found by the codex adversarial review of this PR, and it was a defect
    // this PR INTRODUCED: `dir="rtl"` on the container is inherited by `<pre>`
    // and `<code>` -- the UA stylesheet's `pre` rules set `white-space`, not
    // `direction` -- so `const total = 1;` rendered with its semicolon on the
    // left while the text a reader copies was unchanged. Code that lies about
    // itself is worse than code laid out in the wrong container.
    await page.goto(`${ARTICLE}?lang=ar`);

    const code = page.locator(".markdown-content pre code").first();
    await expect(code).toContainText("const total = 1;");
    expect(
      await code.evaluate((node) => getComputedStyle(node).direction),
    ).toBe("ltr");

    // Measured, not merely declared. highlight.js splits the line into spans,
    // so this walks the whole subtree and compares where two characters landed
    // rather than reading one element's box: `const` opens the line and `;`
    // closes it, so in LTR the semicolon is to the RIGHT of the keyword. Under
    // the inherited RTL it is to the left, which is what reverting the rule
    // produces.
    const order = await code.evaluate((node) => {
      const at = (needle: string) => {
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const text = walker.currentNode as Text;
          const index = text.data.indexOf(needle);
          if (index < 0) continue;
          const range = document.createRange();
          range.setStart(text, index);
          range.setEnd(text, index + needle.length);
          const rect = range.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) continue;
          return rect.left + rect.width / 2;
        }
        throw new Error(`no "${needle}" in the code block`);
      };
      return { keyword: at("const"), terminator: at(";") };
    });
    expect(order.terminator).toBeGreaterThan(order.keyword);

    //...and the prose around it is still right-to-left, so this is a boundary
    // rather than an undo.
    expect(
      await page
        .locator("article")
        .first()
        .evaluate((node) => getComputedStyle(node).direction),
    ).toBe("rtl");
  });

  test("mathematics stays left-to-right inside an RTL article", async ({
    page,
  }) => {
    // Second codex pass, same class as the code block and missed by the first
    // fix: KaTeX declares no `direction` of its own (`katex.min.css` has
    // `flex-direction` and nothing else) and lays an expression out as a row
    // of inline-block groups, so `$$a + b = c$$` reversed under the inherited
    // RTL while the source a reader copies was unchanged.
    await page.goto(`${ARTICLE}?lang=ar`);

    const math = page.locator(".markdown-content .katex").first();
    await expect(math).toBeVisible();
    expect(
      await math.evaluate((node) => getComputedStyle(node).direction),
    ).toBe("ltr");

    // Measured: `a` opens the expression and `c` closes it, so in a correct
    // rendering `c` is to the right of `a`. Reverting the rule swaps them.
    const order = await math.evaluate((node) => {
      const at = (needle: string) => {
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const text = walker.currentNode as Text;
          const index = text.data.indexOf(needle);
          if (index < 0) continue;
          const range = document.createRange();
          range.setStart(text, index);
          range.setEnd(text, index + 1);
          const rect = range.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) continue;
          return rect.left + rect.width / 2;
        }
        throw new Error(`no "${needle}" in the rendered math`);
      };
      return { first: at("a"), last: at("c") };
    });
    expect(order.last).toBeGreaterThan(order.first);
  });

  test("direction and the hreflang cluster reach the crawler together", async ({
    page,
  }) => {
    //  landed an hreflang cluster, `x-default` and a per-variant
    // self-canonical into the `<svelte:head>` of BOTH article routes while this
    // branch was open. Git merged the two cleanly, which is not the same as
    // them being correct together, and a green-but-stale gate is this repo's
    // documented way of shipping a defect. So: one assertion that the
    // SERVER's bytes carry both halves, on both routes.
    //
    // It also pins the negative half. `<html>` gets the variant's `lang` and
    // must NOT get its `dir` -- the crawler reads an Arabic document whose
    // chrome is still the reader's LTR product UI.
    for (const route of [ARTICLE, "/article/bidi-fixture"]) {
      await page.goto(`${route}?lang=ar`);

      await expect(
        page.locator("html"),
        `${route}: the document declares the variant`,
      ).toHaveAttribute("lang", "ar");
      await expect(
        page.locator("html"),
        `${route}: the chrome's direction is not the article's`,
      ).not.toHaveAttribute("dir", /.*/);
      await expect(
        page.locator("article").first(),
        `${route}: the article body is right-to-left`,
      ).toHaveAttribute("dir", "rtl");

      //...and 's cluster is intact in the same bytes.
      const cluster = await page.evaluate(() =>
        [
          ...document.querySelectorAll<HTMLLinkElement>(
            'link[rel="alternate"][hreflang]',
          ),
        ].map((link) => link.getAttribute("hreflang")),
      );
      expect(cluster, `${route}: hreflang cluster`).toContain("ar");
      expect(cluster, `${route}: hreflang cluster`).toContain("az-Arab");
      expect(cluster.at(-1), `${route}: x-default closes the cluster`).toBe(
        "x-default",
      );
      const canonical = await page.evaluate(
        () =>
          document.querySelector<HTMLLinkElement>('link[rel="canonical"]')
            ?.href ?? null,
      );
      expect(canonical, `${route}: self-canonical names the variant`).toMatch(
        /lang=ar$/,
      );
    }
  });

  test("an LTR variant is unchanged", async ({ page }) => {
    // The negative half: nothing here may make a Latin article right-to-left,
    // and `!` stays where English puts it.
    await page.goto(`${ARTICLE}?lang=en`);

    await expect(page.locator("article").first()).toHaveAttribute("dir", "ltr");
    expect(await markPosition(page, "h1", "!")).toBeGreaterThan(0.8);
  });

  test("the script decides, not the language", async ({ page }) => {
    // `az-Arab` and `az-Latn` are ONE language written two ways. This is the
    // pair a `["ar", "he", "fa", "ur"]` list gets wrong, and it is wrong
    // silently — which is why it is asserted end to end and not only in the
    // unit test for the helper.
    await page.goto(`${ARTICLE}?lang=az-Arab`);
    await expect(page.locator("article").first()).toHaveAttribute("dir", "rtl");
    expect(await markPosition(page, "h1", "!")).toBeLessThan(0.2);

    await page.goto(`${ARTICLE}?lang=az-Latn`);
    await expect(page.locator("article").first()).toHaveAttribute("dir", "ltr");
    expect(await markPosition(page, "h1", "!")).toBeGreaterThan(0.8);
  });

  test("an unknown content language is resolved from the text, not guessed", async ({
    page,
  }) => {
    // `und` is the "original, language unknown" sentinel this codebase still
    // stores. `Intl.Locale("und").maximize().script` is `"Latn"` — a confident
    // answer to a question nobody asked — so the guard against it is here, not
    // only in the unit test.
    //
    // **This assertion changed in, deliberately and with the owner's
    // decision.** It used to require the attribute to be ABSENT, on the grounds
    // that inheriting is the one thing that cannot regress an existing article.
    // But inheriting is not neutral: the chrome is left-to-right, so an
    // unlabelled article whose text is Hebrew was laid out backwards — which is
    // a regression that had already happened rather than one being avoided.
    // `dir="auto"` hands the question to the parser, which reads the first strong
    // character of the text actually there. That is strictly more information
    // than omission and strictly less assertion than `ltr`.
    //
    // The fixture serves the HEBREW variant under `und` precisely so this is
    // provable: its title is Hebrew, so the heading below resolves `rtl` under
    // this policy and `ltr` under the one it replaced.
    await page.goto(UNKNOWN);

    await expect(page.locator("article").first()).toHaveAttribute(
      "dir",
      "auto",
    );
    await expect(page.locator("h1").first()).toHaveAttribute("dir", "auto");

    // The outcome, not the attribute: `auto` is worth having only if it resolves.
    const resolved = await page.evaluate(() => ({
      article: getComputedStyle(document.querySelector("article")!).direction,
      heading: getComputedStyle(document.querySelector("h1")!).direction,
      chrome: getComputedStyle(document.documentElement).direction,
    }));
    // THE assertion: a Hebrew heading under an unknown label reads correctly.
    // Under the previous policy (attribute omitted) this is `ltr`.
    expect(resolved.heading).toBe("rtl");

    // And the article resolves `ltr`, which is CORRECT rather than a miss: this
    // fixture's BODY really is ASCII (`bidi-fixture-hebrew-body`) while its title
    // is Hebrew. Two elements carrying the same `dir="auto"` resolving
    // differently is the proof that `auto` is decided PER ELEMENT from that
    // element's own text — neither inherited from an ancestor nor guessed once for
    // the page, which is what a blanket container direction would do.
    expect(resolved.article).toBe("ltr");

    //...and the chrome still does not follow the content, which is the whole
    // point of putting this on the content instead of on `<html>`.
    expect(resolved.chrome).toBe("ltr");

    // `lang` stays ABSENT, because `und` names no language and printing a raw
    // subtag at a screen reader is. `dir` and `lang` are independent: we can
    // honestly say which way the text runs without claiming to know what it is.
    await expect(page.locator("article").first()).not.toHaveAttribute(
      "lang",
      /.*/,
    );
  });

  test("the product chrome keeps its own direction", async ({ page }) => {
    // Content language and product-UI locale are independent axes ( §2
    // principle 8);  owns the chrome. An English-reading visitor looking at
    // an Arabic variant must get an RTL article inside an LTR page — so the
    // article flips and NOTHING above it does.
    await page.goto(`${ARTICLE}?lang=ar`);

    await expect(page.locator("html")).toHaveAttribute("lang", "ar");
    await expect(page.locator("html")).not.toHaveAttribute("dir", /.*/);

    const chrome = await page.evaluate(() => ({
      html: getComputedStyle(document.documentElement).direction,
      body: getComputedStyle(document.body).direction,
      nav: getComputedStyle(document.querySelector("nav")!).direction,
    }));
    expect(chrome).toEqual({ html: "ltr", body: "ltr", nav: "ltr" });
  });

  test("user-supplied strings are isolated from the chrome around them", async ({
    page,
  }) => {
    // A tag, a display name and an `@username` are arbitrary text dropped into
    // a run of our own. `<bdi>` is the construction that stops one reordering
    // against its neighbours; it is asserted structurally because in TODAY's
    // markup the neutrals happen to sit at run boundaries where the bidi
    // algorithm already resolves them to the paragraph direction, so a
    // geometric assertion would pass with the isolation removed and prove
    // nothing. One separator added next to any of these and it stops being
    // true — see the PR body for the measurement.
    await page.goto(`${ARTICLE}?lang=ar`);

    const tag = page.locator('[data-testid="article-tag"]').first();
    await expect(tag).toContainText("عربي");
    expect(await tag.locator("bdi").count()).toBe(1);
    // The `#` is ours and stays outside the isolate.
    expect(await tag.locator("bdi").innerText()).toBe("عربي");

    // The byline display name, in the same LTR meta row as the date.
    const byline = page.locator('a[rel="author"] bdi').first();
    await expect(byline).toHaveText("مرحبا!");
  });
});

// ---------------------------------------------------------------------------
// 2. Line breaking for the scripts with no inter-word spaces.
// ---------------------------------------------------------------------------

// The embed consent card only exists after hydration, so it needs its own test
// outside the `javaScriptEnabled: false` describe above.
test("product chrome mounted inside the article keeps the UI locale's direction", async ({
  page,
}) => {
  // Third codex pass. `MarkdownContent` mounts `ExternalEmbed` INSIDE the
  // content container, so since this PR its consent card inherited the
  // article's direction: an English privacy warning inside an Arabic article
  // got its full stop on the wrong end and its Cancel/Allow pair in reversed
  // visual order. Chrome direction follows the reader's UI locale ( P8),
  // not the article's, wherever that chrome is mounted.
  await page.goto(`${ARTICLE}?lang=ar`);

  const consent = page
    .getByRole("heading", { name: "External content blocked" })
    .locator("xpath=ancestor::div[@dir][1]");
  await expect(consent).toHaveAttribute("dir", "ltr");
  expect(
    await consent.evaluate((node) => getComputedStyle(node).direction),
  ).toBe("ltr");

  //...while the article around it is still right-to-left, so this is a
  // boundary and not an undo.
  expect(
    await page
      .locator("article")
      .first()
      .evaluate((node) => getComputedStyle(node).direction),
  ).toBe("rtl");
});

test.describe("no-space scripts break at word boundaries", () => {
  test.use({ javaScriptEnabled: false });

  // Honest framing, because the measurement said so. At the widths this column
  // can actually have, Chromium's dictionary breaker already handles Thai, Lao,
  // Khmer and Burmese correctly, and `overflow-wrap: anywhere` in the prose
  // styles does NOT override it — `overflow-wrap` is a fallback that applies
  // only when the line has no other break opportunity. Break positions were
  // byte-identical under `anywhere`, `break-word` and `normal`, with and
  // without `lang`. So this is a GUARD, not a fix.
  //
  // It is a guard with teeth: `word-break: break-all` DOES mangle these
  // scripts, at this exact geometry, and nothing else in the suite would
  // notice someone reaching for it to tame a long URL. Khmer is the sample
  // because it is the one that goes red first — Thai survives `break-all` at
  // 358px and would make this test a placebo.
  const NO_SPACE = [
    // Khmer: a break may not start on a dependent vowel or a coeng sign.
    { lang: "km", combining: /[\u17B4-\u17D3]/ },
    // Thai: nor on a vowel sign or a tone mark.
    { lang: "th", combining: /[\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]/ },
  ];

  for (const { lang, combining } of NO_SPACE) {
    test(`a ${lang} body never breaks inside a grapheme cluster`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${ARTICLE}?lang=${lang}`);

      const result = await page.evaluate(() => {
        const el = document.querySelector(".markdown-content p");
        if (!el) throw new Error("no rendered paragraph");
        const node = el.firstChild as Text;
        const range = document.createRange();
        const tops: (number | null)[] = [];
        for (let i = 0; i < node.length; i++) {
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          const rect = range.getClientRects()[0];
          tops.push(rect ? Math.round(rect.top) : null);
        }
        const breaks: number[] = [];
        for (let i = 1; i < tops.length; i++) {
          const here = tops[i];
          const before = tops[i - 1];
          if (here !== null && before !== null && here > before) breaks.push(i);
        }
        return {
          breaks,
          text: node.data,
          wordBreak: getComputedStyle(el).wordBreak,
        };
      });

      // It has to have wrapped at all, or "no bad break" is vacuously true.
      expect(result.breaks.length).toBeGreaterThan(0);
      const mangled = result.breaks.filter((index) =>
        combining.test(result.text[index]),
      );
      expect(mangled).toEqual([]);
      // The property that would actually break it if someone set it.
      expect(result.wordBreak).not.toBe("break-all");
    });
  }
});

// ---------------------------------------------------------------------------
// 3. Script coverage and Han glyph selection.
// ---------------------------------------------------------------------------

test.describe("the content font is chosen for the script", () => {
  test.use({ javaScriptEnabled: false });

  test("Traditional Chinese and Japanese get different Han fonts", async ({
    page,
  }) => {
    // MEASURED, on macOS 15 / Chromium 140: with the generic stack alone,
    // `骨直令高青` renders to a byte-identical bitmap under lang="zh-Hans",
    // "zh-Hant", "yue-Hant", "ja", "ko" and "en". Han is unified, the code
    // points are shared, and the `lang` attribute  added does not by
    // itself select regional glyph forms. Naming a regional family does.
    //
    // The ASSERTION is on the computed family, not on the pixels: a CI runner
    // has none of these fonts installed, so a pixel comparison there would be
    // measuring the runner's font package rather than this change. The pixel
    // proof is in the PR body.
    await page.goto(`${ARTICLE}?lang=zh-Hant`);
    const traditional = await page
      .locator("article")
      .first()
      .evaluate((node) => getComputedStyle(node).fontFamily);
    expect(traditional).toContain("PingFang TC");
    expect(traditional).not.toContain("PingFang SC");

    await page.goto(`${ARTICLE}?lang=ja`);
    const japanese = await page
      .locator("article")
      .first()
      .evaluate((node) => getComputedStyle(node).fontFamily);
    expect(japanese).toContain("Hiragino Sans");
    expect(japanese).not.toContain("PingFang TC");

    expect(traditional).not.toBe(japanese);

    // A tag that states Simplified and carries a Hong Kong region gets the
    // Simplified stack. Be precise about what this proves: Chromium 140's
    // `:lang()` is PREFIX matching, not Selectors-4 extended filtering --
    // probed directly, `zh-Hans-HK` matches `:lang(zh)` and `:lang(zh-Hans)`
    // and not `:lang(zh-HK)` -- so the explicit `:lang(zh-Hans)` rule the
    // codex review asked for is inert here and this assertion passes with or
    // without it. It is kept as a reader-visible statement of the intended
    // precedence, not as coverage of that rule, and the PR says so.
    await page.goto(`${ARTICLE}?lang=zh-Hans-HK`);
    const simplifiedInHongKong = await page
      .locator("article")
      .first()
      .evaluate((node) => getComputedStyle(node).fontFamily);
    expect(simplifiedInHongKong).toContain("PingFang SC");
    expect(simplifiedInHongKong).not.toContain("PingFang TC");

    //...and an article in a Latin language is left on the base stack, so this
    // cannot be passing by applying a CJK font to everything.
    await page.goto(`${ARTICLE}?lang=en`);
    const english = await page
      .locator("article")
      .first()
      .evaluate((node) => getComputedStyle(node).fontFamily);
    expect(english).not.toContain("PingFang");
    expect(english).not.toContain("Hiragino");
  });

  test("the base stack names a font for every script we sell", async ({
    page,
  }) => {
    // Coverage on a thin Linux/ChromeOS font package is the tofu case. On
    // macOS the generic `sans-serif` already reaches all thirteen (measured;
    // see the PR body), so this asserts the CONTRACT — that the named
    // fallbacks are on the element — rather than asserting that this
    // particular runner happens to own the fonts.
    await page.goto(`${ARTICLE}?lang=en`);

    const stack = await page.evaluate(
      () => getComputedStyle(document.body).fontFamily,
    );
    for (const family of [
      "Noto Sans Ethiopic", // am
      "Noto Sans Sinhala", // si
      "Noto Sans Myanmar", // my
      "Noto Sans Georgian", // ka
      "Noto Sans Armenian", // hy
      "Noto Sans Bengali", // bn
      "Noto Sans Tamil", // ta
      "Noto Sans Telugu", // te
      "Noto Sans Arabic", // ar, fa, ur, ps, sd, ckb
      "Noto Sans Hebrew", // he
      "Noto Sans Thai", // th
      "Noto Sans Khmer", // km
      "Noto Sans Lao", // lo
    ]) {
      expect(stack, `${family} must be in the base stack`).toContain(family);
    }
    // Every one of them sits AFTER the generic families, so a Latin code point
    // never reaches them and Latin rendering is unchanged.
    expect(stack.indexOf("sans-serif")).toBeLessThan(
      stack.indexOf("Noto Sans Ethiopic"),
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Hydration must not undo any of it.
// ---------------------------------------------------------------------------

test("the direction survives hydration and a client-side switch", async ({
  page,
}) => {
  // SSR right, hydrated wrong is the hardest version to notice, and it is
  // exactly what happened to `<html lang>` before.
  await page.goto(`${ARTICLE}?lang=ar`);
  await expect(page.locator("article").first()).toHaveAttribute("dir", "rtl");

  const control = page.locator("select#article-language");
  await expect(control).toBeVisible();

  // The `<select>` is server-rendered, so a change fired before hydration
  // reaches no handler; poll until the URL actually moves.
  await expect
    .poll(
      async () => {
        if (!/lang=en/.test(page.url())) await control.selectOption("en");
        return page.url();
      },
      { timeout: 30_000 },
    )
    .toMatch(/lang=en/);

  await expect(page.locator("h1").first()).toContainText("Hello world!", {
    timeout: 30_000,
  });
  await expect(page.locator("article").first()).toHaveAttribute("dir", "ltr");
  expect(
    await page
      .locator("article")
      .first()
      .evaluate((node) => getComputedStyle(node).direction),
  ).toBe("ltr");

  //...and back, without a full page load.
  await expect
    .poll(
      async () => {
        if (!/lang=ar/.test(page.url())) await control.selectOption("ar");
        return page.url();
      },
      { timeout: 30_000 },
    )
    .toMatch(/lang=ar/);
  await expect(page.locator("h1").first()).toContainText(ARABIC_TITLE, {
    timeout: 30_000,
  });
  await expect(page.locator("article").first()).toHaveAttribute("dir", "rtl");
  // The chrome still has not moved.
  expect(
    await page.evaluate(
      () => getComputedStyle(document.documentElement).direction,
    ),
  ).toBe("ltr");
});
