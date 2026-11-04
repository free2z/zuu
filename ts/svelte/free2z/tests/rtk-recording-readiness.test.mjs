import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { watchRecordingReadiness } from "../src/lib/utils/rtk-recording-readiness.ts";

function setup(t, initial = "IDLE") {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const recording = Object.assign(new EventEmitter(), {
    recordingState: initial,
  });
  const visibility = new EventTarget();
  const changes = [];
  const stop = watchRecordingReadiness(
    recording,
    (value) => changes.push(value),
    visibility,
  );
  t.after(stop);
  const update = (state) => {
    recording.recordingState = state;
    recording.emit("recordingUpdate", state);
  };
  return { recording, visibility, changes, stop, update };
}

test("reports continuous STARTING after thirty seconds, including duplicate events", (t) => {
  const { update, changes } = setup(t);
  t.mock.timers.tick(60000);
  assert.deepEqual(changes, []);
  update("STARTING");
  t.mock.timers.tick(20000);
  update("STARTING");
  t.mock.timers.tick(9999);
  assert.deepEqual(changes, []);
  t.mock.timers.tick(1);
  assert.deepEqual(changes, [true]);
  t.mock.timers.tick(60000);
  assert.deepEqual(changes, [true]);
  update("RECORDING");
  assert.deepEqual(changes, [true, false]);
});

test("a completed or failed start cancels the deadline; a new attempt gets its own grace period", (t) => {
  const { update, changes } = setup(t);
  for (const state of ["RECORDING", "IDLE", "STOPPING"]) {
    update("STARTING");
    t.mock.timers.tick(29000);
    update(state);
    t.mock.timers.tick(30000);
    assert.deepEqual(changes, []);
  }
  update("STARTING");
  t.mock.timers.tick(30000);
  update("IDLE");
  assert.deepEqual(changes, [true, false]);
});

test("returning to a throttled tab evaluates elapsed time and current provider state", (t) => {
  const { recording, visibility, changes } = setup(t, "STARTING");
  t.mock.timers.setTime(61000);
  visibility.dispatchEvent(new Event("visibilitychange"));
  assert.deepEqual(changes, [true]);
  recording.recordingState = "RECORDING";
  visibility.dispatchEvent(new Event("visibilitychange"));
  assert.deepEqual(changes, [true, false]);
});

test("teardown removes listeners and cancels pending feedback", (t) => {
  const { recording, visibility, stop, changes } = setup(t, "STARTING");
  stop();
  assert.equal(recording.listenerCount("recordingUpdate"), 0);
  t.mock.timers.tick(60000);
  visibility.dispatchEvent(new Event("visibilitychange"));
  assert.deepEqual(changes, []);
});
