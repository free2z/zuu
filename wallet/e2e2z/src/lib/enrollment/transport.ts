/**
 * The one seam where intent bytes would leave this process — and it is shut.
 *
 * Everything else in `src/lib/enrollment/` is finished work: this app can
 * sample its device keys, build a byte-exact `issue-device-credential` request,
 * remember it, and judge an answer. What it cannot do is **send** one, and this
 * module is the single place that is true.
 *
 * ## Why there is no transport, stated as the docs state it
 *
 * `docs/intent-bridge/PROTOCOL.md` §7 and
 * `docs/intent-bridge/CALLER-AUTHENTICATION.md` §4 draw the same line twice:
 *
 * - **A custom scheme is not an authenticated channel.** Any app can register
 *   `zuuli://`. Shipping the response half over one would let a hostile app
 *   register the response link and answer with a `DeviceCredential` this app
 *   would then install — [#367](https://github.com/free2z/zuu/issues/367)'s
 *   confused deputy, moved from the frame layer to the OS layer.
 * - **What replaces it is domain-bound.** A verified App Link or Universal Link
 *   reaches only the app whose package or team owns the domain association,
 *   which needs `assetlinks.json` and `apple-app-site-association` served from
 *   a domain we control — [#461](https://github.com/free2z/zuu/issues/461),
 *   still blocked.
 *
 * §7 therefore says, without qualification: *no intent carrying authority may
 * be dispatched over a deep link* until that lands. `issue-device-credential`
 * carries authority.
 *
 * ## The shape of the seam
 *
 * One interface, one method, one fail-closed implementation, and a module-level
 * registry so that a real transport is a single registration rather than an
 * edit spread through the enrollment path. When #461 lands, the work is to
 * write an `IntentTransport` and call {@link setIntentTransport} — not to
 * unpick a refusal from the middle of a flow.
 *
 * ## Two independent guards, on purpose
 *
 * {@link IntentTransport.available} is what the enrollment client checks
 * *before* it samples device keys, because sampling a device key set for a
 * request that cannot be sent discards the previous one for nothing
 * (`src-tauri/src/device.rs`). {@link unavailableIntentTransport.dispatch}
 * refuses **anyway**, and refuses unconditionally — it does not read the flag.
 * So flipping `available` to `true` does not produce a success; it produces the
 * same typed refusal one step later. A guard that can be defeated by editing
 * one boolean is not a guard, and
 * `src/lib/enrollment/transport.test.ts` pins exactly that.
 */

/** What a dispatch is for, so a real transport can log and route without parsing. */
export interface IntentDispatchContext {
  /** The family name, from `intentFamilyName` — for logs only. */
  readonly family: string;
  /** The request identifier, hex. The response correlator; never a secret. */
  readonly requestId: string;
  /** Wall-clock expiry of the request, milliseconds since the epoch. */
  readonly expiresAtMs: number;
}

/**
 * Carry a request to the wallet authority and bring back its answer.
 *
 * An implementation MUST NOT interpret the bytes. Correlation, family, window
 * and status are re-checked by the session in
 * `@free2z/wallet-shared`; a transport that decided anything for itself would
 * be a second implementation of the guard the boundary scanner exists to
 * forbid.
 */
export interface IntentTransport {
  /** A stable name for logs and for tests to assert against. */
  readonly id: string;
  /**
   * Whether this transport can both deliver a request **and** receive a
   * response over a channel that authenticates its destination.
   *
   * Both halves, because half of it is worthless: a channel that delivers but
   * cannot authenticate the answer is exactly the confused deputy §4 describes.
   */
  readonly available: boolean;
  /** The response envelope, verbatim. Rejects rather than resolving on failure. */
  dispatch(
    request: Uint8Array,
    context: IntentDispatchContext,
  ): Promise<Uint8Array>;
}

/**
 * The refusal, thrown wherever an intent would have travelled.
 *
 * Typed, with a machine-readable `reason`, so no caller has to match on prose
 * and no caller can mistake it for a network error worth retrying. There is
 * nothing to retry: the transport does not exist.
 */
export class IntentTransportUnavailableError extends Error {
  /** Machine-readable, and structured-clone survivable. */
  readonly reason = "intent-transport-not-built" as const;
  /** The issue that unblocks this, so a log line carries its own next step. */
  readonly blockedOn = 461 as const;
  /** The family that was refused, for logs. */
  readonly family: string;

  constructor(family: string) {
    super(
      `the ${family} intent cannot be dispatched: e2e2z has no authenticated ` +
        "transport to the wallet authority. A custom-scheme deep link does not " +
        "authenticate its sender or its receiver, so no intent carrying " +
        "authority may travel over one (docs/intent-bridge/PROTOCOL.md §7). " +
        "Verified App Links and Universal Links are issue #461.",
    );
    this.name = "IntentTransportUnavailableError";
    this.family = family;
  }
}

/** Whether a caught value is the transport refusal, prototype or not. */
export function isIntentTransportUnavailable(
  error: unknown,
): error is IntentTransportUnavailableError {
  return (
    error instanceof IntentTransportUnavailableError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { reason?: unknown }).reason === "intent-transport-not-built")
  );
}

/**
 * The shipping transport: none.
 *
 * It **throws**. It never resolves, and in particular it never resolves to
 * bytes — because a transport that returned a plausible response envelope
 * would be a transport that fabricated a `DeviceCredential`, and this app would
 * install it. `docs/e2ee/CLIENT-CONTRACT.md` §2.4's rule is that nothing here
 * may synthesize an `EnrollmentStatus`; synthesizing the credential that
 * produces one would be the same defect wearing a hat.
 */
export const unavailableIntentTransport: IntentTransport = {
  id: "unavailable",
  available: false,
  dispatch(_request: Uint8Array, context: IntentDispatchContext): Promise<never> {
    // Deliberately not gated on `available`. See the module note.
    return Promise.reject(new IntentTransportUnavailableError(context.family));
  },
};

let active: IntentTransport = unavailableIntentTransport;

/** The transport the enrollment client will use. */
export function intentTransport(): IntentTransport {
  return active;
}

/**
 * Install a transport.
 *
 * The only production caller this will ever have is #461's App Link surface.
 * Until then it exists so the tests can drive the *shipping* code path against
 * a wallet stand-in, rather than proving a parallel one works.
 */
export function setIntentTransport(transport: IntentTransport): void {
  active = transport;
}

/** Restore the fail-closed default. */
export function resetIntentTransport(): void {
  active = unavailableIntentTransport;
}
