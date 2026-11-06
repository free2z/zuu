import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { createServer } from "vite";

let server, render, captions, plainText, extract, social;
before(async () => {
  server = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  ({ processMarkdown: render, extractPlainText: extract } =
    await server.ssrLoadModule("/src/lib/utils/markdown.ts"));
  captions = await server.ssrLoadModule("/src/lib/utils/image-caption.ts");
  plainText = await server.ssrLoadModule("/src/lib/utils/plainText.ts");
  social = await server.ssrLoadModule("/src/lib/social-card-text.ts");
});
after(async () => {
  await server?.close();
});

test("caption roundtrip, edit and removal preserve alt, title and image", () => {
  const image =
    '![Accessible description](/uploadz/public/a.png "Existing title")';
  const caption = '雪 \"caption\"\nمرحبا';
  const source = captions.serializeCaptionedImage(image, caption);
  assert.deepEqual(captions.parseCaptionedImage(source), { image, caption });
  const html = render(source);
  assert.match(
    html,
    /<figure><img\b[^>]*alt="Accessible description"[^>]*title="Existing title"/,
  );
  assert.match(
    html,
    /<figcaption>雪 "caption"<br>مرحبا<\/figcaption><\/figure>/,
  );
  assert.match(
    render(captions.updateImageCaption(source, "changed")),
    /<figcaption>changed<\/figcaption>/,
  );
  assert.equal(captions.updateImageCaption(source, ""), image);
});

test("legacy images and inline text remain ordinary markdown", () => {
  const image = '![alt](https://example.com/a.png "title")';
  const html = render(`before ${image} after`);
  assert.match(html, /<p>before <img/);
  assert.match(html, /title="title"/);
  assert.doesNotMatch(html, /figure|figcaption/);
  assert.doesNotMatch(render(`<img src="x" onerror="alert(1)">`), /<img/);
  assert.doesNotMatch(render('text\n::caption["hello"]'), /<figure>/);
  const fenced =
    "```\n" + captions.serializeCaptionedImage(image, "caption") + "\n```";
  assert.doesNotMatch(render(fenced), /<figure>/);
  assert.doesNotMatch(
    render(`    ${image}\n::caption["code example"]`),
    /<figure>/,
  );
});

test("captioned image lines interrupt preceding paragraphs", () => {
  const image = '![alt](https://example.com/a.png "title")';
  const html = render(
    `Before\n${captions.serializeCaptionedImage(image, "Visible caption")}\nAfter`,
  );
  assert.match(html, /<p>Before<\/p>\s*<figure><img/);
  assert.match(html, /<figcaption>Visible caption<\/figcaption><\/figure>/);
  assert.match(html, /<p>After<\/p>/);
  assert.doesNotMatch(html, /::caption/);
});

test("article summaries include caption text without its serialization", () => {
  const source = captions.serializeCaptionedImage(
    "![Bird](/image.png)",
    'Snow\n"Bird" [detail] Price < $5 > $2; 5 * 3 = 15',
  );
  assert.equal(
    plainText.markdownToPlainText(`${source}\n\nArticle prose.`),
    'Bird Snow "Bird" [detail] Price < $5 > $2; 5 * 3 = 15 Article prose.',
  );
  const fenced = `~~~\n${source}\n~~~`;
  assert.equal(plainText.stripMediaDirectivesFromSummary(fenced), fenced);
  assert.equal(
    plainText.stripMediaDirectivesFromSummary(
      'Ordinary prose\n::caption["literal"]',
    ),
    'Ordinary prose\n::caption["literal"]',
  );
});

test("untrusted caption and image attributes cannot inject markup or scripts", () => {
  const html = render(
    captions.serializeCaptionedImage(
      "![alt](javascript:alert(1))",
      "<script>alert(1)</script>\n<img src=x onerror=alert(1)>",
    ),
  );
  assert.doesNotMatch(html, /<script|<img[^>]*onerror|src="javascript:/i);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test("all summaries preserve literal caption punctuation and whitespace", () => {
  const caption =
    "Line one\nLine two Use *literal* text and [brackets](verbatim); Price < $5 > $2";
  const source = captions.serializeCaptionedImage(
    "![Bird](/image.png)",
    caption,
  );
  const expected = caption.replace(/\s+/g, " ");
  assert.equal(extract(source, 500), expected);
  assert.equal(social.plainSocialCardSummaryText(source, 500), expected);
  assert.equal(plainText.markdownToPlainText(source, 500), `Bird ${expected}`);
});

test("caption parsing accepts only canonical JSON with visible text controls", () => {
  const image = "![Bird](/image.png)";
  for (const caption of [
    "雪 🌿",
    "line\nnext\tcolumn\rreturn",
    '"quoted" \\ path',
    "$999",
  ]) {
    const source = captions.serializeCaptionedImage(image, caption);
    assert.equal(captions.parseCaptionedImage(source)?.caption, caption);
  }
  for (const encoded of [
    '"\\u0024999"',
    '"pay\\/here"',
    '"hidden\\btext"',
    '"hidden\\u0000text"',
  ]) {
    const source = `${image}\n::caption[${encoded}]`;
    assert.equal(captions.parseCaptionedImage(source), null);
    assert.doesNotMatch(render(source), /<figcaption>/);
  }
});

test("summary caption placeholders have bounded collision handling", () => {
  const hostile = "F2ZCAPTIONTOKEN" + "X".repeat(99000);
  assert.doesNotThrow(() => social.plainSocialCardSummaryText(hostile));
  const collisions = "F2ZCAPTIONTOKEN0SEP0END F2ZCAPTIONTOKEN1SEP0END";
  const source = `${collisions}\n\n${captions.serializeCaptionedImage("![a](/x)", "literal")}`;
  assert.equal(
    plainText.markdownToPlainText(source, 500),
    `${collisions} a literal`,
  );
});

test("public list excerpt ellipses never expose caption serialization", () => {
  const source = captions.serializeCaptionedImage(
    "![Bird](/x)",
    "Snow in the park",
  );
  for (const summary of [
    extract,
    plainText.markdownToPlainText,
    social.plainSocialCardSummaryText,
  ]) {
    assert.match(summary(`${source}...`, 500), /Snow in the park/);
    assert.doesNotMatch(summary(`${source}...`, 500), /::caption/);
    const long = captions.serializeCaptionedImage(
      "![Bird](/x)",
      "snow ".repeat(100),
    );
    assert.doesNotMatch(summary(long.slice(0, 365) + "...", 500), /::caption/);
  }
});
