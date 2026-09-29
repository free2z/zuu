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
export interface ChatRequest {
  model: string;
  messages: Message[];
  tools?: { name: string; description?: string; parameters: Json }[];
  max_output_tokens?: Decimal;
  /** `true`: refuse up front rather than lower `max_output_tokens` (requires it). */
  max_output_tokens_strict?: boolean;
  metadata?: Record<string, string>;
  fallback?: string[];
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
export interface ModelCatalog {
  catalog_version: Decimal; includes_markup_bps: Decimal;
  models: { id: string; min_charge_2z?: Decimal | null; prices: Record<string, Decimal>; [key: string]: unknown }[];
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
/** Native errors deliberately omit raw provider, transport and storage messages. */
export interface NativeError {
  code: string; retryable: boolean; status?: number; retryAfterSeconds?: Decimal;
  callId?: string; idempotencyKey?: string;
  stepUp?: { maxAge?: Decimal | null; acrValues?: string | null }; record?: CallRecord;
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
