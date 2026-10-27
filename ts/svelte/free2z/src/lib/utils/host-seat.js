// The broadcaster seat, client half.
//
// The server owns the rule: one publishing tab per creator, held as a lease
// (`host_session`) that the tab renews with a heartbeat and that another tab
// can only take with an explicit `takeover`. See py/dj/apps/dyte/views.py
// (`_start_or_resume_host`, `HostSession`).
//
// This module is the browser's side of that contract, kept free of SvelteKit
// imports so `node --test` can exercise it directly:
//
// * `classifyHostSeat` -- what the dashboard should show for a seat status;
// * `hostSeatConflict` -- recognise the server's 409s;
// * `startHostSeatHeartbeat` -- renew the seat, and stop the moment the
//   server says another tab took it;
// * `openHostSeatChannel` -- a BroadcastChannel between tabs of the SAME
//   browser, so a take-over there is instant instead of waiting for the next
//   heartbeat, and a freshly opened dashboard learns about a live sibling
//   even before the server answers. It is an accelerator only: every
//   decision is still made by the server, and a browser without
//   BroadcastChannel loses nothing but speed.

/** How often the broadcasting tab renews its seat. Server TTL is 60s. */
export const HOST_SEAT_HEARTBEAT_MS = 15_000;

/** How often a tab showing "live elsewhere" re-checks whether it still is. */
export const HOST_SEAT_RECHECK_MS = 10_000;

const CHANNEL_PREFIX = "f2z:host-seat:";

/**
 * A fresh seat id for one page load. Deliberately NOT persisted: a
 * sessionStorage copy is duplicated by the browser's "Duplicate tab", which
 * would hand two tabs the same seat -- exactly the shadow broadcast this
 * exists to prevent. A reload releases its seat on `pagehide` instead.
 *
 * @param {{ randomUUID?: () => string } | undefined} [cryptoImpl]
 * @returns {string}
 */
export function newHostSession(cryptoImpl = globalThis.crypto) {
  if (cryptoImpl && typeof cryptoImpl.randomUUID === "function") {
    return cryptoImpl.randomUUID();
  }
  // RFC 4122 v4 from getRandomValues; every browser that can run
  // RealtimeKit has one of the two.
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

/**
 * @typedef {{ active?: boolean, host_session?: string | null,
 *   meeting_type?: string | null }} HostSeatStatus
 */

/**
 * @param {HostSeatStatus | null | undefined} status
 * @param {string} mySession
 * @returns {"free" | "mine" | "elsewhere"}
 */
export function classifyHostSeat(status, mySession) {
  if (!status || !status.active) return "free";
  if (status.host_session && status.host_session === mySession) return "mine";
  return "elsewhere";
}

/**
 * The server's seat conflict, if `error` is one (an ApiError-shaped 409).
 *
 * @param {unknown} error
 * @returns {{ code: "already_live_elsewhere" | "host_session_superseded",
 *   meetingType: string | null, lastSeenAt: string | null } | null}
 */
export function hostSeatConflict(error) {
  if (!error || typeof error !== "object") return null;
  const { status, data } = /** @type {{ status?: unknown, data?: any }} */ (
    error
  );
  if (status !== 409 || !data || typeof data !== "object") return null;
  if (
    data.code !== "already_live_elsewhere" &&
    data.code !== "host_session_superseded"
  ) {
    return null;
  }
  return {
    code: data.code,
    meetingType:
      typeof data.meeting_type === "string" ? data.meeting_type : null,
    lastSeenAt:
      typeof data.last_seen_at === "string" ? data.last_seen_at : null,
  };
}

/**
 * Renew the seat every `intervalMs` until stopped, or until the server says
 * another tab holds it -- then call `onSuperseded` once and stop.
 *
 * Any other failure (offline, 5xx, a timeout) is ignored: the seat survives
 * several missed beats, and giving up the broadcast over a network blip is
 * worse than the blip.
 *
 * @param {{
 *   beat: () => Promise<unknown>,
 *   onSuperseded: () => void,
 *   intervalMs?: number,
 *   timers?: { setInterval: typeof setInterval, clearInterval: typeof clearInterval },
 * }} options
 * @returns {() => void} stop
 */
export function startHostSeatHeartbeat({
  beat,
  onSuperseded,
  intervalMs = HOST_SEAT_HEARTBEAT_MS,
  timers = globalThis,
}) {
  let stopped = false;
  let inFlight = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    timers.clearInterval(handle);
  };
  const tick = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      await beat();
    } catch (error) {
      if (
        !stopped &&
        hostSeatConflict(error)?.code === "host_session_superseded"
      ) {
        stop();
        onSuperseded();
      }
    } finally {
      inFlight = false;
    }
  };
  const handle = timers.setInterval(tick, intervalMs);
  return stop;
}

/**
 * @typedef {{ kind: "live" | "query" | "takeover" | "ended",
 *   session: string, meetingType?: string | null }} HostSeatMessage
 */

/**
 * @param {{
 *   username: string,
 *   session: string,
 *   onTakeover?: (message: HostSeatMessage) => void,
 *   onPeerLive?: (message: HostSeatMessage) => void,
 *   onPeerEnded?: (message: HostSeatMessage) => void,
 *   isLive?: () => string | null,
 *   Channel?: typeof BroadcastChannel,
 * }} options  `isLive` returns this tab's live meeting type, or null.
 */
export function openHostSeatChannel({
  username,
  session,
  onTakeover,
  onPeerLive,
  onPeerEnded,
  isLive = () => null,
  Channel = globalThis.BroadcastChannel,
}) {
  /** @type {BroadcastChannel | null} */
  let channel = null;
  try {
    channel = Channel
      ? new Channel(`${CHANNEL_PREFIX}${String(username).toLowerCase()}`)
      : null;
  } catch {
    channel = null;
  }

  /** @param {Omit<HostSeatMessage, "session">} message */
  const post = (message) => {
    try {
      channel?.postMessage({ ...message, session });
    } catch {
      // A closed channel (page tearing down) has nobody left to tell.
    }
  };

  if (channel) {
    channel.onmessage = (event) => {
      const message = /** @type {HostSeatMessage | null} */ (event?.data);
      if (!message || typeof message !== "object") return;
      if (message.session === session) return;
      if (message.kind === "query") {
        const liveType = isLive();
        if (liveType) post({ kind: "live", meetingType: liveType });
      } else if (message.kind === "live") {
        onPeerLive?.(message);
      } else if (message.kind === "takeover") {
        onTakeover?.(message);
      } else if (message.kind === "ended") {
        onPeerEnded?.(message);
      }
    };
  }

  return {
    available: Boolean(channel),
    /** @param {string} meetingType */
    announceLive: (meetingType) => post({ kind: "live", meetingType }),
    /** @param {string} meetingType */
    announceTakeover: (meetingType) => post({ kind: "takeover", meetingType }),
    announceEnded: () => post({ kind: "ended" }),
    query: () => post({ kind: "query" }),
    close: () => {
      try {
        channel?.close();
      } catch {
        // already closed
      }
      channel = null;
    },
  };
}
