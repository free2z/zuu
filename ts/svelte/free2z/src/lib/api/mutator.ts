import * as env from "$app/env/public";
import { authStore } from "$lib/stores/auth";
import { browser } from "$app/env";
import {
  beginAccountBalanceRead,
  recordQuotedBalanceRead,
} from "$lib/account-balance";
import { createAbortSignalWithTimeout } from "$lib/abort-signal.js";
import { ensureCSRFToken } from "$lib/api/config";
import { mergeRequestHeaders, resolveRequestBody } from "$lib/api/request.js";
import {
  apiRequestTimeoutMs,
  armRequestTimeout,
} from "$lib/api/request-timeout.js";
import {
  genericHttpErrorMessage,
  serverErrorMessage,
  serverFieldErrors,
} from "$lib/api/api-errors.js";

export {
  ApiTimeoutError,
  isApiTimeoutError,
} from "$lib/api/request-timeout.js";

const DEFAULT_SSR_API_TIMEOUT_MS = 10_000;
const TEXT_RESPONSE_PATHS = new Set([
  "/api/stripe/native-return/cancel/",
  "/api/stripe/native-return/success/",
]);

function expectsTextResponse(url: string): boolean {
  try {
    return TEXT_RESPONSE_PATHS.has(
      new URL(url, "https://api.invalid").pathname,
    );
  } catch {
    return false;
  }
}

function createSsrApiSignal(signal?: AbortSignal | null) {
  return createAbortSignalWithTimeout(signal, DEFAULT_SSR_API_TIMEOUT_MS);
}

/**
 * Custom error class for API-related errors.
 * Used to provide structured information about failed API requests.
 */
export class ApiError extends Error {
  /** HTTP status code (e.g., 404, 500) */
  status: number;
  /** Error data returned from the API, often containing detailed error messages */
  data: any;
  /**
   * The server's own sentence, or `""` when the body carried none.
   * `message` is this when present, else a generic sentence with the status.
   */
  serverMessage: string;
  /** Every field the server rejected, `{field: sentence}`, in body order. */
  fieldErrors: Record<string, string>;
  /**
   * The response's raw `Retry-After`, or `null`. SSR loaders forward it when
   * the API throttles them, so a 429 page carries the API's own hint.
   */
  retryAfter: string | null;

  constructor(
    message: string,
    status: number,
    data: any,
    retryAfter: string | null = null,
  ) {
    super(message);
    this.status = status;
    this.data = data;
    this.retryAfter = retryAfter;
    this.name = "ApiError";
    this.serverMessage = serverErrorMessage(data);
    this.fieldErrors = serverFieldErrors(data);
  }
}

/**
 * Callers of the generated client may pass `timeoutMs` in the request
 * options: a number replaces the class bound from `apiRequestTimeoutMs`,
 * `null` opts out. It never reaches `fetch`.
 */
export type RequestTimeoutOption = { timeoutMs?: number | null };

/**
 * Custom fetch instance for API requests.
 * Handles baseURL, query parameters, authentication credentials, CSRF tokens,
 * and error handling with ApiError.
 *
 * @template T - The expected return type
 * @param input - RequestInfo, URL, or an object with url and params
 * @param init - Request options, including an optional baseURL
 * @returns The parsed JSON response, or null for 204 No Content
 * @throws {ApiError} For non-OK HTTP responses
 */
export const customInstance = async <T>(
  input: RequestInfo | URL | any,
  init?: RequestInit & { baseURL?: string } & RequestTimeoutOption,
): Promise<T> => {
  const requestIsCurrent = browser
    ? authStore.captureRequestOwnership()
    : () => true;
  let url: string;
  // Captured BEFORE `init` is rebuilt from the descriptor below. Callers
  // (every `+page.server.ts` that forwards a session cookie) put headers on
  // `init`; the generated descriptor owns `input.headers` / `input.data`.
  const callerHeaders = init?.headers;
  let generatedHeaders: HeadersInit | undefined;
  let generatedData: unknown;
  const baseURL =
    (init as any)?.baseURL ||
    env.PUBLIC_API_BASE_URL ||
    (!browser ? process.env.PRIVATE_API_BASE_URL : "") ||
    "";

  if (typeof input === "string") {
    url = `${baseURL}${input}`;
  } else if (input && typeof input === "object" && input.url) {
    url = `${baseURL}${input.url}`;

    // Handle query parameters
    if (input.params) {
      const searchParams = new URLSearchParams();
      Object.entries(input.params).forEach(([key, value]) => {
        if (value === undefined || value === null) return;
        // An array parameter is REPEATED, one entry per value — OpenAPI
        // `style: form, explode: true`, which is what `f2z.yaml` declares for
        // `any_tags` and what Django's `QueryDict.getlist()` reads.
        //
        // Without this branch `String(["t-shirts", "t shirts"])` produces the
        // single value `t-shirts,t shirts`, and the server sees ONE tag whose
        // name contains a comma. It fails silently: the request is a valid
        // 200 with zero results, so the tag hub renders "no pages" for a tag
        // that has hundreds. Repeating is also why `any_tags` is not
        // comma-joined in the first place — a tag name may contain a comma.
        if (Array.isArray(value)) {
          for (const item of value) {
            if (item === undefined || item === null) continue;
            searchParams.append(key, String(item));
          }
          return;
        }
        searchParams.append(key, String(value));
      });
      const queryString = searchParams.toString();
      if (queryString) {
        url += `?${queryString}`;
      }
    }

    generatedHeaders = input.headers;
    generatedData = input.data;

    init = {
      ...init,
      ...input,
      method: input.method,
      // Generated writes may include an absent optional signal. Preserve the
      // caller's cancellation unless the descriptor explicitly supplies one.
      signal: input.signal === undefined ? init?.signal : input.signal,
    };
    // Remove descriptor-only keys from init so they are not passed to fetch
    delete (init as any).params;
    delete (init as any).baseURL;
    delete (init as any).data;
    delete (init as any).url;
  } else {
    url = input as string;
  }

  // orval hands the payload over as `data`, which fetch ignores. Map it onto
  // `body` — but only when nothing has already produced one. `init.body` here
  // is whatever the pre-existing precedence yields: a descriptor `body` (the
  // hand-written eventNotificationsApi shape) wins over request options, both
  // win over generated `data`. Every call site that hand-rolls
  // `body: JSON.stringify(...)` is therefore untouched.
  const body = resolveRequestBody(generatedData, init?.body);

  // Merge generated + caller headers. Clobbering the caller's headers
  // here is what kept the forwarded session cookie off every SSR request.
  const defaultHeaders = mergeRequestHeaders(
    generatedHeaders,
    callerHeaders,
    body,
  );

  // Add CSRF token for non-GET requests
  if (init?.method && init.method !== "GET") {
    const csrf = await ensureCSRFToken();
    if (init?.credentials !== "omit" && !requestIsCurrent())
      throw new ApiError(
        "Account changed before this request was sent. Review the current account before trying again.",
        409,
        { code: "account_changed" },
      );
    if (csrf) {
      // Applied AFTER the merge so a caller can never shadow the real token
      // with a stale one.
      defaultHeaders.set("X-CSRFToken", csrf);
    }
  }

  // `timeoutMs` is a request OPTION, not a fetch field. Read it off `init`
  // (where the caller's options land after the descriptor merge above) and
  // strip it before the request is built.
  const requestedTimeout = (init as RequestTimeoutOption | undefined)
    ?.timeoutMs;
  if (init && "timeoutMs" in init) {
    init = { ...init };
    delete (init as RequestTimeoutOption).timeoutMs;
  }

  const ssrRequestSignal = !browser
    ? createSsrApiSignal(init?.signal)
    : undefined;

  // The browser bound. SSR keeps its own, shorter deadline above.
  const method = String(init?.method || "GET").toUpperCase();
  const browserTimeout = browser
    ? armRequestTimeout(
        init?.signal,
        apiRequestTimeoutMs({
          input: url,
          method,
          body,
          timeoutMs: requestedTimeout,
        }),
        { method, url },
      )
    : undefined;

  // Include credentials for session-based auth unless a public request opts
  // out explicitly. Public homepage discovery must not send a visitor's
  // session cookie to a query that is intentionally anonymous.
  const requestInit: RequestInit = {
    ...init,
    body,
    headers: defaultHeaders,
    signal: ssrRequestSignal?.signal ?? browserTimeout?.signal ?? init?.signal,
    credentials: init?.credentials ?? "include", // Important for Django session auth
  };

  try {
    const balanceReadOrder = browser ? beginAccountBalanceRead() : undefined;
    const response = await fetch(url, requestInit);

    if (
      browser &&
      requestInit.credentials !== "omit" &&
      requestIsCurrent() &&
      authStore.handleAuthFailure(response.status)
    ) {
      console.log("Session expired, user logged out");
    }

    if (!response.ok) {
      let errorData;
      try {
        const text = await response.text();
        try {
          errorData = JSON.parse(text);
        } catch {
          errorData = text;
        }
      } catch (e) {
        errorData = "Unknown error";
      }
      // The server's own reason when it gave one  — every call site
      // that toasts `error.message` shows it — else a sentence that still
      // carries the status. `errorData` stays on `.data` for callers that
      // read specific fields.
      const error = new ApiError(
        serverErrorMessage(errorData) ||
          genericHttpErrorMessage(response.status),
        response.status,
        errorData,
        response.headers?.get?.("retry-after") ?? null,
      );
      throw balanceReadOrder === undefined
        ? error
        : recordQuotedBalanceRead(error, balanceReadOrder);
    }

    if (response.status === 204) {
      // 204 No Content: return null to indicate an empty response body.
      // Callers should be prepared to handle null for operations that return 204.
      return null as T;
    }

    const contentType = response.headers?.get?.("content-type") ?? "";
    if (contentType.toLowerCase().startsWith("text/")) {
      const text = await response.text();
      if (!expectsTextResponse(url)) {
        throw new ApiError(
          `Unexpected text response for JSON operation: ${url}`,
          response.status,
          text,
        );
      }
      return text as T;
    }
    return await response.json();
  } catch (caught) {
    // Our own bound firing becomes an ApiTimeoutError — a named, retryable
    // failure with a sentence — never a bare abort that a call site would
    // treat as "superseded, say nothing". A caller's own abort passes through.
    const error = browserTimeout ? browserTimeout.translate(caught) : caught;
    // AbortError is an expected control-flow signal when a query is unmounted
    // or superseded. Logging it as a request failure creates false alarms.
    //
    // So is a 4xx: the API answered, and the answer is the caller's to act on
    // (a tag with no pages, a validation error it toasts, a 404 page). On the
    // SSR server this `console.error` is stderr, which Cloud Logging grades
    // ERROR, one entry per line of the dumped object — a scanner-driven
    // 404 flood filed as errors. A 5xx, a timeout or a network
    // failure is still logged.
    const clientError =
      error instanceof ApiError && error.status >= 400 && error.status < 500;
    if (
      !(error instanceof Error && error.name === "AbortError") &&
      !clientError
    ) {
      console.error("API request failed:", error);
    }
    throw error;
  } finally {
    ssrRequestSignal?.cleanup();
    browserTimeout?.cleanup();
  }
};
