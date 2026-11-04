/**
 * Scheme allowlist for every string this app is about to hand to a live URL
 * sink — `el.src`, `el.href`, `window.open`, `location =`.
 *
 * WHY A PARSER AND NOT A REGEXP. The obvious implementation is
 * `!/^javascript:/i.test(url)`, and it loses. All of these are `javascript:` to
 * a browser and none of them match that pattern:
 *
 *   "JaVaScRiPt:alert(1)"          case
 *   "java\tscript:alert(1)"        the URL parser strips ASCII tab/LF/CR
 *   "  javascript:alert(1)"        leading C0 controls and space are stripped
 *   "&;avascript:alert(1)"     the HTML parser decodes entities first
 *   "data:text/html;base64,…"     not `javascript:` at all, still script
 *   "vbscript:msgbox(1)"          a scheme a javascript-only blocklist forgets
 *
 * `new URL()` is the same WHATWG parser the browser uses to resolve the
 * attribute, so it collapses every one of those to `protocol === "javascript:"`
 * before we decide. Comparing the parsed protocol against a closed set is the
 * only check that cannot be out-encoded: a scheme we have never heard of is
 * rejected by default rather than allowed by omission.
 *
 * Runs on the server too (SSR, `@sveltejs/adapter-node`) — `URL` is a global in
 * Node, so nothing here touches `document` or `window`.
 */
const SAFE_URL_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * An absolute `http:`/`https:` URL, or `null`.
 *
 * Returns the PARSED `href`, not the input, so callers cannot accidentally use
 * a raw string that the parser read differently than they did.
 */
export function getSafeHttpUrl(url: unknown): string | null {
  if (typeof url !== "string" || url === "") {
    return null;
  }

  try {
    const parsed = new URL(url);
    return SAFE_URL_PROTOCOLS.has(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

/**
 * Same allowlist, but also admits a root-relative path.
 *
 * Uploads are served from `PUBLIC_API_BASE_URL`, which is empty in dev, in the
 * test suite and in any deployment where the API is same-origin — so
 * `renderUploadEmbed` legitimately emits `/uploadz/...` with no origin, and a
 * strict absolute-URL check would silently drop every same-origin audio embed.
 *
 * A leading `/` puts the WHATWG parser in a relative state it can never leave,
 * so the scheme is always the page's own and `javascript:` is unreachable. The
 * one exception is `/\` (and `//`), which the parser treats as an authority
 * delimiter for special schemes — `new URL("/\\evil.example/x", "https://a.b")`
 * is `https://evil.example/x`, not a path. Those go through the absolute check
 * instead of being trusted as same-origin.
 */
export function getSafeMediaUrl(url: unknown): string | null {
  if (typeof url !== "string") {
    return null;
  }

  const value = url.trim();
  if (!value) {
    return null;
  }

  if (value.startsWith("/") && !/^\/[/\\]/.test(value)) {
    return value;
  }

  return getSafeHttpUrl(value);
}

/**
 * True when `url` resolves to an origin OTHER than `pageOrigin`.
 *
 * Used to keep a third-party embed out of our own origin: a `sandbox` carrying
 * both `allow-scripts` and `allow-same-origin` is no sandbox at all when the
 * framed document is same-origin with the embedder, because the frame can then
 * reach `parent.document` and simply delete its own `sandbox` attribute. Those
 * two tokens are unavoidable for real embeds (YouTube, Spotify and Twitter all
 * need storage plus scripts), so the containment has to come from the frame
 * being cross-origin — which we verify here rather than assume.
 */
export function isCrossOriginHttpUrl(
  url: unknown,
  pageOrigin: string,
): boolean {
  if (typeof url !== "string" || url === "") {
    return false;
  }

  let parsed: URL;
  try {
    // Resolved against the page so a relative src is correctly seen as
    // same-origin rather than as an unparseable string we might wave through.
    parsed = new URL(url, pageOrigin);
  } catch {
    return false;
  }

  return (
    SAFE_URL_PROTOCOLS.has(parsed.protocol) && parsed.origin !== pageOrigin
  );
}

/**
 * True when fetching `url` would tell a THIRD PARTY that this reader is here.
 *
 * Deliberately not `isCrossOriginHttpUrl` with the arguments flipped around,
 * because the two answer different questions and the difference is the whole
 * point:
 *
 *   - It admits the root-relative form. `getSafeMediaUrl` already emits
 *     `/uploadz/...` for every hosted upload whenever `PUBLIC_API_BASE_URL` is
 *     empty — which is what PRODUCTION runs (`k8s/new-ui/deployment.yaml`), not
 *     just dev — and has already rejected the `//host` and `/\host` forms that
 *     a bare `startsWith("/")` would otherwise read as a path. So a leading `/`
 *     here really is our own origin.
 *
 *   - It FAILS CLOSED. `isCrossOriginHttpUrl` returns `false` for anything it
 *     cannot parse, which is the right default when the question is "may I drop
 *     `allow-same-origin`" and exactly the wrong one when the question is "may
 *     I contact this host before the reader asked me to". `pageOrigin` is null
 *     under SSR (`location` is undefined there), and `new URL(x, "")` throws
 *     even for an absolute `x` — so routing that case through
 *     `isCrossOriginHttpUrl` would quietly answer "first party" for
 *     `https://tracker.example/probe.mp3` and reinstate the beacon.
 */
export function isThirdPartyMediaUrl(
  url: unknown,
  pageOrigin: string | null,
): boolean {
  if (typeof url !== "string" || url === "") {
    return false;
  }

  // The same `//host` / `/\host` guard `getSafeMediaUrl` uses. Callers are
  // supposed to have passed its output, but "third party?" answered wrong is a
  // silent privacy failure and the check costs one regexp — a bare
  // `startsWith("/")` would read `//tracker.example/probe.mp3` as our own path.
  if (url.startsWith("/") && !/^\/[/\\]/.test(url)) {
    return false;
  }

  if (!pageOrigin) {
    return true;
  }

  return isCrossOriginHttpUrl(url, pageOrigin);
}
