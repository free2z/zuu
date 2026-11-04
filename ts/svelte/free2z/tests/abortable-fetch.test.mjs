import assert from "node:assert/strict";
import test from "node:test";

import { fetchWithAbort } from "../src/lib/abortable-fetch.js";

test("a headers stall cannot hold a fetch past its abort signal", async () => {
  const controller = new AbortController();
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  let requestSignal;
  const reason = new DOMException("enrichment deadline", "TimeoutError");

  const response = fetchWithAbort(
    () => {
      requestSignal = controller.signal;
      markStarted();
      // Deliberately ignore the signal, as a server fetch can do while waiting
      // for response headers. This is the deterministic negative control for
      // awaiting event.fetch() without a deadline race.
      return new Promise(() => {});
    },
    controller.signal,
    () => assert.fail("a response that never arrived cannot be cancelled"),
  );

  await started;
  assert.equal(requestSignal, controller.signal);
  controller.abort(reason);
  await assert.rejects(response, (error) => error === reason);
});

test("a response arriving after abort has its body cancelled", async () => {
  const controller = new AbortController();
  let resolveFetch;
  const fetch = new Promise((resolve) => {
    resolveFetch = resolve;
  });
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  let cancelled = false;
  const response = {
    body: {
      cancel() {
        cancelled = true;
        return Promise.resolve();
      },
    },
  };

  const pending = fetchWithAbort(
    () => {
      markStarted();
      return fetch;
    },
    controller.signal,
    (lateResponse) => void lateResponse.body.cancel(),
  );
  await started;
  controller.abort(new DOMException("deadline", "TimeoutError"));
  await assert.rejects(pending, { name: "TimeoutError" });

  resolveFetch(response);
  // Let the late-response continuation run without using a wall-clock delay.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true);
});
