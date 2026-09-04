/**
 * Which true thing to say about a ZEC tip attempt.
 *
 * This is a separate, pure module for one reason: the mapping from outcome to
 * copy is where a payments UI lies to people, and a `switch` in a component is
 * not testable against the strings it actually ships.
 *
 * The first version of this flow had **four** failure kinds and **three**
 * branches. `unsendable` and `transport-failed` fell through to "the wallet did
 * not complete this payment" — which, for `unsendable`, is simply false: nothing
 * ever left free2z and ZUULI was never asked. Telling somebody the wallet
 * declined a payment the wallet never saw is the exact failure this surface
 * cannot afford. The `never` check at the bottom is what makes that class of bug
 * a compile error rather than a code review someone has to remember to do.
 *
 * ## The distinction the copy is built around
 *
 * Not "did it work", but **"do we know what happened"**:
 *
 * - `certainNothingWasSent: true` — this app can prove no funds moved, because
 *   the request never reached a wallet, or the wallet said it did not act.
 *   Only these may say "nothing was sent" / "your ZEC is untouched".
 * - `certainNothingWasSent: false` — we did not get an answer we can trust. A
 *   transaction may exist. `INTENT_UNAVAILABLE` is the sharp case:
 *   `wallet/zuuli/src-tauri/src/intent.rs`'s `payment_outcome` returns it for
 *   every `BroadcastStatus` but `Accepted`, and that includes `Unknown`, where
 *   "the transaction exists locally and the wallet retains the exact bytes for
 *   `retry_pending_send`, but nothing establishes that the network took them".
 *   Copy for these must send the payer to ZUULI to look, never reassure them.
 *
 * `creator-tip.copy.test.ts` reads the shipped `en`/`es`/`fr` catalogs and fails
 * if a message on the `false` side ever claims nothing was sent.
 */

import { IntentErrorCode } from "@free2z/wallet-shared";
import { MESSAGE_KEYS } from "@/i18n/messages";
import type { CreatorTipOutcome } from "@/lib/bridge/creator-tip";

export type CreatorTipTone = "success" | "info" | "error";

export interface CreatorTipCopy {
  readonly tone: CreatorTipTone;
  readonly titleKey: string;
  readonly bodyKey: string;
  /**
   * Whether this app can honestly state that no funds moved.
   *
   * `false` does NOT mean a payment happened — it means we cannot say either
   * way, which for money is the same obligation: tell the payer to go look.
   */
  readonly certainNothingWasSent: boolean;
}

const SENT: CreatorTipCopy = {
  tone: "success",
  titleKey: MESSAGE_KEYS.creatorZecTipSentTitle,
  bodyKey: MESSAGE_KEYS.creatorZecTipSentBody,
  certainNothingWasSent: false,
};

/** No channel to the wallet exists at all (#461). Nothing left this process. */
const BLOCKED: CreatorTipCopy = {
  tone: "info",
  titleKey: MESSAGE_KEYS.creatorZecTipBlockedTitle,
  bodyKey: MESSAGE_KEYS.creatorZecTipBlockedBody,
  certainNothingWasSent: true,
};

/** free2z could not build a sendable request. The wallet was never asked. */
const UNSENT: CreatorTipCopy = {
  tone: "error",
  titleKey: MESSAGE_KEYS.creatorZecTipUnsentTitle,
  bodyKey: MESSAGE_KEYS.creatorZecTipUnsentBody,
  certainNothingWasSent: true,
};

/** The wallet answered, and its answer was "I did not authorize this". */
const DECLINED: CreatorTipCopy = {
  tone: "info",
  titleKey: MESSAGE_KEYS.creatorZecTipDeclinedTitle,
  bodyKey: MESSAGE_KEYS.creatorZecTipDeclinedBody,
  certainNothingWasSent: true,
};

/** No answer we can trust. A transaction may or may not exist. */
const INDETERMINATE: CreatorTipCopy = {
  tone: "error",
  titleKey: MESSAGE_KEYS.creatorZecTipIndeterminateTitle,
  bodyKey: MESSAGE_KEYS.creatorZecTipIndeterminateBody,
  certainNothingWasSent: false,
};

/** Every copy state, for the exhaustiveness and honesty tests. */
export const CREATOR_TIP_COPY_STATES: readonly CreatorTipCopy[] = [
  SENT,
  BLOCKED,
  UNSENT,
  DECLINED,
  INDETERMINATE,
];

/**
 * The one place an outcome becomes words.
 *
 * @throws never. The `never` binding is a compile-time check; the `throw` is
 * unreachable in a type-checked build and exists so a hand-built object from an
 * untyped boundary cannot fall out of this function with `undefined`.
 */
export function creatorTipCopy(outcome: CreatorTipOutcome): CreatorTipCopy {
  switch (outcome.kind) {
    case "sent":
      return SENT;
    case "no-transport":
      return BLOCKED;
    case "unsendable":
      // Nothing was encoded, so nothing was handed to a transport. Saying the
      // wallet declined would name an app that was never contacted.
      return UNSENT;
    case "transport-failed":
      // A channel existed and threw. The request may have arrived; the answer
      // did not. We do not know.
      return INDETERMINATE;
    case "refused":
      // `NotConfirmed` is the only refusal this client can read as "the wallet
      // did not act": ZUULI returns it before `execute_send` is ever reached.
      // Every other status — `INTENT_UNAVAILABLE` above all — leaves the
      // question open, as do the local refusals (a malformed or unsolicited
      // answer tells us nothing about what the wallet did).
      return outcome.error === IntentErrorCode.NotConfirmed
        ? DECLINED
        : INDETERMINATE;
    default: {
      const unreachable: never = outcome;
      throw new Error(
        `unhandled creator tip outcome: ${JSON.stringify(unreachable)}`,
      );
    }
  }
}
