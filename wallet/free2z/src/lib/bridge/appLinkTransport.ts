/**
 * The App Link transport — the channel `./intent-transport` held shut until a
 * verified link to ZUULI existed (#977) and ZUULI listened on it (#1019).
 *
 * ```text
 *   exchange(bytes)
 *     ▼  openUrl                        (tauri-plugin-opener; no invoke)
 *   https://free2z.com/bridge/zuuli/#req=<hex>
 *     ▼  the OS resolves the association and ZUULI is opened
 *   ZUULI: admit, confirm natively, pay
 *     ▼
 *   https://free2z.com/bridge/free2z/#res=<hex>&rid=<hex>
 *     ▼  onOpenUrl
 *   the pending exchange resolves with the response bytes, verbatim
 * ```
 *
 * Mirrors e2e2z's `src/lib/enrollment/appLinkTransport.ts`, with one
 * deliberate difference: e2e2z opens the link through an app-crate command,
 * and this app registers no `invoke_handler` at all (#904). So the URL is
 * built here and handed to `openUrl`, the same path `./e2e2z-chat.ts` already
 * uses under the `opener:default` grant this app has. The destination is a
 * constant and the payload is `toHex` output, so nothing a caller supplies is
 * ever interpolated into the link.
 *
 * The {@link IntentTransport} contract forbids interpreting the bytes:
 * correlation, family, window and status are re-checked by
 * `IntentSession.accept` in `./creator-tip`. This reads only the response hex
 * and `rid`, and `rid` is used for what {@link IntentExchangeContext} hands it
 * over for — telling this exchange's answer from any other.
 *
 * ## Every failure after the link opens is "unknown", never "not sent"
 *
 * Once `openUrl` has resolved, ZUULI may have the request, and ZUULI may pay.
 * A timeout, or an answer lost because the OS killed this app while ZUULI was
 * confirming, says nothing about whether money moved. So none of them is an
 * `IntentTransportUnavailableError` — that type means "no channel", which the
 * tip dialog renders as "nothing was sent". They surface as a broken channel,
 * which the dialog renders as "check your wallet".
 *
 * ## One exchange in flight
 *
 * A second tip while the first is waiting is refused, typed, rather than
 * queued: two outstanding payments whose answers can arrive in either order
 * are exactly the attribution problem `requestCreatorTipPayment` exists to
 * avoid. `rid` is checked on top of that, so a late answer to an abandoned
 * exchange cannot resolve the one that replaced it.
 *
 * ## Cold start is not handled
 *
 * If the OS kills this app while ZUULI is confirming, the answer arrives with
 * nothing waiting and is ignored. The payment itself is ZUULI's and is
 * unaffected; the reader is sent to their wallet to see it.
 */

import { openUrl } from "@tauri-apps/plugin-opener";
import { fromHex, toHex } from "@free2z/wallet-shared";
import { isMobileRuntime, isTauri, type RuntimeNavigator } from "@/lib/platform";
import type {
  IntentExchangeContext,
  IntentTransport,
} from "./intent-transport";

/** #977. */
const ASSOCIATION_HOST = "free2z.com";

/**
 * Where the request goes: ZUULI's own bridge prefix, the constant e2e2z's
 * `AUTHORITY_BRIDGE_URL` names too. A constant, never an argument: a caller
 * that could name the authority could name an app it owns.
 */
export const AUTHORITY_BRIDGE_URL = "https://free2z.com/bridge/zuuli/";

/**
 * The path ZUULI answers on — its registry's `reply_to` for this caller,
 * `https://free2z.com/bridge/free2z/`, exactly.
 *
 * Exact rather than a prefix, and compared after `URL` has resolved dot
 * segments and their percent-encoded forms, so `/bridge/free2z/../zuuli/`
 * is judged as the path it really names.
 */
export const REPLY_PATH = "/bridge/free2z/";

const REQUEST_KEY = "req";

const RESPONSE_KEY = "res";

const CORRELATOR_KEY = "rid";

/** An exchange that is waiting for its answer. */
interface PendingExchange {
  /** Lowercase hex, from {@link IntentExchangeContext.requestId}. */
  readonly requestId: string;
  readonly resolve: (response: Uint8Array) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** ZUULI did not answer before the request expired. It may still have acted. */
export class IntentResponseTimeoutError extends Error {
  readonly reason = "intent-response-timeout" as const;
  readonly family: string;

  constructor(family: string) {
    super(
      `the ${family} intent expired before the wallet authority answered. ` +
        "The wallet may still have acted on it, and its identifier is " +
        "one-use, so a retry is a new request rather than a resend.",
    );
    this.name = "IntentResponseTimeoutError";
    this.family = family;
  }
}

/** The platform would not open the authority's link. */
export class AuthorityLinkError extends Error {
  readonly reason = "authority-link-failed" as const;
  /** Declared, not `Error`'s ES2022 `options.cause`. */
  readonly cause?: unknown;

  constructor(cause: unknown) {
    super(
      `the wallet authority's link could not be opened: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = "AuthorityLinkError";
    this.cause = cause;
  }
}

/** A second exchange attempted while one was still outstanding. */
export class IntentExchangeBusyError extends Error {
  readonly reason = "intent-exchange-in-flight" as const;

  constructor() {
    super(
      "another request is already waiting for the wallet authority. Only one " +
        "may be outstanding, so every answer belongs to exactly one tip.",
    );
    this.name = "IntentExchangeBusyError";
  }
}

let pending: PendingExchange | null = null;

/** Settle and clear whatever is outstanding. */
function settle(outcome: (exchange: PendingExchange) => void): void {
  const exchange = pending;
  if (!exchange) return;
  pending = null;
  clearTimeout(exchange.timer);
  outcome(exchange);
}

/** The value of `key` in an `a=1&b=2` fragment. */
function fragmentValue(fragment: string, key: string): string | null {
  for (const pair of fragment.split("&")) {
    const at = pair.indexOf("=");
    if (at > 0 && pair.slice(0, at) === key) return pair.slice(at + 1);
  }
  return null;
}

/** The link that carries `request` to ZUULI, payload in the fragment (§4.1). */
export function authorityLink(request: Uint8Array): string {
  return `${AUTHORITY_BRIDGE_URL}#${REQUEST_KEY}=${toHex(request)}`;
}

/**
 * The answer carried by `raw`, if it is an inbound reply to this app.
 *
 * Same four conditions as e2e2z's: a custom scheme authenticates nobody, the
 * association is bound to one host, the path is the one ZUULI answers on (see
 * {@link REPLY_PATH}), and `CALLER-AUTHENTICATION.md` §4.1 forbids the query
 * component.
 */
export function inboundAnswer(
  raw: string,
): { response: Uint8Array; requestId: string } | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.hostname !== ASSOCIATION_HOST) return null;
  if (url.pathname !== REPLY_PATH) return null;
  if (url.search !== "") return null;

  // `URL.hash` keeps its leading `#`.
  const fragment = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  const responseHex = fragmentValue(fragment, RESPONSE_KEY);
  const requestId = fragmentValue(fragment, CORRELATOR_KEY);
  if (!responseHex || !requestId) return null;

  try {
    return { response: fromHex(responseHex), requestId };
  } catch {
    // Unusable rather than hostile: a truncated link is indistinguishable from
    // a corrupt one, and neither is an answer.
    return null;
  }
}

/** Exported for the tests: `onOpenUrl` cannot be provoked from a unit test. */
export function deliverInbound(raw: string): void {
  const answer = inboundAnswer(raw);
  if (!answer) return;
  if (!pending) return;
  // A late answer to an exchange that was abandoned must not resolve the one
  // that replaced it.
  if (answer.requestId !== pending.requestId) return;
  settle((exchange) => exchange.resolve(answer.response));
}

/**
 * Deliver over the verified App Link, receive over this app's own.
 *
 * Reachable only through `installedIntentTransport`, which returns it in a
 * native mobile runtime and nowhere else.
 */
export const appLinkIntentTransport: IntentTransport = {
  id: "app-link",
  exchange(
    request: Uint8Array,
    context: IntentExchangeContext,
  ): Promise<Uint8Array> {
    if (pending) return Promise.reject(new IntentExchangeBusyError());

    return new Promise<Uint8Array>((resolve, reject) => {
      // The request's own deadline, not a transport-invented one: ZUULI refuses
      // an expired intent anyway, so waiting past it can only produce an answer
      // that would be rejected.
      const remaining = Math.max(0, context.expiresAtMs - Date.now());
      const timer = setTimeout(() => {
        settle((exchange) =>
          exchange.reject(new IntentResponseTimeoutError(context.family)),
        );
      }, remaining);

      pending = { requestId: context.requestId, resolve, reject, timer };

      void openUrl(authorityLink(request)).catch((error: unknown) => {
        settle((exchange) => exchange.reject(new AuthorityLinkError(error)));
      });
    });
  },
};

/**
 * Listen for ZUULI's answers — in a native **mobile** runtime only, the same
 * runtime `installedIntentTransport` hands {@link appLinkIntentTransport} to.
 *
 * Called once at startup. If the deep-link plugin does not load, an exchange
 * still opens the authority's link and then expires on its own deadline, which
 * the tip dialog reports as "check your wallet" — the truth when no answer can
 * arrive. `runtime` exists for the tests; production passes nothing.
 */
export function listenForAuthorityAnswers(runtime?: RuntimeNavigator): void {
  if (!isTauri()) return;
  if (!isMobileRuntime(runtime)) return;
  void (async () => {
    try {
      const { onOpenUrl } = await import("@tauri-apps/plugin-deep-link");
      await onOpenUrl((urls) => {
        for (const url of urls) deliverInbound(url);
      });
    } catch {
      // See the doc comment: the exchange times out instead of hanging.
    }
  })();
}

/** Drop any outstanding exchange. For tests, which must not leak a timer. */
export function resetAppLinkTransportForTests(): void {
  settle((exchange) =>
    exchange.reject(new Error("the transport was reset between tests")),
  );
}
