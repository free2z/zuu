import assert from "node:assert/strict";
import test from "node:test";
import { createAccountRouteRefresh } from "../src/lib/ws/accountRouteRefresh.ts";
const wait = (ms = 130) => new Promise((resolve) => setTimeout(resolve, ms));

test("route demand coalesces without holding independently completed balance reads", async () => {
  let release;
  const calls = [];
  const worker = createAccountRouteRefresh({
    username: () => "buyer",
    refresh: async (username) => {
      calls.push(username);
      if (calls.length === 1)
        await new Promise((resolve) => (release = resolve));
    },
  });
  try {
    worker.request();
    worker.request();
    await wait();
    assert.deepEqual(calls, ["buyer"]);
    let balanceReads = 0;
    await (async () => {
      balanceReads++;
      worker.request();
    })();
    assert.equal(balanceReads, 1);
    assert.deepEqual(calls, ["buyer"]);
    release();
    await wait();
    assert.deepEqual(calls, ["buyer", "buyer"]);
  } finally {
    worker.reset();
  }
});

test("route failures and ignored stalled promises have bounded retries and safe late settlement", async () => {
  for (const stall of [false, true]) {
    let calls = 0,
      release;
    const worker = createAccountRouteRefresh({
      username: () => "buyer",
      timeoutMs: 15,
      retryDelaysMs: [0, 0],
      refresh: async () => {
        calls++;
        if (stall) await new Promise((resolve) => (release = resolve));
        else throw Error("503");
      },
    });
    try {
      worker.request();
      await wait(250);
      assert.equal(calls, 3);
      release?.();
      await wait(30);
      assert.equal(calls, 3);
    } finally {
      worker.reset();
    }
  }
});

test("reset retires an old route promise without settling or retrying a replacement account", async () => {
  let username = "alice",
    rejectOld;
  const calls = [];
  const worker = createAccountRouteRefresh({
    username: () => username,
    timeoutMs: 1000,
    retryDelaysMs: [0],
    refresh: async (user) => {
      calls.push(user);
      if (user === "alice")
        await new Promise((_, reject) => (rejectOld = reject));
    },
  });
  try {
    worker.request();
    await wait();
    username = "bob";
    worker.reset();
    worker.request();
    rejectOld(Error("late503"));
    await wait();
    assert.deepEqual(calls, ["alice", "bob"]);
  } finally {
    worker.reset();
  }
});

test("billing refresh waits for navigation and fences a timed-out or reset wait", async () => {
  let navigation, finish;
  let calls = 0;
  const deferredNavigation = () => {
    navigation = new Promise((resolve) => {
      finish = () => {
        navigation = null;
        resolve();
      };
    });
  };
  const routes = createAccountRouteRefresh({
    username: () => "buyer",
    navigation: () => navigation,
    refresh: async () => {
      calls++;
    },
    timeoutMs: 500,
  });
  try {
    deferredNavigation();
    routes.request();
    await wait();
    assert.equal(calls, 0);
    finish();
    await wait();
    assert.equal(calls, 1);
    deferredNavigation();
    routes.request();
    await wait();
    routes.reset();
    finish();
    await wait();
    assert.equal(calls, 1);
  } finally {
    routes.reset();
  }
  const bounded = createAccountRouteRefresh({
    username: () => "buyer",
    navigation: () => navigation,
    refresh: async () => {
      calls++;
    },
    timeoutMs: 15,
    retryDelaysMs: [],
  });
  try {
    deferredNavigation();
    bounded.request();
    await wait();
    finish();
    await wait();
    assert.equal(calls, 1);
  } finally {
    bounded.reset();
  }
});
