import type { CallRecord, Json } from "./types.js";
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
  readonly code: string;
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
    super(`Free2Z request failed (${safe})`);
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
