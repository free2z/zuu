import { Resvg } from "@resvg/resvg-js";
import { contentLanguageDirection } from "$lib/zpage-language.js";

import {
  ogTextGraphemes as graphemes,
  MAX_TEXT_CODE_UNITS,
  truncateOgText,
} from "$lib/social-card-text";
export { truncateOgText } from "$lib/social-card-text";

/** Preserve graphemes while breaking words that cannot fit a whole line. */
export function wrapOgText(value: string, width: number, limit: number) {
  const lines: string[] = [];
  let line: string[] = [];
  const words = truncateOgText(value, MAX_TEXT_CODE_UNITS).trim().split(/\s+/);
  for (const word of words) {
    const units = Array.from(graphemes.segment(word), ({ segment }) => segment);
    if (line.length && line.length + 1 + units.length > width) {
      lines.push(line.join(""));
      line = [];
    } else if (line.length) {
      line.push(" ");
    }
    for (const unit of units) {
      if (line.length === width) {
        lines.push(line.join(""));
        line = [];
      }
      line.push(unit);
    }
  }
  if (line.length) lines.push(line.join(""));
  if (lines.length > limit) {
    lines.length = limit;
    lines[limit - 1] = truncateOgText(`${lines[limit - 1]}…`, width);
  }
  return lines;
}

export function escapeOgXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function ogFontFamily(language?: string) {
  // Han has regional glyph forms. Choose from the actual content language,
  // while keeping all installed scripts available for mixed-language titles.
  const [primary, ...subtags] = (language?.toLowerCase() || "").split("-");
  const traditionalChinese =
    ["zh", "cmn", "yue"].includes(primary) &&
    (subtags.includes("hant") ||
      (!subtags.includes("hans") &&
        (primary === "yue" ||
          subtags.some((tag) => ["tw", "hk", "mo"].includes(tag)))));
  const cjk =
    primary === "ja"
      ? "JP"
      : primary === "ko"
        ? "KR"
        : traditionalChinese
          ? "TC"
          : "SC";
  return `DejaVu Sans,Noto Sans CJK ${cjk},Noto Sans Arabic,Noto Sans Hebrew,Noto Sans Bengali,Noto Sans Devanagari,Noto Sans Ethiopic,Noto Sans Gujarati,Noto Sans Gurmukhi,Noto Sans Kannada,Noto Sans Khmer,Noto Sans Lao,Noto Sans Malayalam,Noto Sans Myanmar,Noto Sans Sinhala,Noto Sans Tamil,Noto Sans Telugu,Noto Sans Thai,Noto Emoji,sans-serif`;
}

type TextLine = {
  text: string;
  y: number;
  size: number;
  bold?: boolean;
  color: string;
};

/**
 * Shape the bounded text block once, then reuse its paths in the card. The
 * actual glyph bounds, including fallback fonts and overhangs, determine the
 * fit. No per-character rasterization or guessed average character width.
 */
export function renderOgTextBlock(
  lines: TextLine[],
  { x, width, language }: { x: number; width: number; language?: string },
) {
  const rtl = contentLanguageDirection(language) === "rtl";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">${lines
    .map(
      ({ text, y, size, bold, color }) =>
        // Resvg 2.6.2 ignores SVG direction/unicode-bidi attributes. Its text
        // shaper honors Unicode embeddings, including when a RTL line starts
        // with a Latin name. Keep these controls inside this shaping boundary.
        `<text x="0" y="${y}" text-anchor="${rtl ? "end" : "start"}" font-family="${ogFontFamily(language)}" font-size="${size}" font-weight="${bold ? 700 : 400}" fill="${color}">${escapeOgXml(rtl ? `\u202b${text}\u202c` : text)}</text>`,
    )
    .join("")}</svg>`;
  const rendered = new Resvg(svg);
  const bounds = rendered.getBBox();
  if (!bounds || !bounds.width) return "";
  const scale = Math.min(1, width / bounds.width);
  const offset =
    x - bounds.x * scale + (rtl ? width - bounds.width * scale : 0);
  // Resvg serializes text as paths, preserving precisely the glyphs measured
  // above. The final card does not re-shape the block under different fonts.
  const paths = rendered
    .toString()
    .replace(/^<svg\b[^>]*>/, "")
    .replace(/<\/svg>\s*$/, "");
  // Preserve glyph proportions when the fallback face needs a smaller size.
  // Keep the top of the block fixed while reducing its width and height.
  return `<g transform="translate(${offset} ${bounds.y * (1 - scale)}) scale(${scale})">${paths}</g>`;
}
