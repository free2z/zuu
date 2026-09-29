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
export interface SignInOptions {
  prompt?: "login" | "consent" | "none";
  maxAge?: number;
  acrValues?: string;
  signal?: AbortSignal;
}
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
export interface ChatRequest {
  model: string;
  messages: Message[];
  tools?: { name: string; description?: string; parameters: Json }[];
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
  rail: string;
  status: string;
  quantity_2z: bigint;
  price: { currency: string; amount_minor: bigint };
  credited_milli_2z: bigint | null;
  credited_at: string | null;
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
export interface CallRecord extends ObjectData {
  call_id: string;
  status: string;
  charge: Charge;
}
export interface Models extends ObjectData {
  models: ObjectData[];
  catalog_version: bigint;
}
export interface Estimate extends ObjectData {
  model: string;
  input_tokens: bigint;
  max_output_tokens: bigint;
  hold_2z: bigint;
}
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
      model: string;
      hold_2z: bigint;
    } & ObjectData)
  | { type: "delta"; text: string }
  | ({ type: "tool_call" } & ToolCall)
  | ({ type: "usage"; usage: ObjectData; source: string } & ObjectData)
  | ({ type: "done"; finish_reason: string } & SettlementFields)
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
