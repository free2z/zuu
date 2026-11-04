/**
 * How a featured image is fitted into a box it does not match.
 *
 * The product stores every cover at **1600 x 400** (`EditorCoverField`), and
 * **no surface displays a 4:1 image**. Measured against the running site at a
 * 1614px viewport:
 *
 *   | surface          | box      | aspect | width kept from a 4:1 cover |
 *   | square thumbnail |  78x78   |  1.00  |  25%                        |
 *   | homepage lead    | 793x395  |  2.01  |  50%                        |
 *   | standard card    | 382x176  |  2.17  |  54%                        |
 *   | article hero     | 1614x658 |  2.45  |  61%                        |
 *   | compact row      | 216x75   |  2.86  |  72%                        |
 *
 * The surfaces disagree with each other by 4x, so there is no upload aspect
 * ratio that satisfies them — which is why chasing one never worked. Creators
 * routinely put a wordmark in the cover, and `object-fit: cover` amputated it:
 * "DYNAWALLA" rendered as "LLA", "ZCASH ECOSYSTEM" as "CASH COSYSTEM".
 *
 * So the rule is inverted from the usual one: **contain by default, never
 * crop**, and let a blurred enlargement of the same bytes fill whatever is left
 * over (`FeaturedImage.svelte`). Two guards sit either side of that default,
 * and both exist because the *result* would look broken, never because a crop
 * is preferable in principle.
 *
 * Everything here is pure so it can be unit tested without a DOM
 * (`tests/image-fit.test.mjs`).
 */

export const IMAGE_FIT = {
  /**
   * Cover is only ever *considered* while it is a real alternative. Past this
   * much enlargement it is not: a 24x18 upload blown up to fill a 1440px hero
   * is a 60x smear, and the floor below must not be allowed to choose it. The
   * guard runs first for that reason.
   */
  maxUpscale: 3,
  /**
   * Containing an image whose aspect ratio nearly matches the box leaves a
   * hairline band that reads as a rendering fault rather than a decision. At
   * this fraction the band is under 3% of the box — a crop nobody can see,
   * against an artifact everybody can. Cover wins.
   */
  snapToCoverFraction: 0.97,
  /**
   * ...and at the other end, letterboxing is only an improvement while what is
   * left reads as a picture. A 13:1 panorama contained in a phone hero is a
   * 29px ribbon floating in a blur — strictly worse than a crop of the real
   * thing, which at least fills the frame with something the creator
   * photographed. Below this fraction of the box, cover wins again.
   *
   * For the sizes this product actually ships, the floor almost never fires: a
   * 1600x400 cover in the *tightest* box on the site (a 78px square thumbnail)
   * still renders at 0.25 of the box.
   */
  minContainFraction: 0.12,
} as const;

export type ImageFit = "cover" | "contain";

export type Box = { width: number; height: number };

/**
 * The fraction of the box the image occupies once fitted inside it without
 * enlarging past 1:1 — i.e. what CSS `object-fit: scale-down` would paint.
 *
 * `scale-down`, not `contain`, is the treatment throughout: a 96x64 upload
 * rendered at 96x64 is crisp and looks intentional, whereas stretching it to
 * touch an edge is the same mush `cover` was rejected for.
 *
 * Returns 0 when nothing has been measured yet.
 */
export function containedFraction(image: Box, box: Box): number {
  const dimensions = [image.width, image.height, box.width, box.height];
  if (!dimensions.every((value) => Number.isFinite(value) && value > 0)) {
    return 0;
  }
  const scale = Math.min(1, box.width / image.width, box.height / image.height);
  return Math.min(
    (image.width * scale) / box.width,
    (image.height * scale) / box.height,
  );
}

/**
 * `contain` here means the CSS `scale-down` treatment: the image is fitted
 * inside the box, never enlarged past 1:1, and floats over a blurred
 * enlargement of itself.
 *
 * Nothing measured yet (SSR, a not-yet-decoded image, a `display: none` box)
 * returns `contain` deliberately. That is both the answer for essentially every
 * real cover on this site and the answer that cannot destroy content, so the
 * server-rendered markup is already right and the common case never swaps fit
 * after hydration.
 */
export function chooseImageFit(image: Box, box: Box): ImageFit {
  const fraction = containedFraction(image, box);
  if (fraction === 0) return "contain";

  // Cover is not on the table at all past this much enlargement, so neither
  // guard below may reach for it.
  const coverScale = Math.max(
    box.width / image.width,
    box.height / image.height,
  );
  if (coverScale > IMAGE_FIT.maxUpscale) return "contain";

  if (fraction >= IMAGE_FIT.snapToCoverFraction) return "cover";
  if (fraction < IMAGE_FIT.minContainFraction) return "cover";
  return "contain";
}
