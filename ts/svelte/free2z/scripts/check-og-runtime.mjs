import assert from "node:assert/strict";
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";
import { OG_SCRIPT_SAMPLES } from "./og-script-samples.mjs";

// This runs in the final Alpine image, where host fonts and dev dependencies
// cannot conceal missing runtime packages.
const text = new Resvg(
  '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="80"><text x="10" y="60" font-family="Arial,sans-serif" font-size="48" fill="white">Free2Z</text></svg>',
).render();
const pixels = text.pixels;
let ink = 0;
for (let i = 3; i < pixels.length; i += 4) {
  if (pixels[i]) ink++;
}
assert.ok(ink > 500, `OG runtime has no usable fonts (${ink} text pixels)`);

// Missing characters produce visible .notdef boxes, so positive ink alone
// cannot establish script support. Shape all samples in one bounded render
// and compare each tile against an unassigned-codepoint negative control.
const samples = [...Object.entries(OG_SCRIPT_SAMPLES), ["missing", "\u0378"]];
const tileWidth = 100;
const tileHeight = 100;
const atlas = new Resvg(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${samples.length * tileWidth}" height="${tileHeight}">${samples
    .map(
      ([, sample], index) =>
        `<text x="${index * tileWidth + 5}" y="75" font-family="DejaVu Sans,sans-serif" font-size="64" fill="white">${sample}</text>`,
    )
    .join("")}</svg>`,
).render();
// The native getter copies the whole atlas. Read it once, not once per row.
const atlasPixels = atlas.pixels;
function tile(index) {
  const result = Buffer.alloc(tileWidth * tileHeight * 4);
  for (let y = 0; y < tileHeight; y++) {
    const offset = (y * samples.length * tileWidth + index * tileWidth) * 4;
    result.set(
      atlasPixels.subarray(offset, offset + tileWidth * 4),
      y * tileWidth * 4,
    );
  }
  return result;
}
const missing = tile(samples.length - 1);
for (let index = 0; index < samples.length - 1; index++) {
  const pixels = tile(index);
  assert.ok(
    pixels.some((value, position) => position % 4 === 3 && value),
    `${samples[index][0]} has no ink`,
  );
  assert.notDeepEqual(
    pixels,
    missing,
    `${samples[index][0]} renders the missing-glyph box`,
  );
}

// Loading sharp here proves its production-only native musl package and
// libvips dependency are present, including the WebP decoder.
const webp = await sharp({
  create: { width: 8, height: 8, channels: 3, background: "#ff00aa" },
})
  .webp({ lossless: true })
  .toBuffer();
const png = await sharp(webp).png().toBuffer();
const cover = new Resvg(
  `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><image href="data:image/png;base64,${png.toString("base64")}" width="8" height="8"/></svg>`,
).render();
assert.deepEqual([...cover.pixels.subarray(0, 4)], [255, 0, 170, 255]);
console.log(
  `OG runtime: ${ink} Latin text pixels, ${samples.length - 1} script/emoji samples distinct from tofu, and visible WebP-derived cover`,
);
