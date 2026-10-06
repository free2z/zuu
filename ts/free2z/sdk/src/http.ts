import { SdkError, cancelled, failure } from "./error.js";
import { object, parseJson } from "./json.js";
import type { Json } from "./types.js";

export function secureUrl(value: string, loopback = false): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    failure("invalid_config");
  }
  const local = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(loopback && local && url.protocol === "http:"))
  )
    failure("invalid_config");
  return url;
}
export function key(value: string): string {
  if (!/^[\x21-\x7e]{1,128}$/.test(value)) failure("invalid_idempotency_key");
  return value;
}
export function identifier(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) failure("invalid_request");
  return value;
}
export async function readBytes(
  response: Response,
  maximum: number,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  let length = 0,
    emptyReads = 0;
  let buffer = new Uint8Array(Math.min(maximum, 4096));
  try {
    for (;;) {
      cancelled(signal);
      const item = await reader.read();
      cancelled(signal);
      if (item.done) break;
      if (item.value.byteLength === 0) {
        if (++emptyReads % 64 === 0)
          await new Promise((resolve) => setTimeout(resolve, 0));
        continue;
      }
      emptyReads = 0;
      const next = length + item.value.byteLength;
      if (next > maximum) failure("response_too_large");
      if (next > buffer.length) {
        const larger = new Uint8Array(
          Math.min(maximum, Math.max(next, buffer.length * 2)),
        );
        larger.set(buffer);
        buffer = larger;
      }
      buffer.set(item.value, length);
      length = next;
    }
    return buffer.slice(0, length);
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (error instanceof SdkError) throw error;
    throw new SdkError(signal?.aborted ? "cancelled" : "transport");
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}
export async function readJson(
  response: Response,
  signal?: AbortSignal,
  maximum = 8 * 1024 * 1024,
): Promise<Json> {
  try {
    return parseJson(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await readBytes(response, maximum, signal),
      ),
    );
  } catch (error) {
    if (error instanceof SdkError) throw error;
    throw new SdkError("invalid_response");
  }
}
export function retryAfter(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = /^\d+$/.test(header)
    ? Number(header)
    : Math.ceil((Date.parse(header) - Date.now()) / 1000);
  return Number.isFinite(seconds)
    ? Math.max(0, Math.min(seconds, 86_400))
    : undefined;
}
/** `errors.md` "Retry" column: the identical request may succeed later. */
const RETRYABLE_CODES = new Set([
  "rate_limited",
  "concurrency_limit",
  "too_many_holds",
  "provider_error",
  "provider_timeout",
  "catalog_unavailable",
  "unavailable",
  "internal",
]);
/** `details` members documented for refusals before any call ran
 * (`f2z_ai_proto::error::PRE_CALL_DETAILS`). Any other member — a settlement,
 * a charge, a partial output — means the call may have run, so it is never
 * retryable. */
const PRE_CALL_DETAILS = new Set([
  "reason",
  "max_age",
  "acr_values",
  "scope",
  "debt_milli_2z",
  "field",
  "input_tokens_estimate",
  "context_window",
  "available_milli_2z",
  "required_2z",
  "min_charge_2z",
  "cap_2z",
  "cap_period",
  "cap_remaining_milli_2z",
  "resets_at",
  "model",
  "limit_bytes",
  "limit",
  "phase",
  "min_2z",
  "max_2z",
  "packs",
  "rail",
  "status",
  "purchase_id",
  "max_output_tokens",
  "model_max_output_tokens",
  "effort_levels",
]);
/** The same rule as the Rust core's `ApiError::retryable`, for a refusal
 * that carries no settlement: a retryable code whose `details` show nothing
 * ran. Retrying a chat call still means a NEW idempotency key. */
export function retryableRefusal(code: string, details: unknown): boolean {
  if (!RETRYABLE_CODES.has(code)) return false;
  if (details === undefined || details === null) return true;
  if (typeof details !== "object" || Array.isArray(details)) return false;
  return Object.keys(details).every((k) => PRE_CALL_DETAILS.has(k));
}
export async function apiError(
  response: Response,
  signal?: AbortSignal,
): Promise<SdkError> {
  let data: ReturnType<typeof object> = {};
  try {
    data = object(object(await readJson(response, signal, 128 * 1024)).error);
  } catch {
    cancelled(signal);
  }
  const code =
    typeof data.code === "string"
      ? data.code
      : response.status === 401
        ? "unauthorized"
        : "http_error";
  const context: ConstructorParameters<typeof SdkError>[1] = {
    status: response.status,
    retryable: retryableRefusal(code, data.details),
  };
  const retry = retryAfter(response);
  if (retry !== undefined) context.retryAfterSeconds = retry;
  if (data.details !== undefined) context.details = data.details;
  if (
    code === "insufficient_user_authentication" ||
    code === "step_up_required"
  ) {
    const challenge = response.headers.get("www-authenticate") ?? "";
    const maxAge = /(?:^|[,\s])max_age="(\d+)"/.exec(challenge)?.[1];
    const acrValues = /(?:^|[,\s])acr_values="([^"\r\n]*)"/.exec(
      challenge,
    )?.[1];
    context.stepUp = {};
    if (maxAge !== undefined) context.stepUp.maxAge = maxAge;
    if (acrValues !== undefined) context.stepUp.acrValues = acrValues;
  }
  return new SdkError(code, context);
}
/** Deadline owns the response body too: callers close it only after consumption. */
export function deadline(
  timeoutMs: number,
  caller?: AbortSignal,
): { signal: AbortSignal; stopTimer(): void; close(): void } {
  cancelled(caller);
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  caller?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    stopTimer() {
      clearTimeout(timer);
    },
    close() {
      clearTimeout(timer);
      caller?.removeEventListener("abort", abort);
    },
  };
}
export function withOperation(
  error: unknown,
  idempotencyKey: string,
  callId?: string,
): SdkError {
  const cause = error instanceof SdkError ? error : new SdkError("transport");
  const ambiguous = [
    "transport",
    "invalid_response",
    "response_too_large",
    "response_too_complex",
  ].includes(cause.code);
  const context: ConstructorParameters<typeof SdkError>[1] = {
    idempotencyKey,
    retryable: false,
  };
  const recoveryCallId = callId ?? cause.callId;
  if (recoveryCallId !== undefined) context.callId = recoveryCallId;
  if (cause.status !== undefined) context.status = cause.status;
  if (cause.retryAfterSeconds !== undefined)
    context.retryAfterSeconds = cause.retryAfterSeconds;
  if (cause.details !== undefined) context.details = cause.details;
  if (cause.stepUp !== undefined) context.stepUp = cause.stepUp;
  if (cause.record !== undefined) context.record = cause.record;
  return new SdkError(ambiguous ? "unconfirmed" : cause.code, context);
}
