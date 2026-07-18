import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";

let server;
let markdown;
let createSlashCommands;

before(async () => {
  server = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  markdown = await server.ssrLoadModule("/src/lib/utils/markdown.ts");
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
  assert.match(standalone, /^<p><span class="katex">/);
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

  assert.match(html, /<code>::qrcode\[literal\]<\/code>/);
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
  assert.doesNotMatch(videos, /markdown-embed-image/);
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

test("editor slash commands insert the supported f2z syntax", () => {
  const commands = Object.fromEntries(
    createSlashCommands().map((command) => [command.name, command]),
  );

  assert.equal(commands["Inline Math"].insert, "$$x^2$$");
  assert.equal(
    commands["Math Block"].insert.slice(
      commands["Math Block"].selectionStartOffset,
      commands["Math Block"].selectionEndOffset,
    ),
    "\\frac{a}{b}",
  );
  assert.equal(
    commands["QR Code"].insert,
    "::qrcode[zcash address or content]",
  );
  assert.equal(commands.Iframe.insert, "::iframe[https://example.com]");
  assert.match(
    commands["Audio Embed"].insert,
    /^::embed\[\/uploadz\/.*\.mp3\]$/,
  );
  assert.match(commands.Footnote.insert, /\[\^1\]: Footnote content/);
  assert.match(commands["Numbered Code Block"].insert, /showLineNumbers/);
  assert.equal(
    commands["Inline Math"].insert.slice(
      commands["Inline Math"].selectionStartOffset,
      commands["Inline Math"].selectionEndOffset,
    ),
    "x^2",
  );
  assert.equal(
    commands["QR Code"].insert.slice(
      commands["QR Code"].selectionStartOffset,
      commands["QR Code"].selectionEndOffset,
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
      commands["Inline Math"].insert,
      "",
      commands["QR Code"].insert,
      "",
      commands.Iframe.insert,
      "",
      commands.Footnote.insert,
      "",
      commands["Numbered Code Block"].insert,
    ].join("\n"),
  );
  assert.match(rendered, /class="katex"/);
  assert.match(rendered, /class="qrcode-embed"/);
  assert.match(rendered, /data-embed-url="https:\/\/example.com\/"/);
  assert.match(rendered, /class="footnotes"/);
  assert.match(rendered, /show-line-numbers/);
});
