import { browser } from "$app/env";
import { authStore } from "$lib/stores/auth";
import {
  beginAccountBalanceRead,
  recordQuotedBalanceRead,
} from "$lib/account-balance";
import {
  apiRequestTimeoutMs,
  armRequestTimeout,
} from "$lib/api/request-timeout.js";

const CSRF_SECRET_LENGTH = 32;
const CSRF_ALLOWED_CHARS =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function createCSRFToken(): string {
  const bytes = new Uint8Array(CSRF_SECRET_LENGTH);
  const maxUnbiasedValue =
    Math.floor(256 / CSRF_ALLOWED_CHARS.length) * CSRF_ALLOWED_CHARS.length;
  let token = "";

  while (token.length < CSRF_SECRET_LENGTH) {
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte < maxUnbiasedValue) {
        token += CSRF_ALLOWED_CHARS[byte % CSRF_ALLOWED_CHARS.length];
        if (token.length === CSRF_SECRET_LENGTH) break;
      }
    }
  }

  return token;
}

/**
 * Get CSRF token from cookie
 */
export function getCSRFToken(): string | null {
  if (!browser) return null;
  const match = document.cookie.match(/(?:^|; )csrftoken=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Ensure CSRF token exists by making a GET request if needed
 */
export async function ensureCSRFToken(): Promise<string | null> {
  if (!browser) return null;
  let token = getCSRFToken();
  if (token) return token;

  // Django accepts an unmasked 32-character CSRF secret when the cookie and
  // X-CSRFToken header match. Creating it on our own origin avoids making
  // every write depend on an unrelated auth GET that may be slow or offline.
  token = createCSRFToken();
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `csrftoken=${token}; Path=/; SameSite=Lax${secure}`;

  return getCSRFToken();
}

/**
 * `apiFetch` options: a `RequestInit` plus `timeoutMs`. A number
 * replaces the class bound from `apiRequestTimeoutMs`; `null` opts out.
 */
export type ApiFetchInit = RequestInit & { timeoutMs?: number | null };

/**
 * Enhanced fetch wrapper that automatically handles CSRF tokens
 * Similar to axios interceptors in the React app
 *
 * Every write is BOUNDED: see `$lib/api/request-timeout.js` for the
 * classes and their numbers. When the bound fires the promise rejects with an
 * `ApiTimeoutError` (status 0, a sentence in `.message`) — never a bare
 * abort, which call sites treat as "superseded, say nothing". The bound also
 * covers reading the body: the timer is left armed after the headers arrive,
 * so a response that stalls mid-body errors instead of hanging `.json()`.
 * Aborting a response that has already been read is a no-op.
 */
export async function apiFetch(
  input: RequestInfo | URL,
  init?: ApiFetchInit,
): Promise<Response> {
  // A copy: callers reuse their init objects, and the old in-place mutation
  // leaked a CSRF header and credentials into them.
  const { timeoutMs, ...rest } = init || {};
  const options: RequestInit = { ...rest };
  const requestIsCurrent = browser
    ? authStore.captureRequestOwnership()
    : () => true;

  // Ensure credentials are included
  options.credentials = options.credentials || "include";

  // For non-GET requests, ensure CSRF token is included
  if (options.method && options.method !== "GET") {
    const csrfToken = await ensureCSRFToken();
    if (options.credentials !== "omit" && !requestIsCurrent())
      throw new Error(
        "Account changed before this request was sent. Review the current account before trying again.",
      );

    options.headers = {
      ...(options.headers as Record<string, string> | undefined),
      ...(csrfToken ? { "X-CSRFToken": csrfToken } : {}),
    };
  }

  const request =
    typeof Request !== "undefined" && input instanceof Request ? input : null;
  const method = String(
    options.method || request?.method || "GET",
  ).toUpperCase();
  const bound = armRequestTimeout(
    // A `Request` carries its own cancellation; overriding `signal` below
    // must not drop it (codex review).
    options.signal ?? request?.signal,
    apiRequestTimeoutMs({ input, method, body: options.body, timeoutMs }),
    { method, url: request ? request.url : String(input) },
  );

  try {
    const order = browser ? beginAccountBalanceRead() : undefined;
    const response = await fetch(input, { ...options, signal: bound.signal });
    return order === undefined
      ? response
      : recordQuotedBalanceRead(response, order);
  } catch (error) {
    bound.cleanup();
    throw bound.translate(error);
  }
}

export const API_BASE = "/api";
