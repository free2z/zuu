const URL_SCHEME = /^[a-z][a-z\d+.-]*:/i;

/**
 * Resolve an upload path without decoding or re-encoding its pathname.
 * This keeps percent-encoded filenames intact while still producing an
 * absolute URL for clipboard and share APIs.
 * @param {string} path
 * @param {string} apiBase
 * @param {string} origin
 */
export function resolveMediaUrl(path, apiBase = "", origin = "") {
  if (!path) return "";
  if (URL_SCHEME.test(path)) return path;

  if (path.startsWith("//")) {
    try {
      return new URL(path, apiBase || origin).href;
    } catch {
      return path;
    }
  }

  const joinedPath = apiBase
    ? `${apiBase.replace(/\/$/, "")}/${path.replace(/^\//, "")}`
    : path;

  if (!origin && !URL_SCHEME.test(joinedPath)) return joinedPath;

  try {
    return new URL(joinedPath, origin || undefined).href;
  } catch {
    return joinedPath;
  }
}

/**
 * @param {string} mimeType
 * @param {string} url
 */
export function isPreviewableMedia(mimeType = "", url = "") {
  if (/^(image|video|audio)\//i.test(mimeType)) return true;

  const pathname = url.split(/[?#]/, 1)[0].toLowerCase();
  return /\.(avif|gif|jpe?g|png|svg|webp|mp4|m4v|mov|webm|mp3|m4a|ogg|wav|flac)$/.test(
    pathname,
  );
}
