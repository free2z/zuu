// Small, self-contained helpers for the Articles feature. Kept local so we
// never reach outside src/features/articles/.

import type { Article } from "@/lib/api/types";

/** The canonical route target for an article (slug preferred, id fallback). */
export function articleHref(a: Pick<Article, "slug" | "id">): string {
  return `/articles/${a.slug ?? a.id}`;
}

/** Stable 32-bit hash of a string (for deterministic cover gradients). */
function hash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * A deterministic, on-brand cover gradient derived from the title. Two violet-
 * leaning hues so covers feel like one editorial family even without images.
 */
export function coverGradient(seed: string): string {
  const h = hash(seed);
  const hue1 = 250 + (h % 60) - 30; // violet-ish, ±30°
  const hue2 = (hue1 + 40 + ((h >> 8) % 40)) % 360;
  const angle = 100 + ((h >> 16) % 160);
  return `linear-gradient(${angle}deg, hsl(${hue1} 62% 32%), hsl(${hue2} 55% 20%))`;
}

/** Categories present in a feed, in first-seen order, prefixed with "All". */
export function categoriesFromFeed(items: Article[]): string[] {
  const seen: string[] = [];
  for (const a of items) {
    if (a.category && !seen.includes(a.category)) seen.push(a.category);
  }
  return ["All", ...seen];
}

/** Words in a markdown string (rough, good enough for an estimate). */
export function wordCount(markdown: string): number {
  const words = markdown.trim().match(/\S+/g);
  return words ? words.length : 0;
}

/** Reading-minute estimate from a word count (~200 wpm, min 1). */
export function readingMinutes(words: number): number {
  return Math.max(1, Math.round(words / 200));
}

/** A readable published date, e.g. "Jul 18, 2026". */
export function formatPublished(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
