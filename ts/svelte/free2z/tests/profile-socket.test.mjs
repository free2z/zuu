import assert from "node:assert/strict";
import { after, before, beforeEach, mock, test } from "node:test";
import { createServer } from "vite";

// Short-lived successful handshakes must increase backoff and eventually
// trip the retry ceiling; opening a socket alone must not reset the budget.

let createProfileSocket;
let CONNECT_TIMEOUT_MS;
let STABLE_CONNECTION_MS;
let MAX_RECONNECT_ATTEMPTS;
let MAX_CONNECTIONS_PER_WINDOW;
let BREAKER_RETRY_MS;
let RESUME_MIN_INTERVAL_MS;
let HEARTBEAT_INTERVAL_MS;
let HEARTBEAT_TIMEOUT_MS;
let server;

before(async () => {
  server = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  ({
    createProfileSocket,
    CONNECT_TIMEOUT_MS,
    STABLE_CONNECTION_MS,
    MAX_RECONNECT_ATTEMPTS,
    MAX_CONNECTIONS_PER_WINDOW,
    BREAKER_RETRY_MS,
    RESUME_MIN_INTERVAL_MS,
    HEARTBEAT_INTERVAL_MS,
    HEARTBEAT_TIMEOUT_MS,
  } = await server.ssrLoadModule("/src/lib/ws/profileSocket.ts"));
});

after(async () => {
  await server?.close();
});

beforeEach(() => {
  mock.timers.reset();
});

/**
 * A WebSocket stand-in with the one property that matters: `close()` is
 * asynchronous. The old `manualSocketClose` flag was cleared synchronously by
 * the next `connectSocket()` call, so by the time a deliberately closed socket
 * actually fired `onclose` the flag said "unexpected drop" and a spurious
 * reconnect was scheduled. A fake that fired `onclose` synchronously would
 * hide that bug entirely.
 */
class FakeSocket {
  constructor(url) {
    this.url = url;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this.closeCalls = 0;
    this.sent = [];
  }

  send(data) {
    this.sent.push(data);
  }

  close() {
    this.closeCalls += 1;
    setTimeout(() => {
      // Reads the handler as of *delivery* time, like a real socket: a handler
      // detached before close() can no longer be reached.
      this.onclose?.({ code: 1000 });
    }, 0);
  }

  // --- driven by the tests, standing in for the network -------------------
  emitOpen() {
    this.onopen?.({});
  }

  emitMessage(data) {
    this.onmessage?.({ data });
  }

  /** Server-side death: the socket closes without anyone asking it to. */
  emitServerClose() {
    this.onclose?.({ code: 1006 });
  }

  emitError() {
    this.onerror?.({ type: "error" });
  }
}

function harness({ random = () => 0, ...overrides } = {}) {
  // `Date` is mocked too so the module's churn window advances with `tick()`.
  // Reset first: a test may build more than one controller.
  mock.timers.reset();
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const sockets = [];
  const messages = [];
  const statuses = [];
  const controller = createProfileSocket({
    onStatusChange: (status) => statuses.push(status),
    // The module defaults to `performance.now()` (monotonic), which node's
    // mock timers do not drive; `Date` is the clock `tick()` advances.
    now: () => Date.now(),
    url: () => "wss://free2z.cash/ws/profile",
    onMessage: (data) => messages.push(data),
    createWebSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    random,
    // Keep existing reconnect-policy tests focused on reconnect behavior.
    // Heartbeats have their own bounded-stall test below.
    heartbeatIntervalMs: 1_000_000,
    ...overrides,
  });
  return {
    controller,
    sockets,
    messages,
    statuses,
    latest: () => sockets.at(-1),
  };
}

test("a missed heartbeat retires a live socket and reconnects within its deadline", () => {
  const { controller, sockets, latest } = harness({
    heartbeatIntervalMs: 100,
    heartbeatTimeoutMs: 50,
  });
  controller.connect("alice");
  latest().emitOpen();

  mock.timers.tick(100);
  assert.deepEqual(JSON.parse(latest().sent[0]), { type: "ping", id: 1 });
  mock.timers.tick(50);

  assert.equal(latest().closeCalls, 1);
  assert.equal(controller.getStatus().phase, "waiting");
  assert.equal(controller.getPendingReconnectDelay(), 1000);
  mock.timers.tick(1000);
  assert.equal(sockets.length, 2);
});

test("a matching heartbeat response is consumed and keeps the socket open", () => {
  const { controller, latest, messages } = harness({
    heartbeatIntervalMs: 100,
    heartbeatTimeoutMs: 50,
  });
  controller.connect("alice");
  latest().emitOpen();
  mock.timers.tick(100);
  latest().emitMessage('{"type":"pong","id":1}');
  mock.timers.tick(50);

  assert.equal(latest().closeCalls, 0);
  assert.deepEqual(messages, []);
  assert.equal(controller.getStatus().phase, "connected");
});

test("repeated matching heartbeats keep the socket live without reaching application handlers", () => {
  const { controller, latest, messages } = harness({
    heartbeatIntervalMs: 100,
    heartbeatTimeoutMs: 50,
  });
  controller.connect("alice");
  latest().emitOpen();

  for (let expectedId = 1; expectedId <= 3; expectedId += 1) {
    mock.timers.tick(100);
    const ping = JSON.parse(latest().sent.at(-1));
    assert.deepEqual(ping, { type: "ping", id: expectedId });
    latest().emitMessage(JSON.stringify({ type: "pong", id: expectedId }));
    mock.timers.tick(50);
    assert.equal(latest().closeCalls, 0);
  }

  assert.equal(controller.getStatus().phase, "connected");
  assert.deepEqual(messages, []);
});

test("missing or mismatched pongs and ordinary messages do not satisfy a challenge", () => {
  const { controller, latest, messages } = harness({
    heartbeatIntervalMs: 100,
    heartbeatTimeoutMs: 50,
  });
  controller.connect("alice");
  latest().emitOpen();
  mock.timers.tick(100);
  latest().emitMessage('{"type":"pong","id":999}');
  latest().emitMessage('{"type":"pong"}');
  latest().emitMessage('{"content":{"id":"notification-1"}}');
  mock.timers.tick(50);

  assert.deepEqual(messages, [
    '{"type":"pong","id":999}',
    '{"type":"pong"}',
    '{"content":{"id":"notification-1"}}',
  ]);
  assert.equal(latest().closeCalls, 1);
  assert.equal(controller.getStatus().phase, "waiting");
});

test("old socket pongs cannot affect the newly connected user", () => {
  const { controller, sockets, latest, messages } = harness({
    heartbeatIntervalMs: 100,
    heartbeatTimeoutMs: 50,
  });
  controller.connect("alice");
  const old = latest();
  old.emitOpen();
  mock.timers.tick(100);
  const oldHandler = old.onmessage;

  controller.connect("bob");
  latest().emitOpen();
  oldHandler?.({ data: '{"type":"pong","id":1}' });
  mock.timers.tick(100);

  assert.equal(sockets.length, 2);
  assert.equal(old.closeCalls, 1);
  assert.deepEqual(messages, []);
  assert.deepEqual(JSON.parse(latest().sent[0]), { type: "ping", id: 2 });
  latest().emitMessage('{"type":"pong","id":2}');
  mock.timers.tick(50);
  assert.equal(controller.getStatus().phase, "connected");
});

test("logout cancels heartbeat timers and a socket error enters bounded backoff", () => {
  const logout = harness({
    heartbeatIntervalMs: 100,
    heartbeatTimeoutMs: 50,
  });
  logout.controller.connect("alice");
  logout.latest().emitOpen();
  const loggedOutSocket = logout.latest();
  logout.controller.close();
  mock.timers.tick(1000);
  assert.deepEqual(loggedOutSocket.sent, []);
  assert.equal(logout.controller.getStatus().phase, "idle");

  const failed = harness({
    heartbeatIntervalMs: 100,
    heartbeatTimeoutMs: 50,
  });
  failed.controller.connect("alice");
  const erroredSocket = failed.latest();
  erroredSocket.emitOpen();
  erroredSocket.emitError();
  assert.equal(erroredSocket.closeCalls, 1);
  assert.equal(failed.controller.getPendingReconnectDelay(), 1000);
  mock.timers.tick(1000);
  assert.equal(failed.sockets.length, 2);
});

test("a synchronous heartbeat send failure retires the socket without a stale deadline", () => {
  const { controller, latest } = harness({ heartbeatIntervalMs: 100 });
  controller.connect("alice");
  latest().emitOpen();
  latest().send = () => {
    throw new Error("closed socket");
  };
  mock.timers.tick(100);
  assert.equal(latest().closeCalls, 1);
  assert.equal(controller.getStatus().phase, "waiting");
  mock.timers.tick(50);
  assert.equal(controller.getPendingReconnectDelay(), 1000);
});

test("defaults detect a missed heartbeat within their foreground scheduling budget", () => {
  assert.equal(HEARTBEAT_INTERVAL_MS + HEARTBEAT_TIMEOUT_MS, 30_000);
  const { controller, latest } = harness({
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
  });
  controller.connect("alice");
  latest().emitOpen();
  mock.timers.tick(HEARTBEAT_INTERVAL_MS);
  assert.deepEqual(JSON.parse(latest().sent[0]), { type: "ping", id: 1 });
  mock.timers.tick(HEARTBEAT_TIMEOUT_MS - 1);
  assert.equal(latest().closeCalls, 0);
  mock.timers.tick(1);
  assert.equal(latest().closeCalls, 1);
});

test("repeated heartbeat failures retain the backoff ceiling", () => {
  const { controller, latest } = harness({
    heartbeatIntervalMs: 100,
    heartbeatTimeoutMs: 50,
    // Keep the reset window longer than this failure sequence: a socket that
    // never completes a matching heartbeat must not earn a clean slate.
    stableConnectionMs: 100_000,
  });
  controller.connect("alice");
  const delays = [];
  for (let failure = 0; failure < 4; failure += 1) {
    latest().emitOpen();
    mock.timers.tick(100);
    mock.timers.tick(50);
    delays.push(controller.getPendingReconnectDelay());
    if (failure < 3) mock.timers.tick(delays.at(-1));
  }
  assert.deepEqual(delays, [1000, 3000, 7000, 15000]);
});

test("the 2026-08-11 shape (opens, dies at 6s) walks the backoff curve", () => {
  const { controller, sockets, latest } = harness();
  controller.connect("alice");

  const delays = [];
  for (let cycle = 0; cycle < 5; cycle += 1) {
    const socket = latest();
    socket.emitOpen();
    // The observed signature: alive long enough to look healthy, dead well
    // before it has proven anything.
    mock.timers.tick(6000);
    socket.emitServerClose();

    const delay = controller.getPendingReconnectDelay();
    delays.push(delay);
    mock.timers.tick(delay);
  }

  // Old behaviour: [1000, 1000, 1000, 1000, 1000] — the ceiling never moved.
  assert.deepEqual(delays, [1000, 3000, 7000, 15000, 30000]);
  assert.equal(controller.getReconnectAttempts(), 5);
  assert.equal(sockets.length, 6, "one socket per cycle plus the current one");
});

test("the circuit breaker is reachable and drops into the slow lane", () => {
  const { controller, sockets, latest } = harness();
  controller.connect("alice");

  for (let cycle = 0; cycle < MAX_RECONNECT_ATTEMPTS + 5; cycle += 1) {
    const socket = latest();
    socket.emitOpen();
    mock.timers.tick(6000);
    socket.emitServerClose();
    if (controller.isBreakerTripped()) break;
    mock.timers.tick(controller.getPendingReconnectDelay());
  }

  assert.equal(controller.getReconnectAttempts(), MAX_RECONNECT_ATTEMPTS);
  assert.ok(controller.isBreakerTripped());
  // Attempts 1..9 each open a socket; attempt 10 leaves the fast lane.
  assert.equal(sockets.length, MAX_RECONNECT_ATTEMPTS);

  // Codex review of this PR: stopping dead turns a transient backend outage
  // into an indefinite silent one for every tab nobody happens to refocus.
  // So the loop survives at ~1 connection per 5 minutes — ~0.2/min against
  // the ~8/min the outage produced.
  // random() === 0 here, so this is the bottom of the [0.5x, 1.5x) spread.
  assert.equal(controller.getPendingReconnectDelay(), BREAKER_RETRY_MS * 0.5);
  mock.timers.tick(BREAKER_RETRY_MS);
  assert.equal(sockets.length, MAX_RECONNECT_ATTEMPTS + 1);

  // A probe that dies leaves the breaker exactly as tripped as it found it.
  latest().emitServerClose();
  assert.equal(controller.getReconnectAttempts(), MAX_RECONNECT_ATTEMPTS);
  assert.equal(controller.getPendingReconnectDelay(), BREAKER_RETRY_MS * 0.5);

  // Twenty more minutes of a dead backend buys a handful of probes, not a
  // storm: this is the fastest the slow lane can ever run.
  mock.timers.tick(20 * 60 * 1000);
  assert.ok(
    sockets.length <= MAX_RECONNECT_ATTEMPTS + 10,
    `slow lane opened ${sockets.length - MAX_RECONNECT_ATTEMPTS} sockets in 25 minutes`,
  );
});

test("the slow lane is jittered across half its interval, not by one second", () => {
  // Codex review of this PR: every tab in the fleet trips its breaker during
  // the same outage. `interval + 1s` (0.33% of 5 minutes) leaves them
  // phase-locked, and the herd returns as a pulse that competes with ordinary
  // HTTP for the same nginx worker connections.
  const delays = [0, 0.25, 0.5, 0.75, 0.999].map((r) => {
    const { controller, latest } = harness({ random: () => r });
    controller.connect("alice");
    for (let cycle = 0; cycle < MAX_RECONNECT_ATTEMPTS + 5; cycle += 1) {
      const socket = latest();
      socket.emitOpen();
      mock.timers.tick(6000);
      socket.emitServerClose();
      if (controller.isBreakerTripped()) break;
      mock.timers.tick(controller.getPendingReconnectDelay());
    }
    return controller.getPendingReconnectDelay();
  });

  for (const delay of delays) {
    assert.ok(
      delay >= BREAKER_RETRY_MS * 0.5 && delay < BREAKER_RETRY_MS * 1.5,
      `${delay} outside [0.5x, 1.5x) of the slow-lane interval`,
    );
  }
  const spread = Math.max(...delays) - Math.min(...delays);
  assert.ok(
    spread > BREAKER_RETRY_MS * 0.9,
    `spread of ${spread}ms is too narrow to decorrelate a fleet`,
  );
});

test("a connection that stays open past the stability window resets the counter", () => {
  const healthyWindow = 50;
  const { controller, latest } = harness({
    heartbeatIntervalMs: 60_000,
    stableConnectionMs: healthyWindow,
  });
  controller.connect("alice");

  // Two failed cycles first, so the reset is observable.
  for (let cycle = 0; cycle < 2; cycle += 1) {
    const socket = latest();
    socket.emitOpen();
    mock.timers.tick(6000);
    socket.emitServerClose();
    mock.timers.tick(controller.getPendingReconnectDelay());
  }
  assert.equal(controller.getReconnectAttempts(), 2);

  const healthy = latest();
  healthy.emitOpen();
  mock.timers.tick(60_000);
  const ping = JSON.parse(healthy.sent.at(-1));
  healthy.emitMessage(JSON.stringify({ type: "pong", id: ping.id }));
  mock.timers.tick(healthyWindow + 1);
  assert.equal(controller.getReconnectAttempts(), 0);

  //...and a drop after a healthy run reconnects promptly, as it should.
  healthy.emitServerClose();
  assert.equal(controller.getPendingReconnectDelay(), 1000);
});

test("opening alone never resets the counter, not even one tick short", () => {
  const { controller, latest } = harness();
  controller.connect("alice");

  const first = latest();
  first.emitOpen();
  mock.timers.tick(6000);
  first.emitServerClose();
  mock.timers.tick(controller.getPendingReconnectDelay());

  const second = latest();
  second.emitOpen();
  assert.equal(
    controller.getReconnectAttempts(),
    1,
    "onopen must not clear the counter",
  );
  mock.timers.tick(STABLE_CONNECTION_MS - 1);
  assert.equal(controller.getReconnectAttempts(), 1);
  second.emitServerClose();
  assert.equal(controller.getPendingReconnectDelay(), 3000);
});

test("a received message does not reset the counter", () => {
  const { controller, messages, latest } = harness();
  controller.connect("alice");

  const socket = latest();
  socket.emitOpen();
  mock.timers.tick(6000);
  socket.emitServerClose();
  mock.timers.tick(controller.getPendingReconnectDelay());

  const chatty = latest();
  chatty.emitOpen();
  chatty.emitMessage('{"content":{"id":"1"}}');
  assert.deepEqual(messages, ['{"content":{"id":"1"}}']);
  // A server that dispatches one frame and then dies is exactly the storm we
  // are preventing, so delivery is not proof of a stable connection.
  assert.equal(controller.getReconnectAttempts(), 1);
});

test("the stability timer cannot fire against a socket that is already gone", () => {
  const { controller, latest } = harness();
  controller.connect("alice");

  const socket = latest();
  socket.emitOpen();
  mock.timers.tick(6000);
  socket.emitServerClose();
  const delay = controller.getPendingReconnectDelay();
  assert.equal(controller.getReconnectAttempts(), 1);

  // The dead socket's 10s stability timer would have matured around here.
  mock.timers.tick(STABLE_CONNECTION_MS);
  assert.equal(
    controller.getReconnectAttempts(),
    1,
    "a disarmed stability timer must not credit a dead socket",
  );
  assert.ok(delay <= STABLE_CONNECTION_MS);
});

test("close() disarms everything, including a pending reconnect", () => {
  const { controller, sockets, latest } = harness();
  controller.connect("alice");

  const socket = latest();
  socket.emitOpen();
  mock.timers.tick(6000);
  socket.emitServerClose();
  assert.notEqual(controller.getPendingReconnectDelay(), null);

  controller.close();
  assert.equal(controller.getPendingReconnectDelay(), null);
  assert.equal(controller.getReconnectAttempts(), 0);

  mock.timers.tick(10 * 60 * 1000);
  assert.equal(sockets.length, 1, "a closed controller reconnects to nothing");
});

test("a deliberate close is never mistaken for a drop when onclose lands late", () => {
  const { controller, sockets, latest } = harness();
  controller.connect("alice");
  latest().emitOpen();

  controller.close();
  assert.equal(sockets[0].closeCalls, 1);

  // The real socket fires onclose a turn later — the moment the old
  // `manualSocketClose` flag had already been cleared by the next connect.
  mock.timers.tick(1);
  mock.timers.tick(10 * 60 * 1000);
  assert.equal(sockets.length, 1);
  assert.equal(controller.getPendingReconnectDelay(), null);
});

test("reconnecting the same user does not let the old socket schedule a ghost", () => {
  const { controller, sockets, latest } = harness();
  controller.connect("alice");
  latest().emitOpen();

  // e.g. auth refresh re-runs the subscriber for the same username.
  controller.connect("alice");
  mock.timers.tick(1); // old socket's asynchronous onclose lands here

  assert.equal(sockets.length, 2);
  assert.equal(
    controller.getPendingReconnectDelay(),
    null,
    "the superseded socket must not schedule a reconnect",
  );
  mock.timers.tick(10 * 60 * 1000);
  assert.equal(sockets.length, 2);
});

test("switching users starts a fresh session with a fresh counter", () => {
  const { controller, latest } = harness();
  controller.connect("alice");

  const socket = latest();
  socket.emitOpen();
  mock.timers.tick(6000);
  socket.emitServerClose();
  mock.timers.tick(controller.getPendingReconnectDelay());
  assert.equal(controller.getReconnectAttempts(), 1);

  controller.connect("bob");
  assert.equal(controller.getReconnectAttempts(), 0);
  assert.equal(latest().url, "wss://free2z.cash/ws/profile");
});

test("a failure cycle just past the stability window is still rate-limited", () => {
  // Codex review of this PR: a 10s window is only ever "long enough" for the
  // failure we already saw. A server killing sockets at 11s clears the window
  // every cycle, so the stability rule alone would pin the backoff at ~1s —
  // the same bug with a new constant. The churn budget is what makes the
  // policy shape-independent: whatever the death period, the tab settles at
  // roughly MAX_CONNECTIONS_PER_WINDOW connections per window.
  const { controller, sockets, latest } = harness();
  const simulatedMs = 20 * 60 * 1000;
  controller.connect("alice");

  let elapsed = 0;
  while (elapsed < simulatedMs) {
    const socket = latest();
    socket.emitOpen();
    mock.timers.tick(STABLE_CONNECTION_MS + 1000); // "stable", then dies
    socket.emitServerClose();
    elapsed += STABLE_CONNECTION_MS + 1000;
    const delay = controller.getPendingReconnectDelay();
    assert.notEqual(delay, null, "the loop must stay alive at this duty cycle");
    mock.timers.tick(delay);
    elapsed += delay;
  }

  const perMinute = sockets.length / (elapsed / 60_000);
  // Stability-only policy: 60000 / (11000 + 1000) = 5 per minute, forever.
  // With the budget the loop oscillates around the budget instead (~3.9/min
  // here) — the point is that it is bounded by a constant we chose rather
  // than by however long the server happens to take to die.
  assert.ok(
    perMinute < MAX_CONNECTIONS_PER_WINDOW + 1,
    `expected < ${MAX_CONNECTIONS_PER_WINDOW + 1} connections/min, got ${perMinute.toFixed(2)}`,
  );
  assert.ok(
    controller.getReconnectAttempts() > 0,
    "the counter must be climbing, not resetting every cycle",
  );
});

test("a genuinely healthy connection is never treated as churn", () => {
  const { controller, latest } = harness();
  controller.connect("alice");
  latest().emitOpen();
  mock.timers.tick(STABLE_CONNECTION_MS);
  assert.equal(controller.getReconnectAttempts(), 0);

  // Hours later, one drop. That is not churn, so recovery stays immediate.
  mock.timers.tick(6 * 60 * 60 * 1000);
  latest().emitServerClose();
  assert.equal(controller.getPendingReconnectDelay(), 1000);
  assert.ok(MAX_CONNECTIONS_PER_WINDOW >= 2);
});

test("a survivor of a churn burst is credited once the burst ages out", () => {
  const { controller, latest } = harness({ heartbeatIntervalMs: 60_000 });
  controller.connect("alice");

  // Burn through the churn budget with fast open/die cycles.
  for (let cycle = 0; cycle < 4; cycle += 1) {
    const socket = latest();
    socket.emitOpen();
    mock.timers.tick(2000);
    socket.emitServerClose();
    mock.timers.tick(controller.getPendingReconnectDelay());
  }
  assert.ok(controller.getReconnectAttempts() >= 3);

  // The backend recovers and this socket simply stays up.
  const survivor = latest();
  survivor.emitOpen();
  mock.timers.tick(STABLE_CONNECTION_MS);
  assert.ok(
    controller.getReconnectAttempts() >= 3,
    "still inside the burst window: no credit yet",
  );

  // The survivor proves application delivery after the churn window drains.
  // A matching pong arms stability credit; an open socket alone cannot.
  mock.timers.tick(50_000);
  const ping = JSON.parse(survivor.sent.at(-1));
  survivor.emitMessage(JSON.stringify({ type: "pong", id: ping.id }));
  mock.timers.tick(STABLE_CONNECTION_MS);
  assert.equal(controller.getReconnectAttempts(), 0);
});

test("resume() sends exactly one probe after the breaker gives up", () => {
  const { controller, sockets, latest } = harness();
  controller.connect("alice");

  // Bounded: an unreachable breaker must fail this test, not hang it.
  for (let cycle = 0; cycle < MAX_RECONNECT_ATTEMPTS + 5; cycle += 1) {
    const socket = latest();
    socket.emitOpen();
    mock.timers.tick(6000);
    socket.emitServerClose();
    if (controller.isBreakerTripped()) break;
    mock.timers.tick(controller.getPendingReconnectDelay());
  }
  assert.ok(
    controller.isBreakerTripped(),
    "the breaker must trip before resume() means anything",
  );
  const openedBeforeResume = sockets.length;

  // Codex review of this PR: human attention is not a rate limit. A user who
  // alt-tabs after every failure would otherwise hand-drive the tab back to
  // the incident's rate with the breaker still tripped.
  controller.resume();
  controller.resume();
  assert.equal(
    sockets.length,
    openedBeforeResume,
    "a resume within the cooldown of the last connection is refused",
  );

  // Still-broken backend: the probe dies and the breaker stays tripped.
  mock.timers.tick(RESUME_MIN_INTERVAL_MS);
  controller.resume();
  assert.equal(sockets.length, openedBeforeResume + 1);
  controller.resume();
  assert.equal(sockets.length, openedBeforeResume + 1, "one probe, not two");
  latest().emitServerClose();
  assert.equal(controller.getPendingReconnectDelay(), BREAKER_RETRY_MS * 0.5);
  assert.equal(controller.getReconnectAttempts(), MAX_RECONNECT_ATTEMPTS);

  // Backend recovered: one probe that proves stable puts everything back.
  mock.timers.tick(60_000); // churn window drains
  controller.resume();
  const healthy = latest();
  healthy.emitOpen();
  mock.timers.tick(1_000_000);
  const ping = JSON.parse(healthy.sent.at(-1));
  healthy.emitMessage(JSON.stringify({ type: "pong", id: ping.id }));
  mock.timers.tick(STABLE_CONNECTION_MS);
  assert.equal(controller.getReconnectAttempts(), 0);
  healthy.emitServerClose();
  assert.equal(controller.getPendingReconnectDelay(), 1000);
});

test("resume() is a no-op while connected, while armed, and while logged out", () => {
  const { controller, sockets, latest } = harness();

  controller.resume(); // nobody is logged in
  assert.equal(sockets.length, 0);

  controller.connect("alice");
  controller.resume(); // socket is live (CONNECTING counts)
  latest().emitOpen();
  controller.resume();
  assert.equal(sockets.length, 1);

  latest().emitServerClose(); // reconnect armed
  controller.resume();
  assert.equal(sockets.length, 1);

  controller.close();
  controller.resume(); // closed for good
  assert.equal(sockets.length, 1);
});

test("connect('') is a no-op, and jitter stays within one second", () => {
  const { controller, sockets, latest } = harness({ random: () => 0.75 });
  controller.connect("");
  assert.equal(sockets.length, 0);

  controller.connect("alice");
  const socket = latest();
  socket.emitOpen();
  mock.timers.tick(6000);
  socket.emitServerClose();
  assert.equal(controller.getPendingReconnectDelay(), 1750);
});

// --- issue: the breaker has to be observable ------------------------
//
// A tripped breaker means the tab receives no notifications for minutes at a
// time, and "no notifications" is exactly what a quiet hour looks like. These
// pin the signal the UI renders from; `tests/notification-socket-status.test.mjs`
// pins the mapping from that signal to what the user sees.

/** The status a subscriber would be looking at right now. */
function lastStatus(statuses) {
  return statuses.at(-1);
}

test("the controller reports connecting, connected and waiting", () => {
  const { controller, statuses, latest } = harness();

  controller.connect("alice");
  assert.deepEqual(lastStatus(statuses), {
    phase: "connecting",
    breakerTripped: false,
    reconnectAttempts: 0,
  });

  latest().emitOpen();
  assert.equal(lastStatus(statuses).phase, "connected");

  latest().emitServerClose();
  assert.deepEqual(lastStatus(statuses), {
    phase: "waiting",
    breakerTripped: false,
    reconnectAttempts: 1,
  });

  // A routine reconnect must never claim the breaker tripped — the UI stays
  // quiet on this branch, and a false positive here is the "warning that
  // fires on every blip" that trains people to ignore warnings.
  assert.equal(
    statuses.some((status) => status.breakerTripped),
    false,
  );
});

test("giving up is reported, and unreported until it happens", () => {
  const { controller, statuses, latest } = harness();
  controller.connect("alice");

  for (let cycle = 0; cycle < MAX_RECONNECT_ATTEMPTS + 5; cycle += 1) {
    const socket = latest();
    socket.emitOpen();
    mock.timers.tick(6000);
    socket.emitServerClose();
    if (controller.isBreakerTripped()) break;
    mock.timers.tick(controller.getPendingReconnectDelay());
  }

  // The one transition the UI exists for.
  assert.deepEqual(lastStatus(statuses), {
    phase: "waiting",
    breakerTripped: true,
    reconnectAttempts: MAX_RECONNECT_ATTEMPTS,
  });
  assert.deepEqual(controller.getStatus(), lastStatus(statuses));

  // Exactly one report says so — the nine cycles before it did not.
  assert.equal(
    statuses.filter((status) => status.breakerTripped).length,
    1,
    "the breaker is reported when it trips, not on every attempt",
  );

  // The automatic slow-lane probe: still tripped, but no longer idle-waiting.
  mock.timers.tick(BREAKER_RETRY_MS);
  assert.deepEqual(lastStatus(statuses), {
    phase: "connecting",
    breakerTripped: true,
    reconnectAttempts: MAX_RECONNECT_ATTEMPTS,
  });

  //...and a probe that dies puts it straight back to "we gave up".
  latest().emitServerClose();
  assert.equal(lastStatus(statuses).phase, "waiting");
  assert.equal(lastStatus(statuses).breakerTripped, true);
});

test("a stable reconnection reports the breaker cleared", () => {
  const { controller, statuses, latest } = harness();
  controller.connect("alice");

  for (let cycle = 0; cycle < MAX_RECONNECT_ATTEMPTS + 5; cycle += 1) {
    const socket = latest();
    socket.emitOpen();
    mock.timers.tick(6000);
    socket.emitServerClose();
    if (controller.isBreakerTripped()) break;
    mock.timers.tick(controller.getPendingReconnectDelay());
  }
  assert.equal(lastStatus(statuses).breakerTripped, true);

  mock.timers.tick(60_000); // churn window drains, so stability can be credited
  assert.equal(controller.resume(), true);
  latest().emitOpen();

  // Open is not recovered: this connection has not outlived the window the
  // 2026-08-11 failure died inside, so the affordance must not go quiet yet.
  assert.deepEqual(lastStatus(statuses), {
    phase: "connected",
    breakerTripped: true,
    reconnectAttempts: MAX_RECONNECT_ATTEMPTS,
  });

  mock.timers.tick(1_000_000);
  const healthy = latest();
  const ping = JSON.parse(healthy.sent.at(-1));
  healthy.emitMessage(JSON.stringify({ type: "pong", id: ping.id }));
  mock.timers.tick(STABLE_CONNECTION_MS);
  assert.deepEqual(lastStatus(statuses), {
    phase: "connected",
    breakerTripped: false,
    reconnectAttempts: 0,
  });
});

test("resume() reports whether a probe was actually opened", () => {
  const { controller, sockets, latest } = harness();

  // Nobody logged in: there is nothing to retry.
  assert.equal(controller.resume(), false);

  controller.connect("alice");
  for (let cycle = 0; cycle < MAX_RECONNECT_ATTEMPTS + 5; cycle += 1) {
    const socket = latest();
    socket.emitOpen();
    mock.timers.tick(6000);
    socket.emitServerClose();
    if (controller.isBreakerTripped()) break;
    mock.timers.tick(controller.getPendingReconnectDelay());
  }

  // Straight after the trip the resume cooldown still owns the tab. A click
  // here genuinely does nothing, and the caller has to be able to say so
  // rather than render a reconnection that never happened.
  const openedBeforeRetry = sockets.length;
  assert.equal(controller.resume(), false);
  assert.equal(sockets.length, openedBeforeRetry);

  mock.timers.tick(RESUME_MIN_INTERVAL_MS);
  assert.equal(controller.resume(), true);
  assert.equal(sockets.length, openedBeforeRetry + 1);
  // One probe per click, and the second click is refused because a socket is
  // already in flight.
  assert.equal(controller.resume(), false);
  assert.equal(sockets.length, openedBeforeRetry + 1);
});

test("close() reports idle, so a logout cannot leave a warning on screen", () => {
  const { controller, statuses, latest } = harness();
  controller.connect("alice");

  for (let cycle = 0; cycle < MAX_RECONNECT_ATTEMPTS + 5; cycle += 1) {
    const socket = latest();
    socket.emitOpen();
    mock.timers.tick(6000);
    socket.emitServerClose();
    if (controller.isBreakerTripped()) break;
    mock.timers.tick(controller.getPendingReconnectDelay());
  }
  assert.equal(lastStatus(statuses).breakerTripped, true);

  controller.close();
  assert.deepEqual(lastStatus(statuses), {
    phase: "idle",
    breakerTripped: false,
    reconnectAttempts: 0,
  });
});

// --- a handshake that never completes -------------------------------------
//
// Codex review of: a socket stuck in CONNECTING fires neither `onopen`
// nor `onclose`, so before `CONNECT_TIMEOUT_MS` existed the whole policy above
// simply never ran for that tab — and the new affordance sat on "reconnecting"
// with its retry control disabled, forever. That is the failure mode the
// browser fake deliberately does not reproduce, so it is pinned here.

test("a handshake that never completes is failed, not waited on forever", () => {
  const { controller, sockets, statuses, latest } = harness();
  controller.connect("alice");

  // Silence. No open, no close — the shape a half-open proxy produces.
  mock.timers.tick(CONNECT_TIMEOUT_MS - 1);
  assert.equal(controller.getReconnectAttempts(), 0);
  assert.equal(statuses.at(-1).phase, "connecting");

  mock.timers.tick(1);
  assert.equal(
    controller.getReconnectAttempts(),
    1,
    "the dead handshake counts as the failed attempt it was",
  );
  assert.deepEqual(statuses.at(-1), {
    phase: "waiting",
    breakerTripped: false,
    reconnectAttempts: 1,
  });
  assert.equal(controller.getPendingReconnectDelay(), 1000);
  assert.equal(sockets.length, 1);
  assert.equal(latest().closeCalls, 1, "the hung socket is actually dropped");

  // One reconnect, not two: the discard detaches the handlers first, so the
  // close it issues cannot come back through `onclose` and schedule again.
  mock.timers.tick(controller.getPendingReconnectDelay());
  assert.equal(sockets.length, 2);
  assert.equal(controller.getReconnectAttempts(), 1);
});

test("hung handshakes reach the breaker like any other failure", () => {
  const { controller, statuses } = harness();
  controller.connect("alice");

  for (let cycle = 0; cycle < MAX_RECONNECT_ATTEMPTS + 5; cycle += 1) {
    mock.timers.tick(CONNECT_TIMEOUT_MS);
    if (controller.isBreakerTripped()) break;
    mock.timers.tick(controller.getPendingReconnectDelay());
  }

  assert.equal(controller.isBreakerTripped(), true);
  assert.equal(statuses.at(-1).breakerTripped, true);
});

test("the connect deadline is disarmed by a socket that opens", () => {
  const { controller, sockets, latest } = harness();
  controller.connect("alice");
  latest().emitOpen();

  // Well past the deadline, and still the one healthy socket: a connection
  // that opened must never be torn down by the handshake watchdog.
  mock.timers.tick(CONNECT_TIMEOUT_MS * 2);
  assert.equal(sockets.length, 1);
  assert.equal(latest().closeCalls, 0);
  assert.equal(controller.getReconnectAttempts(), 0);
  assert.equal(controller.getStatus().phase, "connected");
});

test("close() disarms the connect deadline too", () => {
  const { controller, sockets } = harness();
  controller.connect("alice");
  controller.close();

  mock.timers.tick(CONNECT_TIMEOUT_MS * 2);
  assert.equal(sockets.length, 1, "a closed controller reconnects to nothing");
  assert.equal(controller.getReconnectAttempts(), 0);
});
