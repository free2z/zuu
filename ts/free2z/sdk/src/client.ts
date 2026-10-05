import { SdkError, delay, failure } from "./error.js";
import type {
  CallRecord,
  ChatOptions,
  ChatRequest,
  OperationOptions,
  PollOptions,
  Preflight,
  Purchase,
  PurchaseRequest,
  SignInOptions,
  Transport,
} from "./types.js";

/** Transport-neutral application facade. No implicit operation or payment keys. */
export class Client {
  constructor(readonly transport: Transport) {}
  session() {
    return this.transport.session();
  }
  signIn(options?: SignInOptions) {
    return this.transport.signIn(options);
  }
  signOut() {
    return this.transport.signOut();
  }
  grant(signal?: AbortSignal) {
    return this.transport.grant(signal);
  }
  balance(signal?: AbortSignal) {
    return this.transport.balance(signal);
  }
  models(signal?: AbortSignal) {
    return this.transport.models(signal);
  }
  estimate(request: ChatRequest, signal?: AbortSignal) {
    return this.transport.estimate(request, signal);
  }
  /**
   * Estimate-then-strict-chat, the safe way: asks whether `request` would run
   * **now** with its full `max_output_tokens`, without a hold or a charge, and
   * turns the gateway's refusal into the recovery UX to show
   * (`needs_top_up`, `needs_budget`, `too_large`). Any other failure throws.
   *
   * `request.max_output_tokens_strict` must be `true` (and
   * `max_output_tokens` set): a non-strict estimate is priced differently and
   * can disagree with a strict call, so this refuses one with
   * `invalid_request` (`details.field: "max_output_tokens_strict"`). Send the
   * call with the same request: the estimate is for the UI, the flag is the
   * guarantee.
   */
  async preflight(
    request: ChatRequest,
    signal?: AbortSignal,
  ): Promise<Preflight> {
    if (
      request.max_output_tokens_strict !== true ||
      request.max_output_tokens === undefined
    )
      throw new SdkError("invalid_request", {
        details: {
          field:
            request.max_output_tokens === undefined
              ? "max_output_tokens"
              : "max_output_tokens_strict",
          reason: "required",
        },
      });
    try {
      return { kind: "ready", estimate: await this.estimate(request, signal) };
    } catch (error) {
      if (!(error instanceof SdkError)) throw error;
      const details = (
        error.details && typeof error.details === "object" ? error.details : {}
      ) as { [key: string]: unknown };
      // Present members only: an older server or native plugin may omit them.
      const big = (key: string, name: string) =>
        typeof details[key] === "bigint" ? { [name]: details[key] } : {};
      switch (error.code) {
        case "insufficient_balance":
          return {
            kind: "needs_top_up",
            error,
            ...big("required_2z", "required2z"),
            ...big("available_milli_2z", "availableMilli2z"),
          };
        case "cap_exceeded": {
          const resets = details.resets_at;
          return {
            kind: "needs_budget",
            error,
            ...big("required_2z", "required2z"),
            ...big("cap_remaining_milli_2z", "capRemainingMilli2z"),
            ...(typeof resets === "string" || resets === null
              ? { resetsAt: resets }
              : {}),
          };
        }
        case "context_length_exceeded":
          return { kind: "too_large", error };
        case "invalid_request":
          // Only the strict ceiling refusal: `field: max_output_tokens` is
          // also `out_of_range` (0), a malformed request, not a large one.
          if (
            details.field === "max_output_tokens" &&
            details.reason === "max_output_tokens_strict"
          )
            return { kind: "too_large", error };
          throw error;
        default:
          throw error;
      }
    }
  }
  createPurchase(request: PurchaseRequest, options: OperationOptions) {
    return this.transport.createPurchase(request, options);
  }
  purchase(id: string, signal?: AbortSignal) {
    return this.transport.purchase(id, signal);
  }
  openCheckout(id: string) {
    return this.transport.openCheckout(id);
  }
  chat(request: ChatRequest, options: ChatOptions) {
    return this.transport.chat(request, options);
  }
  call(id: string, signal?: AbortSignal) {
    return this.transport.call(id, signal);
  }
  /** Returns the last observed intent at the deadline, including pending/paid. */
  waitForPurchase(id: string, options?: PollOptions): Promise<Purchase> {
    return this.#poll(
      (signal) => this.purchase(id, signal),
      (intent) => !["created", "pending", "paid"].includes(intent.status),
      options,
    );
  }
  /** Only charge.state identifies a final amount. A deadline may return pending. */
  waitForCall(id: string, options?: PollOptions): Promise<CallRecord> {
    return this.#poll(
      (signal) => this.call(id, signal),
      (record) => record.charge.state !== "pending",
      options,
    );
  }
  async #poll<T>(
    read: (signal?: AbortSignal) => Promise<T>,
    terminal: (value: T) => boolean,
    options: PollOptions = {},
  ): Promise<T> {
    const timeout = options.timeoutMs ?? 120_000;
    if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 86_400_000)
      failure("invalid_request");
    const end = performance.now() + timeout;
    let last: T | undefined,
      attempt = 0;
    for (;;) {
      let hint = 0;
      try {
        last = await read(options.signal);
        if (terminal(last)) return last;
      } catch (error) {
        if (
          !(error instanceof SdkError) ||
          last === undefined ||
          !["transport", "rate_limited", "unavailable"].includes(error.code)
        )
          throw error;
        hint = (error.retryAfterSeconds ?? 0) * 1000;
      }
      const pause = Math.max(
        hint,
        Math.min(2000 * 2 ** Math.min(attempt++, 3), 15000),
      );
      if (performance.now() + pause > end) {
        if (last === undefined) failure("timeout");
        return last;
      }
      await delay(pause, options.signal);
    }
  }
}
