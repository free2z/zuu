export interface RemoteMediaTarget {
  /** Canonical browser destination. This is the only value handed to media DOM. */
  url: string;
  /** Normalized network hostname shown before consent. */
  hostname: string;
}

const TRUSTED_FREE2Z_ZONE = "free2z.cash";
const MAX_TRUSTED_IMAGE_REDIRECTS = 5;
const MAX_TRUSTED_IMAGE_BYTES = 20 * 1024 * 1024;
const SAFE_RASTER_IMAGE_TYPES = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/x-icon",
]);

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]"
  );
}

/**
 * Resolve an untrusted media source without fetching it.
 *
 * The parser deliberately performs exactly one WHATWG URL parse. In
 * particular, percent-encoded absolute URLs are not decoded a second time:
 * `%68%74...` remains a path on the supplied base instead of becoming an
 * attacker-controlled origin. Credentials and non-network schemes fail
 * closed, while protocol-relative and ordinary relative upload paths resolve
 * against the explicit application/media base.
 */
export function normalizeRemoteMediaTarget(
  source: string,
  base: string,
): RemoteMediaTarget | null {
  if (!source || CONTROL_CHARACTER.test(source)) return null;

  const candidate = source.trim();
  if (!candidate) return null;

  let parsed: URL;
  let parsedBase: URL;
  try {
    parsedBase = new URL(base);
    parsed = new URL(candidate, parsedBase);
  } catch {
    return null;
  }

  // Packaged ZUULI intentionally permits only HTTPS network media in CSP. The
  // sole HTTP exception is the exact same-origin loopback Vite dev proxy; it
  // cannot authorize an authored external HTTP destination or packaged app.
  const allowedDevHttp =
    parsed.protocol === "http:" &&
    parsed.origin === parsedBase.origin &&
    isLoopback(parsed.hostname);
  if (parsed.protocol !== "https:" && !allowedDevHttp) return null;
  if (!parsed.hostname || parsed.username || parsed.password) return null;

  // DNS ignores a terminal root dot. Remove it from both the request and the
  // disclosure so equivalent spellings cannot make the destination look
  // different. URL already lower-cases and IDNA-normalizes the hostname.
  const hostname = parsed.hostname.endsWith(".")
    ? parsed.hostname.slice(0, -1)
    : parsed.hostname;
  if (!hostname) return null;
  parsed.hostname = hostname;

  return { url: parsed.href, hostname };
}

/**
 * Whether a normalized destination is an approved first-party image origin.
 *
 * Trust is deliberately narrower than general network validity: HTTPS on the
 * canonical free2z.cash DNS zone, with no non-default port. A dot boundary is
 * mandatory so lookalikes such as `free2z.cash.evil.example` and
 * `notfree2z.cash` never match. The exact same-origin loopback URL used by the
 * Vite proxy is the sole development exception.
 */
export function isTrustedFirstPartyImageTarget(
  target: RemoteMediaTarget,
  applicationBase: string,
): boolean {
  let parsed: URL;
  let base: URL;
  try {
    parsed = new URL(target.url);
    base = new URL(applicationBase);
  } catch {
    return false;
  }

  if (parsed.username || parsed.password) return false;

  if (
    parsed.protocol === "http:" &&
    parsed.origin === base.origin &&
    isLoopback(parsed.hostname)
  ) {
    return true;
  }

  if (parsed.port) return false;

  return (
    parsed.protocol === "https:" &&
    (parsed.hostname === TRUSTED_FREE2Z_ZONE ||
      parsed.hostname.endsWith(`.${TRUSTED_FREE2Z_ZONE}`))
  );
}

type ImageFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

function redirectLocation(response: Response, currentUrl: string): string | null {
  if (![301, 302, 303, 307, 308].includes(response.status)) return null;
  const location = response.headers.get("location");
  if (!location) throw new Error("Image redirect is unavailable");
  try {
    return new URL(location, currentUrl).href;
  } catch {
    throw new Error("Image redirect is invalid");
  }
}

/**
 * Download an approved first-party image without giving a media element a
 * network URL. Every redirect is inspected before the next request and the
 * final bytes are returned for a local object URL, closing the usual `<img>`
 * redirect/TOCTOU hole. Browsers that hide a cross-origin manual redirect as
 * `opaqueredirect` fail closed; the native HTTP transport exposes redirects.
 */
export async function downloadTrustedFirstPartyImage(
  target: RemoteMediaTarget,
  applicationBase: string,
  fetchImage: ImageFetch,
  signal?: AbortSignal,
): Promise<Blob> {
  if (!isTrustedFirstPartyImageTarget(target, applicationBase)) {
    throw new Error("Image origin is not approved");
  }

  let current = target;
  for (let redirects = 0; redirects <= MAX_TRUSTED_IMAGE_REDIRECTS; redirects += 1) {
    const response = await fetchImage(current.url, {
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { Accept: "image/*" },
      signal,
    });

    // A browser intentionally conceals a cross-origin manual redirect. Never
    // let that opacity turn into an automatic follow.
    if (response.type === "opaqueredirect") {
      throw new Error("Image redirect could not be verified");
    }

    const location = redirectLocation(response, current.url);
    if (location) {
      if (redirects === MAX_TRUSTED_IMAGE_REDIRECTS) {
        throw new Error("Too many image redirects");
      }
      const redirected = normalizeRemoteMediaTarget(location, current.url);
      if (
        !redirected ||
        !isTrustedFirstPartyImageTarget(redirected, applicationBase)
      ) {
        throw new Error("Image redirect left the approved origin");
      }
      current = redirected;
      continue;
    }

    if (!response.ok) throw new Error("Image request failed");

    // Defense against a transport that ignored `redirect: manual`: an
    // unobserved redirect is not accepted, even when its final host is trusted.
    if (response.url) {
      const finalTarget = normalizeRemoteMediaTarget(response.url, current.url);
      if (!finalTarget || finalTarget.url !== current.url) {
        throw new Error("Image redirect was not inspected");
      }
    }

    const contentType = response.headers.get("content-type")
      ?.split(";", 1)[0]
      .trim()
      .toLowerCase();
    // SVG can contain attacker-selected subresources. First-party hosting does
    // not make a creator-uploaded SVG safe to auto-load as a beacon-free image.
    if (!contentType || !SAFE_RASTER_IMAGE_TYPES.has(contentType)) {
      throw new Error("Image response has the wrong type");
    }

    const contentLength = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(contentLength) &&
      contentLength > MAX_TRUSTED_IMAGE_BYTES
    ) {
      throw new Error("Image is too large");
    }

    if (response.body) {
      const reader = response.body.getReader();
      const chunks: ArrayBuffer[] = [];
      let bytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_TRUSTED_IMAGE_BYTES) {
          await reader.cancel();
          throw new Error("Image is too large");
        }
        const chunk = new Uint8Array(value.byteLength);
        chunk.set(value);
        chunks.push(chunk.buffer);
      }
      return new Blob(chunks, { type: contentType });
    }

    const blob = await response.blob();
    if (blob.size > MAX_TRUSTED_IMAGE_BYTES) throw new Error("Image is too large");
    return blob;
  }

  throw new Error("Too many image redirects");
}
