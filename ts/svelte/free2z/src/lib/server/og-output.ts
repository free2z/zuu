import sharp from "sharp";

// Below WhatsApp's 600KB recommendation, with headroom for encoders/metadata.
export const SOCIAL_IMAGE_MAX_BYTES = 550_000;

export async function encodeSocialPng(png: Uint8Array): Promise<Uint8Array> {
  if (png.byteLength <= SOCIAL_IMAGE_MAX_BYTES) return png;
  // Two bounded attempts, inside the existing render admission gate. Keep the
  // dimensions and PNG URL/MIME contract; never discard the creator's cover.
  for (const colours of [256, 16]) {
    const encoded = await sharp(png, { limitInputPixels: 1200 * 630 })
      .png({ palette: true, colours, dither: 1, effort: 4 })
      .toBuffer();
    if (encoded.byteLength <= SOCIAL_IMAGE_MAX_BYTES) return encoded;
  }
  throw new Error("Social PNG exceeds the encoded image budget");
}
