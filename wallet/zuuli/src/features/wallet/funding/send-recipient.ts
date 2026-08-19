import type { SimpleCreator } from "@/lib/api/types";
import { ApiError } from "@/lib/api/http";
import { isDonationIdempotencyKey } from "@/lib/api/donation";

export { isDonationIdempotencyKey } from "@/lib/api/donation";

export type RecipientSearchStatus = "idle" | "loading" | "ready" | "error";

export interface TransferReview {
  recipient: SimpleCreator;
  amount: number;
  senderUsername: string;
  idempotencyKey: string;
}

export interface RecipientState {
  query: string;
  generation: number;
  selected: SimpleCreator | null;
  results: SimpleCreator[];
  searchStatus: RecipientSearchStatus;
  highlightedIndex: number;
  review: TransferReview | null;
}

export type RecipientAction =
  | { type: "queryChanged"; query: string }
  | { type: "searchStarted"; generation: number }
  | {
      type: "searchSucceeded";
      generation: number;
      results: SimpleCreator[];
    }
  | { type: "searchFailed"; generation: number }
  | { type: "moveHighlight"; delta: -1 | 1 }
  | { type: "select"; creator: SimpleCreator }
  | { type: "closeResults" }
  | {
      type: "startReview";
      amount: number;
      senderUsername: string;
      idempotencyKey: string;
    }
  | { type: "clearReview" }
  | { type: "reset" };

export const initialRecipientState: RecipientState = {
  query: "",
  generation: 0,
  selected: null,
  results: [],
  searchStatus: "idle",
  highlightedIndex: -1,
  review: null,
};

/** Usernames are case-insensitive throughout the free2z API. */
export function sameUsername(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** UUIDv4 without relying on newer WebView support for crypto.randomUUID(). */
export function createDonationIdempotencyKey(
  fill: (bytes: Uint8Array) => Uint8Array = (bytes) => {
    const crypto = globalThis.crypto;
    if (!crypto?.getRandomValues) {
      throw new Error("Secure randomness is unavailable");
    }
    return crypto.getRandomValues(bytes);
  },
): string {
  const bytes = fill(new Uint8Array(16));
  if (bytes.length !== 16) throw new Error("Invalid secure random result");
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10).join(""),
  ].join("-");
}

const PENDING_DONATION_STORAGE_KEY = "zuuli.tuzi.pending-donation.v1";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function pendingDonationMatches(
  pending: TransferReview,
  candidate: Pick<TransferReview, "senderUsername" | "recipient" | "amount">,
): boolean {
  return (
    sameUsername(pending.senderUsername, candidate.senderUsername) &&
    sameUsername(pending.recipient.username, candidate.recipient.username) &&
    pending.amount === candidate.amount
  );
}

function defaultStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadPendingDonation(
  storage: StorageLike | null = defaultStorage(),
): TransferReview | null {
  if (!storage) return null;
  try {
    const encoded = storage.getItem(PENDING_DONATION_STORAGE_KEY);
    if (!encoded) return null;
    const parsed = JSON.parse(encoded) as Partial<TransferReview>;
    if (
      typeof parsed.senderUsername !== "string" ||
      !parsed.senderUsername ||
      typeof parsed.amount !== "number" ||
      !Number.isSafeInteger(parsed.amount) ||
      parsed.amount < 1 ||
      typeof parsed.idempotencyKey !== "string" ||
      !isDonationIdempotencyKey(parsed.idempotencyKey) ||
      !parsed.recipient ||
      typeof parsed.recipient.username !== "string" ||
      !parsed.recipient.username ||
      typeof parsed.recipient.free2zaddr !== "string"
    ) {
      return null;
    }
    return parsed as TransferReview;
  } catch {
    return null;
  }
}

/** Persist before sending; failure means the money request must not start. */
export function persistPendingDonation(
  review: TransferReview,
  storage: StorageLike | null = defaultStorage(),
): boolean {
  if (!storage || !isDonationIdempotencyKey(review.idempotencyKey)) return false;
  try {
    const existing = loadPendingDonation(storage);
    if (existing && existing.idempotencyKey !== review.idempotencyKey) {
      return false;
    }
    const minimal: TransferReview = {
      senderUsername: review.senderUsername,
      amount: review.amount,
      idempotencyKey: review.idempotencyKey,
      recipient: {
        username: review.recipient.username,
        free2zaddr: review.recipient.free2zaddr,
      },
    };
    storage.setItem(PENDING_DONATION_STORAGE_KEY, JSON.stringify(minimal));
    return true;
  } catch {
    return false;
  }
}

/** Clear only the exact attempt we resolved; never erase a newer pending key. */
export function clearPendingDonation(
  idempotencyKey: string,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    const pending = loadPendingDonation(storage);
    if (pending?.idempotencyKey === idempotencyKey) {
      storage.removeItem(PENDING_DONATION_STORAGE_KEY);
    }
  } catch {
    // Leaving a resolved key behind is fail-closed: its replay cannot recharge.
  }
}

export function nextHighlight(
  current: number,
  resultCount: number,
  delta: -1 | 1,
): number {
  if (resultCount === 0) return -1;
  if (current < 0) return delta === 1 ? 0 : resultCount - 1;
  return (current + delta + resultCount) % resultCount;
}

export function recipientKeyAction(
  key: string,
  results: SimpleCreator[],
  highlightedIndex: number,
): RecipientAction | null {
  if (key === "ArrowDown" || key === "ArrowUp") {
    if (results.length === 0) return null;
    return { type: "moveHighlight", delta: key === "ArrowDown" ? 1 : -1 };
  }
  if (key === "Enter") {
    const creator = results[highlightedIndex];
    return creator ? { type: "select", creator } : null;
  }
  if (key === "Escape") return { type: "closeResults" };
  return null;
}

export function shouldSearchRecipients({
  currentQuery,
  debouncedQuery,
  selected,
  isSelf,
}: {
  currentQuery: string;
  debouncedQuery: string;
  selected: SimpleCreator | null;
  isSelf: boolean;
}): boolean {
  return Boolean(
    debouncedQuery && debouncedQuery === currentQuery && !selected && !isSelf,
  );
}

/**
 * Fail-closed recipient state. Every query edit increments `generation`, which
 * invalidates both a prior selection and any search response still in flight.
 */
export function recipientReducer(
  state: RecipientState,
  action: RecipientAction,
): RecipientState {
  switch (action.type) {
    case "queryChanged":
      return {
        ...state,
        query: action.query.replace(/^@/, ""),
        generation: state.generation + 1,
        selected: null,
        results: [],
        searchStatus: "idle",
        highlightedIndex: -1,
        review: null,
      };
    case "searchStarted":
      if (action.generation !== state.generation) return state;
      return {
        ...state,
        results: [],
        searchStatus: "loading",
        highlightedIndex: -1,
      };
    case "searchSucceeded":
      if (action.generation !== state.generation) return state;
      return {
        ...state,
        results: action.results,
        searchStatus: "ready",
        highlightedIndex: action.results.length > 0 ? 0 : -1,
      };
    case "searchFailed":
      if (action.generation !== state.generation) return state;
      return {
        ...state,
        results: [],
        searchStatus: "error",
        highlightedIndex: -1,
      };
    case "moveHighlight":
      return {
        ...state,
        highlightedIndex: nextHighlight(
          state.highlightedIndex,
          state.results.length,
          action.delta,
        ),
      };
    case "select":
      return {
        ...state,
        query: action.creator.username,
        generation: state.generation + 1,
        selected: action.creator,
        results: [],
        searchStatus: "idle",
        highlightedIndex: -1,
        review: null,
      };
    case "closeResults":
      return {
        ...state,
        results: [],
        searchStatus: "idle",
        highlightedIndex: -1,
      };
    case "startReview":
      if (
        !state.selected ||
        !action.senderUsername ||
        !isDonationIdempotencyKey(action.idempotencyKey)
      ) {
        return state;
      }
      return {
        ...state,
        review: {
          recipient: state.selected,
          amount: action.amount,
          senderUsername: action.senderUsername,
          idempotencyKey: action.idempotencyKey,
        },
      };
    case "clearReview":
      return state.review ? { ...state, review: null } : state;
    case "reset":
      return {
        ...initialRecipientState,
        generation: state.generation + 1,
      };
  }
}

export type TransferBlock =
  | "auth"
  | "unresolved"
  | "self"
  | "amount"
  | "balance"
  | "sending";

export function transferBlock({
  selected,
  query,
  ownUsername,
  amount,
  validAmount,
  balance,
  sending,
}: {
  selected: SimpleCreator | null;
  query: string;
  ownUsername?: string;
  amount: number | null;
  validAmount: boolean;
  balance: number;
  sending: boolean;
}): TransferBlock | null {
  if (!ownUsername) return "auth";
  if (
    !selected ||
    !sameUsername(selected.username, query) ||
    !selected.username.trim()
  ) {
    return "unresolved";
  }
  if (sameUsername(selected.username, ownUsername)) return "self";
  if (
    !validAmount ||
    amount === null ||
    !Number.isSafeInteger(amount) ||
    amount < 1
  ) {
    return "amount";
  }
  if (amount > balance) return "balance";
  if (sending) return "sending";
  return null;
}

/** Confirmation is authorization for exactly one current transfer snapshot. */
export function reviewMatchesTransfer({
  review,
  selected,
  query,
  ownUsername,
  amount,
  validAmount,
  balance,
}: {
  review: TransferReview | null;
  selected: SimpleCreator | null;
  query: string;
  ownUsername?: string;
  amount: number | null;
  validAmount: boolean;
  balance: number;
}): boolean {
  if (
    !review ||
    !selected ||
    transferBlock({
      selected,
      query,
      ownUsername,
      amount,
      validAmount,
      balance,
      sending: false,
    }) !== null ||
    amount !== review.amount ||
    !ownUsername ||
    !sameUsername(review.senderUsername, ownUsername) ||
    !sameUsername(review.recipient.username, selected.username) ||
    !isDonationIdempotencyKey(review.idempotencyKey)
  ) {
    return false;
  }
  return true;
}

export type TransferFailure =
  | "auth"
  | "balance"
  | "not-found"
  | "self"
  | "pending"
  | "pending-conflict"
  | "idempotency-conflict"
  | "unsupported"
  | "rejected"
  | "security"
  | "network";

function apiErrorFields(error: ApiError): {
  code: string;
  message: string;
} {
  if (
    !error.body ||
    typeof error.body !== "object" ||
    Array.isArray(error.body)
  ) {
    return { code: "", message: error.message.toLowerCase() };
  }
  const body = error.body as Record<string, unknown>;
  const code = typeof body.code === "string" ? body.code.toLowerCase() : "";
  const detail =
    typeof body.error === "string"
      ? body.error
      : typeof body.detail === "string"
        ? body.detail
        : error.message;
  return { code, message: detail.toLowerCase() };
}

export function classifyTransferFailure(error: unknown): TransferFailure {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) return "auth";
    const { code, message } = apiErrorFields(error);
    if (
      error.status === 402 ||
      code === "insufficient_funds" ||
      message.includes("insufficient funds") ||
      message.includes("amount > 1 and < balance")
    ) {
      return "balance";
    }
    if (code === "self_send" || message.includes("donate to yourself")) {
      return "self";
    }
    if (error.status === 404) {
      return code === "recipient_not_found" ? "not-found" : "unsupported";
    }
    if (error.status === 409) {
      return code === "request_in_progress"
        ? "pending"
        : "idempotency-conflict";
    }
    if (error.status >= 400 && error.status < 500) return "rejected";
  }
  return "network";
}

export function transferFailureIsAmbiguous(failure: TransferFailure): boolean {
  return (
    failure === "network" ||
    failure === "pending" ||
    failure === "idempotency-conflict"
  );
}

export const TRANSFER_FAILURE_MESSAGES: Record<TransferFailure, string> = {
  auth: "Your session expired. Log in again before sending 2Z.",
  balance: "Your 2Z balance changed and is no longer enough for this tip.",
  "not-found":
    "That creator is no longer available. Search again before sending.",
  self: "You can't send 2Z to your own account.",
  pending:
    "This transfer is still processing. Wait, then retry the same transfer safely.",
  "pending-conflict":
    "A previous transfer is unresolved. Restore its exact recipient and amount before starting another.",
  "idempotency-conflict":
    "This transfer ID conflicts with the server record. Nothing new was sent; contact support before trying another transfer.",
  unsupported:
    "Secure 2Z transfers are not available on this server yet. Nothing was sent.",
  rejected: "The server rejected this transfer. Nothing was sent.",
  security:
    "A crash-safe transfer ID could not be saved. Nothing was sent.",
  network:
    "The transfer result is uncertain. Retry uses the same transfer ID and cannot charge twice.",
};
