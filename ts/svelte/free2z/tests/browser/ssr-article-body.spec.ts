import { expect, test, type Page } from "@playwright/test";
import { browserAppOrigin } from "./ports";

// A cold vite dev server compiles this route on first request, which alone can
// approach the default per-test budget.
test.describe.configure({ timeout: 90_000 });

const ARTICLE = "/ssr-body-user/ssr-body-fixture";

test.beforeAll(async ({ browser }) => {
  test.setTimeout(60_000);
  const context = await browser.newContext({
    javaScriptEnabled: true,
    viewport: { width: 1280, height: 900 },
  });
  const warmPage = await context.newPage();
  const appOrigin = browserAppOrigin();
  await warmPage.goto(`${appOrigin}${ARTICLE}`);
  const content = warmPage.locator(".markdown-content").first();
  await expect(
    content.locator(':is(h2, h3)[data-article-heading="true"]'),
  ).toHaveCount(4, { timeout: 60_000 });
  await context.close();
});

// Every sentinel is a distinct construct in the fixture markdown, so a failure
// names the thing that regressed instead of "the body is missing".
const PROSE_SENTINEL = "ssr-prose-sentinel";
const HEADING_SENTINEL = "ssr-heading-anchor";
const TABLE_SENTINEL = "ssr-table-sentinel";
const CODE_SENTINEL = "ssr-code-sentinel";
const MERMAID_SENTINEL = "ssr-mermaid-sentinel";
const QRCODE_SENTINEL = "ssr-qrcode-sentinel";
const TAIL_SENTINEL = "ssr-tail-sentinel";

/**
 * Visible text as a browser computes it. Deliberately NOT a regex over the
 * response body: Tailwind class names such as `[&>svg]:px-2.5` carry `>` and
 * `<` inside attribute values, so naive tag-stripping both under- and
 * over-counts. With `javaScriptEnabled: false` the DOM this reads is exactly
 * the server's markup — nothing hydrated it.
 */
function visibleText(page: Page) {
  return page.evaluate(() => document.body.innerText.replace(/\s+/g, " "));
}

test.describe("server-rendered article body (no JavaScript)", () => {
  // The crawlers that matter most here — GPTBot, ClaudeBot, PerplexityBot,
  // CCBot, Bytespider, Meta-ExternalAgent — execute no JavaScript at all, and
  // Googlebot only does so in a deferred second wave. This context models them.
  test.use({
    javaScriptEnabled: false,
    userAgent:
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  });

  test("a crawler that runs no JavaScript receives the article prose", async ({
    page,
  }) => {
    await page.goto(ARTICLE);

    const text = await visibleText(page);

    //before the body was server-rendered, this text was ~1 KB of navbar
    // and header chrome and contained none of the following.
    expect(text).toContain(PROSE_SENTINEL);
    expect(text).toContain(HEADING_SENTINEL);
    expect(text).toContain(TABLE_SENTINEL);
    expect(text).toContain(CODE_SENTINEL);
    expect(text).toContain(MERMAID_SENTINEL);
    expect(text).toContain(TAIL_SENTINEL);

    // The header/byline chrome was always server-rendered, so assert the body
    // container specifically: this is what an empty `{@html}` slot would fail.
    const bodyText = await page
      .locator(".markdown-content")
      .first()
      .evaluate((node) => (node as HTMLElement).innerText.trim());
    expect(bodyText).toContain(PROSE_SENTINEL);
    expect(bodyText.length).toBeGreaterThan(200);
  });

  test("markup emitted to a crawler is sanitized and enhancement-ready", async ({
    page,
  }) => {
    await page.goto(ARTICLE);

    const content = page.locator(".markdown-content").first();

    // Structure a crawler can read: real headings with gfm ids, a real table,
    // a real <pre><code> with highlight.js markup.
    // marked-footnote adds its own generated section heading; count only the
    // three author-authored h2 elements here.
    await expect(content.locator("h2[id]:not(.footnotes h2)")).toHaveCount(3);
    await expect(content.locator("h3[id]")).toHaveCount(1);
    await expect(
      content.locator("table td", { hasText: TABLE_SENTINEL }),
    ).toHaveCount(1);
    await expect(content.locator("pre > code.language-python")).toHaveCount(1);

    // Placeholders the client later upgrades are present but inert.
    await expect(
      content.locator(`.qrcode-embed[data-qr-value="${QRCODE_SENTINEL}"]`),
    ).toHaveCount(1);
    await expect(content.locator(".external-embed-placeholder")).toHaveCount(1);

    // processMarkdown emits the loading hints, so even the no-JS render keeps
    // markdown images off the critical path.
    const image = content.locator("img").first();
    await expect(image).toHaveAttribute("loading", "lazy");

    // Sanitization ran server-side: DOMPurify strips event handlers and
    // <script>, so neither can reach the markup.
    const dangerous = await content.evaluate(
      (node) =>
        node.querySelectorAll("script").length +
        node.querySelectorAll("[onclick],[onerror],[onload]").length,
    );
    expect(dangerous).toBe(0);
  });
});

test("hydration enhances the server markup instead of rebuilding it", async ({
  page,
}) => {
  // The `{@html}` block is hydrated, then the imperative pipeline takes over
  // the same nodes. Svelte reports a disagreement between server and client
  // markup as a hydration warning/error, and any teardown bug surfaces as an
  // uncaught exception — both would be silent from the DOM assertions alone.
  // Resource-level failures (the fixture image has no file behind it) are
  // deliberately not in scope here.
  const consoleProblems: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (/hydrat|mismatch/i.test(text)) {
      consoleProblems.push(`${message.type()}: ${text}`);
    }
  });
  page.on("pageerror", (error) => {
    consoleProblems.push(`pageerror: ${error.message}`);
  });

  await page.goto(ARTICLE);

  const content = page.locator(".markdown-content").first();

  // --- every enhancement pass still runs -----------------------------------
  // setContent's outline tagging: exactly the creator's four headings, and not
  // the heading the embed consent card mounts afterwards.
  await expect(
    content.locator(':is(h2, h3)[data-article-heading="true"]'),
  ).toHaveCount(4);
  // enhanceHeadings — a `#` permalink inside each of those four.
  await expect(
    content.locator(
      ':is(h2, h3)[data-article-heading="true"] > a.heading-anchor',
    ),
  ).toHaveCount(4);
  // enhanceTables
  await expect(content.locator(".markdown-table-scroll > table")).toHaveCount(
    1,
  );
  // enhanceCodeBlocks — the mermaid block must NOT get a shell, the python one must
  await expect(content.locator(".code-block-shell[data-wrap]")).toHaveCount(1);
  await expect(
    content.locator(".code-block-shell").getByText("PYTHON"),
  ).toBeVisible();
  // renderMermaidDiagrams
  await expect(content.locator(".mermaid-diagram svg")).toHaveCount(1);
  // mountQrCodes
  await expect(content.locator(".markdown-qrcode")).toHaveCount(1);
  await expect(content.locator(".markdown-qrcode")).toContainText(
    QRCODE_SENTINEL,
  );
  // mountEmbeds — the placeholder is replaced by the consent-gated component
  await expect(content.locator(".external-embed-placeholder")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "External content blocked" }),
  ).toBeVisible();

  // The outline is built by a MutationObserver over the article. Skipping the
  // initial innerHTML write removes one mutation, so prove the outline still
  // populates from the enhancement mutations alone.
  await expect(
    page.getByRole("button", { name: /Heading sentinel/ }).first(),
  ).toBeVisible();

  // --- and the body is rendered exactly once -------------------------------
  const occurrences = await page.evaluate((needle) => {
    return document.body.innerText.split(needle).length - 1;
  }, PROSE_SENTINEL);
  expect(occurrences).toBe(1);

  expect(consoleProblems).toEqual([]);
});

// ---------------------------------------------------------------------------
// The other branch: an article past the SSR cost ceilings.
//
// This is the path nobody will ever click on again, and the one where a bug
// would be invisible — the snapshot is skipped, so the body is built entirely
// client-side, exactly as every article did before.
// ---------------------------------------------------------------------------

const OVERCAP_ARTICLE = "/ssr-body-user/ssr-overcap-fixture";
const OVERCAP_PROSE = "ssr-overcap-prose-sentinel";
const OVERCAP_QUOTE = "ssr-overcap-quote-sentinel";
const OVERCAP_CODE = "ssr-overcap-code-sentinel";

test.describe("an article too expensive to server-render", () => {
  test("declares the fallback instead of failing silently", async ({
    page,
  }) => {
    // The whole point of the attribute: someone diffing view-source, or
    // grepping a crawl, can see that this body was deferred rather than
    // wondering why the article looks empty to a bot.
    await page.goto(OVERCAP_ARTICLE);

    await expect(page.locator(".markdown-content")).toHaveAttribute(
      "data-ssr-body",
      "deferred",
    );
    //...and a normal article does not claim it.
    await page.goto(ARTICLE);
    await expect(page.locator(".markdown-content")).not.toHaveAttribute(
      "data-ssr-body",
      "deferred",
    );
  });

  test("still renders completely for a human", async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto(OVERCAP_ARTICLE);

    const content = page.locator(".markdown-content").first();
    // The client-side write path ran: prose, the deep quote, and an enhanced
    // code block are all present.
    await expect(content).toContainText(OVERCAP_PROSE);
    await expect(content).toContainText(OVERCAP_QUOTE);
    await expect(content.locator(".code-block-shell")).toHaveCount(1);
    await expect(content).toContainText(OVERCAP_CODE);
    // Heading enhancement still runs over client-built DOM.
    await expect(
      content.locator('h2[data-article-heading="true"] > a.heading-anchor'),
    ).toHaveCount(1);

    expect(pageErrors).toEqual([]);
  });

  test("is genuinely absent from the markup a crawler receives", async ({
    browser,
  }) => {
    // The trade this ceiling makes, asserted rather than assumed: a bot gets
    // nothing here. If someone raises a ceiling or adds truncation, this test
    // is where they will find out what changed.
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto(OVERCAP_ARTICLE);

    const text = await visibleText(page);
    expect(text).not.toContain(OVERCAP_PROSE);
    await expect(page.locator(".markdown-content")).toHaveAttribute(
      "data-ssr-body",
      "deferred",
    );

    await context.close();
  });
});
