// Small, self-contained helpers for the Articles feature. Kept local so we
// never reach outside src/features/articles/.

import type { Article } from "@/lib/api/types";

/** The canonical route target for an article (slug preferred, id fallback). */
export function articleHref(a: Pick<Article, "slug" | "id">): string {
  return `/articles/${a.slug ?? a.id}`;
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
