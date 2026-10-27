import type { FeaturedImage } from "$lib/api/f2z.schemas";

/**
 * Which URL a *small* result row is allowed to load.
 *
 * The ⌘K palette draws creator avatars into a 36px box and zPage covers into
 * a 40px one. `featured_image.url` is the creator's **original upload** —
 * routinely a multi-thousand-pixel hero image — and the palette had no reason
 * ever to fetch one. Measured on the real component with five zPage and five
 * creator results whose uploads are 4000x4000: the palette held **960 MB** of
 * decoded bitmap for a strip of 36px chips. With a bounded source it holds
 * 9.6 MB.
 *
 * Order, and why each rung is where it is:
 *
 * 1. `thumb` — `variant_url(128)` from the  WebP ladder. Its docstring
 *    ("Never the original — serving multi-MB originals into small slots is
 *    what this ladder exists to end") names this issue by number. If it is
 *    present it is bounded by construction and nothing else needs consulting.
 *
 * 2. `thumbnail` — the legacy single WebP thumbnail, but **only** when it is
 *    not literally the original. `GenericFile.get_thumbnail()` returns
 *    `self.get_url()` for a row with no legacy webp, so `thumbnail` is a
 *    bounded derivative on some rows and the full original on others. That
 *    silent fallback is the mechanism: `thumbnail || url` reads as "small
 *    image, or else the big one", when in truth the first branch is *already*
 *    the big one. Comparing against `url` is what tells the two apart.
 *
 * 3. Nothing. The row falls back to its icon placeholder. A 36px picture is
 *    not worth an unbounded download and an unbounded decode; every other
 *    surface on the site is free to make a different trade, and this helper is
 *    deliberately scoped to the palette rather than applied site-wide.
 *
 * Returns a possibly-relative path exactly as the API gave it; prefixing with
 * the API origin stays the caller's job.
 */
export function paletteImageSrc(image?: Partial<FeaturedImage> | null): string {
  if (!image) return "";
  // `!== url` guards both rungs, not just the legacy one. `variant_url()`
  // cannot return the original today, but "a rung that is secretly the
  // original" is precisely the bug being fixed, and a single rule that holds
  // for every field cannot be reintroduced one field at a time.
  if (image.thumb && image.thumb !== image.url) return image.thumb;
  if (image.thumbnail && image.thumbnail !== image.url) return image.thumbnail;
  return "";
}
