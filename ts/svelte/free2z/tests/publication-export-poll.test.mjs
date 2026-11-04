// Publication export status polling.
//
// The dialog used to stop polling on the FIRST failed status request and set
// nothing, so one transient 502 left "Generating your publication archive…"
// spinning forever. These tests drive the poller with a hand-cranked
// scheduler, so every assertion is about which request happens next and what
// the UI is told — not about wall-clock timing.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_CONSECUTIVE_POLL_FAILURES,
  POLL_INTERVAL_MS,
  POLL_REQUEST_TIMEOUT_MS,
  PollTimeoutError,
  withDeadline,
  classifyLatestJobError,
  createExportPoller,
  nextPollDelay,
} from "../src/lib/publication-export-poll.ts";

/** A scheduler the test advances by hand. */
function manualClock() {
  const pending = [];
  return {
    pending,
    schedule(fn, ms) {
      const t = { fn, ms, cancelled: false };
      pending.push(t);
      return t;
    },
    cancel(t) {
      t.cancelled = true;
    },
    /**
     * Fire the next live timer (a poll, or a request deadline) and let its
     * async tick settle. Cancelled timers — deadlines of requests that
     * answered in time — are skipped, as a real clock would.
     */
    async fire() {
      while (pending.length && pending[0].cancelled) pending.shift();
      const t = pending.shift();
      assert.ok(t, "expected a scheduled timer, found none");
      t.fn();
      // tick awaits fetchJob, then schedules; drain the microtasks.
      for (let i = 0; i < 5; i++) await Promise.resolve();
      return t.ms;
    },
    live() {
      return pending.filter((t) => !t.cancelled);
    },
  };
}

class HttpError extends Error {
  constructor(status) {
    super(`HTTP error! status: ${status}`);
    this.status = status;
  }
}

/** fetchJob that answers from a script: an Error is thrown, anything else returned. */
function scripted(responses) {
  const calls = [];
  return {
    calls,
    fetchJob: async (id) => {
      calls.push(id);
      const next = responses.length > 1 ? responses.shift() : responses[0];
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

function harness(responses, extra = {}) {
  const clock = manualClock();
  const api = scripted(responses);
  const events = { updates: [], retries: [], gaveUp: [] };
  const poller = createExportPoller({
    fetchJob: api.fetchJob,
    onUpdate: (j) => events.updates.push(j.status),
    onRetry: (n) => events.retries.push(n),
    onGiveUp: (err) => events.gaveUp.push(err),
    schedule: clock.schedule,
    cancel: clock.cancel,
    ...extra,
  });
  return { clock, api, events, poller };
}

test("backoff doubles from the normal cadence and is capped", () => {
  assert.equal(nextPollDelay(0), POLL_INTERVAL_MS);
  assert.equal(nextPollDelay(1), POLL_INTERVAL_MS * 2);
  assert.equal(nextPollDelay(2), POLL_INTERVAL_MS * 4);
  assert.equal(nextPollDelay(3), POLL_INTERVAL_MS * 8);
  assert.equal(nextPollDelay(50), 30_000);
  assert.equal(nextPollDelay(-1), POLL_INTERVAL_MS);
});

test("only a 404 means 'no export yet'; any other failure is 'failed to load'", () => {
  assert.equal(classifyLatestJobError(new HttpError(404)), "none");
  assert.equal(classifyLatestJobError(new HttpError(500)), "failed");
  assert.equal(classifyLatestJobError(new HttpError(502)), "failed");
  assert.equal(classifyLatestJobError(new HttpError(403)), "failed");
  assert.equal(classifyLatestJobError(new TypeError("fetch failed")), "failed");
  assert.equal(classifyLatestJobError(undefined), "failed");
  assert.equal(classifyLatestJobError({ status: "404" }), "failed");
});

test("one failed poll is retried with backoff and the job still completes", async () => {
  const { clock, api, events, poller } = harness([
    { status: "running" },
    new HttpError(502),
    { status: "running" },
    { status: "ready" },
  ]);
  poller.start("job-1");

  assert.equal(await clock.fire(), POLL_INTERVAL_MS); // running
  assert.equal(await clock.fire(), POLL_INTERVAL_MS); // 502
  assert.deepEqual(events.retries, [1]);
  assert.equal(events.gaveUp.length, 0);
  // The retry after a failure is backed off, not the normal cadence.
  assert.equal(await clock.fire(), POLL_INTERVAL_MS * 2); // running
  assert.equal(await clock.fire(), POLL_INTERVAL_MS); // ready — cadence reset

  assert.deepEqual(events.updates, ["running", "running", "ready"]);
  assert.equal(events.gaveUp.length, 0);
  assert.equal(clock.live().length, 0, "polling stops at a terminal status");
  assert.equal(poller.active, false);
  assert.deepEqual(api.calls, ["job-1", "job-1", "job-1", "job-1"]);
});

test("persistent failure gives up visibly after N consecutive failures", async () => {
  const { clock, events, poller } = harness([new HttpError(502)]);
  poller.start("job-1");

  const delays = [];
  for (let i = 0; i < MAX_CONSECUTIVE_POLL_FAILURES; i++) {
    delays.push(await clock.fire());
  }
  assert.deepEqual(delays, [
    POLL_INTERVAL_MS,
    POLL_INTERVAL_MS * 2,
    POLL_INTERVAL_MS * 4,
    POLL_INTERVAL_MS * 8,
  ]);
  assert.equal(events.gaveUp.length, 1, "onGiveUp must fire exactly once");
  assert.equal(events.gaveUp[0].status, 502);
  assert.equal(clock.live().length, 0, "nothing is scheduled after giving up");
  assert.equal(poller.active, false);
});

test("a success between failures resets the consecutive-failure count", async () => {
  const E = () => new HttpError(503);
  const { clock, events, poller } = harness([
    E(),
    E(),
    E(),
    { status: "running" },
    E(),
    E(),
    E(),
    { status: "ready" },
  ]);
  poller.start("job-1");
  for (let i = 0; i < 8; i++) await clock.fire();
  assert.equal(events.gaveUp.length, 0);
  assert.deepEqual(events.updates, ["running", "ready"]);
});

test("'Check again' restarts polling immediately from a clean count", async () => {
  const responses = [new HttpError(502)];
  const { clock, events, poller } = harness(responses);
  poller.start("job-1");
  for (let i = 0; i < MAX_CONSECUTIVE_POLL_FAILURES; i++) await clock.fire();
  assert.equal(events.gaveUp.length, 1);

  responses[0] = { status: "ready" };
  poller.start("job-1", { immediate: true });
  assert.equal(await clock.fire(), 0, "check again must not wait an interval");
  assert.deepEqual(events.updates, ["ready"]);
});

test("a response landing after stop() is discarded", async () => {
  let release;
  const clock = manualClock();
  const events = [];
  const poller = createExportPoller({
    fetchJob: () =>
      new Promise((_, reject) => {
        release = () => reject(new HttpError(502));
      }),
    onUpdate: () => events.push("update"),
    onRetry: () => events.push("retry"),
    onGiveUp: () => events.push("giveup"),
    maxConsecutiveFailures: 1,
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
  poller.start("job-1");
  await clock.fire(); // request now in flight
  poller.stop(); // dialog closed
  release();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.deepEqual(events, [], "a stopped poller must not report anything");
  assert.equal(clock.live().length, 0);
});

test("stop() cancels a scheduled poll", () => {
  const { clock, poller } = harness([{ status: "running" }]);
  poller.start("job-1");
  assert.equal(clock.live().length, 1);
  poller.stop();
  assert.equal(clock.live().length, 0);
});

test("a stalled request hits its deadline, is aborted, and counts as a failure", async () => {
  // The browser fetch has no timeout and the backend allows an hour: a poller
  // that waits for a hung request never retries and never gives up.
  const clock = manualClock();
  const signals = [];
  const events = { retries: [], gaveUp: [] };
  const poller = createExportPoller({
    fetchJob: (_id, signal) => {
      signals.push(signal);
      return new Promise(() => {}); // never settles, ignores its signal
    },
    onUpdate: () => assert.fail("a stalled request produced an update"),
    onRetry: (n) => events.retries.push(n),
    onGiveUp: (err) => events.gaveUp.push(err),
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
  poller.start("job-1");

  for (let i = 0; i < MAX_CONSECUTIVE_POLL_FAILURES; i++) {
    assert.equal(await clock.fire(), nextPollDelay(i)); // the poll
    assert.equal(await clock.fire(), POLL_REQUEST_TIMEOUT_MS); // its deadline
    assert.equal(signals[i].aborted, true, "the stalled request is aborted");
  }
  assert.deepEqual(events.retries, [1, 2, 3]);
  assert.equal(events.gaveUp.length, 1);
  assert.ok(events.gaveUp[0] instanceof PollTimeoutError);
  assert.equal(clock.live().length, 0);
  assert.equal(poller.active, false);
});

test("stop() aborts the in-flight request", async () => {
  const clock = manualClock();
  let seen;
  const poller = createExportPoller({
    fetchJob: (_id, signal) => {
      seen = signal;
      return new Promise(() => {});
    },
    onUpdate: () => {},
    onGiveUp: () => {},
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
  poller.start("job-1");
  await clock.fire();
  assert.equal(seen.aborted, false);
  poller.stop();
  assert.equal(seen.aborted, true);
  assert.equal(
    clock.live().length,
    0,
    "the aborted request's deadline is dropped",
  );
});

test("withDeadline: a request that never settles rejects at the deadline and is aborted", async () => {
  const clock = manualClock();
  let seen;
  const p = withDeadline(
    (signal) => {
      seen = signal;
      return new Promise(() => {});
    },
    POLL_REQUEST_TIMEOUT_MS,
    undefined,
    clock.schedule,
    clock.cancel,
  );
  let outcome = "pending";
  p.then(
    () => (outcome = "resolved"),
    (err) => (outcome = err),
  );
  await Promise.resolve();
  assert.equal(outcome, "pending");
  assert.equal(await clock.fire(), POLL_REQUEST_TIMEOUT_MS);
  await Promise.resolve();
  assert.ok(outcome instanceof PollTimeoutError);
  assert.equal(seen.aborted, true);
  assert.equal(classifyLatestJobError(outcome), "failed");
});

test("withDeadline: an external abort rejects and drops the deadline", async () => {
  const clock = manualClock();
  const controller = new AbortController();
  const p = withDeadline(
    () => new Promise(() => {}),
    POLL_REQUEST_TIMEOUT_MS,
    controller,
    clock.schedule,
    clock.cancel,
  );
  controller.abort(new Error("unmounted"));
  await assert.rejects(p, /unmounted/);
  assert.equal(clock.live().length, 0);
});
