import * as decode from "./decode.js";
import { SdkError, cancelled, failure } from "./error.js";
import {
  apiError,
  deadline,
  identifier,
  key,
  readJson,
  secureUrl,
  withOperation,
} from "./http.js";
import {
  parseJson,
  responseFormat,
  strictOutput,
  toolOptions,
  stringifyJson,
  uint,
} from "./json.js";
import { WebSession, type FetchConfig } from "./oauth.js";
import { frames } from "./sse.js";
import type {
  Balance,
  CallRecord,
  ChatEvent,
  ChatOptions,
  ChatRequest,
  ChatStream,
  Estimate,
  Json,
  Models,
  OperationOptions,
  Purchase,
  PurchaseRequest,
  Session,
  SignInOptions,
  Transport,
} from "./types.js";

export class FetchTransport implements Transport {
  #auth: WebSession;
  #purchaseReturn: string;
  #api: string;
  #ai: string;
  #streams = new Set<AbortController>();
  #checkouts = new Map<string, { generation: string; url: string }>();
  #catalog:
    | {
        generation: string;
        etag: string | undefined;
        expires: number;
        value: Models;
      }
    | undefined;
  constructor(private readonly config: FetchConfig) {
    this.#auth = new WebSession(config);
    this.#purchaseReturn = secureUrl(
      config.purchaseReturnUri ?? config.redirectUri,
      config.allowInsecureLoopback,
    ).href;
    this.#api = secureUrl(
      config.apiBase ?? "https://free2z.cash/api/sdk/v1",
      config.allowInsecureLoopback,
    ).href.replace(/\/$/, "");
    this.#ai = secureUrl(
      config.aiBase ?? "https://ai.free2z.cash/v1",
      config.allowInsecureLoopback,
    ).href.replace(/\/$/, "");
    if (new URL(this.#api).search || new URL(this.#ai).search)
      failure("invalid_config");
    const idle = config.streamIdleTimeoutMs ?? 45_000;
    if (!Number.isSafeInteger(idle) || idle <= 0 || idle > 3_600_000)
      failure("invalid_config");
  }
  async session(): Promise<Session> {
    return this.#auth.snapshot();
  }
  async signIn(options?: SignInOptions): Promise<Session> {
    const session = await this.#auth.signIn(options);
    for (const stream of this.#streams) stream.abort();
    this.#checkouts.clear();
    return session;
  }
  async signOut(): Promise<{ revoked: boolean; generation: string }> {
    for (const stream of this.#streams) stream.abort();
    this.#checkouts.clear();
    return this.#auth.signOut();
  }
  async #send(
    url: string,
    scope: string,
    init: RequestInit,
    generation: string,
    signal: AbortSignal,
  ): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.#auth.token(
        scope,
        generation,
        signal,
        attempt > 0,
      );
      cancelled(signal);
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${token}`);
      let response: Response;
      try {
        response = await this.#auth.request(url, {
          ...init,
          headers,
          signal,
          redirect: "error",
          credentials: "omit",
          referrerPolicy: "no-referrer",
        });
      } catch {
        throw new SdkError(signal.aborted ? "cancelled" : "transport");
      }
      if (generation !== this.#auth.generation) {
        void response.body?.cancel();
        failure("signed_out");
      }
      if (response.status !== 401) return response;
      const error = await apiError(response, signal);
      if (error.code === "token_expired" && attempt === 0) continue;
      if (
        ["token_revoked", "invalid_token", "unauthorized"].includes(error.code)
      )
        this.#auth.invalidate(generation);
      throw error;
    }
    failure("signed_out");
  }
  async #json(
    url: string,
    scope: string,
    signal?: AbortSignal,
    body?: unknown,
    operationKey?: string,
  ): Promise<Json> {
    const generation = this.#auth.generation,
      bound = deadline(this.#auth.timeout, signal);
    try {
      const headers: Record<string, string> = { accept: "application/json" };
      const init: RequestInit = {
        method: body === undefined ? "GET" : "POST",
        headers,
      };
      if (body !== undefined) {
        headers["content-type"] = "application/json";
        init.body = stringifyJson(body);
      }
      if (operationKey !== undefined)
        headers["idempotency-key"] = key(operationKey);
      const response = await this.#send(
        url,
        scope,
        init,
        generation,
        bound.signal,
      );
      if (!response.ok) throw await apiError(response, bound.signal);
      const result = await readJson(response, bound.signal);
      if (generation !== this.#auth.generation) failure("signed_out");
      return result;
    } catch (error) {
      const cause =
        bound.signal.aborted && !signal?.aborted
          ? new SdkError("transport")
          : error;
      if (operationKey !== undefined) throw withOperation(cause, operationKey);
      throw cause instanceof SdkError ? cause : new SdkError("transport");
    } finally {
      bound.close();
    }
  }
  async grant(signal?: AbortSignal) {
    const generation = this.#auth.generation;
    const result = decode.grant(
      await this.#json(`${this.#api}/grant`, "ai:invoke", signal),
    );
    const session = this.#auth.snapshot();
    if (generation !== this.#auth.generation) failure("signed_out");
    if (
      result.client_id !== this.#auth.config.clientId ||
      result.sub !== session.subject
    )
      failure("invalid_response");
    return result;
  }
  async balance(signal?: AbortSignal): Promise<Balance> {
    return decode.balance(
      await this.#json(`${this.#api}/balance`, "balance:read", signal),
    );
  }
  async models(signal?: AbortSignal): Promise<Models> {
    cancelled(signal);
    const generation = this.#auth.generation;
    const cached =
      this.#catalog?.generation === generation ? this.#catalog : undefined;
    if (cached && cached.expires > performance.now())
      return structuredClone(cached.value);
    const bound = deadline(this.#auth.timeout, signal);
    try {
      const headers = new Headers({ accept: "application/json" });
      if (cached?.etag) headers.set("if-none-match", cached.etag);
      const response = await this.#send(
        `${this.#ai}/models`,
        "ai:invoke",
        { headers },
        generation,
        bound.signal,
      );
      let value: Models;
      if (response.status === 304 && cached) value = cached.value;
      else {
        if (!response.ok) throw await apiError(response, bound.signal);
        value = decode.models(await readJson(response, bound.signal));
      }
      if (generation !== this.#auth.generation) failure("signed_out");
      const policy = response.headers.get("cache-control") ?? "";
      const maxAge = /(?:^|,)\s*max-age=(\d+)/i.exec(policy)?.[1];
      const seconds = /(?:no-store|no-cache)/i.test(policy)
        ? 0
        : Math.min(Number(maxAge ?? 0), 3600);
      this.#catalog = {
        generation,
        etag: response.headers.get("etag") ?? cached?.etag,
        expires: performance.now() + seconds * 1000,
        value,
      };
      return structuredClone(value);
    } finally {
      bound.close();
    }
  }
  async estimate(
    request: ChatRequest,
    signal?: AbortSignal,
  ): Promise<Estimate> {
    if (request.max_output_tokens !== undefined)
      uint(request.max_output_tokens);
    request = toolOptions(responseFormat(strictOutput(request)));
    return decode.estimate(
      await this.#json(
        `${this.#ai}/chat/estimate`,
        "ai:invoke",
        signal,
        request,
      ),
    );
  }
  #remember(intent: Purchase, generation: string): Purchase {
    if (generation !== this.#auth.generation) failure("signed_out");
    if (typeof intent.rail_data.checkout_url === "string") {
      const url = secureUrl(intent.rail_data.checkout_url).href;
      if (this.#checkouts.size >= 128)
        this.#checkouts.delete(this.#checkouts.keys().next().value!);
      this.#checkouts.set(intent.id, { generation, url });
    }
    return intent;
  }
  async createPurchase(
    request: PurchaseRequest,
    options: OperationOptions,
  ): Promise<Purchase> {
    const generation = this.#auth.generation;
    key(options.idempotencyKey);
    uint(request.quantity2z);
    if (request.rail !== "card" && request.rail !== "zcash")
      failure("invalid_request");
    const body: Record<string, unknown> = {
      rail: request.rail,
      quantity_2z: request.quantity2z,
      platform: "web",
    };
    if (request.rail === "card") body.return_url = this.#purchaseReturn;
    try {
      return this.#remember(
        decode.purchase(
          await this.#json(
            `${this.#api}/purchases`,
            "purchase:create",
            options.signal,
            body,
            options.idempotencyKey,
          ),
        ),
        generation,
      );
    } catch (error) {
      throw withOperation(error, options.idempotencyKey);
    }
  }
  async purchase(id: string, signal?: AbortSignal): Promise<Purchase> {
    const generation = this.#auth.generation;
    return this.#remember(
      decode.purchase(
        await this.#json(
          `${this.#api}/purchases/${identifier(id)}`,
          "purchase:create",
          signal,
        ),
      ),
      generation,
    );
  }
  async openCheckout(id: string): Promise<void> {
    if (!this.config.openExternal) failure("external_opener_required");
    if (!this.#checkouts.has(id)) await this.purchase(id);
    const checkout = this.#checkouts.get(id);
    if (!checkout) failure("checkout_unavailable");
    if (checkout.generation !== this.#auth.generation) failure("signed_out");
    await this.config.openExternal(checkout.url);
  }
  async call(id: string, signal?: AbortSignal): Promise<CallRecord> {
    return decode.callRecord(
      await this.#json(
        `${this.#ai}/calls/${identifier(id)}`,
        "ai:invoke",
        signal,
      ),
    );
  }
  async chat(request: ChatRequest, options: ChatOptions): Promise<ChatStream> {
    key(options.idempotencyKey);
    identifier(options.operationId);
    cancelled(options.signal);
    if (request.max_output_tokens !== undefined)
      uint(request.max_output_tokens);
    request = toolOptions(responseFormat(strictOutput(request)));
    const generation = this.#auth.generation,
      control = new AbortController();
    if (
      options.sessionGeneration !== undefined &&
      options.sessionGeneration !== generation
    )
      failure("signed_out");
    const abort = () => control.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    this.#streams.add(control);
    const bound = deadline(this.#auth.timeout, control.signal);
    const cleanup = () => {
      bound.close();
      this.#streams.delete(control);
      options.signal?.removeEventListener("abort", abort);
    };
    let callId: string | undefined;
    let responseBody: ReadableStream<Uint8Array> | null = null;
    const stop = () => {
      control.abort();
      if (responseBody && !responseBody.locked)
        void responseBody.cancel().catch(() => {});
      cleanup();
    };
    try {
      const response = await this.#send(
        `${this.#ai}/chat`,
        "ai:invoke",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "text/event-stream, application/json",
            "idempotency-key": options.idempotencyKey,
          },
          body: stringifyJson({ ...request, stream: true }),
        },
        generation,
        bound.signal,
      );
      responseBody = response.body;
      callId = response.headers.get("x-f2z-call-id") ?? undefined;
      if (callId !== undefined && !/^[a-zA-Z0-9_-]{1,128}$/.test(callId))
        failure("invalid_response");
      if (!response.ok) throw await apiError(response, bound.signal);
      const contentType = response.headers
        .get("content-type")
        ?.split(";")[0]
        ?.trim()
        .toLowerCase();
      let iterator: AsyncGenerator<ChatEvent>;
      if (contentType === "application/json") {
        const record = decode.callRecord(
          await readJson(response, bound.signal),
        );
        cancelled(control.signal);
        if (generation !== this.#auth.generation) failure("signed_out");
        callId = record.call_id;
        iterator = (async function* () {
          yield { type: "replay", record } as const;
        })();
      } else {
        if (contentType !== "text/event-stream") failure("invalid_response");
        const auth = this.#auth;
        const raw = frames(
          response,
          control.signal,
          this.config.streamIdleTimeoutMs ?? 45_000,
        );
        iterator = (async function* () {
          let meta = false,
            usage = false;
          try {
            for await (const frame of raw) {
              if (generation !== auth.generation) failure("signed_out");
              if (
                ![
                  "meta",
                  "delta",
                  "tool_call_delta",
                  "tool_call",
                  "usage",
                  "done",
                  "error",
                ].includes(frame.event)
              )
                continue;
              const event = decode.event(frame.event, parseJson(frame.data));
              if (!event) continue;
              if (event.type === "meta") {
                if (meta || (callId !== undefined && callId !== event.call_id))
                  failure("invalid_response");
                meta = true;
                callId = event.call_id;
              } else if (!meta && event.type !== "error")
                failure("invalid_response");
              if (event.type === "usage") {
                if (usage) failure("invalid_response");
                usage = true;
              }
              if (
                usage &&
                (event.type === "delta" ||
                  event.type === "tool_call_delta" ||
                  event.type === "tool_call")
              )
                failure("invalid_response");
              yield event;
              if (event.type === "done" || event.type === "error") return;
            }
            failure("stream_interrupted");
          } finally {
            await raw.return(undefined);
          }
        })();
      }
      bound.stopTimer();
      let reading = false,
        finished = false;
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
          if (finished) return { done: true, value: undefined };
          reading = true;
          try {
            cancelled(control.signal);
            const item = await iterator.next();
            if (
              item.done ||
              ["done", "error", "replay"].includes(item.value.type)
            ) {
              finished = true;
              await iterator.return(undefined);
              stop();
            }
            return item;
          } catch (error) {
            finished = true;
            stop();
            throw withOperation(error, options.idempotencyKey, callId);
          } finally {
            reading = false;
          }
        },
        async cancel() {
          finished = true;
          stop();
          await iterator.return(undefined);
        },
        async return() {
          await this.cancel();
          return { done: true, value: undefined };
        },
      };
      return stream;
    } catch (error) {
      const cause =
        bound.signal.aborted && !control.signal.aborted
          ? new SdkError("transport")
          : error;
      stop();
      throw withOperation(cause, options.idempotencyKey, callId);
    }
  }
}
