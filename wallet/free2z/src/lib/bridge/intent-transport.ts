/**
 * The ONE seam between this app's intent requests and the channel that carries
 * them to ZUULI.
 *
 * `docs/free2z/intent-bridge/PROTOCOL.md` §7 forbids dispatching an intent that
 * carries authority over anything but a **verified** App Link or Universal
 * Link: a custom scheme is not an authenticated channel — any app can register
 * `zuuli://` — so shipping on one would recreate #367's confused deputy at the
 * OS layer. #977 declared those links for all three apps and #1019 gave ZUULI
 * a listener on its own, so the channel now exists, and `./appLinkTransport`
 * is it.
 *
 * It exists only where the association does. `tauri.conf.json` declares it
 * under `plugins.deep-link.mobile`, so a desktop build or a plain browser has
 * no channel at all, and there the refusal below is still the whole story:
 *
 *   * There is exactly one interface, {@link IntentTransport}, with exactly one
 *     method. Everything the caller side does funnels through it.
 *   * {@link failClosedIntentTransport} rejects. It cannot succeed: there is no
 *     code path in it that returns bytes, so no amount of caller optimism can
 *     turn it into a fabricated receipt.
 *   * {@link installedIntentTransport} is **the one place the choice is made**:
 *     the App Link transport in a native mobile runtime, the refusal
 *     everywhere else.
 *
 * ## Why a rejection and not a `null`
 *
 * A nullable result is a value a caller can forget to check, and the thing
 * being forgotten would be "did this payment actually happen". The rejection
 * carries {@link IntentTransportUnavailableError}, which is a named type with a
 * stable `code`, so the UI can say something true about *why* nothing was sent
 * instead of guessing from a generic failure.
 *
 * ## What this seam must never grow
 *
 * Not an `invoke()`. free2z registers no `invoke_handler`, links neither wallet
 * plugin, and grants no `zcash:*` or `f2zmsg:*` capability (#904); a transport
 * that reached for a privileged command would be the boundary violation the
 * whole three-app split exists to prevent, not an implementation detail.
 * `wallet/zuuli/scripts/surface-capability-authority.mjs` fails on the
 * capability side; a reviewer must refuse it on this side.
 */

import { isMobileRuntime, isTauri, type RuntimeNavigator } from "@/lib/platform";
import { appLinkIntentTransport } from "./appLinkTransport";

/** The stable identifier for "there is no channel", for logs and tests. */
export const INTENT_TRANSPORT_UNAVAILABLE = "INTENT_TRANSPORT_UNAVAILABLE";

/** Why no channel exists, in one sentence a human can act on. */
export const INTENT_TRANSPORT_BLOCKED_REASON =
  "the verified App Link to cash.free2z.zuuli exists only in the iOS and Android apps";

/** Thrown by a transport that has no channel to offer. */
export class IntentTransportUnavailableError extends Error {
  /** Stable across builds; matched by tests and by the UI's failure branch. */
  readonly code = INTENT_TRANSPORT_UNAVAILABLE;

  constructor(readonly reason: string = INTENT_TRANSPORT_BLOCKED_REASON) {
    super(`intent transport unavailable: ${reason}`);
    this.name = "IntentTransportUnavailableError";
  }
}

/**
 * A channel that hands one encoded request to the wallet authority and returns
 * the encoded response bytes it got back.
 *
 * Deliberately narrow. It takes bytes and returns bytes: it does not know what
 * an intent is, cannot inspect one, and has no way to report a success on its
 * own — the returned bytes still have to survive
 * `IntentSession.accept`, which refuses anything that is not an answer to an
 * outstanding question. A transport is therefore untrusted plumbing by
 * construction, which is the correct standing for something that will
 * eventually be an operating-system link handler.
 *
 * # READ THIS BEFORE WIRING A REAL TRANSPORT IN
 *
 * **Response authenticity is your job, not the protocol's.** Everything on the
 * caller side of this seam correlates; nothing on it authenticates.
 *
 * What `creator-tip.ts` establishes about a response it accepts:
 *
 * - The responder **saw the request.** `request_id` is 32 CSPRNG bytes that
 *   appear in exactly one outbound message, so an app that never received the
 *   request cannot produce an answer this client will accept.
 *
 * What it does **not** establish, and cannot:
 *
 * - **That the responder is ZUULI.** An app that *received* the request holds
 *   the identifier and can answer with it. Correlation is not authentication.
 * - **That anything was signed or broadcast.** A `txid` is 32 bytes that
 *   arrived over this channel. ZUULI only emits one for
 *   `BroadcastStatus::Accepted`, but this side takes that on trust.
 *
 * There is **no signature over responses** to fall back on, and that is a
 * deliberate design decision rather than an omission —
 * `docs/free2z/intent-bridge/CALLER-AUTHENTICATION.md` §5: adding one would mint a
 * second wallet identity alongside the seed hierarchy to paper over a transport
 * gap. The transport is the right layer, which means **the security of this
 * whole path rests on the implementation that replaces
 * {@link failClosedIntentTransport}.**
 *
 * So the bar for that implementation is not "it delivers bytes":
 *
 * - **iOS** — a Universal Link, whose security property is that only the app
 *   whose team owns the `apple-app-site-association` receives it. A custom
 *   scheme is not a substitute: any app can register `zuuli://`, answer the
 *   request, and this client would accept the answer (#367 at the OS layer).
 * - **Android** — very likely `startActivityForResult` rather than an App Link,
 *   because `setResult` returns to the caller the system identified and
 *   `getCallingPackage()` names the sender. `CALLER-AUTHENTICATION.md` §3.1
 *   records that whether the two compose is **not measured**; measure it on a
 *   signed build on a device before choosing.
 * - **Never put a response payload in a URL query component.** §4.1: if the
 *   association degrades to the web, a query string lands in browser history,
 *   `Referer` headers and server logs. Use the fragment, or a one-use retrieval
 *   handle.
 * - **Normalize the path before you trust it.** Each app is given its own
 *   bridge path prefix, and those patterns are proven pairwise disjoint under
 *   raw, percent-decoded and dot-segment-normalized forms, so no two apps can
 *   ever both match one URL. That proof is about the *association document*;
 *   collapsing `..` is nevertheless the **receiving app's** job and nothing
 *   here does it. A path arriving as `.../free2z/../zuuli/x` is a different
 *   path once resolved, and an app that resolves it *after* matching has
 *   matched the wrong pattern. Resolve first, match second, and refuse a
 *   residual `..` rather than normalizing it away silently.
 */
export interface IntentTransport {
  /** A short stable name, for diagnostics. Never rendered as authority. */
  readonly id: string;
  /**
   * Deliver `request` and resolve with the response envelope.
   *
   * @throws {@link IntentTransportUnavailableError} when there is no channel.
   */
  exchange(
    request: Uint8Array,
    context: IntentExchangeContext,
  ): Promise<Uint8Array>;
}

/**
 * What an exchange is for, so a transport can correlate and time out without
 * parsing the bytes it carries. The same shape e2e2z's `IntentDispatchContext`
 * has.
 */
export interface IntentExchangeContext {
  /** The family name, from `intentFamilyName` — for logs only. */
  readonly family: string;
  /** The request identifier, lowercase hex. The response correlator. */
  readonly requestId: string;
  /** Wall-clock expiry of the request, milliseconds since the epoch. */
  readonly expiresAtMs: number;
}

/**
 * The transport for a runtime with no channel: it refuses, every time.
 *
 * Written so that the refusal is the only branch. There is no flag, no
 * environment check and no "if a wallet is installed" — those are the shapes
 * that decay into a channel nobody reviewed. The environment is decided once,
 * in {@link installedIntentTransport}, never in here.
 */
export const failClosedIntentTransport: IntentTransport = {
  id: "fail-closed",
  exchange(request: Uint8Array): Promise<Uint8Array> {
    void request;
    return Promise.reject(new IntentTransportUnavailableError());
  },
};

/**
 * The transport this runtime has: the verified App Link in a native iOS or
 * Android build, {@link failClosedIntentTransport} everywhere else.
 *
 * A function rather than a mutable binding, so there is no setter anywhere in
 * this app through which some other module could install a channel nobody
 * reviewed. `runtime` exists for the tests; production passes nothing.
 */
export function installedIntentTransport(
  runtime?: RuntimeNavigator,
): IntentTransport {
  return isTauri() && isMobileRuntime(runtime)
    ? appLinkIntentTransport
    : failClosedIntentTransport;
}
