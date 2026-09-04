/**
 * Refusals, and the wire statuses they correspond to.
 *
 * The numbers here are the same numbers `rs/crates/f2z-intent/src/error.rs`
 * defines, and they are stable forever for the same reason: a client built
 * against version 1 must still be able to log a refusal a newer wallet minted.
 *
 * ## Why refusals are thrown internally and returned at the boundary
 *
 * Every decode step can refuse, and threading a result type through a byte
 * reader turns twenty lines of parsing into eighty lines of plumbing that a
 * reader has to check for a forgotten early return. So the internals throw
 * [`IntentRefusal`] and the public entry points catch it exactly once, at the
 * boundary, and hand back a discriminated [`IntentOutcome`]. The public API
 * never throws on bad input — only on a caller passing something that is not a
 * `Uint8Array` at all, which is a programming error rather than a message.
 */

/** Every refusal the bridge can produce, with its stable wire status. */
export const IntentErrorCode = {
  /** Not a well-formed envelope, or trailing data, or a re-encode mismatch. */
  Malformed: 1,
  /** A protocol version this build does not implement. */
  UnsupportedVersion: 2,
  /** An intent family this build does not implement. */
  UnknownIntent: 3,
  /** A field a version-1 message may not hold. */
  InvalidValue: 4,
  /** The validity window has closed. */
  Expired: 5,
  /** Dated in the future, or a clock moved backwards past issuance. */
  NotYetValid: 6,
  /** Already used. */
  Replay: 7,
  /** The one-use record is full and pruning freed nothing. */
  LedgerFull: 8,
  /** No confirmation, or one that binds a different request. */
  NotConfirmed: 9,
  /** The caller is not registered, or the platform contradicted its claim. */
  CallerNotAuthorized: 10,
  /** A response to a question this client never asked. */
  Unsolicited: 11,
  /**
   * The wallet understood the request but could not act on it: no wallet
   * open, the payment cannot be funded, the network is unreachable, or a
   * broadcast did not complete.
   *
   * Deliberately distinct from {@link IntentErrorCode.InvalidValue}: a
   * request the wallet cannot fund is not a malformed request, and a caller
   * told otherwise will "fix" a message that was already correct. It carries
   * no detail — "insufficient funds" would be a balance oracle.
   */
  Unavailable: 12,
} as const;

/** One of {@link IntentErrorCode}'s values. */
export type IntentErrorCode =
  (typeof IntentErrorCode)[keyof typeof IntentErrorCode];

const NAMES: ReadonlyMap<IntentErrorCode, string> = new Map([
  [IntentErrorCode.Malformed, "INTENT_MALFORMED"],
  [IntentErrorCode.UnsupportedVersion, "INTENT_UNSUPPORTED_VERSION"],
  [IntentErrorCode.UnknownIntent, "INTENT_UNKNOWN_INTENT"],
  [IntentErrorCode.InvalidValue, "INTENT_INVALID_VALUE"],
  [IntentErrorCode.Expired, "INTENT_EXPIRED"],
  [IntentErrorCode.NotYetValid, "INTENT_NOT_YET_VALID"],
  [IntentErrorCode.Replay, "INTENT_REPLAY"],
  [IntentErrorCode.LedgerFull, "INTENT_LEDGER_FULL"],
  [IntentErrorCode.NotConfirmed, "INTENT_NOT_CONFIRMED"],
  [IntentErrorCode.CallerNotAuthorized, "INTENT_CALLER_NOT_AUTHORIZED"],
  [IntentErrorCode.Unsolicited, "INTENT_UNSOLICITED"],
  [IntentErrorCode.Unavailable, "INTENT_UNAVAILABLE"],
] as const);

/** The stable screaming-snake name for a status, for logs. */
export function intentErrorName(code: IntentErrorCode): string {
  return NAMES.get(code) ?? `INTENT_UNKNOWN_STATUS_${code}`;
}

/** The refusal a status names, or `null` if this build has never heard of it. */
export function intentErrorFromStatus(status: number): IntentErrorCode | null {
  if (!Number.isInteger(status) || status <= 0) return null;
  return NAMES.has(status as IntentErrorCode) ? (status as IntentErrorCode) : null;
}

/** Thrown internally; never escapes a public entry point. */
export class IntentRefusal extends Error {
  constructor(readonly code: IntentErrorCode) {
    super(intentErrorName(code));
    this.name = "IntentRefusal";
  }
}

/** Refuse. Declared to return `never` so callers need no unreachable branch. */
export function refuse(code: IntentErrorCode): never {
  throw new IntentRefusal(code);
}

/** Success, or a refusal. Never a partially-believed value. */
export type IntentOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: IntentErrorCode };

/**
 * Run `body`, converting the one refusal it may throw into an outcome.
 *
 * Any *other* throw propagates. That distinction is the point: a malformed
 * message is data and must produce a refusal, while a bug in this package is
 * not data and must not be laundered into "the message was bad".
 */
export function outcome<T>(body: () => T): IntentOutcome<T> {
  try {
    return { ok: true, value: body() };
  } catch (error) {
    if (error instanceof IntentRefusal) return { ok: false, error: error.code };
    throw error;
  }
}
