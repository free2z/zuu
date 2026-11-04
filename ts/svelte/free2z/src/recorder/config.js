/** Provider config is base64 JSON. Never log it: future fields may be sensitive.
 * @param {string | null} encoded
 * @returns {Record<string, any>}
 */
export function parseRecorderConfig(encoded) {
  if (!encoded) return {};
  if (encoded.length > 65536)
    throw new Error("Invalid recording configuration");
  const config = JSON.parse(atob(encoded));
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Invalid recording configuration");
  }
  return config;
}

/** Cloudflare's documented watermark size is in pixels, not a proportion.
 * @param {Record<string, any>} config
 */
export function watermarkOptions(config) {
  const watermark =
    config.video_config?.watermark ??
    config.videoConfig?.watermark ??
    config.watermark;
  if (!watermark || watermark.enabled === false || !watermark.url) return null;
  const url = new URL(watermark.url);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Invalid recording watermark");
  }
  const position = watermark.position ?? "left top";
  if (
    !["left top", "right top", "left bottom", "right bottom"].includes(position)
  ) {
    throw new Error("Invalid recording watermark");
  }
  /** @type {Record<string, number>} */
  const size = {};
  for (const axis of ["width", "height"]) {
    const value = watermark.size?.[axis];
    if (value !== undefined) {
      if (!Number.isFinite(value) || value <= 0 || value > 8192)
        throw new Error("Invalid recording watermark");
      size[axis] = value;
    }
  }
  return { url: url.href, position, size };
}
