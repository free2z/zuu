import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { createServer } from "vite";
import { Resvg } from "@resvg/resvg-js";

let server, wrapOgText, truncateOgText, renderOgTextBlock, ogFontFamily;
before(async () => {
  server = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  ({ wrapOgText, truncateOgText, renderOgTextBlock, ogFontFamily } =
    await server.ssrLoadModule("/src/lib/server/og-text.ts"));
});
after(async () => {
  await server?.close();
});

test("regional font forms use exact primary tags and Mandarin aliases", () => {
  for (const [language, region] of [
    ["ja", "JP"],
    ["ja-JP", "JP"],
    ["ko-KR", "KR"],
    ["jam", "SC"],
    ["kok", "SC"],
    ["yue", "TC"],
    ["cmn-Hant", "TC"],
    ["cmn-TW", "TC"],
    ["cmn-Hant-HK", "TC"],
    ["zh-MO", "TC"],
    ["ZH-hANT", "TC"],
    ["cmn", "SC"],
    ["cmn-Hans-TW", "SC"],
    ["yue-Hans", "SC"],
    ["zh-Hans-HK", "SC"],
  ]) {
    assert.ok(
      ogFontFamily(language).includes(`Noto Sans CJK ${region},`),
      language,
    );
  }
});

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
const units = (value) =>
  [...segmenter.segment(value)].map(({ segment }) => segment);

for (const text of [
  "Supercalifragilisticexpialidocious",
  "这是一个没有空格的中文标题也不能覆盖作者选择的封面图片",
  "ภาษาไทยไม่มีช่องว่างระหว่างคำ",
  "👨‍👩‍👧‍👦".repeat(30),
  "e\u0301".repeat(30),
]) {
  test(`wrapping and truncation preserve graphemes: ${text.slice(0, 12)}`, () => {
    const lines = wrapOgText(text, 11, 3);
    assert.ok(lines.length <= 3);
    assert.ok(lines.every((line) => units(line).length <= 11));
    assert.ok(lines.every((line) => !/^[\u0300-\u036f\u200d]/u.test(line)));
    assert.equal(units(truncateOgText(text, 8)).length, 8);
    assert.equal(truncateOgText(text, 8).endsWith("…"), true);
  });
}

test("normal words wrap without losing words or changing spaces", () => {
  assert.deepEqual(wrapOgText("one two three four", 7, 4), [
    "one two",
    "three",
    "four",
  ]);
  assert.deepEqual(wrapOgText("one two three four", 7, 2), [
    "one two",
    "three…",
  ]);
});

test("a giant combining cluster cannot bypass the rendering work limit", () => {
  assert.equal(truncateOgText(`a${"\u0301".repeat(10000)}`, 190), "…");
  assert.equal(truncateOgText(`safe a${"\u0301".repeat(100)}`, 190), "safe…");
  assert.deepEqual(wrapOgText(`a${"\u0301".repeat(10000)}`, 11, 3), ["…"]);
  const prefix = `${"é".repeat(1023)}👨‍👩‍👧‍👦tail`;
  const truncated = truncateOgText(prefix, 2000);
  assert.ok(truncated.length <= 1024);
  assert.ok(!/[\ud800-\udfff]/u.test(truncated));
});

for (const [language, text] of [
  ["en", "WWWWWWWWWWW"],
  ["en", "Supercalifragilisticexpialidocious"],
  ["zh-Hans", "中文支付与隐私技术的最新发展"],
  ["ja", "プライバシーを守る新しい技術"],
  ["ar", "Zcash المدفوعات والخصوصية"],
  ["he", "Zcash פרטיות ותשלומים"],
  ["hi", "गोपनीयता और भुगतान तकनीक"],
]) {
  test(`actual shaped ${language} glyphs fit the artwork-free text column`, () => {
    const block = renderOgTextBlock(
      [
        { text, y: 100, size: 64, bold: true, color: "white" },
        { text: "subtitle", y: 160, size: 23, color: "white" },
      ],
      { x: 74, width: 426, language },
    );
    const renderer = new Resvg(
      `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="200">${block}</svg>`,
      { font: { loadSystemFonts: false } },
    );
    const bounds = renderer.getBBox();
    assert.ok(
      bounds,
      "text paths must survive without fonts on the final rasterizer",
    );
    assert.ok(bounds.x >= 73.9, `left edge ${bounds.x}`);
    assert.ok(bounds.y >= 15, `top edge ${bounds.y}`);
    assert.ok(bounds.y + bounds.height <= 170, "text stays near its baseline");
    assert.ok(
      bounds.x + bounds.width <= 500.1,
      `right edge ${bounds.x + bounds.width}`,
    );
    const { pixels } = renderer.render();
    for (let y = 0; y < 200; y++) {
      for (let x = 510; x < 1200; x++) {
        assert.equal(
          pixels[(y * 1200 + x) * 4 + 3],
          0,
          `text entered cover at ${x},${y}`,
        );
      }
    }
  });
}

test("RTL lines share the right edge and preserve vertical placement", () => {
  const block = renderOgTextBlock(
    [
      { text: "الكتابة", y: 245, size: 48, color: "white" },
      { text: "المستقلة", y: 310, size: 48, color: "white" },
    ],
    { x: 74, width: 426, language: "ar" },
  );
  const renderer = new Resvg(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">${block}</svg>`,
    { font: { loadSystemFonts: false } },
  );
  const bounds = renderer.getBBox();
  assert.ok(bounds.y >= 180, `top edge ${bounds.y}`);
  const { pixels } = renderer.render();
  const rightEdge = (start, end) => {
    let right = 0;
    for (let y = start; y < end; y++) {
      for (let x = 74; x < 510; x++) {
        if (pixels[(y * 1200 + x) * 4 + 3]) right = Math.max(right, x);
      }
    }
    return right;
  };
  assert.ok(Math.abs(rightEdge(180, 260) - rightEdge(260, 330)) <= 4);
});

test("mixed RTL text uses RTL run order even when a Latin name comes first", () => {
  const text = "Zcash المدفوعات والخصوصية";
  const pathData = (svg) =>
    [...svg.matchAll(/<path\b[^>]*\bd="([^"]+)"/g)].map((match) => match[1]);
  const reference = (content) =>
    pathData(
      new Resvg(
        `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><text x="0" y="245" text-anchor="end" font-family="${ogFontFamily("ar")}" font-size="48" font-weight="400" fill="white">${content}</text></svg>`,
      ).toString(),
    );
  const rtl = reference(`\u202b${text}\u202c`);
  assert.notDeepEqual(
    rtl,
    reference(text),
    "fixture must distinguish base run order",
  );
  const block = renderOgTextBlock(
    [{ text, y: 245, size: 48, color: "white" }],
    { x: 74, width: 426, language: "ar" },
  );
  assert.deepEqual(pathData(block), rtl);
});
