import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { createServer } from "vite";

let server, render, captions;
before(async () => {
  server = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  ({ processMarkdown: render } = await server.ssrLoadModule(
    "/src/lib/utils/markdown.ts",
  ));
  captions = await server.ssrLoadModule("/src/lib/utils/image-caption.ts");
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
