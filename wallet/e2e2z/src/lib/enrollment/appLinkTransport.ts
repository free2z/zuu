/**
 * The App Link transport — the `IntentTransport` `transport.ts` said #461
 * would make writable, now that #977 has landed it.
 *
 * ```text
 *   dispatch(bytes)
 *     ▼  e2e2z_dispatch_intent          (Rust opens the link; no capability)
 *   https://free2z.com/bridge/zuuli/#req=<hex>
 *     ▼  the OS resolves the association and ZUULI is opened
 *   ZUULI: admit, confirm natively, act
 *     ▼
 *   https://free2z.com/bridge/e2e2z/#res=<hex>&rid=<hex>
 *     ▼  onOpenUrl
 *   the pending dispatch resolves with the response bytes, verbatim
 * ```
 *
 * The {@link IntentTransport} contract forbids interpreting the bytes:
 * correlation, family, window and status are re-checked by
 * `IntentSession.accept`. So this reads only the response hex and `rid` — and
 * `rid` is handed over by {@link IntentDispatchContext} as the response
 * correlator, which is what it is used for.
 *
 * ## One request in flight
 *
 * `prepare_device` replaces the pending key set, so a second concurrent
 * dispatch would be answered over keys the engine already discarded. The
 * refusal is typed so a caller can tell it from a timeout. `rid` is checked on
 * top of that, so a late answer to an abandoned attempt cannot resolve the one
 * that replaced it.
 *
 * ## Cold start is not handled
 *
 * If the OS kills this app while ZUULI is confirming, the answer arrives with
 * no pending dispatch and is ignored. Persisting one would hold an authority
 * round trip open across a process boundary; enrolling again is cheaper.
 */

import { fromHex } from "@free2z/wallet-shared";
import { isTauri } from "../platform";
import {
  setIntentTransport,
  type IntentDispatchContext,
  type IntentTransport,
} from "./transport";

/** #977. */
const ASSOCIATION_HOST = "free2z.com";

const INBOUND_PATH_PREFIX = "/bridge/e2e2z/";

const RESPONSE_KEY = "res";

const CORRELATOR_KEY = "rid";

/** A dispatch that is waiting for its answer. */
interface PendingDispatch {
  /** Lowercase hex, from {@link IntentDispatchContext.requestId}. */
  readonly requestId: string;
  readonly resolve: (response: Uint8Array) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** Typed so a caller can tell "never answered" from "refused". */
export class IntentResponseTimeoutError extends Error {
  readonly reason = "intent-response-timeout" as const;
  readonly family: string;

  constructor(family: string) {
    super(
      `the ${family} intent expired before the wallet authority answered. ` +
        "The request is spent either way: its identifier is one-use, so a " +
        "retry is a new request rather than a resend.",
    );
    this.name = "IntentResponseTimeoutError";
    this.family = family;
  }
}

/** A second dispatch attempted while one was still outstanding. */
export class IntentDispatchBusyError extends Error {
  readonly reason = "intent-dispatch-in-flight" as const;

  constructor() {
    super(
      "another intent is already waiting for the wallet authority. Only one " +
        "may be outstanding: this device samples one key set per enrollment, " +
        "and a second request would be answered over keys already discarded.",
    );
    this.name = "IntentDispatchBusyError";
  }
}

let pending: PendingDispatch | null = null;

/** Settle and clear whatever is outstanding. */
function settle(outcome: (dispatch: PendingDispatch) => void): void {
  const dispatch = pending;
  if (!dispatch) return;
  pending = null;
  clearTimeout(dispatch.timer);
  outcome(dispatch);
}

/** The value of `key` in an `a=1&b=2` fragment. */
function fragmentValue(fragment: string, key: string): string | null {
  for (const pair of fragment.split("&")) {
    const at = pair.indexOf("=");
    if (at > 0 && pair.slice(0, at) === key) return pair.slice(at + 1);
  }
  return null;
}

/**
 * The answer carried by `raw`, if it is an inbound reply to this app.
 *
 * Same four conditions as the authority side: a custom scheme authenticates
 * nobody, the association is bound to one host, the prefix is what this app
 * claimed, and §4.1 forbids the query component.
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
  if (!url.pathname.startsWith(INBOUND_PATH_PREFIX)) return null;

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
  // A late answer to an attempt that was abandoned must not resolve the one
  // that replaced it.
  if (answer.requestId !== pending.requestId) return;
  settle((dispatch) => dispatch.resolve(answer.response));
}

/** Open the authority's link through the app-crate command that owns the URL. */
async function openAuthorityLink(request: Uint8Array): Promise<void> {
  const [{ invoke }, { toHex }] = await Promise.all([
    import("@tauri-apps/api/core"),
    import("@free2z/wallet-shared"),
  ]);
  await invoke("e2e2z_dispatch_intent", { args: { request: toHex(request) } });
}

/**
 * `available` holds on both halves `transport.ts` requires: it delivers over a
 * verified App Link and receives over one, so the answer reaches only the app
 * that owns the association (`CALLER-AUTHENTICATION.md` §4).
 */
export const appLinkIntentTransport: IntentTransport = {
  id: "app-link",
  available: true,
  dispatch(
    request: Uint8Array,
    context: IntentDispatchContext,
  ): Promise<Uint8Array> {
    if (pending) return Promise.reject(new IntentDispatchBusyError());

    return new Promise<Uint8Array>((resolve, reject) => {
      // The request's own deadline, not a transport-invented one: the wallet
      // refuses an expired intent anyway, so waiting past it can only produce
      // an answer that would be rejected.
      const remaining = Math.max(0, context.expiresAtMs - Date.now());
      const timer = setTimeout(() => {
        settle((dispatch) =>
          dispatch.reject(new IntentResponseTimeoutError(context.family)),
        );
      }, remaining);

      pending = { requestId: context.requestId, resolve, reject, timer };

      void openAuthorityLink(request).catch((error: unknown) => {
        settle((dispatch) =>
          dispatch.reject(
            error instanceof Error ? error : new Error(String(error)),
          ),
        );
      });
    });
  },
};

/**
 * Install the transport — in a native runtime only.
 *
 * A browser cannot hand a link to a native app, so nothing would deliver the
 * answer. Reporting `available` there would make the enrollment client sample
 * a device key set for a request with nowhere to go, since it checks
 * `available` before sampling. The browser keeps `#926`'s fail-closed refusal.
 */
export function installAppLinkIntentTransport(): void {
  if (!isTauri()) return;
  setIntentTransport(appLinkIntentTransport);
  void (async () => {
    try {
      const { onOpenUrl } = await import("@tauri-apps/plugin-deep-link");
      await onOpenUrl((urls) => {
        for (const url of urls) deliverInbound(url);
      });
    } catch {
      // A native runtime whose deep-link plugin did not load. `dispatch` still
      // opens the authority's link, and the request expires on its own
      // deadline rather than hanging — the same outcome as an answer that
      // never arrives, which is what this is.
    }
  })();
}

/** Drop any outstanding dispatch. For tests, which must not leak a timer. */
export function resetAppLinkTransportForTests(): void {
  settle((dispatch) =>
    dispatch.reject(new Error("the transport was reset between tests")),
  );
}
