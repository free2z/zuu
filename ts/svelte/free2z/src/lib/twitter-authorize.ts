/**
 * Starting "Sign in with X": ask the SERVER where to send the browser.
 *
 *  the modal used to build the X authorize URL itself, from a
 * build-time `VITE_TWITTER_CLIENT_ID` read off Vite's env. That variable was
 * set in no Dockerfile, no Cloud Build substitution and
 * no k8s manifest, so it was `undefined` in every image ever shipped: 100% of
 * new-UI users saw "Sign-in with X is not configured" for two months while
 * `/api/twitter/start` answered 200 to every click. 137 accounts have an
 * unusable password and could only sign in this way.
 *
 * The client no longer assembles anything. `/api/twitter/start` returns a
 * complete `authorize_url` built from the same `TWITTER_CLIENT_ID` the
 * callback uses to exchange the code, and this module's whole job is to fetch
 * it and refuse to navigate anywhere that is not an X consent screen.
 *
 * The destination check is not ceremony: `window.location.href = <server
 * string>` is an open redirect the moment that string can be influenced, and
 * a redirect that carries a login handshake is exactly the one worth
 * hijacking.
 *
 *  it checks the SCHEME, HOST and PATH that will actually be
 * navigated, never `URL.origin`. Per WHATWG a `blob:` URL's origin is the
 * origin of its INNER URL, so `new URL("blob:https://x.com/abc").origin` is
 * `"https://x.com"` and an origin allowlist waved it through. `origin` is
 * inherited, not derived from the scheme the browser would load.
 */

/** The only hosts a returned `authorize_url` may point at (https only). */
export const X_AUTHORIZE_HOSTS: readonly string[] = ["x.com", "twitter.com"];

/** X's OAuth2 consent screen: the only path the module exists to reach. */
export const X_AUTHORIZE_PATH = "/i/oauth2/authorize";

/** Why a start attempt failed, so the caller can pick a translated message. */
export type TwitterAuthorizeFailure = "start_failed" | "bad_authorize_url";

export class TwitterAuthorizeError extends Error {
  readonly reason: TwitterAuthorizeFailure;

  constructor(reason: TwitterAuthorizeFailure, message: string) {
    super(message);
    this.name = "TwitterAuthorizeError";
    this.reason = reason;
  }
}

/**
 * Validate a server-supplied authorize URL and return it normalized.
 *
 * Absolute, parseable, `https:`, no userinfo, exactly an X host on the
 * default port, and exactly the consent-screen path — nothing else is
 * navigable.
 */
export function assertAuthorizeUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TwitterAuthorizeError(
      "bad_authorize_url",
      "The server returned no authorize_url",
    );
  }
  let parsed: URL;
  try {
    // No base argument: a relative URL must FAIL here rather than be
    // resolved against the current page.
    parsed = new URL(value);
  } catch {
    throw new TwitterAuthorizeError(
      "bad_authorize_url",
      "The server returned a non-absolute authorize_url",
    );
  }
  // Scheme first, and by equality: `blob:https://x.com/...` and
  // `filesystem:` carry an INNER https origin but are not https URLs.
  if (parsed.protocol !== "https:") {
    throw new TwitterAuthorizeError(
      "bad_authorize_url",
      `Refusing to navigate to an unexpected scheme: ${parsed.protocol}`,
    );
  }
  // `host`, not `hostname`: it carries a non-default port, which must fail.
  // https:443 is normalized away by the parser, so `x.com:443` still passes.
  if (!X_AUTHORIZE_HOSTS.includes(parsed.host)) {
    throw new TwitterAuthorizeError(
      "bad_authorize_url",
      `Refusing to navigate to an unexpected host: ${parsed.host}`,
    );
  }
  // `toString()` below preserves userinfo, so `https://u:p@x.com/...` would
  // navigate with credentials attached. Nothing legitimate sends them.
  if (parsed.username !== "" || parsed.password !== "") {
    throw new TwitterAuthorizeError(
      "bad_authorize_url",
      "Refusing to navigate to a URL that carries credentials",
    );
  }
  if (parsed.pathname !== X_AUTHORIZE_PATH) {
    throw new TwitterAuthorizeError(
      "bad_authorize_url",
      `Refusing to navigate to an unexpected path: ${parsed.pathname}`,
    );
  }
  return parsed.toString();
}

/**
 * `GET /api/twitter/start` and return the authorize URL it supplies.
 *
 * `credentials: "include"` matters — the response sets the signed handshake
 * cookie the callback checks `state` against.
 *
 * `next` is where the sign-in should land instead of `/profile`. The server
 * honours it only for the pages an SDK app opens (consent, Manage, account
 * deletion; `safe_x_return_path` in py/dj/apps/twitter/views.py) and drops
 * anything else, so passing it is always safe.
 */
export async function fetchTwitterAuthorizeUrl(
  fetchImpl: typeof fetch = fetch,
  next?: string | null,
): Promise<string> {
  const startUrl = next
    ? `/api/twitter/start?${new URLSearchParams({ next }).toString()}`
    : "/api/twitter/start";
  let response: Response;
  try {
    response = await fetchImpl(startUrl, {
      method: "GET",
      credentials: "include",
    });
  } catch (cause) {
    throw new TwitterAuthorizeError(
      "start_failed",
      "Could not reach /api/twitter/start",
    );
  }
  if (!response.ok) {
    // Includes the server's own 503 when TWITTER_CLIENT_ID is unset. The
    // browser has no opinion about configuration any more; it only reports
    // that the start call did not succeed.
    throw new TwitterAuthorizeError(
      "start_failed",
      `/api/twitter/start responded ${response.status}`,
    );
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new TwitterAuthorizeError(
      "start_failed",
      "/api/twitter/start returned a body that is not JSON",
    );
  }
  return assertAuthorizeUrl(
    (data as { authorize_url?: unknown } | null)?.authorize_url,
  );
}
