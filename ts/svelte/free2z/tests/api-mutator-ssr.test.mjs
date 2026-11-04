import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import { createServer } from "vite";

let server;
let customInstance;

before(async () => {
  server = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  ({ customInstance } = await server.ssrLoadModule("/src/lib/api/mutator.ts"));
});

after(async () => {
  await server?.close();
});

test("SSR keeps the request signal alive until response.json settles", async () => {
  const nativeFetch = globalThis.fetch;
  const nativeConsoleError = console.error;
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  let requestSignal;
  let jsonStarted = false;
  let jsonSettled = false;
  let watchdog;

  globalThis.fetch = (_input, init) => {
    requestSignal = init?.signal;
    return Promise.resolve({
      ok: true,
      status: 200,
      json() {
        jsonStarted = true;
        return new Promise((_resolve, reject) => {
          const rejectOnAbort = () => {
            jsonSettled = true;
            reject(requestSignal?.reason);
          };

          if (!requestSignal) {
            reject(new Error("SSR mutator did not pass a request signal"));
          } else if (requestSignal.aborted) {
            rejectOnAbort();
          } else {
            requestSignal.addEventListener("abort", rejectOnAbort, {
              once: true,
            });
          }
        });
      },
    });
  };
  // The expected timeout is intentionally logged by the production catch
  // block. Keep this focused test's output quiet while restoring the global.
  console.error = () => {};

  try {
    // This replaces only the clock used by createAbortSignalWithTimeout. The
    // production deadline remains 10 seconds; tick() avoids waiting for it.
    mock.timers.enable({ apis: ["setTimeout"] });

    const request = customInstance("/slow-response");
    // Let fetch resolve and response.json() register its abort listener before
    // advancing the timeout.
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(jsonStarted, true);
    assert.equal(requestSignal?.aborted, false);

    const watchdogPromise = new Promise((_resolve, reject) => {
      // Use the captured native timer so an implementation that cleans up the
      // SSR deadline too early fails promptly instead of hanging for 10s.
      watchdog = nativeSetTimeout(
        () => reject(new Error("SSR request did not abort at its deadline")),
        250,
      );
    });

    mock.timers.tick(10_000);

    await assert.rejects(Promise.race([request, watchdogPromise]), (error) => {
      assert.equal(error?.name, "TimeoutError");
      assert.equal(error?.message, "The operation was aborted due to timeout");
      return true;
    });
    assert.equal(requestSignal?.aborted, true);
    assert.equal(requestSignal?.reason?.name, "TimeoutError");
    assert.equal(jsonSettled, true);
  } finally {
    if (watchdog !== undefined) nativeClearTimeout(watchdog);
    mock.timers.reset();
    globalThis.fetch = nativeFetch;
    console.error = nativeConsoleError;
  }
});

test("generated text/html operations return text instead of parsing JSON", async () => {
  const nativeFetch = globalThis.fetch;
  let jsonCalled = false;
  globalThis.fetch = () =>
    Promise.resolve({
      ok: true,
      status: 200,
      headers: new Headers({ "Content-Type": "text/html; charset=utf-8" }),
      text: async () => "<!doctype html><title>Return to ZUULI</title>",
      json: async () => {
        jsonCalled = true;
        throw new Error("HTML must not be parsed as JSON");
      },
    });

  try {
    assert.equal(
      await customInstance("/api/stripe/native-return/cancel/"),
      "<!doctype html><title>Return to ZUULI</title>",
    );
    assert.equal(jsonCalled, false);
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

test("JSON operations fail closed on a successful text response", async () => {
  const nativeFetch = globalThis.fetch;
  const nativeConsoleError = console.error;
  console.error = () => undefined;
  globalThis.fetch = () =>
    Promise.resolve({
      ok: true,
      status: 200,
      headers: new Headers({ "Content-Type": "text/html; charset=utf-8" }),
      text: async () => "<!doctype html><title>Maintenance</title>",
      json: async () => {
        throw new Error("unexpected HTML must fail before JSON parsing");
      },
    });

  try {
    await assert.rejects(
      customInstance("/api/stripe/transactions/"),
      (error) => {
        assert.equal(error?.name, "ApiError");
        assert.equal(error?.status, 200);
        assert.match(error?.message, /Unexpected text response/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = nativeFetch;
    console.error = nativeConsoleError;
  }
});

test("explicitly public requests omit browser and SSR credentials", async () => {
  const nativeFetch = globalThis.fetch;
  let requestInit;
  globalThis.fetch = (_input, init) => {
    requestInit = init;
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: new Headers({ "Content-Type": "application/json" }),
      json: async () => [],
    });
  };

  try {
    await customInstance("/api/dyte/public/", {
      credentials: "omit",
    });
    assert.equal(requestInit?.credentials, "omit");
  } finally {
    globalThis.fetch = nativeFetch;
  }
});
