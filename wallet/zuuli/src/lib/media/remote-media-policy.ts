export interface RemoteMediaTarget {
  /** Canonical browser destination. This is the only value handed to media DOM. */
  url: string;
  /** Normalized network hostname shown before consent. */
  hostname: string;
}

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
