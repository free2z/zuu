/**
 * Which true thing to say about a chat request attempt.
 *
 * Modelled on `./tip-copy`: the mapping from outcome to words is where a
 * payments UI lies, so it lives in one exhaustive, pure function whose `never`
 * check turns a forgotten outcome into a compile error, and whose strings are
 * tested in every shipped locale.
 *
 * ## The distinction the copy is built around
 *
 * `certainNothingWasCharged: true` only where the server gave a definitive
 * refusal before it could have touched the ledger (402, 404, 429, 401/403,
 * 409 `price_changed`, 422 `sender_handle_unavailable`).
 * Everything else — network loss, a 5xx, an answer that does not match the
 * request, an unfamiliar 4xx — says nothing about the charge except "go look".
 *
 * `retry` records what a retry means for the idempotency key:
 *
 * - `"same-attempt"`: the outcome is unknown, so the retry MUST reuse the key.
 *   The server then replays the original result and never charges twice.
 * - `"new-attempt"`: the server refused outright; a later try is a new request.
 * - `"re-confirm"`: the price moved. The attempt ends, the new price is
 *   fetched, and the payer confirms it before anything is sent again.
 * - `null`: no retry belongs on this screen.
 */

import { MESSAGE_KEYS } from "@/i18n/messages";
import type { ChatRequestOutcome } from "@/lib/api/chat-request";

export type ChatRequestTone = "success" | "info" | "error";

export interface ChatRequestCopy {
  readonly id: string;
  readonly tone: ChatRequestTone;
  readonly titleKey: string;
  readonly bodyKey: string;
  readonly certainNothingWasCharged: boolean;
  readonly retry: "same-attempt" | "new-attempt" | "re-confirm" | null;
}

const CONNECTED: ChatRequestCopy = {
  id: "connected",
  tone: "success",
  titleKey: MESSAGE_KEYS.creatorChatOutcomeConnectedTitle,
  bodyKey: MESSAGE_KEYS.creatorChatOutcomeConnectedBody,
  certainNothingWasCharged: false,
  retry: null,
};

/** Paid, delivered as a notification, but no handle to open a chat with yet. */
const AWAITING_HANDLE: ChatRequestCopy = {
  id: "awaiting-handle",
  tone: "info",
  titleKey: MESSAGE_KEYS.creatorChatOutcomeAwaitingHandleTitle,
  bodyKey: MESSAGE_KEYS.creatorChatOutcomeAwaitingHandleBody,
  certainNothingWasCharged: false,
  retry: null,
};

const INSUFFICIENT: ChatRequestCopy = {
  id: "insufficient",
  tone: "info",
  titleKey: MESSAGE_KEYS.creatorChatOutcomeInsufficientTitle,
  bodyKey: MESSAGE_KEYS.creatorChatOutcomeInsufficientBody,
  certainNothingWasCharged: true,
  retry: null,
};

const NOT_FOUND: ChatRequestCopy = {
  id: "not-found",
  tone: "error",
  titleKey: MESSAGE_KEYS.creatorChatOutcomeNotFoundTitle,
  bodyKey: MESSAGE_KEYS.creatorChatOutcomeNotFoundBody,
  certainNothingWasCharged: true,
  retry: null,
};

/**
 * Only reachable if the page's own-profile check missed. 409 is the self
 * refusal in Contract A, but this copy does not lean on that to reassure.
 */
const SELF: ChatRequestCopy = {
  id: "self",
  tone: "info",
  titleKey: MESSAGE_KEYS.creatorChatOutcomeSelfTitle,
  bodyKey: MESSAGE_KEYS.creatorChatOutcomeSelfBody,
  certainNothingWasCharged: false,
  retry: null,
};

/** Shown above the confirmation, with the NEW price as `{cost}`. */
const PRICE_CHANGED: ChatRequestCopy = {
  id: "price-changed",
  tone: "info",
  titleKey: MESSAGE_KEYS.creatorChatOutcomePriceChangedTitle,
  bodyKey: MESSAGE_KEYS.creatorChatOutcomePriceChangedBody,
  certainNothingWasCharged: true,
  retry: "re-confirm",
};

/** The payer, not the recipient, has no messaging handle yet. */
const SENDER_HANDLE_UNAVAILABLE: ChatRequestCopy = {
  id: "sender-handle-unavailable",
  tone: "info",
  titleKey: MESSAGE_KEYS.creatorChatOutcomeSenderHandleTitle,
  bodyKey: MESSAGE_KEYS.creatorChatOutcomeSenderHandleBody,
  certainNothingWasCharged: true,
  retry: null,
};

const RATE_LIMITED: ChatRequestCopy = {
  id: "rate-limited",
  tone: "info",
  titleKey: MESSAGE_KEYS.creatorChatOutcomeRateLimitedTitle,
  bodyKey: MESSAGE_KEYS.creatorChatOutcomeRateLimitedBody,
  certainNothingWasCharged: true,
  retry: "new-attempt",
};

const SIGNED_OUT: ChatRequestCopy = {
  id: "signed-out",
  tone: "info",
  titleKey: MESSAGE_KEYS.creatorChatOutcomeSignedOutTitle,
  bodyKey: MESSAGE_KEYS.creatorChatOutcomeSignedOutBody,
  certainNothingWasCharged: true,
  retry: null,
};

const REFUSED: ChatRequestCopy = {
  id: "refused",
  tone: "error",
  titleKey: MESSAGE_KEYS.creatorChatOutcomeRefusedTitle,
  bodyKey: MESSAGE_KEYS.creatorChatOutcomeRefusedBody,
  certainNothingWasCharged: false,
  retry: null,
};

const MISMATCH: ChatRequestCopy = {
  id: "mismatch",
  tone: "error",
  titleKey: MESSAGE_KEYS.creatorChatOutcomeMismatchTitle,
  bodyKey: MESSAGE_KEYS.creatorChatOutcomeMismatchBody,
  certainNothingWasCharged: false,
  retry: null,
};

const UNCERTAIN: ChatRequestCopy = {
  id: "uncertain",
  tone: "error",
  titleKey: MESSAGE_KEYS.creatorChatOutcomeUncertainTitle,
  bodyKey: MESSAGE_KEYS.creatorChatOutcomeUncertainBody,
  certainNothingWasCharged: false,
  retry: "same-attempt",
};

export const CHAT_REQUEST_COPY_STATES: readonly ChatRequestCopy[] = [
  CONNECTED,
  AWAITING_HANDLE,
  INSUFFICIENT,
  NOT_FOUND,
  SELF,
  PRICE_CHANGED,
  SENDER_HANDLE_UNAVAILABLE,
  RATE_LIMITED,
  SIGNED_OUT,
  REFUSED,
  MISMATCH,
  UNCERTAIN,
];

export function chatRequestCopy(outcome: ChatRequestOutcome): ChatRequestCopy {
  switch (outcome.kind) {
    case "started":
      // Only a validated handle can be `bound`; see `normalizeRecipient`.
      return outcome.result.recipient.handleStatus === "bound"
        ? CONNECTED
        : AWAITING_HANDLE;
    case "insufficient":
      return INSUFFICIENT;
    case "not-found":
      return NOT_FOUND;
    case "self":
      return SELF;
    case "price-changed":
      return PRICE_CHANGED;
    case "sender-handle-unavailable":
      return SENDER_HANDLE_UNAVAILABLE;
    case "rate-limited":
      return RATE_LIMITED;
    case "signed-out":
      return SIGNED_OUT;
    case "refused":
      return REFUSED;
    case "mismatch":
      return MISMATCH;
    case "uncertain":
      return UNCERTAIN;
    default: {
      const unreachable: never = outcome;
      throw new Error(
        `unhandled chat request outcome: ${JSON.stringify(unreachable)}`,
      );
    }
  }
}
