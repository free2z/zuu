import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

// Issue  — the notification bell said nothing when the `/ws/profile`
// socket gave up reconnecting, so "no notifications" and "we stopped listening
// four minutes ago" rendered identically.
//
// `tests/profile-socket.test.mjs` pins the signal (the controller reporting
// that it gave up). This file pins the two things between that signal and the
// user: the mapping to an affordance, and the retry the affordance triggers.
// `tests/browser/notification-socket-offline.spec.ts` drives the real navbar
// end to end.

const UI_ROOT = path.dirname(fileURLToPath(import.meta.url));

let notificationSocketAffordanceFor;
let notificationSocketStatus;
let notificationSocketAffordance;
let IDLE_NOTIFICATION_SOCKET_STATUS;
let server;

before(async () => {
  server = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  ({
    notificationSocketAffordanceFor,
    notificationSocketStatus,
    notificationSocketAffordance,
    IDLE_NOTIFICATION_SOCKET_STATUS,
  } = await server.ssrLoadModule("/src/lib/stores/notificationSocket.ts"));
});

after(async () => {
  await server?.close();
});

const status = (phase, breakerTripped, reconnectAttempts = 0) => ({
  phase,
  breakerTripped,
  reconnectAttempts,
});

test("a healthy or routinely-reconnecting socket shows nothing", () => {
  // The fast retry loop recovers most blips within seconds. A bell that flashes
  // a warning on every blip is a bell whose warnings get ignored.
  for (const phase of ["idle", "connecting", "connected", "waiting"]) {
    assert.equal(
      notificationSocketAffordanceFor(status(phase, false, 3)),
      "none",
      `${phase} inside the fast loop must stay quiet`,
    );
  }
});

test("a tripped breaker with nothing open reads as offline", () => {
  assert.equal(
    notificationSocketAffordanceFor(status("waiting", true, 10)),
    "offline",
  );
});

test("a probe under a tripped breaker reads as retrying, not as recovered", () => {
  // `connected` is included on purpose: under a tripped breaker an open socket
  // has not yet outlived the window the 2026-08-11 failure died inside. Calling
  // it recovered would make the affordance blink off and on every few minutes
  // for the whole outage.
  assert.equal(
    notificationSocketAffordanceFor(status("connecting", true, 10)),
    "retrying",
  );
  assert.equal(
    notificationSocketAffordanceFor(status("connected", true, 10)),
    "retrying",
  );
});

test("a closed controller shows nothing even if the counter is still hot", () => {
  // Logout closes the controller; whatever the breaker thought a moment ago,
  // there is no session to be offline for.
  assert.equal(
    notificationSocketAffordanceFor(status("idle", true, 10)),
    "none",
  );
});

test("the store starts idle and follows what the controller reports", () => {
  const seen = [];
  const unsubscribe = notificationSocketAffordance.subscribe((value) =>
    seen.push(value),
  );

  assert.deepEqual(
    notificationSocketAffordanceFor(IDLE_NOTIFICATION_SOCKET_STATUS),
    "none",
  );

  notificationSocketStatus.report(status("waiting", false, 2));
  notificationSocketStatus.report(status("waiting", true, 10));
  notificationSocketStatus.report(status("connecting", true, 10));
  notificationSocketStatus.report(status("connected", false, 0));

  // Four reports, three renders: the routine reconnect maps to the same
  // `none` the store already held, and a derived store of a primitive does
  // not re-emit an unchanged value.
  assert.deepEqual(seen, ["none", "offline", "retrying", "none"]);
  unsubscribe();

  notificationSocketStatus.report(IDLE_NOTIFICATION_SOCKET_STATUS);
});

test("retry reports refusal instead of pretending something happened", () => {
  // Nothing registered — SSR, or after the layout was destroyed.
  assert.equal(notificationSocketStatus.retry(), false);

  let calls = 0;
  let accepts = true;
  const unregister = notificationSocketStatus.registerRetry(() => {
    calls += 1;
    return accepts;
  });

  assert.equal(notificationSocketStatus.retry(), true);
  assert.equal(calls, 1);

  // The controller's resume cooldown refusing a click is a real outcome: the
  // UI has to say so rather than render a reconnection that never started.
  accepts = false;
  assert.equal(notificationSocketStatus.retry(), false);
  assert.equal(calls, 2);

  unregister();
  assert.equal(notificationSocketStatus.retry(), false);
  assert.equal(calls, 2, "an unregistered handler is never called again");
});

test("the navbar renders the affordance and the layout feeds it", () => {
  // Cheap structural guard for the wiring the browser spec exercises: if the
  // component stops being mounted, or the layout stops reporting status, the
  // affordance silently returns to never appearing — which is the bug.
  const read = (relative) =>
    fs.readFileSync(path.join(UI_ROOT, "..", relative), "utf8");

  const navbar = read("src/lib/components/layout/Navbar.svelte");
  assert.match(navbar, /<NotificationBell class=\{iconButtonClass\} \/>/);

  const layout = read("src/routes/+layout.svelte");
  assert.match(layout, /onStatusChange:.*notificationSocketStatus\.report/s);
  assert.match(layout, /registerRetry\(\(\) =>\s*profileSocket\.resume\(\)/s);
});
