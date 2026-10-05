import type { CallRecord, Json } from "./types.js";
/**
 * Codes the Free2Z servers send (`docs/free2z/sdk/spec/errors.md`). Stable;
 * new ones may be added, so always keep a default branch.
 */
export type ServerErrorCode =
  // §2 authentication and authorization
  | "invalid_token"
  | "token_revoked"
  | "insufficient_user_authentication"
  | "insufficient_scope"
  | "app_disabled"
  | "account_frozen"
  | "account_in_debt"
  | "unavailable"
  // §3 requests, limits and balances
  | "invalid_request"
  | "context_length_exceeded"
  | "insufficient_balance"
  | "cap_exceeded"
  | "model_disabled"
  | "model_not_found"
  | "call_not_found"
  | "purchase_not_found"
  | "idempotency_conflict"
  | "too_many_holds"
  | "payload_too_large"
  | "rate_limited"
  | "concurrency_limit"
  // §4 providers and the stream
  | "provider_error"
  | "provider_timeout"
  | "catalog_unavailable"
  | "internal"
  | "delivery_aborted"
  // §5 identity provider (RFC 6749 `error`)
  | "access_denied"
  | "invalid_scope"
  | "login_required"
  | "consent_required"
  | "interaction_required"
  | "invalid_grant"
  | "invalid_client"
  | "unauthorized_client"
  | "unsupported_grant_type"
  | "unsupported_token_type"
  // §6 purchases
  | "invalid_quantity"
  | "rail_unavailable"
  | "intent_not_pending"
  | "receipt_already_used"
  | "receipt_invalid"
  | "store_unavailable";
/**
 * Codes this SDK (web `FetchTransport`) or the native plugin
 * (`NativeTransport`) produce locally. Some differ between the two
 * transports today — see the parity table in `docs/free2z/sdk/QUICKSTART.md`.
 */
export type LocalErrorCode =
  // both transports
  | "cancelled"
  | "signed_out"
  | "unconfirmed"
  | "stream_interrupted"
  | "timeout"
  | "concurrent_stream_read"
  | "unsafe_integer"
  | "unsupported_operation"
  | "unknown"
  // web (FetchTransport / browser sign-in)
  | "transport"
  | "invalid_response"
  | "response_too_large"
  | "response_too_complex"
  | "invalid_config"
  | "invalid_discovery"
  | "invalid_callback"
  | "invalid_idempotency_key"
  | "auth_timeout"
  | "popup_blocked"
  | "browser_unavailable"
  | "external_opener_required"
  | "checkout_unavailable"
  | "refresh_recovery_exhausted"
  | "temporarily_unavailable"
  | "unauthorized"
  | "http_error"
  // native (tauri-plugin-f2z)
  | "transport_error"
  | "protocol_error"
  | "configuration_error"
  | "storage_unavailable"
  | "browser_error"
  | "invalid_authentication_response"
  | "invalid_prompt"
  | "chat_failed"
  | "replayed"
  | "internal_error"
  | "unknown_error"
  | "native_error"
  | "native_sign_in_signal_unsupported";
/**
 * Every code an `SdkError` can carry. The `string & {}` arm keeps a code newer
 * than this SDK assignable while editors still autocomplete the known ones.
 */
export type SdkErrorCode = ServerErrorCode | LocalErrorCode | (string & {});
/**
 * What the app should do about a code, in one line, for developers and logs
 * (not end-user copy). Codes without an entry get a generic hint.
 */
const HINTS: { readonly [code: string]: string } = {
  insufficient_balance:
    "the user's 2Z balance cannot cover this request; offer a purchase (details.required_2z, details.available_milli_2z)",
  cap_exceeded:
    "this app's spend budget for the user is used up; link to https://free2z.cash/account/apps or wait for details.resets_at",
  account_in_debt:
    "a refund or chargeback left a debt; show debt_milli_2z from balance() and the buy surface; do not retry",
  account_frozen: "the account cannot spend; send the user to free2z.cash",
  context_length_exceeded:
    "the input plus max_output_tokens does not fit the model's context window; shorten the input or lower max_output_tokens",
  invalid_request:
    "the request was refused before any charge; details.field and details.reason say which field",
  model_not_found:
    "unknown model id; pick one from models(), never hard-code it",
  model_disabled: "the model is not callable now; pick another from models()",
  insufficient_scope:
    "the user did not grant the scope this needs (details.scope); sign in again requesting it",
  invalid_token: "the access token was refused; sign in again",
  token_revoked:
    "the grant or account changed; clear the session and sign in again",
  signed_out: "there is no session; sign in",
  insufficient_user_authentication:
    "fresh authentication is required; signIn({maxAge, acrValues}) from error.stepUp, then retry once",
  idempotency_conflict:
    "this Idempotency-Key was used with a different body, or its call is still running; reconcile with call(details.call_id)",
  rate_limited: "too many requests; wait retryAfterSeconds",
  concurrency_limit:
    "too many simultaneous streams for this user; wait retryAfterSeconds",
  unavailable:
    "temporarily unavailable; retry with backoff and do not sign the user out",
  catalog_unavailable: "pricing is temporarily unavailable; retry with backoff",
  provider_error:
    "the model provider failed; check the charge before offering a retry with a NEW idempotency key",
  provider_timeout:
    "the model provider timed out; check the charge before offering a retry with a NEW idempotency key",
  unconfirmed:
    "no answer arrived; the call may have run. Re-send the SAME request with the SAME idempotencyKey to find out",
  stream_interrupted:
    "the stream closed early; the call may still be billable. Read waitForCall(callId)",
  delivery_aborted:
    "delivery stopped but the call continues and will be charged; read waitForCall(callId)",
  cancelled:
    "delivery was cancelled; generation and charging may continue, so reconcile with waitForCall(callId)",
  replayed:
    "this idempotency key already finished; error.record is its receipt, nothing new was charged",
  transport: "network failure; nothing is known to have run",
  transport_error: "network failure; nothing is known to have run",
  invalid_quantity:
    "purchase quantity is outside the rail's range (details.min_2z, details.max_2z)",
};
/** Transport-independent one-line hint for `code`. */
export function errorHint(code: string): string {
  return HINTS[code] ?? "see docs/free2z/sdk/spec/errors.md";
}
export interface ErrorContext {
  status?: number;
  retryable?: boolean;
  retryAfterSeconds?: number;
  idempotencyKey?: string;
  callId?: string;
  record?: CallRecord;
  details?: Json;
  stepUp?: { maxAge?: string; acrValues?: string };
}
/** Safe structured error. Never includes token responses or raw transport messages. */
export class SdkError extends Error implements ErrorContext {
  /** Switch on this, never on `message`. */
  readonly code: SdkErrorCode;
  readonly status?: number;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
  readonly idempotencyKey?: string;
  readonly callId?: string;
  readonly record?: CallRecord;
  readonly details?: Json;
  readonly stepUp?: { maxAge?: string; acrValues?: string };
  constructor(code: string, context: ErrorContext = {}) {
    const safe = /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : "unknown";
    super(`Free2Z request failed (${safe}): ${errorHint(safe)}`);
    this.name = "SdkError";
    this.code = safe;
    this.retryable = context.retryable ?? false;
    Object.assign(this, context);
  }
}
export function failure(code: string): never {
  throw new SdkError(code);
}
export function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) failure("cancelled");
}
/** Cancel a wait without cancelling shared session rotation. */
export async function waitWithSignal<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  cancelled(signal);
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(new SdkError("cancelled"));
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}
export async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  cancelled(signal);
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new SdkError("cancelled"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
