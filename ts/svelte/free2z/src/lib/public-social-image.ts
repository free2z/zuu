export const PUBLIC_IMAGE_RENDERER_VERSION = "1";
export const PUBLIC_IMAGE_SOURCE_MAX_LENGTH = 2048;
export const PUBLIC_SOCIAL_IMAGE_WIDTH = 1200;
export const PUBLIC_SOCIAL_IMAGE_HEIGHT = 630;

/** Cached share URLs survive a renderer upgrade; future/malformed keys do not. */
export function isSupportedPublicImageVersion(
  version: string,
  currentVersion = PUBLIC_IMAGE_RENDERER_VERSION,
): boolean {
  const canonicalVersion = /^[1-9][0-9]{0,5}$/;
  return (
    canonicalVersion.test(version) &&
    canonicalVersion.test(currentVersion) &&
    Number(version) <= Number(currentVersion)
  );
}

/** Only public upload objects on the configured site may enter the renderer. */
export function publicUploadUrl(
  value: string,
  canonicalOrigin: string,
): URL | null {
  if (
    !value ||
    value.length > PUBLIC_IMAGE_SOURCE_MAX_LENGTH ||
    value.trim() !== value ||
    /[\\\u0000-\u001f\u007f#]/u.test(value)
  )
    return null;
  try {
    const base = new URL(canonicalOrigin);
    if (
      !["http:", "https:"].includes(base.protocol) ||
      base.username ||
      base.password ||
      base.pathname !== "/" ||
      base.search ||
      base.hash
    )
      return null;
    if (value.startsWith("//")) return null;
    const target = new URL(value, base);
    if (
      target.origin !== base.origin ||
      target.username ||
      target.password ||
      target.hash
    )
      return null;
    // Check the supplied path BEFORE URL parsing can erase dot segments. No
    // encoded slash/backslash/percent: downstream proxies must not reinterpret
    // another decoding layer as a private path, host, or traversal segment.
    const rawPath = value
      .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "")
      .split("?")[0];
    if (
      !rawPath.startsWith("/uploadz/public/") ||
      /%(?:2f|5c|25)/i.test(rawPath)
    )
      return null;
    const decoded = decodeURIComponent(rawPath);
    if (
      /[\\\u0000-\u001f\u007f]/u.test(decoded) ||
      decoded.includes("//") ||
      decoded.split("/").some((part) => part === "." || part === "..") ||
      decoded.endsWith("/")
    )
      return null;
    if (
      !target.pathname.startsWith("/uploadz/public/") ||
      (target.pathname + target.search).length > PUBLIC_IMAGE_SOURCE_MAX_LENGTH
    )
      return null;
    return target;
  } catch {
    return null;
  }
}

/** The endpoint accepts a relative public path, never an arbitrary fetch URL. */
export function publicImageSource(
  value: string,
  canonicalOrigin: string,
): URL | null {
  return value.startsWith("/") && !value.startsWith("//")
    ? publicUploadUrl(value, canonicalOrigin)
    : null;
}

export function normalizedPublicImageUrl(
  value: string,
  canonicalOrigin: string,
  assetOrigin = canonicalOrigin,
): string | null {
  const source = publicUploadUrl(value, canonicalOrigin);
  if (!source) return null;
  const image = new URL("/og/image.png", assetOrigin);
  image.searchParams.set("source", source.pathname + source.search);
  image.searchParams.set("renderer", PUBLIC_IMAGE_RENDERER_VERSION);
  return image.href;
}
