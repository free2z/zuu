/**
 * Reconnect policy for the `/ws/profile` notification socket.
 *
 * ## Why this is a module and not four closures inside `+layout.svelte`
 *
 * A completed handshake does not establish a healthy connection. Resetting
 * the reconnect counter on every open allows a server that disconnects just
 * after each handshake to bypass exponential backoff and the retry ceiling.
 * Reset only after STABLE_CONNECTION_MS; repeated short-lived connections
 * then follow the bounded backoff curve and trip the circuit breaker.
 *
 * **Receiving a message is deliberately NOT a reset.** It looks like proof of
 * a working connection, but a server that dispatches one frame and then dies
 * reopens the exact hole this module closes: the counter would reset every
 * cycle again. Duration is the only signal that scales with the thing we care
 * about, which is how much load a broken server is asked to absorb.
 *
 * ## Why a duration threshold alone is not enough
 *
 * Any single threshold has an outside. A failure that killed sockets at 11s
 * rather than 6s would clear the stability window every cycle and pin the
 * backoff at ~1s again — the same bug with a different constant. So the reset
 * also requires that this tab has not opened more than
 * `MAX_CONNECTIONS_PER_WINDOW` sockets in the last
 * `CONNECTION_CHURN_WINDOW_MS`. Churn is what actually costs the server, and
 * it is measured in the units the server feels. A healthy tab opens one socket
 * and never comes near the budget.
 *
 * ## A handshake that never finishes is a failure, not a wait
 *
 * Everything above is driven by `onopen` and `onclose`. A socket that hangs in
 * `CONNECTING` — a half-open proxy, a network that went away mid-handshake —
 * fires neither, so none of it runs: no backoff, no breaker, no reconnect, and
 * (since ) a UI stuck on "reconnecting" with its retry control disabled,
 * indefinitely. `CONNECT_TIMEOUT_MS` is this module's own deadline on the
 * handshake; a socket that misses it is discarded and counted as the failed
 * attempt it was. Browser-level connect timeouts exist but are unspecified and
 * measured in minutes, which is not a bound anything here can rely on.
 *
 * ## The breaker has to be recoverable
 *
 * A reachable breaker means a transient backend outage can leave a long-lived
 * tab permanently disconnected, which is its own (quieter) bug. `resume()`
 * exists for that: the layout calls it when the window regains focus or the
 * tab becomes visible, and it opens **exactly one** probe — the attempt
 * counter is not cleared, so a probe that dies leaves the breaker tripped and
 * a probe that proves stable restores normal operation. Human attention is
 * not a rate limit on its own, though (alt-tab after every failure and you
 * are back at the incident's connection rate), so a resume probe is also
 * refused unless `RESUME_MIN_INTERVAL_MS` has passed since this tab last
 * opened a socket.
 *
 * A tab nobody blurs would never get that event, so the breaker also drops
 * into a slow lane rather than stopping dead: one probe roughly every
 * `BREAKER_RETRY_MS` (5 minutes, ~0.2 connections/minute — a ~40x reduction
 * against the ~8/minute the outage produced). "Tripped" therefore means
 * *stop hammering*, never *stay dark until someone reloads*.
 *
 * The slow lane's delay is spread over **half its interval to one and a half
 * times it**, not `interval + 1s of jitter`. Every tab in the fleet trips its
 * breaker during the same outage, so a jitter that is 0.33% of the interval
 * leaves them phase-locked and they come back as a synchronized pulse — and a
 * pulse of handshakes competes with ordinary HTTP for the same nginx worker
 * connections, which is how a websocket incident turns into a site-wide one.
 * Jitter has to be a large fraction of the interval to actually decorrelate a
 * herd; a fixed second on top of a fixed delay decorrelates nothing.
 *
 * ## A tripped breaker has to be visible
 *
 * Between slow-lane probes the user receives nothing, and "nothing" is exactly
 * what a quiet hour looks like — a notification bell that stopped listening
 * four minutes ago is pixel-identical to one with no news. So the
 * controller reports its own state through `onStatusChange`, and the UI drives
 * the affordance off that rather than guessing: the breaker's state is here,
 * and a second copy of it maintained by a component would be a copy that can
 * be wrong.
 *
 * **How long the user waits for that warning depends on the failure shape,
 * and the spread is wide.** A backend that closes sockets promptly walks the
 * fast lane in ~3.5 minutes; a backend that hangs every handshake burns
 * `CONNECT_TIMEOUT_MS` per attempt and takes ~10.5. Codex review of
 * raised the second number and it is knowingly accepted: shortening it means
 * either a deadline short enough to abort a slow-but-succeeding handshake, or
 * a second "how long have we been connecting?" notion of state in the UI —
 * and a second notion of state is the thing this design exists to avoid.
 * Both windows are quiet by intent; the fast lane usually recovers, and a
 * warning that fires on every blip is a warning nobody reads.
 *
 * ## What this policy does and does not promise
 *
 * The invariant is a **bounded connection rate per tab**, not eventual
 * permanent shutdown. A server that dies every 20s stays under the churn
 * budget and keeps being retried indefinitely at ~3/minute — deliberately.
 * Something that works most of the time *should* be retried; permanent
 * silence is its own outage, and the breaker exists to cap load, not to
 * punish. Everything above bounds the rate; nothing above promises to give up.
 *
 * ## Application heartbeat for a live-but-stalled socket
 *
 * A successful WebSocket handshake does not prove later messages can travel.
 * Browsers cannot originate WebSocket control pings, so every open socket now
 * sends a JSON application ping and accepts only the matching JSON pong. The
 * server queues that pong through the consumer's own Channels channel; a
 * blocked Redis receive therefore cannot answer from the ASGI input path.
 * With the defaults below, a foreground tab detects silence within about 30s
 * (20s until ping + 10s response deadline). Browser timer throttling can make
 * that longer in background tabs; this is a scheduling bound, not a universal
 * wall-clock guarantee.
 *
 * ## The second bug this fixes
 *
 * The old code guarded deliberate closes with a shared `manualSocketClose`
 * flag: `closeSocket()` set it true and called `ws.close()`, then
 * `connectSocket()` set it back to false on the very next statement.
 * `WebSocket.close()` is asynchronous, so the doomed socket's `onclose` fired
 * *after* the flag had already been cleared — a deliberate close read as an
 * unexpected drop and scheduled a spurious reconnect. There is no flag here:
 * a socket we are done with gets its handlers detached before `close()`, and
 * every surviving handler ignores any event from a socket that is no longer
 * the current one.
 *
 * Everything is injectable so `tests/profile-socket.test.mjs` can drive the
 * whole policy with a fake socket, fake timers and a fixed jitter.
 */

/** Reset the attempt counter only after a socket has been open this long. */
export const STABLE_CONNECTION_MS = 10_000;

/** Leave the fast retry loop after this many consecutive non-stable connections. */
export const MAX_RECONNECT_ATTEMPTS = 10;

/**
 * Mean slow-lane interval once the fast loop has been abandoned. The actual
 * delay is spread over [0.5x, 1.5x) of this — see the header on why a herd
 * needs jitter proportional to the interval, not a constant second.
 */
export const BREAKER_RETRY_MS = 5 * 60_000;

/** A resume probe is refused if this tab opened a socket more recently. */
export const RESUME_MIN_INTERVAL_MS = 30_000;

/**
 * Give up on a handshake that has not completed in this long, and treat it as
 * the failed attempt it is.
 *
 * A socket stuck in `CONNECTING` fires neither `onopen` nor `onclose`, so
 * without this every rule below is simply never reached: no backoff, no
 * breaker, no reconnect — the tab sits there looking healthy while a half-open
 * proxy holds a connection that will never carry a frame. Browser defaults for
 * this exist but are unspecified and measured in minutes, which is not a bound
 * anything here can rely on.
 *
 * **Why 45s and not 20.** Codex review of  pushed back on the first
 * value: this handshake is not one round trip. It crosses the load balancer
 * and nginx, then Django session auth, then a Redis `group_add` — and a
 * degraded (not dead) Redis or database can stretch an upgrade that *would
 * have succeeded* well past 20 seconds. A deadline shorter than the degraded
 * path turns "slow but recovering" into "no live notifications at all", which
 * is a worse outage than the one this constant exists to bound. 45s is far
 * above any healthy handshake and above a plausible degraded one, while still
 * bounding both the hang and the UI state that renders from it.
 */
export const CONNECT_TIMEOUT_MS = 45_000;

/** Send an application heartbeat often enough to bound a silent live socket. */
export const HEARTBEAT_INTERVAL_MS = 20_000;

/** Drop a socket that does not answer an application heartbeat in time. */
export const HEARTBEAT_TIMEOUT_MS = 10_000;

/** Ceiling on the exponential term, before jitter. */
export const MAX_BACKOFF_MS = 30_000;

/** Trailing window over which repeated connections count as churn. */
export const CONNECTION_CHURN_WINDOW_MS = 60_000;

/**
 * Above this many connections per window, "stable" stops earning a reset.
 * A healthy tab opens one socket and keeps it; three per minute is already
 * pathological, and this is the rate the backoff then settles around.
 */
export const MAX_CONNECTIONS_PER_WINDOW = 3;

/**
 * `performance.now()` where it exists (every browser this ships to), falling
 * back to the wall clock only where it does not. Resolved once at construction
 * so the hot paths stay a plain call.
 */
function defaultClock(): () => number {
  if (typeof performance !== "undefined" && performance?.now) {
    return () => performance.now();
  }
  return Date.now;
}

/** The slice of `WebSocket` this module actually uses. */
export interface ProfileSocketLike {
  onopen: ((event?: unknown) => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onclose: ((event?: unknown) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

/**
 * What the socket is doing right now, in the only terms a user cares about.
 *
 *   - `idle`       — nobody is logged in, or the controller was closed.
 *   - `connecting` — a socket exists but has not opened yet.
 *   - `connected`  — open. Events are arriving; this is *not* a promise that
 *                    the connection has proven stable (see the header).
 *   - `waiting`    — no socket, a reconnect is armed.
 */
export type ProfileSocketPhase =
  "idle" | "connecting" | "connected" | "waiting";

export interface ProfileSocketStatus {
  phase: ProfileSocketPhase;
  /**
   * True once the fast retry loop has been abandoned for the slow lane — i.e.
   * we gave up on reconnecting promptly. This is the bit the UI has to be
   * honest about: between probes the user is not receiving notifications.
   */
  breakerTripped: boolean;
  /** Consecutive connections that never proved stable. */
  reconnectAttempts: number;
}

export interface ProfileSocketOptions {
  /** Resolved at connect time, exactly like the old inline helper. */
  url: () => string;
  /** Raw `MessageEvent.data` from a live socket; parsing stays at the callsite. */
  onMessage: (data: string) => void;
  /**
   * Called on every *change* of the status above (never on construction, and
   * never twice for the same status), so a UI can show that live notifications
   * are down instead of looking identical to a quiet hour.
   */
  onStatusChange?: (status: ProfileSocketStatus) => void;
  createWebSocket?: (url: string) => ProfileSocketLike;
  random?: () => number;
  now?: () => number;
  stableConnectionMs?: number;
  maxReconnectAttempts?: number;
  maxBackoffMs?: number;
  breakerRetryMs?: number;
  resumeMinIntervalMs?: number;
  connectTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  churnWindowMs?: number;
  maxConnectionsPerWindow?: number;
}

export interface ProfileSocketController {
  /** Connect (or reconnect) as `username`. A different user starts fresh. */
  connect(username: string): void;
  /**
   * Open a single probe now instead of waiting out the slow lane. No-op while
   * a socket is live, a reconnect is armed, or nobody is logged in.
   *
   * Returns whether a probe was actually opened. A refusal is a real outcome —
   * a "retry" button that silently does nothing is the same disease as a bell
   * that silently stops listening — so the callsite can say so.
   */
  resume(): boolean;
  /** True once the fast retry loop has been abandoned for the slow lane. */
  isBreakerTripped(): boolean;
  /** Deliberate teardown: no reconnect, counters and timers cleared. */
  close(): void;
  /**
   * The controller's status right now — the same value `onStatusChange` last
   * reported, for a caller that has no subscription (or none yet).
   */
  getStatus(): ProfileSocketStatus;
  /** Consecutive connections that never proved stable. Exposed for tests. */
  getReconnectAttempts(): number;
  /** Milliseconds until the pending reconnect, or null if none is armed. */
  getPendingReconnectDelay(): number | null;
}

export function createProfileSocket(
  options: ProfileSocketOptions,
): ProfileSocketController {
  const {
    url,
    onMessage,
    onStatusChange,
    createWebSocket = (target: string) =>
      new WebSocket(target) as unknown as ProfileSocketLike,
    random = Math.random,
    // Monotonic on purpose. Both the churn budget and the resume cooldown are
    // durations, and `Date.now()` can step backwards (manual clock change, VM
    // resume, an aggressive NTP correction). A backwards step would leave
    // timestamps "in the future", so the churn window would never drain: the
    // breaker could not be credited and resume probes would be refused until
    // the wall clock caught up.
    now = defaultClock(),
    stableConnectionMs = STABLE_CONNECTION_MS,
    maxReconnectAttempts = MAX_RECONNECT_ATTEMPTS,
    maxBackoffMs = MAX_BACKOFF_MS,
    breakerRetryMs = BREAKER_RETRY_MS,
    resumeMinIntervalMs = RESUME_MIN_INTERVAL_MS,
    connectTimeoutMs = CONNECT_TIMEOUT_MS,
    heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
    heartbeatTimeoutMs = HEARTBEAT_TIMEOUT_MS,
    churnWindowMs = CONNECTION_CHURN_WINDOW_MS,
    maxConnectionsPerWindow = MAX_CONNECTIONS_PER_WINDOW,
  } = options;

  let recentConnections: number[] = [];
  let socket: ProfileSocketLike | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let stabilityTimer: ReturnType<typeof setTimeout> | null = null;
  let connectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatId = 0;
  let pendingHeartbeatId: number | null = null;
  let reconnectAttempts = 0;
  let activeUsername = "";
  let pendingReconnectDelay: number | null = null;
  let phase: ProfileSocketPhase = "idle";

  function currentStatus(): ProfileSocketStatus {
    return {
      phase,
      breakerTripped: reconnectAttempts >= maxReconnectAttempts,
      reconnectAttempts,
    };
  }

  const statusKey = (status: ProfileSocketStatus) =>
    `${status.phase}|${status.breakerTripped}|${status.reconnectAttempts}`;

  /**
   * Report the status, but only when it actually changed. The breaker flips
   * from two different places (the attempt counter and the stability credit),
   * and a subscriber that re-renders on every no-op would be a worse citizen
   * than the silence this exists to fix.
   *
   * Seeded with the construction-time status, so a controller that is built
   * and torn down without ever connecting reports nothing at all. That is the
   * SSR path — `+layout.svelte` constructs one per request and Svelte runs
   * `onDestroy` (and therefore `close()`) on the server — and it must not
   * touch a store shared by every concurrent request.
   */
  let lastReported = statusKey(currentStatus());
  function reportStatus() {
    if (!onStatusChange) return;
    const status = currentStatus();
    const key = statusKey(status);
    if (key === lastReported) return;
    lastReported = key;
    onStatusChange(status);
  }

  function setPhase(next: ProfileSocketPhase) {
    phase = next;
    reportStatus();
  }

  function clearReconnectTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    pendingReconnectDelay = null;
  }

  function clearStabilityTimer() {
    if (stabilityTimer) {
      clearTimeout(stabilityTimer);
      stabilityTimer = null;
    }
  }

  function clearConnectTimer() {
    if (connectTimer) {
      clearTimeout(connectTimer);
      connectTimer = null;
    }
  }

  function clearHeartbeatTimers() {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    if (heartbeatDeadlineTimer) clearTimeout(heartbeatDeadlineTimer);
    heartbeatTimer = null;
    heartbeatDeadlineTimer = null;
    pendingHeartbeatId = null;
  }

  /** Drop a socket without letting its late events touch this controller. */
  function discardSocket() {
    clearStabilityTimer();
    clearConnectTimer();
    clearHeartbeatTimers();
    if (!socket) return;
    const doomed = socket;
    socket = null;
    doomed.onopen = null;
    doomed.onmessage = null;
    doomed.onclose = null;
    doomed.onerror = null;
    try {
      doomed.close();
    } catch {
      // A socket that refuses to close is already gone; nothing to salvage.
    }
  }

  function reconnectAfterSocketFailure(
    current: ProfileSocketLike,
    username: string,
  ) {
    if (socket !== current) return;
    discardSocket();
    if (activeUsername === username) scheduleReconnect(username);
    else setPhase("idle");
  }

  /**
   * True when this tab has been reconnecting hard enough that a single stable
   * window should not be allowed to wipe the slate — see the header.
   */
  function isChurning() {
    const cutoff = now() - churnWindowMs;
    recentConnections = recentConnections.filter((at) => at > cutoff);
    return recentConnections.length > maxConnectionsPerWindow;
  }

  /**
   * Credit a socket that has been open for a full stability window, unless
   * this tab is churning. Re-arms rather than firing once so a connection that
   * outlives a churn burst still gets its credit when the burst ages out —
   * otherwise a tab that survived an outage would carry a hot counter for
   * hours and answer its next ordinary drop with a 30s backoff.
   */
  function armStabilityTimer(current: ProfileSocketLike) {
    clearStabilityTimer();
    stabilityTimer = setTimeout(() => {
      stabilityTimer = null;
      if (socket !== current) return;
      if (isChurning()) {
        armStabilityTimer(current);
        return;
      }
      reconnectAttempts = 0;
      // Clears a tripped breaker: this is the moment "we gave up" stops being
      // true, and the only one the UI can learn it from.
      reportStatus();
    }, stableConnectionMs);
  }

  function scheduleReconnect(username: string) {
    // Clamped rather than incremented forever: `resume()` can send another
    // probe after the breaker trips, and each failed probe must leave the
    // breaker exactly as tripped as it found it.
    reconnectAttempts = Math.min(reconnectAttempts + 1, maxReconnectAttempts);
    const exhausted = reconnectAttempts >= maxReconnectAttempts;

    // The fast lane's jitter is a second on top of a delay that is at most 30
    // seconds and is reached by tabs that failed at different moments. The
    // slow lane is reached by every tab in the fleet at once, during the same
    // outage, so its jitter is proportional: [0.5x, 1.5x) of the interval.
    const backoff = exhausted
      ? breakerRetryMs * 0.5 + random() * breakerRetryMs
      : Math.min(maxBackoffMs, (Math.pow(2, reconnectAttempts) - 1) * 1000) +
        random() * 1000;
    clearReconnectTimer();
    pendingReconnectDelay = backoff;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      pendingReconnectDelay = null;
      open(username);
    }, backoff);
    // Reported last, and deliberately so: `onStatusChange` runs a subscriber's
    // code, and a subscriber that calls `resume()` synchronously must find the
    // armed timer this reconnect is scheduled on, not a half-built state.
    setPhase("waiting");
  }

  function open(username: string) {
    discardSocket();

    recentConnections.push(now());
    const current = createWebSocket(url());
    socket = current;

    // A handshake that never completes fires neither handler below, so nothing
    // else in this module would ever run again for this tab. Treat the silence
    // as the failure it is, on our own deadline.
    connectTimer = setTimeout(() => {
      connectTimer = null;
      if (socket !== current) return;
      // `discardSocket()` detaches the handlers first, so the close it issues
      // cannot come back through `onclose` and schedule a second reconnect.
      discardSocket();
      if (activeUsername !== username) {
        setPhase("idle");
        return;
      }
      scheduleReconnect(username);
    }, connectTimeoutMs);
    setPhase("connecting");

    current.onopen = () => {
      if (socket !== current) return;
      clearConnectTimer();
      // Opening proves nothing — the 2026-08-11 outage opened every time.
      setPhase("connected");
      scheduleHeartbeat(current, username);
    };

    current.onmessage = (event) => {
      if (socket !== current) return;
      let message: unknown = undefined;
      try {
        message = JSON.parse(event.data);
      } catch {
        // Existing event messages are forwarded unchanged; only the reserved
        // heartbeat response is consumed here.
      }
      if (
        pendingHeartbeatId !== null &&
        message &&
        typeof message === "object" &&
        (message as { type?: unknown }).type === "pong" &&
        (message as { id?: unknown }).id === pendingHeartbeatId
      ) {
        if (heartbeatDeadlineTimer) clearTimeout(heartbeatDeadlineTimer);
        heartbeatDeadlineTimer = null;
        pendingHeartbeatId = null;
        // Only a pong that returned through the server's application delivery
        // path is evidence that this connection can carry messages. An open
        // socket alone cannot reset accumulated backoff.
        armStabilityTimer(current);
        scheduleHeartbeat(current, username);
        return;
      }
      onMessage(event.data);
    };

    current.onclose = () => {
      if (socket !== current) return;
      clearStabilityTimer();
      clearConnectTimer();
      clearHeartbeatTimers();
      socket = null;
      if (activeUsername !== username) {
        setPhase("idle");
        return;
      }
      scheduleReconnect(username);
    };

    // Some browsers do not reliably follow `error` with `close`. Retire this
    // socket here so heartbeat/connect timers and the retry policy still run.
    current.onerror = () => reconnectAfterSocketFailure(current, username);
  }

  function scheduleHeartbeat(current: ProfileSocketLike, username: string) {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    heartbeatTimer = setTimeout(() => {
      heartbeatTimer = null;
      if (socket !== current || activeUsername !== username) return;
      const id = ++heartbeatId;
      pendingHeartbeatId = id;
      try {
        current.send(JSON.stringify({ type: "ping", id }));
      } catch {
        reconnectAfterSocketFailure(current, username);
        return;
      }
      heartbeatDeadlineTimer = setTimeout(() => {
        heartbeatDeadlineTimer = null;
        if (socket !== current || pendingHeartbeatId !== id) return;
        // A stalled consumer may not read, and therefore cannot be recovered
        // by waiting for its server-side close. Retire it locally at the
        // deadline so detection does not serialize behind other consumers.
        reconnectAfterSocketFailure(current, username);
      }, heartbeatTimeoutMs);
    }, heartbeatIntervalMs);
  }

  return {
    connect(username: string) {
      if (!username) return;
      clearReconnectTimer();
      discardSocket();
      if (activeUsername !== username) {
        // A different account is a different session; nothing to carry over.
        reconnectAttempts = 0;
        recentConnections = [];
      }
      activeUsername = username;
      open(username);
    },

    resume() {
      if (!activeUsername || socket) return false;
      // While the fast loop still owns the schedule, its backoff is the whole
      // point — a focus/blur loop must not be able to shorten it. Only the
      // slow lane yields to a user who has come back to the tab.
      if (reconnectTimer && reconnectAttempts < maxReconnectAttempts)
        return false;
      //...and even then, not faster than this. Otherwise a user who
      // alt-tabs after every failure hand-drives the tab back to the
      // incident's connection rate with the breaker still tripped.
      const lastConnectedAt = recentConnections[recentConnections.length - 1];
      if (
        lastConnectedAt !== undefined &&
        now() - lastConnectedAt < resumeMinIntervalMs
      ) {
        return false;
      }
      clearReconnectTimer();
      open(activeUsername);
      return true;
    },

    isBreakerTripped() {
      return reconnectAttempts >= maxReconnectAttempts;
    },

    close() {
      clearReconnectTimer();
      discardSocket();
      activeUsername = "";
      reconnectAttempts = 0;
      recentConnections = [];
      setPhase("idle");
    },

    getStatus() {
      return currentStatus();
    },

    getReconnectAttempts() {
      return reconnectAttempts;
    },

    getPendingReconnectDelay() {
      return pendingReconnectDelay;
    },
  };
}
