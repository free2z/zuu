/**
 * Deterministic placeholder art for covers, banners and thumbnails.
 *
 * Four features used to carry four near-identical hash→gradient generators,
 * one of which walked the full 360° hue wheel at 70–75% saturation and put the
 * most saturated surfaces in the app behind editorial cards. This replaces all
 * of them.
 *
 * The rules here are the point:
 *  - Tone comes from a curated set of six near-neutrals, not a hue wheel, so a
 *    wall of covers reads as one family instead of a paint chart.
 *  - Chroma never exceeds 12%. These are surfaces that sit under titles and
 *    avatars; they establish depth, they do not compete.
 *  - Lightness stays inside a narrow band just above the card surface, so
 *    overlaid white text has the same contrast on every card.
 */

/** Stable 32-bit FNV-1a hash. Same seed in, same surface out, forever. */
function hash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Six near-neutral tones. Each is a graphite with a barely-there cast — the
 * variation is felt rather than seen, which is exactly what a placeholder
 * should do.
 */
const TONES = [
  { hue: 258, sat: 12 }, // violet graphite — the house tone
  { hue: 208, sat: 10 }, // cool slate
  { hue: 162, sat: 9 }, // green grey
  { hue: 38, sat: 11 }, // warm sand
  { hue: 348, sat: 10 }, // rose grey
  { hue: 0, sat: 0 }, // true neutral
] as const;

export type CoverWeight = "cover" | "surface";

/**
 * A deterministic low-chroma fill for a seeded surface.
 *
 * `cover` sits behind overlaid text (article and stream cards, creator
 * banners); `surface` is a shade lighter for small avatar fallbacks that carry
 * no overlay.
 */
export function coverTone(seed: string, weight: CoverWeight = "cover"): string {
  const h = hash(seed);
  const { hue, sat } = TONES[h % TONES.length];
  const base = weight === "cover" ? 13 : 18;
  const top = base + ((h >>> 8) % 5);
  return `linear-gradient(155deg, hsl(${hue} ${sat}% ${top}%), hsl(${hue} ${Math.max(
    0,
    sat - 3,
  )}% ${top - 5}%))`;
}
