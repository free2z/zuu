export const CANONICAL_URL_MAX_LENGTH = 2048;

/** @param {string} hostname */
function hasValidHostname(hostname) {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return true;
  }

  const normalized = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  const labels = normalized.split(".");

  return labels.every(
    (label) =>
      label.length > 0 &&
      label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
  );
}

/**
 * Return why a canonical URL is unusable, or null when it is blank/valid.
 * This mirrors the API's safety rules; the API remains the source of truth.
 * No network request is made because publishing must not depend on another
 * site being online.
 *
 * @param {unknown} value
 * @returns {"invalid" | "credentials" | "fragment" | "too_long" | null}
 */
export function getCanonicalUrlError(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const candidate = value.trim();

  if (candidate.length > CANONICAL_URL_MAX_LENGTH) {
    return "too_long";
  }

  if (!/^https?:\/\//i.test(candidate) || /\s/.test(candidate)) {
    return "invalid";
  }

  let parsed;

  try {
    parsed = new URL(candidate);
  } catch {
    return "invalid";
  }

  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    !hasValidHostname(parsed.hostname)
  ) {
    return "invalid";
  }

  if (parsed.username || parsed.password) {
    return "credentials";
  }

  if (candidate.includes("#")) {
    return "fragment";
  }

  return null;
}

/**
 * Prefer a valid external article URL, otherwise retain Free2Z's URL.
 *
 * @param {unknown} externalUrl
 * @param {string | undefined} fallbackUrl
 */
export function selectCanonicalUrl(externalUrl, fallbackUrl) {
  return getCanonicalUrlError(externalUrl) === null &&
    typeof externalUrl === "string" &&
    externalUrl.trim()
    ? externalUrl.trim()
    : fallbackUrl;
}
