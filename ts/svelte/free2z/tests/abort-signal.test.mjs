import assert from "node:assert/strict";
import test from "node:test";

import { createAbortSignalWithTimeout } from "../src/lib/abort-signal.js";

function trackAbortListeners(signal) {
  let added = 0;
  let removed = 0;
  const addEventListener = signal.addEventListener.bind(signal);
  const removeEventListener = signal.removeEventListener.bind(signal);

  signal.addEventListener = (type, listener, options) => {
    if (type === "abort") added += 1;
    return addEventListener(type, listener, options);
  };
  signal.removeEventListener = (type, listener, options) => {
    if (type === "abort") removed += 1;
    return removeEventListener(type, listener, options);
  };

  return {
    get added() {
      return added;
    },
    get removed() {
      return removed;
    },
  };
}

test("caller cancellation keeps its exact reason and cleans the timeout", () => {
  const parent = new AbortController();
  const listeners = trackAbortListeners(parent.signal);
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  let cleared = 0;

  globalThis.setTimeout = (...args) => nativeSetTimeout(...args);
  globalThis.clearTimeout = (...args) => {
    cleared += 1;
    return nativeClearTimeout(...args);
  };

  try {
    const combined = createAbortSignalWithTimeout(parent.signal, 60_000);
    const reason = new DOMException("caller left", "AbortError");
    parent.abort(reason);

    assert.equal(combined.signal.aborted, true);
    assert.equal(combined.signal.reason, reason);
    assert.equal(listeners.added, 1);
    assert.equal(listeners.removed, 1);
    assert.equal(cleared, 1);

    // Cleanup is safe to call from the request's finally block too.
    combined.cleanup();
    assert.equal(cleared, 1);
  } finally {
    globalThis.setTimeout = nativeSetTimeout;
    globalThis.clearTimeout = nativeClearTimeout;
  }
});

test("timeout aborts with TimeoutError and removes the parent listener", async () => {
  const parent = new AbortController();
  const listeners = trackAbortListeners(parent.signal);
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  let cleared = 0;

  globalThis.setTimeout = (...args) => nativeSetTimeout(...args);
  globalThis.clearTimeout = (...args) => {
    cleared += 1;
    return nativeClearTimeout(...args);
  };

  try {
    const combined = createAbortSignalWithTimeout(parent.signal, 5);
    await new Promise((resolve) => nativeSetTimeout(resolve, 25));

    assert.equal(combined.signal.aborted, true);
    assert.equal(combined.signal.reason?.name, "TimeoutError");
    assert.equal(
      combined.signal.reason?.message,
      "The operation was aborted due to timeout",
    );
    assert.equal(parent.signal.aborted, false);
    assert.equal(listeners.added, 1);
    assert.equal(listeners.removed, 1);
    assert.equal(cleared, 1);
  } finally {
    globalThis.setTimeout = nativeSetTimeout;
    globalThis.clearTimeout = nativeClearTimeout;
  }
});

test("explicit cleanup cancels the timer without aborting the derived signal", () => {
  const parent = new AbortController();
  const listeners = trackAbortListeners(parent.signal);
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  let cleared = 0;

  globalThis.setTimeout = (...args) => nativeSetTimeout(...args);
  globalThis.clearTimeout = (...args) => {
    cleared += 1;
    return nativeClearTimeout(...args);
  };

  try {
    const combined = createAbortSignalWithTimeout(parent.signal, 60_000);
    combined.cleanup();
    parent.abort(new Error("later cancellation"));

    assert.equal(combined.signal.aborted, false);
    assert.equal(listeners.added, 1);
    assert.equal(listeners.removed, 1);
    assert.equal(cleared, 1);
  } finally {
    globalThis.setTimeout = nativeSetTimeout;
    globalThis.clearTimeout = nativeClearTimeout;
  }
});
