/**
 * How long the browser waits for an API WRITE before it gives up.
 *
 * Until this existed no browser-side write had a bound at all except the
 * uploads  and subscribe (15 s, hand-rolled). A write that never
 * settled — a stalled mobile connection, a half-open socket, the  case
 * where the server answered while the client was still streaming — left its
 * spinner up forever. The editor was the worst of it: `isSaving` stayed true,
 * every autosave returned "in-flight", and Save/Publish awaited the hung
 * promise with no end and no message.
 *
 * Both shared request paths — the orval `customInstance` (`mutator.ts`) and
 * the hand-rolled `apiFetch` (`config.ts`) — ask {@link apiRequestTimeoutMs}
 * which bound applies, and arm it with the one timing primitive the app
 * already uses everywhere else, `createAbortSignalWithTimeout`
 * (`$lib/abort-signal.js`: SSR API reads, auth, series search). The upload
 * transport (`uploadRequest.ts`) keeps its XHR stall watch — only XHR reports
 * upload progress — but its response bound is {@link UPLOAD_RESPONSE_TIMEOUT_MS},
 * defined HERE and re-exported there, so the two can never drift.
 *
 * THE CLASSES, AND WHY EACH NUMBER
 * --------------------------------
 * The ceiling that matters is the proxy in front of `/api/`: the new-ui nginx
 * (`k8s/new-ui/nginx-configmap.yaml`) and the classic one
 * (`k8s/free2z/nginx.conf`) both run `/api/` under the server-level
 * `proxy_read_timeout 200s`. Past 200 s of upstream silence a live proxy has
 * ALREADY answered with a 504, so no bound above ~200 s can ever cut off an
 * answer that was coming. The only thing a browser bound above that catches
 * is the case where nothing answers at all — which is exactly.
 *
 *   - ordinary JSON write: {@link API_WRITE_TIMEOUT_MS} = 30 s. A zPage save,
 *     a donation, a password change, a vote: single-row database work plus,
 *     at worst, one Stripe call (`RequestsClient(timeout=(3.05, 5))` in
 *     `ztripe/views.py`). Past 30 s nothing on this list is still working;
 *     it is wedged, and a creator staring at "Saving…" deserves to know.
 *     The bound includes UPLOADING the request body: `/api/` JSON is capped
 *     at `client_max_body_size 1m`, and a full 1 MB body would need a link
 *     slower than ~270 kbit/s up to miss 30 s. The largest prod zPage save
 *     in the 30 days to 2026-09-23 was 58 KB (fresh review of ).
 *     Translation purchase and publication export are in this class on
 *     purpose: both answer 202 and do the slow part in a background job
 *     (`g12f/views/translate.py`, `exports/views.py`).
 *
 *   - AI generation: {@link API_LONG_WRITE_TIMEOUT_MS} = 210 s. The provider
 *     call runs INSIDE the request: chat stops at `AI_CHAT_DEADLINE_SECONDS =
 *     170` (`openai/models.py`), image generation has no deadline of its own
 *     and is bounded only by nginx's 200 s. 210 s sits just above the proxy,
 *     so the browser never abandons a generation that could still arrive —
 *     the 504 always gets there first. See {@link LONG_WRITE_PATHS}.
 *
 *   - binary body (FormData, Blob, ArrayBuffer, stream): {@link
 *     UPLOAD_RESPONSE_TIMEOUT_MS} = 610 s. A multipart body on a slow link is
 *     a legitimate multi-minute request (KYC document photos go through
 *     `apiFetch`), and `fetch` cannot see upload progress, so the only honest
 *     bound is the upload transport's own wall: just above the 600 s
 *     `proxy_read_timeout` on `/uploads` and gunicorn's `--timeout 600`.
 *
 *   - reads (GET/HEAD/OPTIONS): no default bound here. Reads are cancelled by
 *     their query's lifecycle and have their own per-surface deadlines where
 *     it mattered (`first-party-card-resolver.ts`, `search/series.ts`,
 *     `language-catalog.js`);  is about writes.
 *
 * A caller can always pass `timeoutMs`: a number replaces the class bound,
 * `null` opts out entirely (a streamed response, a long poll). Opting out is
 * a decision the call site must make in writing, not the default.
 */

import { createAbortSignalWithTimeout } from "../abort-signal.js";

/** Ordinary JSON writes. See the module comment for the derivation. */
export const API_WRITE_TIMEOUT_MS = 30_000;

/**
 * AI generation writes: just above nginx's `/api/` `proxy_read_timeout 200s`,
 * which is itself above the chat's own 170 s deadline.
 */
export const API_LONG_WRITE_TIMEOUT_MS = 210_000;

/**
 * Binary-body writes, and the upload transport's response bound — just above
 * the 600 s `proxy_read_timeout` on `/uploads` and gunicorn's `--timeout 600`.
 * `uploadRequest.ts` re-exports this; it is the one definition.
 */
export const UPLOAD_RESPONSE_TIMEOUT_MS = 610_000;

/**
 * Paths whose write runs an AI provider inside the request. Matched against
 * the URL's pathname, so an absolute `${apiBase}/api/...` and a relative
 * `/api/...` are the same request.
 *
 * Every POST endpoint in `f2z.yaml` that calls a model synchronously belongs
 * here — whether or not the Svelte app calls it today, because the generated
 * client exports all of them and the next caller should not have to know.
 * `tests/api-request-timeout.test.mjs` pins the list.
 */
export const LONG_WRITE_PATHS = Object.freeze([
  // AI cover / image generation (`CoverAIPanel.svelte`).
  /^\/api\/openai\/image\/?$/,
  /^\/api\/openai\/prompt\/?$/,
  /^\/api\/storytime\/[^/]+\/(?:image|text)\/?$/,
  // Chat: one provider generation per request, 170 s deadline server-side.
  /^\/api\/ai\/prompt\/?$/,
  /^\/api\/ai\/conversations\/[^/]+\/promptresponses\/?$/,
  // Stream start (`StreamService.initStream`): recovering a missing provider
  // meeting is three SEQUENTIAL Dyte calls (add host, create, add host;
  // `dyte/views.py`), each allowed a 15 s read timeout — up to ~45 s of
  // legitimate work, past the 30 s write bound. Found by the codex review.
  /^\/api\/dyte\/[^/]+\/(?:broadcast|ppv|subscribers-only)\/?$/i,
]);

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * @param {unknown} body
 * @returns {boolean}
 */
export function isBinaryBody(body) {
  if (body == null || typeof body === "string") return false;
  if (typeof FormData !== "undefined" && body instanceof FormData) return true;
  if (typeof Blob !== "undefined" && body instanceof Blob) return true;
  if (typeof ArrayBuffer !== "undefined") {
    if (body instanceof ArrayBuffer) return true;
    if (ArrayBuffer.isView(body)) return true;
  }
  if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream)
    return true;
  return false;
}

/**
 * @param {RequestInfo | URL | string} input
 * @returns {string}
 */
function pathnameOf(input) {
  const raw =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input && typeof input === "object" && "url" in input
          ? String(/** @type {{url: unknown}} */ (input).url)
          : String(input);
  try {
    return new URL(raw, "https://api.invalid").pathname;
  } catch {
    return raw.split("?")[0];
  }
}

/**
 * The bound, in milliseconds, for one browser API request — or `null` when
 * the request gets no default bound (a read).
 *
 * @param {{
 *   input: RequestInfo | URL | string,
 *   method?: string | null,
 *   body?: unknown,
 *   timeoutMs?: number | null,
 * }} request
 * @returns {number | null}
 */
export function apiRequestTimeoutMs({ input, method, body, timeoutMs }) {
  if (timeoutMs === null) return null;
  if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs)) {
    return timeoutMs > 0 ? timeoutMs : null;
  }

  const verb = String(method || "GET").toUpperCase();
  if (READ_METHODS.has(verb)) return null;

  if (isBinaryBody(body)) return UPLOAD_RESPONSE_TIMEOUT_MS;

  const pathname = pathnameOf(input);
  if (LONG_WRITE_PATHS.some((pattern) => pattern.test(pathname))) {
    return API_LONG_WRITE_TIMEOUT_MS;
  }

  return API_WRITE_TIMEOUT_MS;
}

/**
 * A request the browser abandoned because it outlived its bound.
 *
 * A distinct class, not an `ApiError` with a made-up status: there WAS no
 * response, so there is no status, and "the server said no" and "we never
 * heard back" call for different words. The write may still have committed
 * server-side; the message says so rather than claiming nothing happened.
 */
export class ApiTimeoutError extends Error {
  /**
   * @param {{ timeoutMs: number, method?: string, url?: string }} details
   */
  constructor({ timeoutMs, method = "", url = "" }) {
    const seconds = Math.round(timeoutMs / 1000);
    super(
      `The server did not respond within ${seconds} seconds. Check your connection and try again.`,
    );
    this.name = "ApiTimeoutError";
    /** HTTP status: none — nothing answered. */
    this.status = 0;
    this.timeoutMs = timeoutMs;
    this.method = method;
    this.url = url;
  }
}

/**
 * @param {unknown} error
 * @returns {error is ApiTimeoutError}
 */
export function isApiTimeoutError(error) {
  return (
    error instanceof ApiTimeoutError ||
    (Boolean(error) &&
      typeof error === "object" &&
      /** @type {{name?: unknown}} */ (error).name === "ApiTimeoutError")
  );
}

/**
 * Did this request end because a bound fired — whether before the headers
 * (`apiFetch` rejects with {@link ApiTimeoutError}) or while the BODY was
 * being read? `apiFetch` leaves its timer armed after the headers arrive, so
 * a body that stalls rejects `response.json()` with the raw abort reason, a
 * `DOMException` named `TimeoutError`, outside apiFetch's own catch. Callers
 * that read the body themselves must treat both the same (codex review).
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isRequestTimeout(error) {
  return (
    isApiTimeoutError(error) ||
    (Boolean(error) &&
      typeof error === "object" &&
      /** @type {{name?: unknown}} */ (error).name === "TimeoutError")
  );
}

/**
 * Said when the body stalled after the headers arrived: the raw
 * `DOMException("TimeoutError")` carries a browser-specific, developer-facing
 * message ("signal timed out"), not a sentence for a person.
 */
export const BODY_TIMEOUT_MESSAGE =
  "The server stopped responding before its answer arrived. Check your connection and try again.";

/**
 * The sentence to show for a request that ended because a bound fired, or
 * `""` when `error` is not a timeout (the caller keeps its own copy). For a
 * call site's `catch`, next to `readApiError` for the non-2xx case.
 *
 * @param {unknown} error
 * @returns {string}
 */
export function requestTimeoutMessage(error) {
  if (isApiTimeoutError(error)) {
    return /** @type {ApiTimeoutError} */ (error).message;
  }
  return isRequestTimeout(error) ? BODY_TIMEOUT_MESSAGE : "";
}

/**
 * Arm the bound for one request.
 *
 * Returns the signal to hand `fetch`, a `cleanup`, and `translate(error)`,
 * which turns the abort OUR timer caused into an {@link ApiTimeoutError} and
 * passes everything else through untouched — in particular a caller's own
 * abort stays an `AbortError`, which every call site already treats as
 * "superseded, say nothing".
 *
 * With no bound (`timeoutMs === null`) the caller's signal is passed through
 * and nothing is armed.
 *
 * @param {AbortSignal | null | undefined} callerSignal
 * @param {number | null} timeoutMs
 * @param {{ method?: string, url?: string }} [describe]
 * @returns {{
 *   signal: AbortSignal | null | undefined,
 *   cleanup: () => void,
 *   timedOut: () => boolean,
 *   translate: (error: unknown) => unknown,
 * }}
 */
export function armRequestTimeout(callerSignal, timeoutMs, describe = {}) {
  if (timeoutMs === null) {
    return {
      signal: callerSignal,
      cleanup: () => {},
      timedOut: () => false,
      translate: (error) => error,
    };
  }

  const armed = createAbortSignalWithTimeout(callerSignal, timeoutMs);
  const timedOut = () =>
    armed.signal.aborted &&
    !callerSignal?.aborted &&
    /** @type {{name?: unknown} | undefined} */ (armed.signal.reason)?.name ===
      "TimeoutError";

  return {
    signal: armed.signal,
    cleanup: armed.cleanup,
    timedOut,
    translate: (error) =>
      timedOut() ? new ApiTimeoutError({ timeoutMs, ...describe }) : error,
  };
}
