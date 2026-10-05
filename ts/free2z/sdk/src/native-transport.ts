import * as decode from "./decode.js";
import {
  SdkError,
  cancelled,
  failure,
  waitWithSignal,
  type ErrorContext,
} from "./error.js";
import { identifier, key, withOperation } from "./http.js";
import { spendCapParams } from "./spend-cap.js";
import {
  object,
  reasoningEffort,
  responseFormat,
  strictOutput,
  string,
  uint,
} from "./json.js";
import type {
  ChatOptions,
  ChatRequest,
  ChatStream,
  OperationOptions,
  PurchaseRequest,
  SignInOptions,
  Transport,
} from "./types.js";

type NativeJson =
  | null
  | boolean
  | number
  | string
  | NativeJson[]
  | { [key: string]: NativeJson };
export type NativeChatRequest = Omit<
  ChatRequest,
  "max_output_tokens" | "tools" | "response_format"
> & {
  max_output_tokens?: string;
  tools?: { name: string; description?: string; parameters: NativeJson }[];
  response_format?:
    | { type: "json_object" }
    | {
        type: "json_schema";
        json_schema: { name: string; schema: NativeJson; strict?: boolean };
      };
};
/** Structural subset of the plugin guest API; importing this SDK never loads Tauri. */
export interface NativeBridge {
  session(): Promise<unknown>;
  signIn(options?: {
    prompt?: "none" | "login" | "consent";
    maxAge?: string;
    acrValues?: string;
    /** Needs a plugin with spend-cap support; an older one refuses unknown keys. */
    spendCap?: string;
    spendPeriod?: string;
  }): Promise<unknown>;
  signOut(): Promise<{ revoked: boolean; generation: string }>;
  balance(): Promise<unknown>;
  grant?(): Promise<unknown>;
  models(): Promise<unknown>;
  estimate(request: NativeChatRequest): Promise<unknown>;
  createPurchase(request: {
    rail: "card" | "zcash";
    quantity2z: string;
    idempotencyKey: string;
  }): Promise<unknown>;
  purchase(id: string): Promise<unknown>;
  openCheckout(id: string): Promise<void>;
  startChat(
    request: NativeChatRequest,
    operation: { operationId: string; idempotencyKey: string },
  ): Promise<{ operationId: string; callId?: string; replay?: unknown }>;
  nextChat(operationId: string): Promise<unknown | null>;
  cancelChat(operationId: string): Promise<void>;
  call(callId: string): Promise<unknown>;
}
function parameters(value: unknown, depth = 0): NativeJson {
  if (depth > 64) failure("invalid_request");
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "bigint") {
    if (
      value > BigInt(Number.MAX_SAFE_INTEGER) ||
      value < BigInt(Number.MIN_SAFE_INTEGER)
    )
      failure("unsafe_integer");
    return Number(value);
  }
  if (typeof value === "number") {
    if (
      !Number.isFinite(value) ||
      (Number.isInteger(value) && !Number.isSafeInteger(value))
    )
      failure("unsafe_integer");
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => parameters(v, depth + 1));
  const result: { [key: string]: NativeJson } = Object.create(null) as {
    [key: string]: NativeJson;
  };
  for (const [k, v] of Object.entries(object(value)))
    if (v !== undefined) result[k] = parameters(v, depth + 1);
  return result;
}
function request(value: ChatRequest): NativeChatRequest {
  const {
    max_output_tokens,
    tools,
    response_format: format,
    ...rest
  } = reasoningEffort(responseFormat(strictOutput(value)));
  const result: NativeChatRequest = { ...rest };
  if (format?.type === "json_object") result.response_format = format;
  else if (format !== undefined)
    // The schema is ordinary JSON, like tool parameters: bigint becomes a
    // safe number, never a decimal string.
    result.response_format = {
      type: "json_schema",
      json_schema: {
        ...format.json_schema,
        schema: parameters(format.json_schema.schema),
      },
    };
  if (max_output_tokens !== undefined)
    result.max_output_tokens = uint(max_output_tokens).toString();
  if (tools !== undefined)
    result.tools = tools.map((tool) => ({
      ...tool,
      parameters: parameters(tool.parameters),
    }));
  return result;
}
function nativeError(error: unknown): SdkError {
  if (error instanceof SdkError) return error;
  if (!error || typeof error !== "object") return new SdkError("native_error");
  const data = error as Record<string, unknown>,
    context: ErrorContext = {};
  if (typeof data.retryable === "boolean") context.retryable = data.retryable;
  for (const k of ["status"] as const) {
    if (
      typeof data[k] === "number" &&
      Number.isSafeInteger(data[k]) &&
      data[k] >= 0
    )
      context[k] = data[k];
  }
  if (
    typeof data.retryAfterSeconds === "string" &&
    /^(0|[1-9][0-9]{0,19})$/.test(data.retryAfterSeconds)
  ) {
    const seconds = BigInt(data.retryAfterSeconds);
    context.retryAfterSeconds = Number(seconds > 86_400n ? 86_400n : seconds);
  }
  for (const k of ["callId", "idempotencyKey"] as const)
    if (typeof data[k] === "string") context[k] = data[k];
  if (data.stepUp && typeof data.stepUp === "object") {
    const step = data.stepUp as Record<string, unknown>;
    context.stepUp = {};
    if (typeof step.maxAge === "string") context.stepUp.maxAge = step.maxAge;
    if (typeof step.acrValues === "string")
      context.stepUp.acrValues = step.acrValues;
  }
  if (
    data.details &&
    typeof data.details === "object" &&
    !Array.isArray(data.details)
  ) {
    try {
      // Same shape as FetchTransport: documented integers become bigint.
      context.details = decode.nativeData(data.details);
    } catch {
      /* malformed optional details remain unknown */
    }
  }
  if (data.record !== undefined) {
    try {
      context.record = decode.callRecord(decode.nativeData(data.record));
    } catch {
      /* malformed optional receipt remains unknown */
    }
  }
  return new SdkError(
    typeof data.code === "string" ? data.code : "native_error",
    context,
  );
}
async function invoke<T>(
  action: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  cancelled(signal);
  try {
    return await waitWithSignal(action(), signal);
  } catch (error) {
    throw nativeError(error);
  }
}
export class NativeTransport implements Transport {
  #epoch = 0;
  #streams = new Set<() => void>();
  #invalidateStreams(): void {
    this.#epoch++;
    for (const stop of this.#streams) stop();
    this.#streams.clear();
  }
  constructor(private readonly bridge: NativeBridge) {}
  async session() {
    return decode.session(await invoke(() => this.bridge.session()));
  }
  async signIn(options: SignInOptions = {}) {
    // A browser AbortSignal cannot cancel a native system authentication session.
    if (options.signal !== undefined)
      failure("native_sign_in_signal_unsupported");
    const native: Parameters<NativeBridge["signIn"]>[0] = {};
    if (options.prompt !== undefined) native.prompt = options.prompt;
    if (options.acrValues !== undefined) native.acrValues = options.acrValues;
    if (options.maxAge !== undefined) {
      if (!Number.isSafeInteger(options.maxAge) || options.maxAge < 0)
        failure("invalid_request");
      native.maxAge = String(options.maxAge);
    }
    if (options.spendCap !== undefined) {
      const hint = spendCapParams(options.spendCap);
      native.spendCap = hint.f2z_spend_cap;
      if (hint.f2z_spend_period !== undefined)
        native.spendPeriod = hint.f2z_spend_period;
    }
    const session = decode.session(
      await invoke(() => this.bridge.signIn(native)),
    );
    this.#invalidateStreams();
    return session;
  }
  async signOut() {
    this.#invalidateStreams();
    return invoke(() => this.bridge.signOut());
  }
  async grant(signal?: AbortSignal) {
    cancelled(signal);
    if (!this.bridge.grant) failure("unsupported_operation");
    const before = await this.session(),
      epoch = this.#epoch;
    const result = decode.grant(
      decode.nativeData(await invoke(() => this.bridge.grant!(), signal)),
    );
    const after = await this.session();
    if (
      epoch !== this.#epoch ||
      before.generation !== after.generation ||
      !after.signedIn
    )
      failure("signed_out");
    if (result.sub !== after.subject) failure("invalid_response");
    cancelled(signal);
    return result;
  }
  async balance(signal?: AbortSignal) {
    return decode.balance(
      decode.nativeData(await invoke(() => this.bridge.balance(), signal)),
    );
  }
  async models(signal?: AbortSignal) {
    return decode.models(
      decode.nativeData(await invoke(() => this.bridge.models(), signal)),
    );
  }
  async estimate(value: ChatRequest, signal?: AbortSignal) {
    return decode.estimate(
      decode.nativeData(
        await invoke(() => this.bridge.estimate(request(value)), signal),
      ),
    );
  }
  async createPurchase(value: PurchaseRequest, options: OperationOptions) {
    key(options.idempotencyKey);
    try {
      const result = await invoke(
        () =>
          this.bridge.createPurchase({
            rail: value.rail,
            quantity2z: uint(value.quantity2z).toString(),
            idempotencyKey: options.idempotencyKey,
          }),
        options.signal,
      );
      return decode.purchase(decode.nativeData(result));
    } catch (error) {
      throw withOperation(error, options.idempotencyKey);
    }
  }
  async purchase(id: string, signal?: AbortSignal) {
    return decode.purchase(
      decode.nativeData(
        await invoke(() => this.bridge.purchase(identifier(id)), signal),
      ),
    );
  }
  async openCheckout(id: string) {
    await invoke(() => this.bridge.openCheckout(identifier(id)));
  }
  async call(id: string, signal?: AbortSignal) {
    return decode.callRecord(
      decode.nativeData(
        await invoke(() => this.bridge.call(identifier(id)), signal),
      ),
    );
  }
  async chat(value: ChatRequest, options: ChatOptions): Promise<ChatStream> {
    key(options.idempotencyKey);
    identifier(options.operationId);
    cancelled(options.signal);
    // Convert (and so validate) before any bridge call: a request refused
    // locally never reaches native, so there is no operation to cancel.
    const wire = request(value);
    const bridge = this.bridge,
      owner = this,
      epoch = this.#epoch;
    const current = () => {
      if (epoch !== owner.#epoch) failure("signed_out");
    };
    let stopped = false,
      reading = false,
      callId: string | undefined;
    const abort = () => {
      stopped = true;
      cleanup();
      void bridge.cancelChat(options.operationId).catch(() => {});
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    this.#streams.add(abort);
    const cleanup = () => {
      options.signal?.removeEventListener("abort", abort);
      owner.#streams.delete(abort);
    };
    try {
      const initial = decode.session(
        await invoke(() => bridge.session(), options.signal),
      );
      current();
      // Keep observing start after caller cancellation so the registered stream
      // is also closed if cancellation reached native before registration did.
      const pending = invoke(() =>
        bridge.startChat(wire, {
          operationId: options.operationId,
          idempotencyKey: options.idempotencyKey,
        }),
      );
      void pending
        .then(() => {
          if (stopped) return bridge.cancelChat(options.operationId);
        })
        .catch(() => {});
      const opened = await waitWithSignal(pending, options.signal);
      current();
      if (opened.operationId !== options.operationId)
        failure("invalid_response");
      callId = opened.callId;
      let replay =
        opened.replay === undefined
          ? undefined
          : decode.callRecord(decode.nativeData(opened.replay));
      const stream: ChatStream = {
        operationId: options.operationId,
        idempotencyKey: options.idempotencyKey,
        get callId() {
          return callId;
        },
        [Symbol.asyncIterator]() {
          return this;
        },
        async next() {
          if (reading) failure("concurrent_stream_read");
          if (options.signal?.aborted)
            throw withOperation(
              new SdkError("cancelled"),
              options.idempotencyKey,
              callId,
            );
          reading = true;
          try {
            current();
            if (stopped) return { done: true, value: undefined };
            if (replay !== undefined) {
              const latest = decode.session(
                await invoke(() => bridge.session(), options.signal),
              );
              current();
              if (latest.generation !== initial.generation)
                failure("signed_out");
              if (stopped) return { done: true, value: undefined };
              const record = replay;
              replay = undefined;
              stopped = true;
              cleanup();
              return { done: false, value: { type: "replay", record } };
            }
            for (;;) {
              const result = await invoke(
                () => bridge.nextChat(options.operationId),
                options.signal,
              );
              current();
              if (stopped) return { done: true, value: undefined };
              if (result === null) failure("stream_interrupted");
              const data = object(decode.nativeData(result));
              const event = decode.event(string(data.type), data);
              if (!event) continue;
              if (event.type === "meta") callId = event.call_id;
              if (event.type === "done" || event.type === "error") {
                stopped = true;
                cleanup();
              }
              return { done: false, value: event };
            }
          } catch (error) {
            abort();
            cleanup();
            throw withOperation(
              nativeError(error),
              options.idempotencyKey,
              callId,
            );
          } finally {
            reading = false;
          }
        },
        async cancel() {
          stopped = true;
          cleanup();
          await invoke(() => bridge.cancelChat(options.operationId));
        },
        async return() {
          await this.cancel();
          return { done: true, value: undefined };
        },
      };
      return stream;
    } catch (error) {
      abort();
      cleanup();
      throw withOperation(nativeError(error), options.idempotencyKey, callId);
    }
  }
}
