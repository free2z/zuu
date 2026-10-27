import * as env from "$app/env/private";
import { error, redirect } from "@sveltejs/kit";
import { createAbortSignalWithTimeout } from "$lib/abort-signal.js";
import { loginDestination } from "$lib/login-destination";
import {
  buildBackendMutationRequest,
  BackendBridgeError,
  type BackendMutationMethod,
} from "./backend-policy";

export { BackendBridgeError } from "./backend-policy";

const DEFAULT_API_BASE = "http://localhost:8000";

type CookieReader = {
  get: (name: string) => string | undefined;
};

export type BackendUser = {
  username: string;
  p2paddr?: string | null;
  [key: string]: unknown;
};

export function getApiBase() {
  return env.PRIVATE_API_BASE_URL || DEFAULT_API_BASE;
}

export function getSessionCookie(cookies: CookieReader) {
  return cookies.get("sessionid");
}

export function getCsrfCookie(cookies: CookieReader) {
  return cookies.get("csrftoken");
}

export async function authenticatedBackendMutation({
  fetchFn,
  cookies,
  requestDestinationOrigin,
  initiatingOrigin,
  path,
  method,
  json,
}: {
  fetchFn: typeof fetch;
  cookies: CookieReader;
  requestDestinationOrigin: string;
  initiatingOrigin: string;
  path: string;
  method: BackendMutationMethod;
  json?: unknown;
}) {
  const sessionId = getSessionCookie(cookies);
  const csrfToken = getCsrfCookie(cookies);

  const apiBase = getApiBase();
  const request = buildBackendMutationRequest({
    apiBase,
    configuredOrigins: env.PRIVATE_BACKEND_TRUSTED_ORIGINS || "",
    requestDestinationOrigin,
    initiatingOrigin,
    path,
    method,
    sessionId,
    csrfToken,
    json,
  });

  return fetchFn(request.target, request.init);
}

export type BackendFailure = {
  status: number;
  kind: "csrf" | "authentication" | "validation" | "redirect" | "upstream";
  detail: string;
};

function sanitizeDetail(value: unknown) {
  if (typeof value !== "string") return "";
  return value
    .replace(
      /(?:sessionid|csrftoken|x-csrftoken|cookie)\s*[:=]\s*[^\s,;]+/gi,
      "[credential redacted]",
    )
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, 300);
}

export async function readBackendFailure(
  response: Response,
): Promise<BackendFailure> {
  let detail = "";
  try {
    const raw = await response.text();
    try {
      const parsed = raw ? JSON.parse(raw) : {};
      detail = sanitizeDetail(
        parsed?.detail || parsed?.error || parsed?.message,
      );
    } catch {
      detail = sanitizeDetail(raw);
    }
  } catch {
    detail = "";
  }

  const status = response.status || 502;
  const kind =
    status >= 300 && status < 400
      ? "redirect"
      : status === 401
        ? "authentication"
        : status === 403 && /csrf/i.test(detail)
          ? "csrf"
          : status >= 400 && status < 500
            ? "validation"
            : "upstream";

  return { status, kind, detail };
}

export function logBackendFailure(operation: string, failure: BackendFailure) {
  console.error("Authenticated backend mutation failed", {
    operation,
    status: failure.status,
    kind: failure.kind,
    // Downstream bodies may contain secrets we do not know how to recognize.
    // Use the sanitized text only for local classification; logs stay metadata-only.
    hasDetail: Boolean(failure.detail),
  });
}

/**
 * How long the server-side `/api/auth/user/` lookup may take — headers AND
 * body — before the load gives up and answers 503. Well under the 60s
 * the public proxy waits on new-ui: without a deadline the fetch inherits the
 * localhost sidecar's 200s `/api/` patience, so a Django that accepts the
 * connection and then stalls keeps the SSR render (and its memory) alive long
 * after the visitor has been served the maintenance page.
 */
export const AUTH_USER_TIMEOUT_MS = 10_000;

function identityUnavailable(): never {
  throw error(503, "errors.http.503.title", { code: 503 });
}

function causeName(cause: unknown) {
  return cause instanceof Error ? cause.name : typeof cause;
}

/**
 * The caller's creator record; `null` when the caller is genuinely signed
 * out; a thrown 503 when the backend could not answer.
 *
 * This is the ONE place a server load asks Django who the visitor is, and the
 * distinction it exists to preserve is: **only a 401/403 means "not signed
 * in".** A 5xx from a rollout draining gunicorn workers, a 429 from the
 * throttle, a timeout, a 3xx, or a 200 whose body is not a user all mean "the
 * backend could not be consulted". Reporting any of those as "you are logged
 * out" sends a signed-in user to `/login` to re-enter credentials that were
 * never the problem. The client-side editor has always drawn this line
 * (401/403 -> re-auth, anything else -> error); the server loads now do too.
 *
 * No `sessionid` cookie is `null` without a backend round trip: Django session
 * auth cannot authenticate a request that carries none.
 *
 * `T` is the caller's view of the record; only `username` is checked here.
 * The dashboard loads pass `any` because their pages were written against the
 * untyped `response.json()` this replaced.
 *
 * What the 503 buys is an honest status at the APPLICATION layer, which a 302
 * to a login page can never be; `+error.svelte` renders it as "temporarily
 * unavailable, try again".
 */
export async function resolveAuthenticatedUser<T = BackendUser>(
  fetchFn: typeof fetch,
  cookies: CookieReader,
): Promise<T | null> {
  const sessionId = getSessionCookie(cookies);
  if (!sessionId) {
    return null;
  }

  // The deadline covers the BODY as well as the headers, which is why it is
  // cleaned up once, at the very end: a flapping upstream that sends `200`
  // and then stalls mid-body is the likelier of the two hangs.
  const deadline = createAbortSignalWithTimeout(null, AUTH_USER_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetchFn(`${getApiBase()}/api/auth/user/`, {
        redirect: "manual",
        signal: deadline.signal,
        headers: { Cookie: `sessionid=${sessionId}` },
      });
    } catch (cause) {
      console.error("Identity lookup could not reach the backend", {
        cause: causeName(cause),
      });
      identityUnavailable();
    }

    if (response.status === 401 || response.status === 403) {
      // The distinguishing log line for "sent to /login": without it a
      // spurious logout is an invisible 302 inside new-ui.
      console.warn("Identity lookup rejected the session", {
        status: response.status,
      });
      return null;
    }

    if (!response.ok || (response.status >= 300 && response.status < 400)) {
      console.error("Identity lookup got an unusable response", {
        status: response.status,
      });
      identityUnavailable();
    }

    let user: unknown;
    try {
      user = await response.json();
    } catch (cause) {
      console.error("Identity lookup could not read the response", {
        cause: causeName(cause),
      });
      identityUnavailable();
    }

    const username = (user as { username?: unknown } | null)?.username;
    if (typeof username !== "string" || !username.trim()) {
      // A 200 with no username is a broken contract, not a signed-out
      // visitor. Calling it anonymous would loop signed-in users through the
      // login page for the whole life of a serializer regression.
      console.error("Identity lookup got a 200 with no username");
      identityUnavailable();
    }
    return user as T;
  } finally {
    deadline.cleanup();
  }
}

/**
 * The signed-in creator, or a redirect to the real login page  — but
 * only when the backend says the session is not valid (401/403) or there is
 * no session cookie at all. Every other failure is a 503 error page, never a
 * login bounce; see `resolveAuthenticatedUser`.
 *
 * `returnTo` is the route's own `url.pathname` (+ `url.search`), so a visitor
 * whose session expired comes back to the page they asked for once they have
 * signed in; it passes through `getSafeNextPath` like every other `next`.
 */
export async function requireAuthenticatedUser<T = BackendUser>(
  fetchFn: typeof fetch,
  cookies: CookieReader,
  returnTo?: string,
): Promise<T> {
  const user = await resolveAuthenticatedUser<T>(fetchFn, cookies);
  if (!user) {
    throw redirect(302, loginDestination(returnTo));
  }
  return user;
}
