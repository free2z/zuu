/**
 * A minimal PNG reader and the WCAG contrast maths, for tests that need to
 * assert what a reader actually sees rather than what the CSS says.
 *
 * Playwright screenshots are 8-bit, non-interlaced PNGs, which is the only
 * shape this handles — deliberately, so it stays small enough to audit and
 * pulls in no dependency. Anything else throws rather than guessing.
 */

import zlib from "node:zlib";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
/** @type {Record<number, number>} */
const CHANNELS_BY_COLOR_TYPE = { 0: 1, 2: 3, 4: 2, 6: 4 };

/**
 * @param {Buffer} buffer
 * @returns {{ width: number, height: number, channels: number, data: Buffer }}
 */
export function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("not a PNG");
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  /** @type {Buffer[]} */
  const compressed = [];

  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error("interlaced PNG is not supported");
    } else if (type === "IDAT") {
      compressed.push(data);
    } else if (type === "IEND") {
      break;
    }

    offset += 12 + length;
  }

  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
  const channels = CHANNELS_BY_COLOR_TYPE[colorType];
  if (!channels) throw new Error(`unsupported colour type ${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(compressed));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);

  let read = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[read];
    read += 1;
    const line = raw.subarray(read, read + stride);
    read += stride;

    const current = pixels.subarray(y * stride, (y + 1) * stride);
    const previous =
      y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;

    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? current[x - channels] : 0;
      const up = previous ? previous[x] : 0;
      const upLeft = previous && x >= channels ? previous[x - channels] : 0;
      const value = line[x];

      switch (filter) {
        case 0:
          current[x] = value;
          break;
        case 1:
          current[x] = (value + left) & 0xff;
          break;
        case 2:
          current[x] = (value + up) & 0xff;
          break;
        case 3:
          current[x] = (value + ((left + up) >> 1)) & 0xff;
          break;
        case 4: {
          const estimate = left + up - upLeft;
          const dLeft = Math.abs(estimate - left);
          const dUp = Math.abs(estimate - up);
          const dUpLeft = Math.abs(estimate - upLeft);
          const predictor =
            dLeft <= dUp && dLeft <= dUpLeft
              ? left
              : dUp <= dUpLeft
                ? up
                : upLeft;
          current[x] = (value + predictor) & 0xff;
          break;
        }
        default:
          throw new Error(`unknown PNG filter ${filter}`);
      }
    }
  }

  return { width, height, channels, data: pixels };
}

/** @param {number} value */
function toLinear(value) {
  const channel = value / 255;
  return channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.x relative luminance. @param {[number, number, number]} rgb */
export function relativeLuminance([red, green, blue]) {
  return (
    0.2126 * toLinear(red) + 0.7152 * toLinear(green) + 0.0722 * toLinear(blue)
  );
}

/**
 * WCAG 2.x contrast ratio, 1..21.
 * @param {[number, number, number]} a
 * @param {[number, number, number]} b
 */
export function contrastRatio(a, b) {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * `rgb(24, 24, 27)` / `rgba(...)` / `#rrggbb` -> `[r, g, b]`.
 * @param {string} value
 * @returns {[number, number, number]}
 */
export function parseCssColor(value) {
  const functional = /rgba?\(([^)]+)\)/.exec(value);
  if (functional) {
    const parts = functional[1]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number);
    return /** @type {[number, number, number]} */ ([
      parts[0],
      parts[1],
      parts[2],
    ]);
  }
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (hex) {
    const int = Number.parseInt(hex[1], 16);
    return /** @type {[number, number, number]} */ ([
      (int >> 16) & 0xff,
      (int >> 8) & 0xff,
      int & 0xff,
    ]);
  }
  throw new Error(`cannot parse colour: ${value}`);
}

/**
 * @typedef {{ width: number, height: number, channels: number, data: Buffer }} Image
 */

/*
 * `worstContrastAgainst(image, color)` — "the worst pixel anywhere in this
 * box" — lived here and has been REMOVED rather than left for the next test to
 * reach for. It was the right probe while the zPage headline sat on a
 * full-width band, because then every pixel in the box was backing. It is the
 * wrong probe for text backed by a glyph-shaped pad: the photograph showing
 * through between the words is the feature, so a box-wide worst pixel reports
 * ~1:1 on a hero that is perfectly legible, and the obvious way to make it
 * pass again is to put the band back. Use `differenceMask` + `annulusAround` +
 * `worstContrastInMask` below, which state the claim where it is actually
 * made: within a few pixels of the letterforms.
 */

/**
 * The pixels where two renders of the SAME clip differ.
 *
 * Used to recover a glyph mask: render the text in a colour nothing else in
 * the frame uses, render it transparent, and every pixel that moved between
 * the two is a pixel the text covers — antialiased edges included, and
 * independent of what the photograph underneath happens to be. That last part
 * is why it is a difference rather than a colour match: white text over a
 * near-white cover is exactly the case the hero's contrast matrix exists for,
 * and it is the case a "find the pixels that look like the text colour" mask
 * gets wrong.
 *
 * @param {Image} a
 * @param {Image} b
 * @param {number} threshold per-channel difference that counts as "moved"
 * @returns {Uint8Array} 1 where the renders differ, 0 where they agree
 */
export function differenceMask(a, b, threshold = 10) {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error("difference of two differently sized images");
  }
  const mask = new Uint8Array(a.width * a.height);
  for (let index = 0; index < mask.length; index += 1) {
    const offsetA = index * a.channels;
    const offsetB = index * b.channels;
    const moved =
      Math.abs(a.data[offsetA] - b.data[offsetB]) > threshold ||
      Math.abs(a.data[offsetA + 1] - b.data[offsetB + 1]) > threshold ||
      Math.abs(a.data[offsetA + 2] - b.data[offsetB + 2]) > threshold;
    mask[index] = moved ? 1 : 0;
  }
  return mask;
}

/**
 * The ring of pixels within `radius` of the mask but not in it — the
 * background immediately around each glyph.
 *
 * Euclidean, not a square kernel: a square dilation of radius 3 reaches 4.2px
 * diagonally, which would quietly assert a weaker claim on the diagonals than
 * on the axes.
 *
 * @param {Uint8Array} mask
 * @param {number} width
 * @param {number} height
 * @param {number} radius
 * @returns {Uint8Array}
 */
export function annulusAround(mask, width, height, radius) {
  /** @type {Array<[number, number]>} */
  const kernel = [];
  const limit = Math.ceil(radius);
  for (let dy = -limit; dy <= limit; dy += 1) {
    for (let dx = -limit; dx <= limit; dx += 1) {
      if (dx * dx + dy * dy <= radius * radius) kernel.push([dx, dy]);
    }
  }

  const ring = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (mask[index]) continue;
      for (const [dx, dy] of kernel) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        if (mask[ny * width + nx]) {
          ring[index] = 1;
          break;
        }
      }
    }
  }
  return ring;
}

/**
 * The worst contrast any masked pixel of `image` has against `color`, sampling
 * EVERY masked pixel rather than a grid — a glyph annulus is a few pixels
 * wide, and a stride of 3 would step straight over most of it.
 *
 * @param {Image} image
 * @param {Uint8Array} mask
 * @param {[number, number, number]} color
 */
export function worstContrastInMask(image, mask, color) {
  let worst = Number.POSITIVE_INFINITY;
  /** @type {[number, number, number] | null} */
  let worstPixel = null;
  let samples = 0;

  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) continue;
    samples += 1;
    const offset = index * image.channels;
    const pixel = /** @type {[number, number, number]} */ ([
      image.data[offset],
      image.data[offset + 1],
      image.data[offset + 2],
    ]);
    const ratio = contrastRatio(pixel, color);
    if (ratio < worst) {
      worst = ratio;
      worstPixel = pixel;
    }
  }

  return { ratio: worst, pixel: worstPixel, samples };
}

/** How many pixels a mask selects. @param {Uint8Array} mask */
export function maskCoverage(mask) {
  let count = 0;
  for (let index = 0; index < mask.length; index += 1) count += mask[index];
  return count;
}
