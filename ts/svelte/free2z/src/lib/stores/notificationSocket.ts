/**
 * UI-facing state of the `/ws/profile` notification socket.
 *
 * The reconnect policy lives in `$lib/ws/profileSocket`; the controller is
 * owned by `+layout.svelte`, and the affordance renders in the navbar. This
 * store is the wire between them, and it deliberately holds no state of its
 * own beyond the last status the controller *reported*. Anything the UI needs
 * to know about the breaker is already known by the thing that trips it, and a
 * second, parallel notion of "are we connected?" maintained by a component is
 * a notion that can disagree with the socket it claims to describe.
 *
 * SSR note: this is a module-scoped store, shared by every concurrent request
 * on the server (see ). It is safe only because nothing on the server ever
 * writes to it: `+layout.svelte` guards `report()` on `browser`, and
 * `registerRetry()` runs from `onMount`, which never fires on the server. The
 * initial value renders nothing, so SSR output is identical for every request.
 */

import { derived, writable } from "svelte/store";

import type { ProfileSocketStatus } from "$lib/ws/profileSocket";

/**
 * What, if anything, to show the user.
 *
 *   - `none`     — connected, or reconnecting inside the fast loop. The fast
 *                  loop is transient by construction (it either recovers or
 *                  trips the breaker within ~4 minutes), and a bell that
 *                  flashes a warning on every routine blip teaches people to
 *                  ignore the warning that matters.
 *   - `offline`  — the breaker is tripped and nothing is open: we gave up on
 *                  reconnecting promptly and the next automatic probe is
 *                  minutes away. Visible, and clickable to retry now.
 *   - `retrying` — the breaker is tripped and a probe is in flight. Bounded by
 *                  the controller's own handshake deadline
 *                  (`CONNECT_TIMEOUT_MS`), so it resolves to `offline` if the
 *                  probe fails and to `none` once the connection proves
 *                  stable. It is never a spinner that spins forever — which
 *                  would be the same lie as the silence this replaces.
 */
export type NotificationSocketAffordance = "none" | "offline" | "retrying";

export const IDLE_NOTIFICATION_SOCKET_STATUS: ProfileSocketStatus = {
  phase: "idle",
  breakerTripped: false,
  reconnectAttempts: 0,
};

/**
 * The whole mapping, as one pure function so it can be tested without a DOM.
 *
 * Note that a *connected* socket under a tripped breaker still shows
 * `retrying` rather than `none`. That window is the 10 seconds a probe has to
 * survive before it earns the counter reset, and during an outage it is a
 * window the socket usually dies inside. Calling it "fine" would make the
 * affordance blink on and off every few minutes; calling it "still recovering"
 * is both quieter and truer.
 */
export function notificationSocketAffordanceFor(
  status: ProfileSocketStatus,
): NotificationSocketAffordance {
  if (!status.breakerTripped) return "none";
  if (status.phase === "idle") return "none";
  return status.phase === "waiting" ? "offline" : "retrying";
}

function createNotificationSocketStore() {
  const status = writable<ProfileSocketStatus>(IDLE_NOTIFICATION_SOCKET_STATUS);
  let retryHandler: (() => boolean) | null = null;

  return {
    subscribe: status.subscribe,

    /** Called by the layout for every status change the controller reports. */
    report(next: ProfileSocketStatus) {
      status.set(next);
    },

    /**
     * The layout registers the controller's `resume()` here and unregisters it
     * on destroy. Returns the unregister function.
     */
    registerRetry(handler: () => boolean) {
      retryHandler = handler;
      return () => {
        if (retryHandler === handler) retryHandler = null;
      };
    },

    /**
     * Ask for a probe now. False means the request was refused — no controller
     * registered, or the resume cooldown that keeps a click-happy user from
     * hand-driving the tab back to the incident's connection rate. The caller
     * must say so rather than pretend something happened.
     */
    retry(): boolean {
      return retryHandler ? retryHandler() : false;
    },
  };
}

export const notificationSocketStatus = createNotificationSocketStore();

export const notificationSocketAffordance = derived(
  notificationSocketStatus,
  notificationSocketAffordanceFor,
);
