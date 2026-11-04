const URL_SCHEME = /^[a-z][a-z\d+.-]*:/i;

/**
 * Schemes we are willing to hand to an `href`, a `src`, or the clipboard.
 * Everything else (`javascript:`, `data:`, `vbscript:`, …) is rejected —
 * see. Media URLs are backend-constructed today, so this is
 * defense-in-depth at a trust boundary, not a fix for a live exploit.
 */
const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/** Leading/trailing characters a browser strips before parsing a URL. */
const TRIM_URL_CHARS = /^[\u0000-\u0020]+|[\u0000-\u0020]+$/g;

/**
 * Browsers strip ASCII whitespace and C0 controls before parsing a URL's
 * scheme, so `java\nscript:alert(1)` still navigates as `javascript:`.
 * Strip the same characters before sniffing, or the allow-list is
 * trivially bypassed.
 * @param {string} value
 */
function schemeOf(value) {
  const stripped = String(value).replace(/[\u0000-\u0020]+/g, "");
  const match = /^([a-z][a-z\d+.-]*):/i.exec(stripped);
  return match ? `${match[1].toLowerCase()}:` : "";
}

/**
 * An origin no real deployment can own, used purely as a yardstick: if a
 * *relative* reference resolves to anything other than the base it was
 * resolved against, it was never relative.
 */
const PROBE_ORIGIN = "https://media-url-probe.invalid";

/** The only protocol-relative shape we accept: `//host…`. */
const PROTOCOL_RELATIVE = /^\/\/[^/\\]/;

/**
 * True when a path that *looks* relative actually escapes to another
 * origin once a browser parses it.
 *
 * WHATWG URL parsing treats `\` as `/` inside a special URL, so `/\host/x`
 * is a protocol-relative reference: it resolves to `https://host/x`. A
 * scheme allow-list can never catch that — the result genuinely is https,
 * just to somebody else's origin. And it only bites when `apiBase` is empty
 * (production), because a non-empty apiBase pushes the escape into that
 * host's path instead. Compare the resolved origin, not the scheme.
 *
 * @param {string} path
 */
function escapesOrigin(path) {
  try {
    return new URL(path, PROBE_ORIGIN).origin !== PROBE_ORIGIN;
  } catch {
    return true;
  }
}

/**
 * The origin of `value` if it is an absolute URL, else "".
 * @param {string} value
 */
function originOf(value) {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

/**
 * True for relative paths, protocol-relative URLs, and absolute http(s)
 * URLs. False for every other scheme.
 * @param {string} value
 */
export function isAllowedMediaUrl(value) {
  if (!value) return false;
  const scheme = schemeOf(value);
  return scheme === "" || ALLOWED_SCHEMES.has(scheme);
}

/**
 * Resolve an upload path without decoding or re-encoding its pathname.
 * This keeps percent-encoded filenames intact while still producing an
 * absolute URL for clipboard and share APIs.
 * @param {string} rawPath
 * @param {string} apiBase
 * @param {string} origin
 */
export function resolveMediaUrl(rawPath, apiBase = "", origin = "") {
  if (!rawPath) return "";
  // Browsers ignore leading/trailing ASCII whitespace and C0 controls when
  // they parse a URL, so strip them here too: otherwise the checks below
  // see "  //evil.example/x" as a relative path while the browser sees a
  // protocol-relative URL. Normalize once, then reason about one string.
  const path = String(rawPath).replace(TRIM_URL_CHARS, "");
  if (!path) return "";
  if (!isAllowedMediaUrl(path)) return "";
  if (URL_SCHEME.test(path)) return path;

  // Exactly two slashes then a host character is the one protocol-relative
  // form we honour: the backend saying "same scheme, this other host".
  // `///host` and `//\host` are not that — they are path-shaped values a
  // browser still resolves to another origin — so they fall through to the
  // relative branch below and are rejected by escapesOrigin.
  if (PROTOCOL_RELATIVE.test(path)) {
    try {
      return new URL(path, apiBase || origin).href;
    } catch {
      return path;
    }
  }

  // Past this point `path` is a relative reference, so it must stay on the
  // origin it is resolved against — whatever the browser's parser makes of
  // it. This is the check a scheme allow-list cannot do ( follow-up).
  if (escapesOrigin(path)) return "";

  const joinedPath = apiBase
    ? `${apiBase.replace(/\/$/, "")}/${path.replace(/^\//, "")}`
    : path;

  if (!origin && !URL_SCHEME.test(joinedPath)) return joinedPath;

  // Belt and braces: assert the resolved origin is the one we resolved
  // against, so any future parser quirk fails closed instead of off-site.
  const expectedOrigin = originOf(apiBase) || originOf(origin);

  try {
    const resolved = new URL(joinedPath, origin || undefined);
    if (expectedOrigin && resolved.origin !== expectedOrigin) return "";
    return resolved.href;
  } catch {
    return joinedPath;
  }
}

/**
 * The value that belongs on the clipboard, in an `href`, or in a share
 * sheet: a complete absolute URL, never a bare `/uploadz/...` path.
 *
 * `PUBLIC_API_BASE_URL` is empty in production (k8s/new-ui/deployment.yaml),
 * so `resolveMediaUrl` returns only the path portion unless the caller
 * remembers to thread `window.location.origin` through — which is how
 * "copy link" ended up putting a fragment of a URL on the clipboard.
 * Default the origin here so no call site can forget it.
 *
 * @param {string} path
 * @param {string} apiBase
 * @param {string} origin explicit origin; defaults to the current document
 */
export function absoluteMediaUrl(path, apiBase = "", origin = "") {
  const documentOrigin =
    typeof globalThis === "undefined" ? "" : globalThis.location?.origin || "";
  return resolveMediaUrl(path, apiBase, origin || documentOrigin);
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
