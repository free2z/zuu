// The lazy notifier import retries with backoff and gives up (
// verification round, codex adversarial review): a failed chunk used to be
// re-imported in a tight loop for the life of the tab.

import assert from "node:assert/strict";
import test from "node:test";

import { createRetryingLoader } from "../src/lib/retrying-loader.ts";

function fakeClock() {
  const timers = [];
  return {
    timers,
    setTimer: (fn, ms) => {
      const handle = { fn, ms, cleared: false };
      timers.push(handle);
      return handle;
    },
    clearTimer: (handle) => {
      handle.cleared = true;
    },
    async fireNext() {
      const handle = timers.find((t) => !t.cleared && !t.fired);
      assert.ok(handle, "a retry is scheduled");
      handle.fired = true;
      handle.fn();
      await flush();
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("a persistent failure retries on the backoff schedule, then gives up", async () => {
  const clock = fakeClock();
  let calls = 0;
  const loader = createRetryingLoader(
    () => {
      calls += 1;
      return Promise.reject(new Error("chunk missing"));
    },
    () => assert.fail("never loads"),
    { delaysMs: [10, 20, 40], ...clock },
  );
  loader.start();
  await flush();
  // One import, then a wait — not an immediate second import.
  assert.equal(calls, 1);
  assert.deepEqual(
    clock.timers.map((t) => t.ms),
    [10],
  );
  // Starting again while waiting does nothing (the reactive statement re-runs).
  loader.start();
  loader.start();
  await flush();
  assert.equal(calls, 1);
  await clock.fireNext();
  await clock.fireNext();
  await clock.fireNext();
  assert.equal(calls, 4);
  assert.deepEqual(
    clock.timers.map((t) => t.ms),
    [10, 20, 40],
  );
  assert.equal(loader.gaveUp, true);
  loader.start();
  await flush();
  assert.equal(calls, 4, "after giving up, start() is inert");
});

test("a retry that succeeds loads once; reset() allows a deliberate retry after a give-up", async () => {
  const clock = fakeClock();
  let calls = 0;
  let loaded = 0;
  let fail = true;
  const loader = createRetryingLoader(
    () => {
      calls += 1;
      return fail
        ? Promise.reject(new Error("offline"))
        : Promise.resolve("ok");
    },
    () => (loaded += 1),
    { delaysMs: [5], ...clock },
  );
  loader.start();
  await flush();
  await clock.fireNext();
  assert.equal(loader.gaveUp, true);
  fail = false;
  loader.reset();
  loader.start();
  await flush();
  assert.equal(loaded, 1);
  assert.equal(calls, 3);
  loader.start();
  await flush();
  assert.equal(calls, 3, "loaded: never imported again");
});

test("stop() cancels a pending retry", async () => {
  const clock = fakeClock();
  let calls = 0;
  const loader = createRetryingLoader(
    () => {
      calls += 1;
      return Promise.reject(new Error("x"));
    },
    () => {},
    { delaysMs: [5, 5], ...clock },
  );
  loader.start();
  await flush();
  loader.stop();
  assert.equal(clock.timers[0].cleared, true);
  assert.equal(calls, 1);
});
