/**
 * URL helpers for author-authored Markdown links.
 *
 * This module deliberately knows nothing about external embeds. Markdown
 * links are navigation, not content loading, and their preferences live in a
 * separate store (`stores/outbound-links.ts`).
 */

const HTTP_PROTOCOLS = new Set(["http:", "https:"]);
const SAFE_NON_HTTP_PROTOCOLS = new Set(["mailto:", "tel:"]);

export const OUTBOUND_TRUSTED_DOMAINS_KEY = "trustedExternalDomains";
export const OUTBOUND_GLOBAL_WARNING_KEY = "dontShowExternalLinkWarning";

export type HttpProtocol = "http:" | "https:";

export interface OutboundLinkDestination {
  /** The URL after WHATWG parsing and serialization. */
  href: string;
  /** A normalized hostname, never a display string or a URL with userinfo. */
  hostname: string;
  protocol: HttpProtocol;
  origin: string;
  isExternal: boolean;
}

/**
 * Normalize a hostname into the exact key used for outbound-link trust.
 *
 * The WHATWG URL parser gives us lower-case, IDN/punycode-normalized hostnames.
 * A DNS trailing dot is removed so `Example.test` and `example.test.` cannot
 * create two preferences. Ports, userinfo, paths and schemes are rejected:
 * this function accepts a hostname, not an arbitrary URL or display label.
 */
export function normalizeOutboundHostname(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }

  const candidate = value.trim();
  if (
    candidate !== value ||
    candidate.includes("/") ||
    candidate.includes("?") ||
    candidate.includes("#") ||
    candidate.includes("@")
  ) {
    return null;
  }

  // Keep IPv6 support without treating a colon in a normal hostname as a
  // port. Stored trust keys are still hostnames, never host:port strings.
  const isIpv6 = /^\[[0-9a-f:.]+\]$/i.test(candidate);
  if (candidate.includes(":") && !isIpv6) {
    return null;
  }

  try {
    const parsed = new URL(`https://${candidate}`);
    if (
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }

    const hostname = parsed.hostname.toLowerCase().replace(/\.+$/, "");
    return hostname || null;
  } catch {
    return null;
  }
}

function canonicalHttpOrigin(parsed: URL, hostname: string): string {
  // URL.port is already empty for the default port, which is exactly the
  // origin comparison browsers use for http/https.
  return `${parsed.protocol}//${hostname}${parsed.port ? `:${parsed.port}` : ""}`;
}

function parseBaseUrl(base: string | URL | null | undefined): URL | null {
  if (base instanceof URL) {
    return base;
  }

  if (typeof base !== "string" || base.length === 0) {
    return null;
  }

  try {
    return new URL(base);
  } catch {
    return null;
  }
}

/**
 * Parse an absolute or base-resolved HTTP(S) destination.
 *
 * The returned href is always the parsed URL, never the raw attribute value.
 * That makes the value safe to pass to `window.open` after the user has made
 * an explicit choice in the warning dialog.
 */
export function parseOutboundHttpUrl(
  value: unknown,
  base?: string | URL | null,
): OutboundLinkDestination | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }

  const baseUrl = parseBaseUrl(base);
  if (base !== undefined && base !== null && !baseUrl) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = baseUrl ? new URL(value, baseUrl) : new URL(value);
  } catch {
    return null;
  }

  if (!HTTP_PROTOCOLS.has(parsed.protocol as HttpProtocol)) {
    return null;
  }

  const hostname = normalizeOutboundHostname(parsed.hostname);
  if (!hostname) {
    return null;
  }

  const origin = canonicalHttpOrigin(parsed, hostname);
  let baseOrigin: string | null = null;
  if (baseUrl) {
    const baseHostname = normalizeOutboundHostname(baseUrl.hostname);
    // A malformed base must never turn an absolute destination into an
    // apparently same-origin one. It is only used in the browser, but keeping
    // this explicit also makes unit tests and SSR callers fail closed.
    if (
      !baseHostname ||
      !HTTP_PROTOCOLS.has(baseUrl.protocol as HttpProtocol)
    ) {
      return null;
    }
    baseOrigin = canonicalHttpOrigin(baseUrl, baseHostname);
  }

  return {
    href: parsed.href,
    hostname,
    protocol: parsed.protocol as HttpProtocol,
    origin,
    isExternal: baseOrigin !== null && origin !== baseOrigin,
  };
}

/**
 * Return true for an author link scheme that must not be allowed to navigate.
 * `mailto:` and `tel:` remain valid Markdown destinations; every other
 * non-HTTP scheme is rejected by the delegated handler. Relative links are
 * resolved against the page and therefore become HTTP(S) destinations.
 */
export function isDisallowedAuthorLink(
  value: unknown,
  base: string | URL,
): boolean {
  if (typeof value !== "string" || value.length === 0) {
    return true;
  }

  let parsed: URL;
  try {
    parsed = new URL(value, base);
  } catch {
    return true;
  }

  return (
    !HTTP_PROTOCOLS.has(parsed.protocol) &&
    !SAFE_NON_HTTP_PROTOCOLS.has(parsed.protocol)
  );
}

// Short aliases make the boundary easy to discover for call sites and tests.
export const parseOutboundLink = parseOutboundHttpUrl;
export const normalizeHostname = normalizeOutboundHostname;
