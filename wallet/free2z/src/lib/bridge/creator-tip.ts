/**
 * Creator ZEC tip — the caller half of the intent bridge (#790, #905).
 *
 * In ZUULI this module's counterpart (`src/lib/wallet/creator-tip.ts`) issues a
 * nonce-keyed route state and the creator page navigates to
 * `/wallet/send/creator-tip`. That was the ONE import crossing from the social
 * surface into the wallet (#904), and it is the edge this app deliberately does
 * not have: there is no `/wallet` route here, no `zcash:*` capability, and no
 * plugin that could sign anything.
 *
 * What this app *can* do is **ask**. It builds a real `execute-payment` request
 * through `@free2z/wallet-shared` — the single implementation of the protocol —
 * hands it to the one transport seam, and judges the answer. The asymmetry is
 * the entire point of #367 and #904: free2z can propose a payment and can never
 * execute one, because ZUULI re-derives its own review, shows its own native
 * confirmation, and holds the only spending key.
 *
 * ## What changed, and what did not
 *
 * This file used to validate a tip destination and stop, because
 * `encodeExecutePaymentPayload` refuses `amountZatoshis <= 0` and **no tip
 * dialog collected a ZEC amount** — the product gap #790 names. The dialog now
 * collects one, so the request can be built for real.
 *
 * Every validation that was here before is still here, unchanged and still
 * fail-closed: the address/label/username bounds, the trim-equality rule, the
 * control-character rejection, the frozen snapshot, and the 32-entry cap.
 * `recordCreatorTipIntent` is the argument check it always was; the intent is
 * built *after* it passes, never instead of it.
 *
 * ## The three things this file will not do
 *
 * 1. **Invent a transport.** `docs/intent-bridge/PROTOCOL.md` §7 gates every
 *    authority-carrying dispatch on #461, so the request goes to
 *    `installedIntentTransport`, which refuses. See `./intent-transport`.
 * 2. **Re-implement the protocol.** It declares none of the five
 *    single-implementation names `wallet/zuuli/scripts/project-boundary.mjs`
 *    reserves, mints no label in the `free2z/intent/v1/` namespace, and writes
 *    no encoder, version gate or response matcher of its own.
 * 3. **Report a payment it cannot prove.** A txid is returned only when the
 *    response decoded, correlated to *this* request, named this family, arrived
 *    inside the window, carried status 0, and held exactly 32 bytes. Anything
 *    else is a refusal with a code, and the refusal is what the UI renders.
 *
 * ## What the correlation proves, and what it does not
 *
 * `request_id` is 32 CSPRNG bytes that appear in exactly one outbound message,
 * so a bystander who never saw the request cannot forge an answer to it. That
 * is the whole of it. `docs/intent-bridge/CALLER-AUTHENTICATION.md` §5 records
 * that **there is no signature over responses**: an app that *received* the
 * request holds the identifier and could answer, and nothing in these bytes
 * proves ZUULI wrote them. Response authenticity is a property of the
 * transport, and the transport is #461.
 *
 * The snapshot map lives in module memory only. Reloads lose it and fail
 * closed; creator payment details never enter web storage.
 */

import {
  IntentErrorCode,
  IntentFamily,
  createIntentSession,
  decodeExecutePaymentResult,
  encodeExecutePaymentPayload,
  intentErrorName,
  newRequestId,
  toHex,
} from "@free2z/wallet-shared";
import type { IntentRequest } from "@free2z/wallet-shared";
import {
  IntentTransportUnavailableError,
  installedIntentTransport,
  type IntentTransport,
} from "./intent-transport";

// The same bound the bridge's own outstanding-question map uses
// (`MAX_PENDING_INTENTS` in wallet/shared/src/intent/session.ts). Kept as a
// local literal rather than an import so this app takes on no dependency for a
// number; the sessions themselves are created below with their own capacity.
const MAX_RECORDED_INTENTS = 32;

/**
 * This app's own identifier, and it must equal ZUULI's registry entry.
 *
 * `REGISTERED_CALLERS` in `wallet/zuuli/src-tauri/src/intent.rs` maps this
 * exact string to the display name **ZUULI** renders. The value here is a
 * claim; the name a human sees comes from the wallet's registry and never from
 * this field (`CALLER-AUTHENTICATION.md` §2).
 */
export const CREATOR_TIP_CALLER = "cash.free2z.free2z";

/**
 * How long a tip request stays answerable, in milliseconds.
 *
 * Well under the protocol's 300 000 ms ceiling. #904: "nothing here is a
 * continuous grant" — two minutes is long enough for a person to read ZUULI's
 * confirmation and short enough that an unanswered request is not a standing
 * offer.
 */
export const CREATOR_TIP_LIFETIME_MS = 120_000;

/**
 * The fee this app expects, in zatoshis: ZIP-317's conventional minimum.
 *
 * **Advisory, and it is the wallet's number that governs.** ZUULI computes the
 * fee from its own ZIP-317 rule over its own notes and shows that; when its
 * figure differs from this one it says so in the confirmation
 * (`format_payment_confirmation`). Declaring the conventional minimum rather
 * than zero keeps that line meaningful: it appears when the payment really is
 * costlier than a simple send, instead of on every single tip.
 */
export const CREATOR_TIP_EXPECTED_FEE_ZATOSHIS = 10_000n;

export interface CreatorTipIntent {
  readonly username: string;
  readonly label: string;
  readonly recipient: string;
}

const pendingCreatorTips: CreatorTipIntent[] = [];

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function isBoundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    codePointLength(value) <= maximum &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

/** The same acceptance ZUULI applies before a tip may reach Wallet Send. */
export function isCreatorTipSource(value: CreatorTipIntent): boolean {
  return (
    isBoundedText(value.username, 150) &&
    isBoundedText(value.label, 128) &&
    isBoundedText(value.recipient, 255) &&
    !/\s/u.test(value.recipient)
  );
}

/**
 * Validate and retain a tip intent.
 *
 * Throws for the same inputs ZUULI rejects, so the creator page's error path is
 * unchanged: a creator without a usable ZEC address is reported as such rather
 * than being offered a handoff that would fail later.
 */
export function recordCreatorTipIntent(
  source: CreatorTipIntent,
): CreatorTipIntent {
  if (!isCreatorTipSource(source)) {
    throw new Error("Creator ZEC tip details are missing or malformed");
  }

  const intent = Object.freeze({
    username: source.username,
    label: source.label,
    recipient: source.recipient,
  });
  pendingCreatorTips.push(intent);
  while (pendingCreatorTips.length > MAX_RECORDED_INTENTS) {
    pendingCreatorTips.shift();
  }
  return intent;
}

/** The intents recorded this session, oldest first. Bounded, never persisted. */
export function pendingCreatorTipIntents(): readonly CreatorTipIntent[] {
  return Object.freeze([...pendingCreatorTips]);
}

/** Drop every recorded intent (sign-out, and the test seam). */
export function clearCreatorTipIntents(): void {
  pendingCreatorTips.length = 0;
}

/**
 * The reason string ZUULI renders as "its stated reason, in its own words".
 *
 * Built from the **username** rather than the display name: the username is the
 * identity a payer can check against the page they came from, and it is the one
 * this app can also put in a URL. It is quoted and escaped by ZUULI before it
 * reaches a screen, and it is bridge text here, so a name carrying a
 * bidirectional override never reaches the confirmation at all — the request
 * fails to encode instead.
 */
export function creatorTipPurpose(username: string): string {
  return `Tip ${username} on free2z`;
}

/** Why a tip request could not be completed, and nothing was sent. */
export type CreatorTipFailure =
  /** This app could not build a sendable request. Nothing left the process. */
  | { readonly kind: "unsendable"; readonly error: IntentErrorCode }
  /** There is no channel to the wallet. See #461 and `./intent-transport`. */
  | { readonly kind: "no-transport"; readonly reason: string }
  /** A channel existed and failed. No response was judged. */
  | { readonly kind: "transport-failed"; readonly detail: string }
  /** An answer arrived and was refused: unsolicited, malformed, or a "no". */
  | { readonly kind: "refused"; readonly error: IntentErrorCode };

/** A tip that ZUULI confirmed, signed and broadcast. */
export interface CreatorTipSent {
  readonly kind: "sent";
  /** Lowercase hex of the 32 response bytes. Never shown unless it is here. */
  readonly txid: string;
}

export type CreatorTipOutcome = CreatorTipSent | CreatorTipFailure;

/** The stable diagnostic name for a failure, for logs and tests. */
export function creatorTipFailureName(failure: CreatorTipFailure): string {
  return failure.kind === "no-transport"
    ? "INTENT_TRANSPORT_UNAVAILABLE"
    : failure.kind === "transport-failed"
      ? "INTENT_TRANSPORT_FAILED"
      : intentErrorName(failure.error);
}

/**
 * Build the encoded `execute-payment` request for one validated tip.
 *
 * Separate from the exchange so the bytes are testable on their own, and so the
 * one place a request is constructed is the one place its bounds are decided.
 * Every bound below is also enforced by the encoder — the request would refuse
 * to encode — but stating the family, window and caller here keeps them
 * reviewable rather than implied.
 */
function creatorTipRequest(
  intent: CreatorTipIntent,
  amountZatoshis: number,
  nowMs: number,
): IntentRequest | null {
  const payload = encodeExecutePaymentPayload({
    recipient: intent.recipient,
    // The bridge carries `uint64`, and `amountZatoshis` is an exact integer
    // count of zatoshis produced by `parseZecToZatoshis` — never a float
    // multiplied by 1e8. `BigInt(x)` throws on a non-integer, which is the
    // behaviour we want if a caller ever hands this a rounded value.
    amountZatoshis: BigInt(amountZatoshis),
    // Empty on purpose. A memo is on-chain data the payer authors, and the
    // surface that can show them what they are attaching is ZUULI's own send
    // review — the same reason the amount used to live there. The amount had to
    // move because free2z is where the *tip* is chosen; the memo did not.
    memo: "",
    feeZatoshis: CREATOR_TIP_EXPECTED_FEE_ZATOSHIS,
  });
  if (!payload.ok) return null;
  return {
    intent: IntentFamily.ExecutePayment,
    requestId: newRequestId(),
    caller: CREATOR_TIP_CALLER,
    purpose: creatorTipPurpose(intent.username),
    issuedAtMs: nowMs,
    expiresAtMs: nowMs + CREATOR_TIP_LIFETIME_MS,
    payload: payload.value,
  };
}

/**
 * Ask ZUULI to send a creator tip, and judge the answer as if it were hostile.
 *
 * The source is validated by {@link recordCreatorTipIntent} first, so this
 * throws exactly what that throws for a creator with no usable address; every
 * *other* failure is a returned {@link CreatorTipFailure}, because "nothing was
 * sent, and here is why" is information the payer needs rather than an
 * exception the UI has to interpret.
 *
 * ## One question per exchange
 *
 * The outstanding-question map is created here, per call, with capacity one.
 * That is not thrift — it is the correlation. `IntentSession.accept` matches a
 * response by identifier and returns the family and payload, but not *which*
 * question was answered; with a shared map and two tips in flight, an answer to
 * the second could be read as an answer to the first. A session holding exactly
 * one question cannot make that mistake: any response that is not the answer to
 * this request finds nothing outstanding and is `INTENT_UNSOLICITED`. The entry
 * is consumed whether it is accepted or refused, so a replayed response fails
 * the second time too.
 */
export async function requestCreatorTipPayment(
  source: CreatorTipIntent,
  amountZatoshis: number,
  {
    transport = installedIntentTransport,
    now = Date.now(),
  }: { transport?: IntentTransport; now?: number } = {},
): Promise<CreatorTipOutcome> {
  const intent = recordCreatorTipIntent(source);
  // This checks representability, and NOT positivity. The two are a deliberate
  // split rather than one condition:
  //
  //   * `Number.isSafeInteger` is this function's own rule and nothing else
  //     enforces it. `BigInt(0.5)` throws a `RangeError`, which is not an
  //     `IntentRefusal`, so `outcome()` rethrows it and the caller gets a
  //     rejected promise instead of a refusal it can render. Pinned by
  //     `refuses a fractional amount without throwing`.
  //   * **Positivity belongs to the encoder** (`PROTOCOL.md` §3.4), and is
  //     deliberately not repeated here. It used to be, and the mutation matrix
  //     showed why that was worse than useless: `amountZatoshis <= 0` in this
  //     function and `<= 0n` in `encodeExecutePaymentPayload` produced the same
  //     refusal at the same point, so no test could tell them apart and either
  //     could have been deleted with the suite green. A duplicate that no test
  //     can distinguish is not defence in depth — it is one guard plus a decoy
  //     that makes the matrix look better than it is.
  //
  // A non-positive amount is still refused before `session.issue`, before the
  // transport, and before any amount is rendered beside a creator's name —
  // `creatorTipRequest` returns `null` and this function returns `unsendable`.
  if (!Number.isSafeInteger(amountZatoshis)) {
    return { kind: "unsendable", error: IntentErrorCode.InvalidValue };
  }

  const request = creatorTipRequest(intent, amountZatoshis, now);
  if (request === null) {
    return { kind: "unsendable", error: IntentErrorCode.InvalidValue };
  }

  const session = createIntentSession(1);
  const issued = session.issue(request, now);
  if (!issued.ok) return { kind: "unsendable", error: issued.error };

  let answer: Uint8Array;
  try {
    answer = await transport.exchange(issued.value);
  } catch (error) {
    if (error instanceof IntentTransportUnavailableError) {
      return { kind: "no-transport", reason: error.reason };
    }
    return {
      kind: "transport-failed",
      detail: error instanceof Error ? error.name : "unknown",
    };
  }
  if (!(answer instanceof Uint8Array)) {
    // A transport that returns something else is broken, not hostile — but the
    // decoder would throw rather than refuse, and a thrown decoder is how a
    // caller ends up in a catch block deciding what a payment meant.
    return { kind: "refused", error: IntentErrorCode.Malformed };
  }

  // Judged against the frozen record, at the time the answer arrived: version
  // gate, re-encode equality, identifier, family, window, status. Every one of
  // those is `@free2z/wallet-shared`'s, not this app's.
  const accepted = session.accept(answer, Date.now());
  if (!accepted.ok) return { kind: "refused", error: accepted.error };
  if (accepted.value.intent !== IntentFamily.ExecutePayment) {
    return { kind: "refused", error: IntentErrorCode.UnknownIntent };
  }

  const txid = decodeExecutePaymentResult(accepted.value.payload);
  if (!txid.ok) return { kind: "refused", error: txid.error };
  return { kind: "sent", txid: toHex(txid.value) };
}
