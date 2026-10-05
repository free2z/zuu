/** Free2Z native IPC. Tokens, browser callbacks and endpoint configuration never enter this API. */
import { invoke } from '@tauri-apps/api/core';

/** Canonical unsigned base-ten integer. Convert with BigInt, never Number. */
export type Decimal = string;
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface ToolCall { id: string; name: string; arguments: string }
export type ContentPart = { type: 'text'; text: string } | { type: 'image'; media_type: string; data: string };
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: ContentPart[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
/**
 * Structured output: `json_schema` (prefer it) or `json_object`. The reply is
 * ordinary text to parse; `finish_reason: 'length'` means truncated JSON.
 * A model without `capabilities.structured_output` refuses the call up front
 * (`invalid_request`, reason `response_format_unsupported`).
 */
export type ResponseFormat =
  | { type: 'json_object' }
  | {
      type: 'json_schema';
      /** `name`: 1-64 of `A-Z a-z 0-9 _ -`; `schema`: a JSON Schema object, at most 32 KiB. */
      json_schema: { name: string; schema: Json; strict?: boolean };
    };
/** OpenAI's `reasoning_effort`; `'minimal'` is GPT-5-family only. */
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';
/** OpenAI's `tool_choice`; requires `tools`. */
export type ToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; function: { name: string } };
export interface ChatRequest {
  model: string;
  messages: Message[];
  tools?: { name: string; description?: string; parameters: Json }[];
  /** Opt-in; refused up front (`tools_unsupported`) where a model cannot express it. */
  tool_choice?: ToolChoice;
  /** Opt-in; `false` = at most one tool call per turn. */
  parallel_tool_calls?: boolean;
  max_output_tokens?: Decimal;
  /** `true`: refuse up front rather than lower `max_output_tokens` (requires it). */
  max_output_tokens_strict?: boolean;
  metadata?: Record<string, string>;
  fallback?: string[];
  /** Opt-in structured output; omit for prose. Plain JSON, not decimal strings. */
  response_format?: ResponseFormat;
  /**
   * Opt-in reasoning effort; omit for the provider's default. A model without
   * `capabilities.reasoning_effort` (or whose `controls.effort_levels` omit the
   * level) refuses the call up front (`invalid_request`, reason
   * `reasoning_effort_unsupported`).
   */
  reasoning_effort?: ReasoningEffort;
  stream?: true;
}
export interface Session {
  signedIn: boolean;
  subject: string | null;
  grantedScopes: string[];
  persistence: 'persistent' | 'memory_only';
  generation: string;
}
/** Scopes are configured in the Rust Builder; inspect the actual grantedScopes. */
export interface SignInOptions {
  prompt?: 'none' | 'login' | 'consent';
  maxAge?: Decimal;
  acrValues?: string;
  loginHint?: string;
  uiLocales?: string;
  /**
   * A SUGGESTED spend cap for `ai:invoke`, whole 2Z as a decimal string.
   * The consent screen may pre-select it after clamping it
   * to the registration's default and the user's existing grant; nothing is
   * granted unless the user confirms. Read the result from `grant()`.
   */
  spendCap?: Decimal;
  /** The period of `spendCap`; absent keeps the screen's own. */
  spendPeriod?: 'day' | 'week' | 'month' | 'total';
}
export interface Balance {
  available_milli_2z: Decimal;
  held_milli_2z: Decimal;
  balance_milli_2z: Decimal;
  debt_milli_2z: Decimal;
  as_of: string;
}
/** Only this normalized result says whether an amount is final. */
export type Charge = { state: 'pending' } | { state: 'released'; charged2z: '0' } | {
  state: 'charged'; charged2z: Decimal; receiptId: string;
  collectedMilli2z?: Decimal | null; shortfallMilli2z?: Decimal | null;
};
export interface Usage {
  input_tokens: Decimal; cached_input_tokens: Decimal; cache_write_tokens: Decimal;
  output_tokens: Decimal; reasoning_tokens: Decimal; images: Decimal; tool_calls: Decimal;
}
export interface CallRecord {
  call_id: string; status: string; charge: Charge; replayed: boolean;
  model?: string | null; usage?: Usage | null; hold_2z?: Decimal | null;
  charged_2z?: Decimal | null; receipt_id?: string | null;
  collected_milli_2z?: Decimal | null; shortfall_milli_2z?: Decimal | null;
  [key: string]: unknown;
}
export type StreamEvent =
  | { type: 'meta'; call_id: string; model: string; hold_2z: Decimal; [key: string]: unknown }
  | { type: 'delta'; text: string }
  | ({ type: 'tool_call' } & ToolCall)
  | { type: 'usage'; usage: Usage; source?: string }
  | { type: 'done'; charge: Charge; finish_reason: string; [key: string]: unknown }
  | { type: 'error'; charge: Charge; code: string; [key: string]: unknown };
/**
 * What the gateway accepts for a model. Absent, `null` or `false`: unsupported;
 * compare with `=== true`. `structured_output === true` is the precondition for
 * `ChatRequest.response_format`, `reasoning_effort === true` for
 * `ChatRequest.reasoning_effort`, `tools === true` for `tools` — otherwise the
 * gateway refuses (`invalid_request`) before any hold or charge.
 */
export interface ModelCapabilities {
  vision?: boolean; tools?: boolean; reasoning?: boolean; structured_output?: boolean;
  /** Precondition for `ChatRequest.reasoning_effort`; not implied by `reasoning`. */
  reasoning_effort?: boolean;
  [key: string]: unknown;
}
/** Signed narrowing of a capability; absent members are not narrowed. */
export interface ModelControls {
  /** The `reasoning_effort` levels the model takes. */
  effort_levels?: string[];
  [key: string]: unknown;
}
/** One catalogue model; `null` optional members were not reported. */
export interface CatalogModel {
  id: string; provider?: string | null; display_name?: string | null;
  context_window?: Decimal | null; max_output_tokens?: Decimal | null;
  capabilities?: ModelCapabilities;
  controls?: ModelControls;
  /** Milli-2Z per million tokens (`*_milli_2z_per_mtok`) or per unit, markup included. */
  prices: Record<string, Decimal>;
  min_charge_2z?: Decimal | null; ttfb_timeout_ms?: Decimal | null;
  [key: string]: unknown;
}
export interface ModelCatalog {
  catalog_version: Decimal; includes_markup_bps: Decimal;
  models: CatalogModel[];
}
export interface Estimate {
  model: string; input_tokens: Decimal; max_output_tokens: Decimal; hold_2z: Decimal;
  available_milli_2z?: Decimal | null; min_charge_2z?: Decimal | null;
  cap_remaining_milli_2z?: Decimal | null; [key: string]: unknown;
}
export interface Purchase {
  id: string; rail: 'card' | 'zcash' | 'unknown'; status: string; quantity_2z: Decimal;
  price: { currency: string; amount_minor: Decimal };
  credited_milli_2z?: Decimal | null; checkoutAvailable: boolean;
  rail_data: Record<string, unknown>;
  [key: string]: unknown;
}
export interface PurchaseRequest { rail: 'card' | 'zcash'; quantity2z: Decimal; idempotencyKey: string }
export interface ChatOperation { operationId: string; idempotencyKey: string }
export interface ChatOpened { operationId: string; callId?: string; replay?: CallRecord }
export interface PollOptions { timeoutMs?: number }
/**
 * Why `signIn` ended without signing in, when the platform can tell:
 * - `user_cancelled`: the user dismissed the sign-in sheet or Custom Tab
 *   (iOS/Android). A choice, not a failure: offer sign-in again quietly.
 * - `browser_unavailable`: no browser or authentication session could be shown.
 * - `timeout`: no callback before the deadline (desktop cannot see a closed
 *   browser tab, so its cancel arrives as this).
 * - `browser_error`: any other browser or session failure, and every sign-in
 *   failure from a native core older than these codes. Always handle it.
 * Sign-in can also reject with IdP codes (`access_denied`, …) and others;
 * keep a default branch.
 */
export type SignInErrorCode = 'user_cancelled' | 'browser_unavailable' | 'timeout' | 'browser_error';
/** Native errors deliberately omit raw provider, transport and storage messages. */
export interface NativeError {
  /** Switch on this. A code newer than your app arrives unchanged; keep a default branch. */
  code: SignInErrorCode | (string & {}); retryable: boolean; status?: number; retryAfterSeconds?: Decimal;
  callId?: string; idempotencyKey?: string;
  stepUp?: { maxAge?: Decimal | null; acrValues?: string | null }; record?: CallRecord;
  /**
   * The server's documented refusal details (`errors.md`), integers as
   * decimal strings: `required_2z`, `available_milli_2z`,
   * `cap_remaining_milli_2z`, `resets_at`, `reason`, `field`, … Absent from
   * plugins older than this field, and for local failures.
   */
  details?: { [key: string]: Json };
}
/** Fresh server policy snapshot, not an immutable cap version. */
export interface Grant {
  sub: string;
  client_id: string;
  account_epoch: Decimal;
  grant_generation: Decimal;
  scopes: string[];
  spend_cap_2z: Decimal | null;
  cap_period: 'day' | 'week' | 'month' | 'total';
  enforced: boolean;
  /** Coarse reason for `enforced`; absent from older servers. A
   * code newer than the native core arrives as `'unknown'`. Never enforced
   * unless `enforced` is true. */
  enforcement_reason?: 'ok' | 'platform_disabled' | 'ledger_cutover_pending' | 'ledger_cap_pending' | 'unknown';
  as_of: string;
}
export interface NativeBridge {
  session(): Promise<Session>;
  /** Rejects with a `NativeError`; see `SignInErrorCode` for why the browser step ended. */
  signIn(options?: SignInOptions): Promise<Session>;
  signOut(): Promise<{ revoked: boolean; generation: string }>;
  balance(): Promise<Balance>;
  grant(): Promise<Grant>;
  models(): Promise<ModelCatalog>;
  estimate(request: ChatRequest): Promise<Estimate>;
  createPurchase(request: PurchaseRequest): Promise<Purchase>;
  purchase(id: string): Promise<Purchase>;
  waitForPurchase(id: string, options?: PollOptions): Promise<Purchase>;
  openCheckout(id: string): Promise<void>;
  /** Persist both caller-owned keys BEFORE this call. No automatic retry with a new key. */
  startChat(request: ChatRequest, operation: ChatOperation): Promise<ChatOpened>;
  /** One outstanding reader per operation. Null means the stream is exhausted. */
  nextChat(operationId: string): Promise<StreamEvent | null>;
  /** Stops delivery, not server generation or billing. Reconcile using the call record. */
  cancelChat(operationId: string): Promise<void>;
  call(callId: string): Promise<CallRecord>;
  waitForCall(callId: string, options?: PollOptions): Promise<CallRecord>;
}
const command = <T>(name: string, args?: Record<string, unknown>): Promise<T> => invoke<T>(`plugin:f2z|${name}`, args);
export const nativeBridge: NativeBridge = {
  session: () => command('session'),
  signIn: (options = {}) => command('sign_in', { options }),
  signOut: () => command('sign_out'),
  balance: () => command('balance'),
  grant: () => command('grant'),
  models: () => command('models'),
  estimate: (request) => command('estimate', { request }),
  createPurchase: (request) => command('create_purchase', { request }),
  purchase: (id) => command('purchase', { id }),
  waitForPurchase: (id, options = {}) => command('wait_for_purchase', { id, options }),
  openCheckout: (id) => command('open_checkout', { id }),
  startChat: (request, operation) => command('start_chat', { request, operation }),
  nextChat: (operationId) => command('next_chat', { operationId }),
  cancelChat: (operationId) => command('cancel_chat', { operationId }),
  call: (callId) => command('call', { callId }),
  waitForCall: (callId, options = {}) => command('wait_for_call', { callId, options }),
};
