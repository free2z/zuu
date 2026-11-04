import { expect, test, type Page } from "@playwright/test";

import { devSourceModuleLoader } from "./dev-source-module";
import { browserAppOrigin } from "./ports";

// A creator bought a Simplified Chinese translation, reviewed it, published it
// and no reader could reach it. The API was right the whole time:
// `GET /api/zpage/<id>/?lang=zh-Hans` returned the Chinese title and listed
// `zh-Hans` in `available_languages`. The reader route threw that away by
// running the `?lang=` through the PRODUCT-UI locale normalizer.
//
// So these specs assert the only thing that matters: what the page RENDERS.
// A unit test on a normalizer would have passed on main for either shape.
//
// The mock fixture matches `?lang=` as an EXACT tag, exactly as production
// does (`?lang=zh` there returns `actual_language: en`), so the `?lang=zh`
// case below can only pass if the route resolved the language range itself.

// A cold vite dev server compiles this route on first request.
test.describe.configure({ timeout: 90_000 });

const ARTICLE = "/zh-fixture-user/zh-variant-fixture";
const BOTH_SCRIPTS = "/zh-fixture-user/zh-scripts-fixture";
const REGIONAL = "/zh-fixture-user/regional-variant-fixture";
const SPANISH_TITLE = "Financiar el desarrollo de Zcash para siempre.";
const AMERICAN_TITLE = "Fund Zcash Development Forever, y'all.";

const ENGLISH_TITLE = "Fund Zcash Development Forever. Entitle Nobody.";
const SIMPLIFIED_TITLE = "永远资助Zcash开发。不赋予任何人特权。";
const TRADITIONAL_TITLE = "永遠資助Zcash開發。不賦予任何人特權。";

test.beforeAll(async ({ browser }) => {
  test.setTimeout(60_000);
  const context = await browser.newContext({ javaScriptEnabled: true });
  const warmPage = await context.newPage();
  const appOrigin = browserAppOrigin();
  await warmPage.goto(`${appOrigin}${ARTICLE}`);
  await expect(warmPage.locator("h1")).toContainText(ENGLISH_TITLE, {
    timeout: 60_000,
  });
  await context.close();
});

// Through the guarded loader, never a raw dynamic import of an app source
// module: the dev client installs Vite's `define` values as globals at page
// load, so importing one directly races a Vite-initiated reload.
// `tests/dev-source-module.test.mjs` fails if a spec writes the raw form --
// including inside a comment, which is why this one describes it in prose.
const I18N_LOADER = devSourceModuleLoader("/src/lib/i18n.ts");

function headingText(page: Page) {
  return page.locator("h1").first().innerText();
}

// The SSR half. `javaScriptEnabled: false` means the DOM read here is exactly
// the server's markup — the same bytes the crawler tier and the "seobot" nginx
// routing outcome serve, and the same first paint every human gets.
test.describe("the published variant is server-rendered", () => {
  test.use({ javaScriptEnabled: false });

  test("?lang=zh-Hans renders the Chinese title, not the English one", async ({
    page,
  }) => {
    await page.goto(`${ARTICLE}?lang=zh-Hans`);

    expect(await headingText(page)).toContain(SIMPLIFIED_TITLE);
    expect(await headingText(page)).not.toContain(ENGLISH_TITLE);
    await expect(page).toHaveTitle(new RegExp(SIMPLIFIED_TITLE));
    // The body is the translation too, not just the headline.
    await expect(page.locator(".markdown-content").first()).toContainText(
      "zh-fixture-simplified-body",
    );
    // And the article declares the language it is written in, script intact.
    await expect(page.locator("article").first()).toHaveAttribute(
      "lang",
      "zh-Hans",
    );
    // So does the document. On prod both `?lang=en` and `?lang=zh-Hans` came
    // back byte-identical under `<html lang="en">` — wrong about the page's
    // language before a reader reaches a single word of it.
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-Hans");
    // The chrome is still in the reader's UI language and says so.
    await expect(page.locator("nav").first()).toHaveAttribute("lang", "en");
  });

  test("the document language follows the variant, not the reader's UI", async ({
    page,
  }) => {
    // The clean URL negotiates to English for a cookieless visitor, so the
    // document is English...
    await page.goto(ARTICLE);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    //...and every route that is not an article keeps the UI locale, which is
    // the only thing `<html lang>` ever carried.
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    // Each script gets its own declaration: Han code points are shared, so the
    // tag is the only thing that picks the right glyphs.
    await page.goto(`${BOTH_SCRIPTS}?lang=zh-Hant`);
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-Hant");
    await page.goto(`${BOTH_SCRIPTS}?lang=zh-Hans`);
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-Hans");
  });

  test("every case of the tag reaches the same variant", async ({ page }) => {
    // All four of these returned the English title on main.
    for (const requested of ["zh-Hans", "zh-hans", "ZH-HANS", "zh_Hans"]) {
      await page.goto(`${ARTICLE}?lang=${requested}`);
      expect(
        await headingText(page),
        `?lang=${requested} must render the Chinese variant`,
      ).toContain(SIMPLIFIED_TITLE);
    }
  });

  test("?lang=zh resolves to the one Chinese variant that exists", async ({
    page,
  }) => {
    // The API needs the exact tag and answers `?lang=zh` in English. Resolving
    // the range is the route's job, and this is the only proof it does it.
    await page.goto(`${ARTICLE}?lang=zh`);

    expect(await headingText(page)).toContain(SIMPLIFIED_TITLE);
    await expect(page.locator(".markdown-content").first()).toContainText(
      "zh-fixture-simplified-body",
    );
  });

  test("a region-only tag is a script request too", async ({ page }) => {
    // `zh-TW` and `zh-CN` name no script and are the commonest hand-written
    // Chinese tags — precisely the ones range resolution exists to serve. A
    // guard that reads only a spelled-out subtag handed a Taiwanese reader
    // Simplified text, under `<html lang="zh-Hans">`, with no disclosure
    // (reviewer F1). This article has only Simplified.
    await page.goto(`${ARTICLE}?lang=zh-TW`);

    const served = await headingText(page);
    expect(served).toContain(ENGLISH_TITLE);
    expect(served).not.toContain(SIMPLIFIED_TITLE);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    //...and the reader is TOLD, rather than quietly handed another script.
    await expect(page.locator("#article-language-fallback")).toContainText(
      /Chinese/,
    );

    // A region that agrees with the article's script still resolves.
    await page.goto(`${ARTICLE}?lang=zh-CN`);
    expect(await headingText(page)).toContain(SIMPLIFIED_TITLE);
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-Hans");
    // Nothing to disclose when the request was answered.
    await expect(page.locator("#article-language-fallback")).toHaveCount(0);

    // On the two-script article a region-bearing tag picks its own script,
    // where a bare `zh` cannot.
    await page.goto(`${BOTH_SCRIPTS}?lang=zh-TW`);
    expect(await headingText(page)).toContain(TRADITIONAL_TITLE);
    await page.goto(`${BOTH_SCRIPTS}?lang=zh-CN`);
    expect(await headingText(page)).toContain(SIMPLIFIED_TITLE);
  });

  test("a resolved range still discloses when it could not be honoured", async ({
    page,
  }) => {
    // The disclosure used to be read out of the RETRIED response, where
    // `requested_language === actual_language` and `fallback_used` is false —
    // structurally unreachable for every range request (reviewer F1). `zh` on
    // the two-script article is the case that must speak up.
    await page.goto(`${BOTH_SCRIPTS}?lang=zh`);

    expect(await headingText(page)).toContain(ENGLISH_TITLE);
    await expect(page.locator("#article-language-fallback")).toContainText(
      /Chinese/,
    );

    //...and stays quiet when the range WAS honoured: `?lang=zh` on the
    // single-Chinese-variant article is answered, so there is nothing to say.
    await page.goto(`${ARTICLE}?lang=zh`);
    expect(await headingText(page)).toContain(SIMPLIFIED_TITLE);
    await expect(page.locator("#article-language-fallback")).toHaveCount(0);
  });

  test("a request for one script is never answered with the other", async ({
    page,
  }) => {
    // Two Chinese variants: `zh` names neither, so nothing is guessed. The
    // reader keeps the source and is offered the choice — serving Simplified
    // to someone who may have meant Traditional is 's defect.
    await page.goto(`${BOTH_SCRIPTS}?lang=zh`);
    const ambiguous = await headingText(page);
    expect(ambiguous).toContain(ENGLISH_TITLE);
    expect(ambiguous).not.toContain(SIMPLIFIED_TITLE);
    expect(ambiguous).not.toContain(TRADITIONAL_TITLE);

    // Named exactly, each script serves its own text.
    await page.goto(`${BOTH_SCRIPTS}?lang=zh-Hant`);
    expect(await headingText(page)).toContain(TRADITIONAL_TITLE);
    await page.goto(`${BOTH_SCRIPTS}?lang=zh-Hans`);
    expect(await headingText(page)).toContain(SIMPLIFIED_TITLE);
  });

  test("a ?lang= the API rejects renders the article anyway", async ({
    page,
  }) => {
    // `?lang=` selects a REPRESENTATION. `zz-ZZ` is well-formed BCP-47 and not
    // a language, so the API 400s it — and a stranger's typo in a shared link
    // must not be a 500 for everyone who clicks it (codex adversarial review).
    const response = await page.goto(`${ARTICLE}?lang=zz-ZZ`);

    expect(response?.status()).toBe(200);
    expect(await headingText(page)).toContain(ENGLISH_TITLE);
    await expect(page.locator(".markdown-content").first()).toContainText(
      "zh-fixture-english-body",
    );
  });

  test("recovering from a rejected ?lang= still resolves the default", async ({
    page,
  }) => {
    // Spanish source, and the only English text is `en-US`. A rejected
    // `?lang=zz-ZZ` degrades to `en` — and the range resolution has to run
    // against THAT, not against the tag the API just refused, or this reader
    // gets Spanish while the crawler tier (which defaults to `en` and resolves
    // it) serves American English from the same URL (codex adversarial review).
    await page.goto(`${REGIONAL}?lang=zz-ZZ`);

    expect(await headingText(page)).toContain(AMERICAN_TITLE);
    await expect(page.locator("html")).toHaveAttribute("lang", "en-US");

    // The query-free URL resolves the same way, which is the shape the Django
    // tier is asserted against in test_crawler_language.py.
    await page.goto(REGIONAL);
    expect(await headingText(page)).toContain(AMERICAN_TITLE);

    //...and asking for Spanish by name still gets the source.
    await page.goto(`${REGIONAL}?lang=es`);
    expect(await headingText(page)).toContain(SPANISH_TITLE);
  });

  test("the immutable /article/<id> route declares the variant too", async ({
    page,
  }) => {
    // The same four surfaces on the escape-hatch route, which has the same
    // shape and had the same defect.
    await page.goto(`/article/zh-variant-fixture?lang=zh-Hans`);

    expect(await headingText(page)).toContain(SIMPLIFIED_TITLE);
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-Hans");
    await expect(page.locator("article").first()).toHaveAttribute(
      "lang",
      "zh-Hans",
    );

    //...including the hreflang cluster, which this route computed all along
    // and simply never rendered. `javaScriptEnabled: false` on this
    // describe block is what makes it an assertion about the SERVER's markup:
    // a crawler does not hydrate, so a cluster added on mount is a cluster
    // that does not exist. the `<head>` is also the AUTHORITATIVE
    // carrier — past `SITEMAP_MAX_BYTES_PER_ZPAGE` per article the sitemap stops
    // repeating the cluster and relies on exactly this markup.
    const alternates = await page.evaluate(() =>
      [
        ...document.querySelectorAll<HTMLLinkElement>(
          'link[rel="alternate"][hreflang]',
        ),
      ].map((link) => ({
        hreflang: link.getAttribute("hreflang"),
        href: new URL(link.href).pathname + new URL(link.href).search,
      })),
    );
    // The cluster is the article's, so it points at the canonical
    // /{user}/{vanity} URLs, not at this immutable-id alias.
    expect(alternates).toEqual([
      { hreflang: "en", href: `${ARTICLE}?lang=en` },
      { hreflang: "zh-Hans", href: `${ARTICLE}?lang=zh-Hans` },
      { hreflang: "x-default", href: ARTICLE },
    ]);
  });

  test("the variant is advertised to crawlers and canonicalizes to itself", async ({
    page,
  }) => {
    await page.goto(ARTICLE);

    const alternates = await page.evaluate(() =>
      [
        ...document.querySelectorAll<HTMLLinkElement>(
          'link[rel="alternate"][hreflang]',
        ),
      ].map((link) => ({
        hreflang: link.getAttribute("hreflang"),
        href: new URL(link.href).pathname + new URL(link.href).search,
      })),
    );

    // On prod this list was `en` + `x-default` only, with no sign that a
    // Chinese translation existed at all.
    expect(alternates).toEqual([
      { hreflang: "en", href: `${ARTICLE}?lang=en` },
      { hreflang: "zh-Hans", href: `${ARTICLE}?lang=zh-Hans` },
      { hreflang: "x-default", href: ARTICLE },
    ]);

    // The variant's own page agrees: an hreflang whose target canonicalizes
    // elsewhere costs the whole cluster.
    await page.goto(`${ARTICLE}?lang=zh-Hans`);
    const canonical = await page.evaluate(() => {
      const link = document.querySelector<HTMLLinkElement>(
        'link[rel="canonical"]',
      );
      return link
        ? new URL(link.href).pathname + new URL(link.href).search
        : null;
    });
    expect(canonical).toBe(`${ARTICLE}?lang=zh-Hans`);
  });
});

test("the switcher offers a variant the product UI is not translated into", async ({
  page,
}) => {
  await page.goto(`${BOTH_SCRIPTS}?lang=zh-Hans`);

  // With JavaScript ON: the document language survives hydration. `setLocale`
  // runs on mount and writes `<html lang>` too, so before 's fix the SSR
  // markup was right and the hydrated page quietly reverted to `en`.
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-Hans");

  const control = page.locator("select#article-language");
  await expect(control).toBeVisible();
  // Every variant, each as its own exact tag. The filter this replaces left
  // `["en"]` here on a three-language article.
  await expect(control.locator("option")).toHaveCount(3);
  expect(
    await control
      .locator("option")
      .evaluateAll((options) =>
        options.map((option) => (option as HTMLOptionElement).value),
      ),
  ).toEqual(["en", "zh-Hans", "zh-Hant"]);
  // Named, never rendered as a raw subtag.
  const labels = await control
    .locator("option")
    .evaluateAll((options) =>
      options.map((option) => option.textContent?.trim()),
    );
  expect(labels).not.toContain("zh-Hans");
  expect(labels?.every((label) => Boolean(label))).toBe(true);
  // The control shows the variant that is actually on screen.
  await expect(control).toHaveValue("zh-Hans");

  // Switching is a content choice and nothing else: it must not re-skin the
  // product UI, and it must not persist a UI-locale cookie ( P9).
  // Re-select until the URL moves: the `<select>` is server-rendered, so a
  // change fired before hydration reaches no handler at all and navigates
  // nowhere. (Same race, same remedy, as `converse-stream.spec.ts`.)
  await expect
    .poll(
      async () => {
        if (!/lang=zh-Hant/.test(page.url())) {
          await control.selectOption("zh-Hant");
        }
        return page.url();
      },
      { timeout: 30_000 },
    )
    .toMatch(/lang=zh-Hant/);
  await expect(page.locator("h1").first()).toContainText(TRADITIONAL_TITLE, {
    timeout: 30_000,
  });
  expect(new URL(page.url()).searchParams.get("lang")).toBe("zh-Hant");
  // The document language follows the switch, and the chrome does not.
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-Hant");
  await expect(page.locator("nav").first()).toHaveAttribute("lang", "en");
  const localeCookie = (await page.context().cookies()).find(
    (cookie) => cookie.name === "free2z-locale",
  );
  expect(localeCookie?.value ?? "en").toBe("en");
});

test("the immutable route keeps the document language after hydration", async ({
  page,
}) => {
  // With JavaScript ON, and driven rather than raced: asserting right after
  // `goto` proves nothing, because `toHaveAttribute` passes on the SSR value
  // before the layout's mounted `setLocale` can overwrite it. Calling
  // `setLocale` ourselves puts the write strictly after hydration, which is the
  // ordering that used to lose the language here (codex adversarial review).
  await page.goto(`/article/zh-variant-fixture?lang=zh-Hans`);
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-Hans");

  await page.evaluate(async (loader) => {
    const { setLocale } = await new Function(loader)();
    setLocale("es");
  }, I18N_LOADER);

  await expect(page.locator("nav").first()).toHaveAttribute("lang", "es");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-Hans");
  expect(await headingText(page)).toContain(SIMPLIFIED_TITLE);
});

test("changing the UI language does not relabel the article's language", async ({
  page,
}) => {
  // The one case that separates "the document language is decided in one
  // place" from "whoever writes the attribute last wins": `setLocale` also
  // writes `<html lang>`, and it runs on every UI-language change — after the
  // page has already declared the variant it is showing.
  await page.goto(`${ARTICLE}?lang=zh-Hans`);
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-Hans");

  await page.evaluate(async (loader) => {
    const { setLocale } = await new Function(loader)();
    setLocale("es");
  }, I18N_LOADER);

  // The chrome is Spanish now...
  await expect(page.locator("nav").first()).toHaveAttribute("lang", "es");
  //...and the document is still the Chinese article it was.
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-Hans");
  expect(await headingText(page)).toContain(SIMPLIFIED_TITLE);
});
