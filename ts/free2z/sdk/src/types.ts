/** JSON without loss of integer precision. Integers are bigint in SDK results. */
export type Json =
  | null
  | boolean
  | string
  | number
  | bigint
  | Json[]
  | { [key: string]: Json | undefined };
export type ObjectData = { [key: string]: Json | undefined };
/**
 * Coarse, non-sensitive reason for `Grant.enforced`.
 * Diagnostic only; `enforced` stays authoritative. A code newer than this SDK
 * decodes as `"unknown"` and is never enforced.
 */
export type EnforcementReason =
  | "ok"
  | "platform_disabled"
  | "ledger_cutover_pending"
  | "ledger_cap_pending"
  | "unknown";
/** Fresh authoritative grant snapshot; generation is not a cap policy version. */
export interface Grant {
  sub: string;
  client_id: string;
  account_epoch: bigint;
  grant_generation: bigint;
  scopes: string[];
  spend_cap_2z: bigint | null;
  cap_period: "day" | "week" | "month" | "total";
  enforced: boolean;
  /** Why `enforced` has its value; absent from servers predating it. */
  enforcement_reason?: EnforcementReason;
  as_of: string;
}
export interface Balance {
  available_milli_2z: bigint;
  held_milli_2z: bigint;
  balance_milli_2z: bigint;
  debt_milli_2z: bigint;
  as_of: string;
}
export interface Session {
  signedIn: boolean;
  subject: string | null;
  grantedScopes: string[];
  persistence: "persistent" | "memory_only";
  generation: string;
}
export type CapPeriod = "day" | "week" | "month" | "total";
/**
 * A spend cap the app SUGGESTS for `ai:invoke` (`f2z_spend_cap` /
 * `f2z_spend_period`). The consent screen may pre-select
 * it after clamping it to the app registration's default and to the user's
 * existing grant (and never changes a capped grant's period). Nothing is
 * granted unless the user confirms it; read the result from `grant()`.
 */
export interface SpendCapHint {
  /** Whole 2Z, 1..2147483647. */
  cap2z: bigint;
  /** Absent: the period the screen would have pre-selected. */
  period?: CapPeriod;
}
export interface SignInOptions {
  prompt?: "login" | "consent" | "none";
  maxAge?: number;
  acrValues?: string;
  /** Optional, additive: see {@link SpendCapHint}. */
  spendCap?: SpendCapHint;
  signal?: AbortSignal;
}
/**
 * `SdkError.code` when a `NativeTransport` sign-in ends at the browser
 * step without signing in:
 * - `user_cancelled`: the user dismissed the iOS sign-in sheet or the Android
 *   Custom Tab. A choice, not a failure: offer sign-in again quietly.
 * - `browser_unavailable`: no browser or authentication session could be shown.
 * - `timeout`: no callback before the deadline. Desktop cannot see a closed
 *   browser tab, so a desktop cancel arrives as this.
 * - `browser_error`: any other browser or session failure, and every one from
 *   a native plugin older than these codes. Always handle it.
 *
 * Sign-in also rejects with other codes (`access_denied`, …); keep a default
 * branch. The web `PopupAuthSession` reports its own codes (`cancelled`,
 * `popup_blocked`, `auth_timeout`, `browser_unavailable`).
 */
export type NativeSignInErrorCode =
  "user_cancelled" | "browser_unavailable" | "timeout" | "browser_error";
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; media_type: string; data: string };
export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content?: ContentPart[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
/**
 * Structured output. `json_schema` constrains the reply to JSON matching
 * `schema` (prefer it); `json_object` to any JSON object (OpenAI also requires
 * the word "JSON" in the messages). The reply arrives as ordinary text: parse
 * it yourself, and treat `finish_reason: "length"` as truncated JSON.
 */
export type ResponseFormat =
  | { type: "json_object" }
  | {
      type: "json_schema";
      json_schema: {
        /** 1–64 characters of `A-Z a-z 0-9 _ -`. */
        name: string;
        /** A JSON Schema object, at most 32 KiB serialized. */
        schema: Json;
        /** Ask the provider to enforce the schema exactly. Absent: its default. */
        strict?: boolean;
      };
    };
/**
 * OpenAI's `tool_choice`: which of `tools` the model may or must call.
 * Requires `tools`; a named function must be one of them.
 */
export type ToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };
/**
 * OpenAI's `reasoning_effort` values, exactly. `"minimal"` is GPT-5-family
 * only; check `Model.controls.effort_levels` where a model lists them.
 */
export type ReasoningEffort = "minimal" | "low" | "medium" | "high";
export interface ChatRequest {
  model: string;
  messages: Message[];
  tools?: { name: string; description?: string; parameters: Json }[];
  /**
   * Opt-in; absent is never sent (the provider's default, `auto`). A model
   * whose adapter cannot express it refuses the call before any hold or
   * charge (`invalid_request`, `reason: "tools_unsupported"`).
   */
  tool_choice?: ToolChoice;
  /**
   * Opt-in; `false` asks for at most one tool call per turn. Absent is never
   * sent. Refused up front where unsupported
   * (`reason: "tools_unsupported"`).
   */
  parallel_tool_calls?: boolean;
  max_output_tokens?: bigint;
  /**
   * `true`: `max_output_tokens` is required, not a ceiling. The gateway
   * refuses (`insufficient_balance`, `cap_exceeded`,
   * `context_length_exceeded`, `invalid_request`) before any hold or charge
   * instead of lowering it and charging for a truncated answer. Requires
   * `max_output_tokens`. `false`/absent is the default and is never sent.
   */
  max_output_tokens_strict?: boolean;
  metadata?: Record<string, string>;
  fallback?: string[];
  /**
   * Opt-in structured output; absent is never sent. Check
   * `Model.capabilities.structured_output === true` first: a model without it
   * refuses the call before any hold or charge (`invalid_request`, `reason: "response_format_unsupported"`);
   * it is never silently answered in prose.
   */
  response_format?: ResponseFormat;
  /**
   * Opt-in: how hard a reasoning model thinks; absent is never sent (the
   * provider's default). Check `Model.capabilities.reasoning_effort === true`
   * (and `Model.controls.effort_levels`, when listed) first: any other model
   * refuses the call before any hold or charge (`invalid_request`,
   * `reason: "reasoning_effort_unsupported"`); it is never sent without it.
   * Reasoning is billed as output and, on OpenAI, counts inside
   * `max_output_tokens`: leave room for it.
   */
  reasoning_effort?: ReasoningEffort;
}
export interface OperationOptions {
  /** Create and persist this before calling; reuse only to reconcile this operation. */
  idempotencyKey: string;
  signal?: AbortSignal;
}
export interface ChatOptions extends OperationOptions {
  /** A caller-owned UUID identifying the native stream operation. */
  operationId: string;
}
export type PurchaseRail = "card" | "zcash";
export interface PurchaseRequest {
  rail: PurchaseRail;
  quantity2z: bigint;
}
export type PurchaseStatus =
  | "created"
  | "pending"
  | "paid"
  | "credited"
  | "expired"
  | "failed"
  | "refunded"
  | "partially_refunded"
  | "disputed"
  | "clawed_back";
export interface Purchase extends ObjectData {
  id: string;
  /** `card` or `zcash` for third-party apps; a newer rail keeps its string. */
  rail: PurchaseRail | "apple_iap" | "google_iap" | (string & {});
  /** Only `credited` means 2Z reached the account. A newer status keeps its
   * string: treat it like `pending` (keep polling), never as credited. */
  status: PurchaseStatus | (string & {});
  quantity_2z: bigint;
  price: { currency: string; amount_minor: bigint };
  credited_milli_2z: bigint | null;
  credited_at: string | null;
  /** The price table the quote came from, when the server sends it. */
  pricing_version?: string;
  created_at: string;
  expires_at: string;
  rail_data: ObjectData;
}
export type Charge =
  | { state: "pending" }
  | { state: "released"; charged2z: 0n }
  | {
      state: "charged";
      charged2z: bigint;
      receiptId: string;
      collectedMilli2z?: bigint;
      shortfallMilli2z?: bigint;
    };
/** `GET /v1/calls/{id}` `status`; a newer one keeps its string (not final). */
export type CallStatus =
  "streaming" | "settling" | "settled" | "released" | "settled_partial";
/** Why generation stopped. `length` means truncated (and charged). */
export type FinishReason =
  "stop" | "length" | "tool_calls" | "content_filter" | "cancelled";
/** Token and unit counts the charge was computed from. */
export interface Usage extends ObjectData {
  input_tokens?: bigint;
  cached_input_tokens?: bigint;
  cache_write_tokens?: bigint;
  output_tokens?: bigint;
  reasoning_tokens?: bigint;
  images?: bigint;
  tool_calls?: bigint;
}
/**
 * A call's receipt (`chat-api.md` §7). Read `charge` for what was taken; the
 * raw fields are for display and reconciliation. No prompt or completion
 * text is ever in a record. An unreported member may be absent OR `null`
 * (the native plugin sends every one, `null` when unknown).
 */
export interface CallRecord extends ObjectData {
  call_id: string;
  status: CallStatus | (string & {});
  /** The only field that says whether the amount is final. */
  charge: Charge;
  model?: string | null;
  requested_model?: string | null;
  provider?: string | null;
  finish_reason?: FinishReason | (string & {}) | null;
  usage?: Usage | null;
  usage_source?: string | null;
  hold_2z?: bigint | null;
  charged_2z?: bigint | null;
  receipt_id?: string | null;
  collected_milli_2z?: bigint | null;
  released_2z?: bigint | null;
  shortfall_milli_2z?: bigint | null;
  catalog_version?: bigint | null;
  markup_bps?: bigint | null;
  metadata?: { [key: string]: string } | null;
  /** `null`, or the failure that ended the call. */
  /** `message` is for logs and absent on native (the plugin drops it). */
  error?: { code: string; message?: string } | null;
  /** `true` when an idempotent replay returned this record. */
  replayed?: boolean;
  created_at?: string | null;
  settled_at?: string | null;
}
/**
 * What the gateway will accept for a model (`docs/free2z/sdk/spec/chat-api.md`
 * §5). A member that is absent was not declared, and is never `true`: read it
 * as unsupported. Compare with `=== true`.
 */
export interface ModelCapabilities {
  /** Accepts image parts; otherwise they are refused (`invalid_request`). */
  vision?: boolean;
  /**
   * Accepts `tools` and tool-result history; otherwise the gateway refuses
   * them (`invalid_request`) before any hold or charge.
   */
  tools?: boolean;
  /** Reasons before answering (billed as output). */
  reasoning?: boolean;
  /**
   * `true` is the precondition for `ChatRequest.response_format`: otherwise
   * the gateway refuses the call (`invalid_request`,
   * `reason: "response_format_unsupported"`) before any hold or charge.
   * Absent (an older gateway): unsupported.
   */
  structured_output?: boolean;
  /**
   * `true` is the precondition for `ChatRequest.reasoning_effort` (at a level
   * in `Model.controls.effort_levels`, when listed): otherwise the gateway
   * refuses the call (`invalid_request`,
   * `reason: "reasoning_effort_unsupported"`) before any hold or charge. Not
   * implied by `reasoning`. Absent (an older gateway): unsupported.
   */
  reasoning_effort?: boolean;
  /** Capabilities newer than this SDK pass through undeclared. */
  [key: string]: Json | undefined;
}
/** A model's signed `controls`. Members newer than this SDK pass through. */
export interface ModelControls {
  /** The `reasoning_effort` levels the model takes, as wire strings. */
  effort_levels?: string[];
  [key: string]: Json | undefined;
}
/**
 * Published rates, already including the platform margin and the calling
 * app's markup. A documented member that is absent was not published.
 */
export interface ModelPrices {
  /** Milli-2Z per million tokens; `0` means no such price. */
  input_milli_2z_per_mtok?: bigint;
  cached_input_milli_2z_per_mtok?: bigint;
  cache_write_milli_2z_per_mtok?: bigint;
  output_milli_2z_per_mtok?: bigint;
  /** Milli-2Z per unit where the provider bills per unit; `0` otherwise. */
  image_milli_2z?: bigint;
  tool_call_milli_2z?: bigint;
  /**
   * Rates newer than this SDK pass through; one named `*_milli_2z_per_mtok`
   * or `*_2z` is a `bigint` like the members above.
   */
  [key: string]: Json | undefined;
}
/**
 * One model of `GET /v1/models`. Optional members absent (or `null`) were not
 * reported. Unknown members pass through.
 */
export interface Model extends ObjectData {
  /** What `ChatRequest.model` names; never empty. */
  id: string;
  /** `openai`, `anthropic`, `xai`, … */
  provider?: string;
  /** For a picker. */
  display_name?: string;
  /** Input plus output, tokens. */
  context_window?: bigint;
  /** The most a call can generate, tokens. */
  max_output_tokens?: bigint;
  /** Always present: `{}` when the gateway sent none (nothing supported). */
  capabilities: ModelCapabilities;
  /**
   * Signed narrowing of what a capability admits. `effort_levels`: the
   * `reasoning_effort` levels the model takes; absent means not narrowed.
   * Always present: `{}` when the gateway sent none.
   */
  controls: ModelControls;
  /** Always present: `{}` when the gateway sent none. */
  prices: ModelPrices;
  /** The floor for one call, whole 2Z. */
  min_charge_2z?: bigint;
  /** How long the gateway waits for the provider's first byte. */
  ttfb_timeout_ms?: bigint;
}
export interface Models extends ObjectData {
  models: Model[];
  /** The signed catalogue's version; only increases. */
  catalog_version: bigint;
  /** The markup, in basis points, already inside every price. */
  includes_markup_bps?: bigint;
}
/**
 * A `POST /v1/chat/estimate` answer. The budget fields are a read-only
 * snapshot taken for the clamp, not a reservation and not an authorization to
 * spend: the gateway re-checks balance and cap on the paid call itself.
 *
 * Every gateway that has shipped the endpoint sends all four budget fields,
 * but the protocol (`docs/free2z/sdk/spec/chat-api.md` §6) makes them optional
 * on decode, so they are optional here. Absent means "not reported" — in
 * particular an absent `cap_remaining_milli_2z` is NOT "uncapped".
 *
 * Not a quote and not a maximum charge. A refusal arrives as the same
 * `SdkError` the call would get — see `Client.preflight`.
 */
export interface Estimate extends ObjectData {
  model: string;
  input_tokens: bigint;
  /** The limit the call would run with, after any clamping. */
  max_output_tokens: bigint;
  /** Whole 2Z the call would reserve now. */
  hold_2z: bigint;
  /** Spendable balance net of open holds (`0` while in debt), in milli-2Z. */
  available_milli_2z?: bigint;
  /**
   * Remaining spend under this app's grant cap for the current period, in
   * milli-2Z; `null` when the grant is uncapped. Absent: not reported.
   */
  cap_remaining_milli_2z?: bigint | null;
  /** The model's minimum charge for a call, in whole 2Z. */
  min_charge_2z?: bigint;
  /** The signed catalogue version the estimate was priced from. */
  catalog_version?: bigint;
}
/**
 * `Client.preflight`: whether a strict request would run **now** with its
 * full `max_output_tokens`, and if not, which recovery UX to show. A
 * snapshot — send the call itself with `max_output_tokens_strict: true` too.
 * Amount fields are absent when the server (or an older native plugin) did
 * not send them.
 */
export type Preflight =
  | { kind: "ready"; estimate: Estimate }
  | {
      /** Balance too low: offer a purchase (`createPurchase`). */
      kind: "needs_top_up";
      required2z?: bigint;
      availableMilli2z?: bigint;
      error: import("./error.js").SdkError;
    }
  | {
      /** This app's budget is used up: link to free2z.cash/account/apps or
       * wait for `resetsAt`. Buying 2Z does NOT raise it. */
      kind: "needs_budget";
      required2z?: bigint;
      capRemainingMilli2z?: bigint;
      /** RFC 3339; `null` for a `total` cap, which never resets. */
      resetsAt?: string | null;
      error: import("./error.js").SdkError;
    }
  | {
      /** Never runs as asked: shorten the input or lower `max_output_tokens`
       * (context window, or above the model's own ceiling). */
      kind: "too_large";
      error: import("./error.js").SdkError;
    };
export interface SettlementFields extends ObjectData {
  settlement: string;
  charge: Charge;
  charged_2z?: bigint;
  receipt_id?: string;
  collected_milli_2z?: bigint;
  shortfall_milli_2z?: bigint;
}
export type ChatEvent =
  | ({
      type: "meta";
      call_id: string;
      /** The model that answered (a `fallback` may differ from the request). */
      model: string;
      hold_2z: bigint;
      requested_model?: string;
      provider?: string;
      /** The limit this call runs with. Below what you asked means the
       * gateway lowered it (not strict): expect `finish_reason: "length"`. */
      max_output_tokens?: bigint;
      input_tokens_estimate?: bigint;
      created_at?: string;
    } & ObjectData)
  | { type: "delta"; text: string }
  | ({ type: "tool_call" } & ToolCall)
  | ({ type: "usage"; usage: Usage; source: string } & ObjectData)
  | ({
      type: "done";
      finish_reason: FinishReason | (string & {});
    } & SettlementFields)
  | ({ type: "error"; code: string; partial: boolean } & SettlementFields)
  | { type: "replay"; record: CallRecord };
export interface ChatStream extends AsyncIterableIterator<ChatEvent> {
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly callId: string | undefined;
  /** Stops delivery. It does not promise that generation or charging stopped. */
  cancel(): Promise<void>;
}
export interface PollOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}
export interface Transport {
  session(): Promise<Session>;
  signIn(options?: SignInOptions): Promise<Session>;
  signOut(): Promise<{ revoked: boolean; generation: string }>;
  balance(signal?: AbortSignal): Promise<Balance>;
  grant(signal?: AbortSignal): Promise<Grant>;
  models(signal?: AbortSignal): Promise<Models>;
  estimate(request: ChatRequest, signal?: AbortSignal): Promise<Estimate>;
  createPurchase(
    request: PurchaseRequest,
    options: OperationOptions,
  ): Promise<Purchase>;
  purchase(id: string, signal?: AbortSignal): Promise<Purchase>;
  openCheckout(id: string): Promise<void>;
  chat(request: ChatRequest, options: ChatOptions): Promise<ChatStream>;
  call(id: string, signal?: AbortSignal): Promise<CallRecord>;
}
