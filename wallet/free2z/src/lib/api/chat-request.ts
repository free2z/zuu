/**
 * Contract A of #1022: the paid chat request.
 *
 * ```
 * GET  /api/e2ee/chat-requests/price/            → 200 {"cost": 1}
 * POST /api/e2ee/chat-requests/{username}/
 *      Authorization: Token <knox>   Idempotency-Key: <uuid-v4>
 *      body: {"expected_cost": <the cost the payer confirmed>}
 *   200 → {"balance": "9.000", "charged": "1.000", "replayed", "request_id",
 *          "recipient": {"username", "handle", "handle_status"}}
 *   402 → insufficient 2Z (carries the authoritative balance)
 *   404 → unknown user
 *   409 → {"code": "price_changed"} (nothing charged), otherwise self
 *   422 → {"code": "sender_handle_unavailable"} (nothing charged)
 *   429 → rate limited
 * ```
 *
 * `balance` and `charged` arrive as decimal strings from the real backend;
 * both parsers accept them without rounding.
 *
 * The server sets the price. `expected_cost` only lets it refuse when the
 * price moved after the payer saw it; it is never an amount to charge. The
 * client still owns the other refusal: a `charged` that differs from the cost
 * the payer was shown is a contract failure, never something to accept,
 * exactly like `normalizeDonationResult`.
 *
 * Everything here is pure so the money boundary can be tested against the
 * shapes the backend may really send, not against a component.
 */

import { ApiError } from "./http";
import {
  authoritativeBalanceFromErrorBody,
  isDonationIdempotencyKey,
  parseBalanceTuzis,
  parseWholeTuzis,
} from "./donation";

export const CHAT_REQUEST_PRICE_ROUTE = "/api/e2ee/chat-requests/price/";

/**
 * A creator literally named `price` cannot receive a request: that path is the
 * price endpoint. The page hides the button for them.
 */
export function canReceiveChatRequest(username: string): boolean {
  return username.toLowerCase() !== "price";
}

export function chatRequestRoute(username: string): string {
  return `/api/e2ee/chat-requests/${encodeURIComponent(username)}/`;
}

/** The same uuid-v4 shape the donation ledger accepts. */
export const isChatRequestIdempotencyKey = isDonationIdempotencyKey;

/**
 * A messaging handle as Contract B carries it. This is the only thing that may
 * ever reach the `peer=` fragment.
 */
export const MESSAGING_HANDLE_PATTERN = /^[a-z0-9_]{1,30}$/;

export function isMessagingHandle(value: unknown): value is string {
  return typeof value === "string" && MESSAGING_HANDLE_PATTERN.test(value);
}

export type ChatRequestRecipient =
  | { username: string; handleStatus: "bound"; handle: string }
  | { username: string; handleStatus: "unclaimed"; handle: null };

export interface ChatRequestResult {
  /** Authoritative 2Z balance after the original keyed request. */
  balance: number;
  /** Whole-2Z amount the original keyed request charged. */
  charged: number;
  /** True when the server replayed the stored result for this key. */
  replayed: boolean;
  requestId: string;
  recipient: ChatRequestRecipient;
}

export class ChatRequestContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatRequestContractError";
  }
}

const MAX_REQUEST_ID = 128;
const MAX_USERNAME = 150;

function record(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ChatRequestContractError(`${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

/** The price is a positive whole number of 2Z, or it is not a price. */
export function normalizeChatRequestPrice(response: unknown): number {
  const cost = parseWholeTuzis(record(response, "Chat request price").cost);
  if (cost === null || cost <= 0) {
    throw new ChatRequestContractError("Chat request price is invalid");
  }
  return cost;
}

/**
 * The recipient never decides whether money moved; it only decides whether a
 * link can be built. A `bound` status with a handle that fails the pattern is
 * therefore read as "no usable handle" rather than thrown: the charge has
 * already been proven, and the payer deserves the honest outcome, not an
 * error. Only a valid handle can ever become `bound`.
 */
function normalizeRecipient(
  value: unknown,
  requestedUsername: string,
): ChatRequestRecipient {
  const raw = record(value, "Chat request recipient");
  const username = raw.username;
  if (
    typeof username !== "string" ||
    username.length === 0 ||
    [...username].length > MAX_USERNAME ||
    username.toLowerCase() !== requestedUsername.toLowerCase()
  ) {
    // A charge recorded against somebody other than the person on screen is
    // not a success this client can show.
    throw new ChatRequestContractError(
      "Chat request recipient does not match",
    );
  }
  if (raw.handle_status === "bound" && isMessagingHandle(raw.handle)) {
    return { username, handleStatus: "bound", handle: raw.handle };
  }
  if (raw.handle_status !== "bound" && raw.handle_status !== "unclaimed") {
    throw new ChatRequestContractError("Chat request handle status is invalid");
  }
  return { username, handleStatus: "unclaimed", handle: null };
}

export function normalizeChatRequestResult(
  response: unknown,
  shownCost: number,
  requestedUsername: string,
): ChatRequestResult {
  const raw = record(response, "Chat request response");
  const balance = parseBalanceTuzis(raw.balance);
  const charged = parseWholeTuzis(raw.charged);
  if (balance === null) {
    throw new ChatRequestContractError("Chat request balance is invalid");
  }
  if (charged === null || charged !== shownCost) {
    throw new ChatRequestContractError("Chat request charge does not match");
  }
  if (typeof raw.replayed !== "boolean") {
    throw new ChatRequestContractError("Chat request replay status is invalid");
  }
  if (
    typeof raw.request_id !== "string" ||
    raw.request_id.length === 0 ||
    raw.request_id.length > MAX_REQUEST_ID
  ) {
    throw new ChatRequestContractError("Chat request id is invalid");
  }
  return {
    balance,
    charged,
    replayed: raw.replayed,
    requestId: raw.request_id,
    recipient: normalizeRecipient(raw.recipient, requestedUsername),
  };
}

/**
 * Everything a chat request attempt can end as.
 *
 * The failure kinds split on one question — did the server give a definitive
 * refusal before touching money? — and `chatRequestCopy` turns that into
 * `certainNothingWasCharged`.
 */
export type ChatRequestOutcome =
  | { kind: "started"; result: ChatRequestResult }
  | { kind: "insufficient"; balance: number | null }
  | { kind: "not-found" }
  | { kind: "self" }
  /** The server price moved after the payer saw it. Nothing was charged. */
  | { kind: "price-changed" }
  /** The payer has no bound messaging handle yet. Nothing was charged. */
  | { kind: "sender-handle-unavailable" }
  | { kind: "rate-limited" }
  | { kind: "signed-out" }
  /** Some other 4xx. A refusal, but not one this client can prove was free. */
  | { kind: "refused"; status: number }
  /** The server answered with terms that do not match this request. */
  | { kind: "mismatch" }
  /** No trustworthy answer: network loss, a 5xx, a body we cannot read. */
  | { kind: "uncertain" };

/**
 * The machine-readable refusal code, read defensively: a top-level `code`
 * string, or DRF's `{"detail": {"code": …}}` nesting. Anything else is none.
 */
export function chatRequestErrorCode(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const raw = body as Record<string, unknown>;
  if (typeof raw.code === "string") return raw.code;
  const detail = raw.detail;
  if (detail && typeof detail === "object" && !Array.isArray(detail)) {
    const code = (detail as Record<string, unknown>).code;
    if (typeof code === "string") return code;
  }
  return null;
}

export function classifyChatRequestFailure(error: unknown): ChatRequestOutcome {
  if (error instanceof ChatRequestContractError) return { kind: "mismatch" };
  if (error instanceof ApiError) {
    switch (error.status) {
      case 402:
        return {
          kind: "insufficient",
          balance: authoritativeBalanceFromErrorBody(error.body),
        };
      case 401:
      case 403:
        return { kind: "signed-out" };
      case 404:
        return { kind: "not-found" };
      // `price_changed` is a definitive refusal before any charge. Any other
      // 409 is read as "cannot message yourself". This client never reuses a
      // key across recipients, so an idempotency-key conflict should not arise
      // from it; the UI still refuses to claim anything was free there.
      case 409:
        return chatRequestErrorCode(error.body) === "price_changed"
          ? { kind: "price-changed" }
          : { kind: "self" };
      case 422:
        return chatRequestErrorCode(error.body) === "sender_handle_unavailable"
          ? { kind: "sender-handle-unavailable" }
          : { kind: "refused", status: 422 };
      case 429:
        return { kind: "rate-limited" };
      default:
        if (error.status >= 400 && error.status < 500) {
          return { kind: "refused", status: error.status };
        }
        // A 5xx may be thrown after the ledger committed.
        return { kind: "uncertain" };
    }
  }
  // fetch rejects with a TypeError on network loss, and an AbortError on a
  // timeout. Either may happen after the server committed.
  return { kind: "uncertain" };
}
