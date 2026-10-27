import sharp from "sharp";
import { PUBLIC_IMAGE_BUDGET } from "$lib/server/og-image";
import {
  PUBLIC_SOCIAL_IMAGE_WIDTH,
  PUBLIC_SOCIAL_IMAGE_HEIGHT,
} from "$lib/public-social-image";

export const PUBLIC_IMAGE_MAT = "#09090b";

/** Call only while holding the shared OG render slot. */
export async function normalizePublicImage(
  bytes: Uint8Array,
): Promise<Uint8Array> {
  // Importing og-image also installs the bounded libvips cache/thread settings.
  // Decode one frame, respect EXIF orientation, and retain every artwork edge.
  return sharp(bytes, {
    limitInputPixels: PUBLIC_IMAGE_BUDGET.maxPixels,
    pages: 1,
  })
    .autoOrient()
    .resize(PUBLIC_SOCIAL_IMAGE_WIDTH, PUBLIC_SOCIAL_IMAGE_HEIGHT, {
      fit: "contain",
      background: PUBLIC_IMAGE_MAT,
    })
    .flatten({ background: PUBLIC_IMAGE_MAT })
    .png()
    .toBuffer();
}
