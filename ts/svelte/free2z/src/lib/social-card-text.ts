import { stripMediaDirectivesFromSummary } from "$lib/utils/plainText";

// Pure text preparation shared by card rendering and public cache revisions.
// Keep native image/font imports in server/og-text.ts.
export const ogTextGraphemes = new Intl.Segmenter("en", {
  granularity: "grapheme",
});
export const MAX_TEXT_CODE_UNITS = 1024;
const MAX_GRAPHEME_CODE_UNITS = 64;

export function truncateOgText(value: string, length: number) {
  // A grapheme can contain arbitrarily many combining marks. Bound both the
  // segmentation input and the glyph work; counting graphemes alone is not a
  // resource limit. Drop the boundary cluster when slicing, never split it.
  let clipped = value.length > MAX_TEXT_CODE_UNITS;
  const segments = Array.from(
    ogTextGraphemes.segment(value.slice(0, MAX_TEXT_CODE_UNITS)),
    ({ segment }) => segment,
  );
  if (clipped) segments.pop();
  const units: string[] = [];
  for (const segment of segments) {
    if (segment.length > MAX_GRAPHEME_CODE_UNITS || units.length === length) {
      clipped = true;
      break;
    }
    units.push(segment);
  }
  return clipped
    ? `${units
        .slice(0, length - 1)
        .join("")
        .trimEnd()}…`
    : units.join("");
}

// Consume paired delimiters without retrying an unmatched opener at every
// following character. The regex forms /<[^>]*>/ and /\[[^\]]+\]/ can
// rescan a 100KB malformed body quadratically before truncation happens.
function stripPairs(value: string, open: string, close: string): string {
  const parts: string[] = [];
  let cursor = 0;
  for (;;) {
    const start = value.indexOf(open, cursor);
    if (start < 0) break;
    const end = value.indexOf(close, start + open.length);
    if (end < 0) break;
    parts.push(value.slice(cursor, start), " ");
    cursor = end + close.length;
  }
  parts.push(value.slice(cursor));
  return parts.join("");
}

function stripLinks(value: string, images: boolean): string {
  const parts: string[] = [];
  const opener = images ? "![" : "[";
  let cursor = 0;
  let bracket = -1;
  let paren = -1;
  for (;;) {
    const start = value.indexOf(opener, cursor);
    if (start < 0) break;
    const label = start + opener.length;
    // Failed candidates may share the same closing delimiter. Cache it so
    // repeated unmatched '[' or '![' never scan the suffix more than once.
    if (bracket < label) bracket = value.indexOf("]", label);
    if (bracket < 0) break;
    if (value[bracket + 1] === "(" && (images || bracket > label)) {
      if (paren < bracket + 2) paren = value.indexOf(")", bracket + 2);
      if (paren < 0) break;
      parts.push(
        value.slice(cursor, start),
        images ? " " : value.slice(label, bracket),
      );
      cursor = paren + 1;
    } else {
      parts.push(value.slice(cursor, label));
      cursor = label;
    }
  }
  parts.push(value.slice(cursor));
  return parts.join("");
}

export function plainSocialCardText(value?: string, maxLength = 180) {
  let text = stripPairs(value || "", "```", "```");
  text = stripLinks(text, true);
  text = stripLinks(text, false);
  text = stripPairs(text, "<", ">");
  text = text
    .replace(/[#*_>`~|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return truncateOgText(text, maxLength);
}

export function plainSocialCardSummaryText(value?: string, maxLength = 180) {
  return plainSocialCardText(
    stripMediaDirectivesFromSummary(value || ""),
    maxLength,
  );
}
