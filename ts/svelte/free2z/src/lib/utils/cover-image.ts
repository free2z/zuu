/**
 * What the editor is allowed to do to a cover image on its way to the server.
 *
 * The old answer was "resample every upload to exactly 1600 x 400". That was a
 * guess at a universal aspect ratio — one stored shape that would survive every
 * surface's `object-fit: cover`.  established there is no such shape: the
 * surfaces disagree with each other by 4x (1.00 thumbnail... 2.86 compact row)
 * and **not one of them is 4:1**.  then stopped cropping anywhere, so the
 * stored aspect ratio no longer has to match anything and the forced crop had
 * nothing left to buy — while still discarding ~90% of a poster.
 *
 * What survives from 1600 x 400 is the *bound*, not the *shape*. Removing the
 * forced resample without a cap would be the real regression: a modern phone
 * hands us a 4032 x 3024 JPEG and a camera 8256 x 5504, and every one of those
 * pixels would be decoded by the OG rasterizer, which shares the SSR process
 * heap that already OOM-crashes 3-7x a day.
 *
 * So: **cap the longest edge, preserve the aspect ratio.**
 *
 * Why 2048 specifically
 * ---------------------
 * Two numbers bracket it.
 *
 * The floor is the largest box any surface paints. The article hero measures
 * 1614 x 658 CSS px at a 1614px viewport. A cap below ~1600 would mean
 * the stored original is *upscaled* into the hero on a common desktop, which is
 * a visible quality loss we would be choosing on purpose. 2048 clears it.
 *
 * The ceiling is the decode. An RGBA decode costs `w * h * 4` bytes, and the
 * worst case at a given cap is a square:
 *
 *   | cap   | square decode | 2:1 decode |
 *   | 1600  |   10.2 MB     |   5.1 MB   |
 *   | 2048  |   16.8 MB     |   8.4 MB   |
 *   | 4096  |   67.1 MB     |  33.6 MB   |
 *
 * 4096 is not survivable next to  — one square cover would be two thirds
 * of a 100MB heap on its own. 2048 raises the worst case from today's fixed
 * 1600x400 (2.6 MB) to 16.8 MB, which is a real increase and is the price of
 * letting creators keep their composition; the thing it actually prevents is
 * the *unbounded* case (an 8256x5504 original decodes at 182 MB).
 *
 * It is also a texture-size floor every GPU and every canvas implementation
 * supports, which the 4096 tier is not on older mobile hardware.
 *
 * The server then builds its own WebP size ladder from whatever we send
 * (`dj.apps.uploads.tasks`), so this cap governs the stored original only —
 * see  for the ladder itself.
 *
 * Everything here is pure so it can be unit tested without a DOM
 * (`tests/cover-image.test.mjs`).
 */

export const MAX_COVER_EDGE = 2048;

export type Dimensions = { width: number; height: number };

function isUsable(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/**
 * The size a cover is stored at: the source, scaled down uniformly until its
 * longest edge fits `maxEdge`. Never enlarged — a 400x300 upload stays 400x300,
 * because inventing pixels serves nobody and the blur pad handles small images
 * better than an upscale does.
 *
 * Returns integers, each at least 1: a 4096x9 panorama scales to 2048x4.5, and
 * a canvas of height 4.5 is not a thing. Rounding down to 0 would be, which is
 * why the floor is explicit.
 */
export function boundedCoverSize(
  source: Dimensions,
  maxEdge: number = MAX_COVER_EDGE,
): Dimensions {
  const { width, height } = source;
  if (!isUsable(width) || !isUsable(height) || !isUsable(maxEdge)) {
    return { width: 0, height: 0 };
  }

  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** True when the source already fits the cap and needs no resampling at all. */
export function isWithinCoverBounds(
  source: Dimensions,
  maxEdge: number = MAX_COVER_EDGE,
): boolean {
  const { width, height } = source;
  if (!isUsable(width) || !isUsable(height)) {
    return false;
  }
  return Math.max(width, height) <= maxEdge;
}

/**
 * Types we are willing to hand to the server byte-for-byte.
 *
 * Every one of these is on the server allowlist (`dj.apps.uploads.validation`),
 * is a format the browser will render passively, and — this is the part that
 * decides the list — is one the server will build derivatives from. The point
 * of passing bytes through is that a re-encode is never free: it drops a PNG's
 * alpha channel to black and adds a generational JPEG loss to an image nobody
 * asked us to change.
 *
 * `image/gif` is deliberately absent. An animated GIF gets **no** derivatives
 * at all — `image_utils.create_thumbnail` and `tasks.generate_image_variants`
 * both bail on `_is_animated` — so passing one through would put the full
 * original on every card in the feed, for every visitor. Flattening it to its
 * first frame is exactly what this dialog did to every GIF before, so nothing
 * regresses; the alternative would be a new bandwidth cliff.
 *
 * `image/webp` is absent for a nearer reason: `single_public_upload_handle`
 * calls `create_thumbnail` only for `image/jpeg` and `image/png`, so a WebP
 * cover has no legacy thumbnail and `get_thumbnail()` falls back to the
 * original — which `ZpageCard` then loads at full size on every card. Same
 * reason `renderRegion` encodes PNG/JPEG rather than WebP.
 *
 * HEIC is absent too, even though the server accepts it: Safari can decode it
 * into a canvas but no other browser can, so a HEIC that arrives here has
 * already been decoded by an `<img>` we can re-encode from — and the types
 * below are universally displayable, which HEIC is not.
 */
export const PASSTHROUGH_COVER_TYPES: readonly string[] = [
  "image/jpeg",
  "image/png",
];

/**
 * The largest file we will forward untouched.
 *
 * Dimensions are not a proxy for bytes. A noisy 2048 x 2048 PNG can be 12MB,
 * and the byte budget it has to fit is not ours: nginx enforces a 5MB ceiling
 * on a zero-balance account (the free rung of the ladder
 * `GET /api/uploads/limits/` publishes), so passing it through would
 * promise the creator a success and hand them a rejection. Above the free
 * paid tier the request ceiling is 250MiB (including multipart overhead), and
 * `remove_exif_data` reads the whole file into memory in the request process —
 * so "it fit in 2048px" is not a reason to forward an arbitrarily large file
 * either.
 *
 * 4MiB sits under the tightest of those ceilings with room for the multipart
 * envelope. Anything larger goes through the canvas, which re-encodes at the
 * cap and lands well under 2MB for any realistic photograph.
 */
export const MAX_PASSTHROUGH_BYTES = 4 * 1024 * 1024;

/**
 * Whether the creator's original file can be uploaded unmodified.
 *
 * Four things have to hold: they did not crop, the image is inside the
 * dimension cap, the file is inside the byte cap, and we recognise the
 * container. Anything else goes through the canvas.
 */
export function canUseSourceFileDirectly(options: {
  cropped: boolean;
  natural: Dimensions;
  mimeType?: string | null;
  byteLength?: number;
  maxEdge?: number;
  maxBytes?: number;
}): boolean {
  const {
    cropped,
    natural,
    mimeType,
    byteLength,
    maxEdge = MAX_COVER_EDGE,
    maxBytes = MAX_PASSTHROUGH_BYTES,
  } = options;
  if (cropped) return false;
  if (!isWithinCoverBounds(natural, maxEdge)) return false;
  // An unknown size is not a small size.
  if (
    !Number.isFinite(byteLength as number) ||
    (byteLength as number) > maxBytes
  ) {
    return false;
  }
  return PASSTHROUGH_COVER_TYPES.includes((mimeType ?? "").toLowerCase());
}

const EXTENSION_BY_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

/**
 * Ceiling for a canvas-encoded cover.
 *
 * PNG is the only lossless container both the browser and the server's
 * synchronous thumbnail path agree on, so it is what an image with alpha is
 * written as — but a 2048px photograph with one stray translucent pixel would
 * be a 10MB PNG, over the free tier's upload ceiling. When PNG lands over this,
 * the encoder falls back to JPEG: a flattened alpha channel is a visible
 * disappointment, and a rejected upload is a dead end.
 */
export const MAX_ENCODED_COVER_BYTES = 4 * 1024 * 1024;

/**
 * The extension to name an upload with, derived from its bytes' actual type.
 *
 * The server cross-checks the declared extension against a sniff of the bytes
 * and returns a clean 400 on a mismatch, so calling a WebP `.jpg` — as
 * this code did while every cover really was a JPEG — is a rejected upload the
 * moment the encoder changes.
 */
export function coverFileExtension(mimeType?: string | null): string {
  return EXTENSION_BY_TYPE[(mimeType ?? "").toLowerCase()] ?? "jpg";
}
