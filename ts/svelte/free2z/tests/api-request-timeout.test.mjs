/**
 * Every browser API write is bounded.
 *
 * Before this, a write that never settled — a stalled connection, a
 * half-open socket — left its spinner up forever; in the editor it wedged
 * autosave and Publish behind `isSaving` with no message. These tests pin:
 *
 *   - the CLASS bounds and their numbers (ordinary write 30 s, AI generation
 *     210 s, binary body 610 s, reads unbounded here), and that every
 *     long-class path is a real POST in `f2z.yaml`;
 *   - that the bound actually FIRES, and fires as an `ApiTimeoutError` with a
 *     sentence — not a bare abort a call site would read as "superseded";
 *   - that a caller's own abort is still an `AbortError`;
 *   - that `apiFetch` — the editor's save path — really arms it.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, mock, test } from "node:test";
import { createServer } from "vite";

import {
  API_LONG_WRITE_TIMEOUT_MS,
  API_WRITE_TIMEOUT_MS,
  ApiTimeoutError,
  LONG_WRITE_PATHS,
  UPLOAD_RESPONSE_TIMEOUT_MS,
  apiRequestTimeoutMs,
  armRequestTimeout,
  isApiTimeoutError,
  isRequestTimeout,
  BODY_TIMEOUT_MESSAGE,
  requestTimeoutMessage,
} from "../src/lib/api/request-timeout.js";

test("requestTimeoutMessage: a sentence for either timeout, nothing otherwise (#2078)", () => {
  const headers = new ApiTimeoutError({ timeoutMs: API_WRITE_TIMEOUT_MS });
  assert.equal(requestTimeoutMessage(headers), headers.message);
  assert.match(headers.message, /within 30 seconds/);
  // A body stall is the raw DOMException, whose own message is for developers.
  assert.equal(
    requestTimeoutMessage(new DOMException("signal timed out", "TimeoutError")),
    BODY_TIMEOUT_MESSAGE,
  );
  // Everything else keeps the caller's own copy.
  assert.equal(
    requestTimeoutMessage(new DOMException("superseded", "AbortError")),
    "",
  );
  assert.equal(requestTimeoutMessage(new TypeError("Failed to fetch")), "");
  assert.equal(requestTimeoutMessage(new Error("Insufficient 2Z")), "");
  assert.equal(requestTimeoutMessage(undefined), "");
});

test("a body that stalls past the bound still counts as a timeout", () => {
  // `apiFetch` leaves its timer armed after the headers: a stalled body
  // rejects `.json()` with the raw abort reason, outside apiFetch's catch.
  const bodyStall = new DOMException(
    "The operation was aborted due to timeout",
    "TimeoutError",
  );
  assert.equal(isRequestTimeout(bodyStall), true);
  assert.equal(isRequestTimeout(new ApiTimeoutError({ timeoutMs: 1 })), true);
  assert.equal(isRequestTimeout(new DOMException("x", "AbortError")), false);
  assert.equal(isRequestTimeout(new TypeError("Failed to fetch")), false);
  assert.equal(isRequestTimeout(null), false);
});

const APP_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.join(APP_ROOT, "..", "..", "..");

test("the class bounds are the numbers the module comment derives", () => {
  assert.equal(API_WRITE_TIMEOUT_MS, 30_000);
  // Above nginx's `/api/` proxy_read_timeout 200s, which is above the chat's
  // own AI_CHAT_DEADLINE_SECONDS = 170: the proxy's 504 always arrives first.
  assert.ok(API_LONG_WRITE_TIMEOUT_MS > 200_000);
  assert.ok(API_LONG_WRITE_TIMEOUT_MS <= 240_000);
  // Above the 600 s upload proxy window and gunicorn's --timeout 600.
  assert.equal(UPLOAD_RESPONSE_TIMEOUT_MS, 610_000);
});

test("ordinary writes get 30 s, reads get no default bound", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "post"]) {
    assert.equal(
      apiRequestTimeoutMs({ input: "/api/zpage/", method, body: "{}" }),
      API_WRITE_TIMEOUT_MS,
      method,
    );
  }
  for (const method of ["GET", "HEAD", "OPTIONS", undefined, null, ""]) {
    assert.equal(
      apiRequestTimeoutMs({ input: "/api/zpage/", method }),
      null,
      String(method),
    );
  }
  // Translation purchase and export answer 202 and work in the background.
  assert.equal(
    apiRequestTimeoutMs({
      input: "/api/zpage/abc/variants/fr/translate/",
      method: "POST",
    }),
    API_WRITE_TIMEOUT_MS,
  );
  assert.equal(
    apiRequestTimeoutMs({
      input: "/api/exports/publications/",
      method: "POST",
    }),
    API_WRITE_TIMEOUT_MS,
  );
});

test("AI generation writes get the long bound, absolute or relative", () => {
  const long = [
    "/api/openai/image",
    "https://free2z.cash/api/openai/image",
    "/api/openai/prompt",
    "/api/ai/prompt/",
    "/api/ai/conversations/7f0c/promptresponses/",
    "/api/storytime/my-story/image",
    "/api/storytime/my-story/text?x=1",
    "/api/dyte/alice/broadcast",
    "/api/dyte/alice/subscribers-only",
    new URL("https://example.test/api/openai/image"),
  ];
  for (const input of long) {
    assert.equal(
      apiRequestTimeoutMs({ input, method: "POST" }),
      API_LONG_WRITE_TIMEOUT_MS,
      String(input),
    );
  }
  // A READ of a long path is still a read.
  assert.equal(
    apiRequestTimeoutMs({
      input: "/api/ai/conversations/7f0c/promptresponses/",
      method: "GET",
    }),
    null,
  );
});

test("every long-class path is a real POST in f2z.yaml", () => {
  const spec = fs.readFileSync(
    path.join(REPO_ROOT, "py/free2z/dj/free2z/openapi/f2z.yaml"),
    "utf8",
  );
  // One block per path: `  /api/...:` then its operations at 4 spaces.
  const posts = spec
    .split(/\n(?= {2}\/api\/)/)
    .map((block) => block.match(/^ {2}(\/api\/[^\s:]+):/))
    .filter(Boolean)
    .filter((match) => /\n {4}post:/.test(match.input))
    // `{type}` is a closed enum in the spec; substitute a real member.
    .map((match) =>
      match[1].replace("{type}", "broadcast").replace(/\{[^}]+\}/g, "x"),
    );
  assert.ok(posts.length > 50, "f2z.yaml parse found too few POSTs");
  for (const pattern of LONG_WRITE_PATHS) {
    assert.ok(
      posts.some((p) => pattern.test(p)),
      `${pattern} matches no POST in f2z.yaml — stale entry`,
    );
  }
});

test("a binary body gets the upload bound, not the 30 s one", () => {
  for (const body of [
    new FormData(),
    new Blob(["x"]),
    new Uint8Array(4),
    new ArrayBuffer(4),
  ]) {
    assert.equal(
      apiRequestTimeoutMs({
        input: "/api/kyc/documents/",
        method: "POST",
        body,
      }),
      UPLOAD_RESPONSE_TIMEOUT_MS,
    );
  }
});

test("a caller's timeoutMs replaces the class bound; null opts out", () => {
  assert.equal(
    apiRequestTimeoutMs({ input: "/api/x/", method: "POST", timeoutMs: 5 }),
    5,
  );
  assert.equal(
    apiRequestTimeoutMs({ input: "/api/x/", method: "POST", timeoutMs: null }),
    null,
  );
  // An explicit bound on a read is honoured too.
  assert.equal(
    apiRequestTimeoutMs({ input: "/api/x/", method: "GET", timeoutMs: 7 }),
    7,
  );
});

test("the upload transport re-exports the one definition, never its own", () => {
  const source = fs.readFileSync(
    path.join(APP_ROOT, "src/lib/components/media/uploadRequest.ts"),
    "utf8",
  );
  assert.match(
    source,
    /import\s*\{\s*UPLOAD_RESPONSE_TIMEOUT_MS\s*\}\s*from\s*["']\.\.\/\.\.\/api\/request-timeout\.js["']/,
  );
  assert.doesNotMatch(source, /UPLOAD_RESPONSE_TIMEOUT_MS\s*=/);
});

test("the armed bound fires as an ApiTimeoutError with a sentence", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const armed = armRequestTimeout(undefined, 30_000, {
      method: "PUT",
      url: "/api/zpage/x/",
    });
    assert.equal(armed.signal.aborted, false);
    mock.timers.tick(29_999);
    assert.equal(armed.signal.aborted, false, "must not fire early");
    mock.timers.tick(1);
    assert.equal(armed.signal.aborted, true);
    assert.equal(armed.timedOut(), true);

    const translated = armed.translate(armed.signal.reason);
    assert.ok(translated instanceof ApiTimeoutError);
    assert.ok(isApiTimeoutError(translated));
    assert.equal(translated.status, 0);
    assert.equal(translated.timeoutMs, 30_000);
    assert.equal(translated.method, "PUT");
    assert.match(translated.message, /did not respond within 30 seconds/);
    // Not an AbortError: every call site treats that as "say nothing".
    assert.notEqual(translated.name, "AbortError");
  } finally {
    mock.timers.reset();
  }
});

test("a caller's own abort is passed through untouched", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const controller = new AbortController();
    const armed = armRequestTimeout(controller.signal, 30_000);
    controller.abort();
    assert.equal(armed.signal.aborted, true);
    assert.equal(armed.timedOut(), false);
    const reason = armed.signal.reason;
    assert.equal(armed.translate(reason), reason);
    assert.equal(reason.name, "AbortError");
  } finally {
    mock.timers.reset();
  }
});

test("no bound means no signal is invented", () => {
  const controller = new AbortController();
  const armed = armRequestTimeout(controller.signal, null);
  assert.equal(armed.signal, controller.signal);
  assert.equal(armed.timedOut(), false);
});

// ---------------------------------------------------------------------------
// apiFetch, the editor's save path — loaded through Vite for `$lib` / `$app`.
// ---------------------------------------------------------------------------

let server;
let apiFetch;

before(async () => {
  server = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  ({ apiFetch } = await server.ssrLoadModule("/src/lib/api/config.ts"));
});

after(async () => {
  await server?.close();
});

/** A fetch that never answers, and rejects with the reason when aborted. */
function hangingFetch(seen) {
  return (input, init) => {
    seen.push({ input, init });
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return; // never settles: exactly the #2046 bug
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  };
}

test("apiFetch: a PUT nobody answers rejects with ApiTimeoutError at 30 s", async () => {
  const nativeFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = hangingFetch(seen);
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let settled = false;
    const request = apiFetch("/api/zpage/abc/", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    request.then(
      () => (settled = true),
      () => (settled = true),
    );
    // Let apiFetch reach fetch (it awaits the CSRF step first).
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    assert.equal(seen.length, 1);
    assert.ok(seen[0].init.signal, "apiFetch must hand fetch a signal");

    mock.timers.tick(API_WRITE_TIMEOUT_MS - 1);
    await Promise.resolve();
    assert.equal(settled, false, "must not fire early");

    mock.timers.tick(1);
    await assert.rejects(request, (error) => {
      assert.equal(error.name, "ApiTimeoutError");
      assert.equal(error.status, 0);
      assert.match(error.message, /30 seconds/);
      return true;
    });
  } finally {
    mock.timers.reset();
    globalThis.fetch = nativeFetch;
  }
});

test("apiFetch: timeoutMs is consumed, never forwarded to fetch", async () => {
  const nativeFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = (input, init) => {
    seen.push(init);
    return Promise.resolve(new Response("{}", { status: 200 }));
  };
  try {
    const init = { method: "POST", body: "{}", timeoutMs: 1234 };
    await apiFetch("/api/x/", init);
    assert.equal("timeoutMs" in seen[0], false);
    // The caller's init object is not mutated any more.
    assert.deepEqual(Object.keys(init).sort(), ["body", "method", "timeoutMs"]);
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

test("apiFetch: a GET keeps its old unbounded behaviour", async () => {
  const nativeFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = (input, init) => {
    seen.push(init);
    return Promise.resolve(new Response("{}", { status: 200 }));
  };
  try {
    await apiFetch("/api/x/");
    assert.equal(seen[0].signal, undefined);
  } finally {
    globalThis.fetch = nativeFetch;
  }
});
