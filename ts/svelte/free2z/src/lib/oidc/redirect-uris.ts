/**
 * Redirect URI feedback for the developer console (; zuu
 * docs/free2z/sdk/spec/oidc.md §3, RFC 8252 §7).
 *
 * A mirror of `dj.apps.oidc.redirects.classify` plus the registration rules
 * in `F2ZApplication.clean` (confidential = https only, no duplicates), so
 * the form can say what is wrong with a line BEFORE it is submitted. The
 * server remains the authority: whatever it refuses is shown too, and a
 * divergence here only costs a round trip, never a bad registration.
 *
 * No imports: `tests/oidc-redirect-uris.test.mjs` loads this directly.
 */

export type RedirectUriKind = "loopback" | "private_scheme" | "https";

export type RedirectUriProblem =
  | "required"
  | "whitespace"
  | "fragment"
  | "query"
  | "notAbsolute"
  | "credentials"
  | "localhost"
  | "httpNotLoopback"
  | "badPort"
  | "loopbackNoPath"
  | "httpsNoHost"
  | "httpsLoopback"
  | "badScheme"
  | "privateSchemeSlashes"
  | "privateSchemeNoPath"
  | "confidentialHttpsOnly"
  | "duplicate";

export type RedirectUriVerdict =
  | { ok: true; kind: RedirectUriKind }
  | { ok: false; problem: RedirectUriProblem };

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);
const REVERSE_DNS_SCHEME = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;

function splitNetloc(netloc: string): { host: string; port: string | null } {
  if (netloc.startsWith("[")) {
    const end = netloc.indexOf("]");
    if (end === -1) return { host: netloc.slice(1), port: null };
    const rest = netloc.slice(end + 1);
    return {
      host: netloc.slice(1, end),
      port: rest.startsWith(":") ? rest.slice(1) : null,
    };
  }
  const colon = netloc.lastIndexOf(":");
  if (colon === -1) return { host: netloc, port: null };
  return { host: netloc.slice(0, colon), port: netloc.slice(colon + 1) };
}

/** One URI's shape, the way the server's `classify` judges it. */
export function classifyRedirectUri(uri: string): RedirectUriVerdict {
  if (typeof uri !== "string" || !uri.trim()) {
    return { ok: false, problem: "required" };
  }
  if (uri !== uri.trim() || /\s/.test(uri)) {
    return { ok: false, problem: "whitespace" };
  }
  if (uri.includes("#")) return { ok: false, problem: "fragment" };
  if (uri.includes("?")) return { ok: false, problem: "query" };

  const schemeMatch = SCHEME.exec(uri);
  if (!schemeMatch) return { ok: false, problem: "notAbsolute" };
  const scheme = schemeMatch[1].toLowerCase();
  const rest = uri.slice(schemeMatch[0].length);

  let netloc = "";
  let path = rest;
  if (rest.startsWith("//")) {
    const afterSlashes = rest.slice(2);
    const slash = afterSlashes.indexOf("/");
    netloc = slash === -1 ? afterSlashes : afterSlashes.slice(0, slash);
    path = slash === -1 ? "" : afterSlashes.slice(slash);
  }
  if (netloc.includes("@")) return { ok: false, problem: "credentials" };

  if (scheme === "http") {
    const { host, port } = splitNetloc(netloc);
    const hostname = host.toLowerCase();
    if (hostname === "localhost") return { ok: false, problem: "localhost" };
    if (!LOOPBACK_HOSTS.has(hostname)) {
      return { ok: false, problem: "httpNotLoopback" };
    }
    if (port !== null && port !== "") {
      if (!/^\d+$/.test(port) || Number(port) > 65535) {
        return { ok: false, problem: "badPort" };
      }
    }
    if (!path.startsWith("/")) return { ok: false, problem: "loopbackNoPath" };
    return { ok: true, kind: "loopback" };
  }

  if (scheme === "https") {
    const hostname = splitNetloc(netloc).host.toLowerCase();
    if (!hostname) return { ok: false, problem: "httpsNoHost" };
    if (LOOPBACK_HOSTS.has(hostname) || hostname === "localhost") {
      return { ok: false, problem: "httpsLoopback" };
    }
    return { ok: true, kind: "https" };
  }

  if (!REVERSE_DNS_SCHEME.test(scheme)) {
    return { ok: false, problem: "badScheme" };
  }
  if (netloc || rest.startsWith("//")) {
    return { ok: false, problem: "privateSchemeSlashes" };
  }
  if (!path.startsWith("/")) {
    return { ok: false, problem: "privateSchemeNoPath" };
  }
  return { ok: true, kind: "private_scheme" };
}

export interface RedirectUriLine {
  uri: string;
  verdict: RedirectUriVerdict;
}

/** The textarea's lines, trimmed of blank ones (one URI per line). */
export function redirectUriLines(text: string): string[] {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Every line judged for a client type, including the two registration rules
 * `classify` alone does not know: a confidential client registers https only,
 * and a URI may appear once.
 */
export function validateRedirectUris(
  uris: string[],
  clientType: "public" | "confidential",
): RedirectUriLine[] {
  const seen = new Set<string>();
  return uris.map((uri) => {
    let verdict = classifyRedirectUri(uri);
    if (
      verdict.ok &&
      clientType === "confidential" &&
      verdict.kind !== "https"
    ) {
      verdict = { ok: false, problem: "confidentialHttpsOnly" };
    }
    if (verdict.ok && seen.has(uri)) {
      verdict = { ok: false, problem: "duplicate" };
    }
    seen.add(uri);
    return { uri, verdict };
  });
}
