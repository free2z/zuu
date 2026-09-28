import { SdkError, delay, failure } from "./error.js";
import type {
  CallRecord,
  ChatOptions,
  ChatRequest,
  OperationOptions,
  PollOptions,
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
