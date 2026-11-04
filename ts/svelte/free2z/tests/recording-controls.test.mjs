import assert from "node:assert/strict";
import test from "node:test";
import {
  recordingControls,
  withoutNativeRecording,
} from "../src/lib/utils/recording-controls.ts";
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

test("polls authoritative state, suppresses overlap and cancels late teardown results", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const states = [];
  const calls = [];
  let resolve;
  const control = recordingControls(
    (action, signal) => {
      calls.push({ action, signal });
      return new Promise((r) => (resolve = r));
    },
    (v) => states.push(v),
  );
  assert.equal(calls.length, 1);
  await control.run("start");
  assert.equal(calls.length, 1);
  resolve({ state: "IDLE" });
  await flush();
  const start = control.run("start");
  assert.equal(calls[1].action, "start");
  await control.run("start");
  assert.equal(calls.length, 2);
  resolve({ state: "INVOKED" });
  await start;
  t.mock.timers.tick(10000);
  assert.equal(calls[2].action, "status");
  resolve({ state: "RECORDING" });
  await flush();
  const stop = control.run("stop");
  assert.equal(calls[3].action, "stop");
  resolve({ state: "STOPPING" });
  await stop;
  t.mock.timers.tick(10000);
  const before = states.length;
  control.stop();
  assert.equal(calls[4].signal.aborted, true);
  resolve({ state: "UPLOADED" });
  await flush();
  assert.equal(states.length, before);
  t.mock.timers.tick(30000);
  assert.equal(calls.length, 5);
});

test("a failed probe clears stale state and recovers without automatically starting", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let count = 0;
  const states = [];
  const actions = [];
  const control = recordingControls(
    async (action) => {
      actions.push(action);
      if (++count === 2) throw Error("network");
      return { state: "IDLE" };
    },
    (v) => states.push(v),
  );
  await flush();
  t.mock.timers.tick(10000);
  await flush();
  assert.deepEqual(states.at(-1), { state: null, busy: false, error: true });
  t.mock.timers.tick(15000);
  await flush();
  assert.equal(states.at(-1).state, "IDLE");
  assert.deepEqual(actions, ["status", "status", "status"]);
  control.stop();
});

test("native recording control removed from every responsive menu without changing source config", () => {
  const original = {
    root: {
      "rtk-more-toggle.activeMoreMenu": [
        "rtk-chat",
        ["rtk-recording-toggle", { slot: "more-elements" }],
      ],
      "rtk-more-toggle.activeMoreMenu.sm": [
        "rtk-recording-toggle",
        "rtk-settings",
      ],
      "rtk-recording-toggle": { props: {} },
    },
  };
  const next = withoutNativeRecording(original);
  assert.equal(JSON.stringify(next).includes("rtk-recording-toggle"), false);
  assert.equal(JSON.stringify(original).includes("rtk-recording-toggle"), true);
  assert.deepEqual(next.root["rtk-more-toggle.activeMoreMenu"], ["rtk-chat"]);
});

test("hung status request times out, aborts, releases controls and backs off", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const states = [];
  const signals = [];
  const control = recordingControls(
    (action, signal) => {
      signals.push(signal);
      return new Promise(() => {});
    },
    (v) => states.push(v),
  );
  t.mock.timers.tick(12000);
  await flush();
  assert.equal(signals[0].aborted, true);
  assert.deepEqual(states.at(-1), { state: null, busy: false, error: true });
  t.mock.timers.tick(14999);
  assert.equal(signals.length, 1);
  t.mock.timers.tick(1);
  assert.equal(signals.length, 2);
  t.mock.timers.tick(12000);
  await flush();
  t.mock.timers.tick(29999);
  assert.equal(signals.length, 2);
  t.mock.timers.tick(1);
  assert.equal(signals.length, 3);
  control.stop();
  await flush();
});
