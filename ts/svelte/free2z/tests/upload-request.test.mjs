/**
 * The shared upload transport (RCA ), driven against a fake XHR.
 *
 * For 19 days every upload over 1 MiB got an nginx 500 mid-body, `fetch`
 * never settled, and the browser showed "pending" forever — 57 failures, no
 * error on screen, one 33 MB video retried 24 times. These tests pin the
 * three promises that make that impossible to hide:
 *
 *   - a request whose upload counter stops moving is ABORTED, while one that
 *     is merely slow is left alone (idle time, not wall clock);
 *   - every failure (stall, 403, 413, 500, network) REJECTS with the status,
 *     a kind, and the file's name and size — nothing stays pending;
 *   - the message a creator sees names the file, its size and what to do.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test, { mock } from "node:test";

// `uploadRequest.ts` imports `./uploadLimit` without an extension — the form
// Vite and svelte-check want, and the one Node's type stripping cannot
// resolve. Retry an extensionless relative specifier as `.ts`; nothing else
// is touched. Registered before the dynamic import below, which is why the
// module under test is not a static import.
register(
  "data:text/javascript," +
    encodeURIComponent(`
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    if (
      error?.code === "ERR_MODULE_NOT_FOUND" &&
      /^\\.\\.?\\//.test(specifier) &&
      !/\\.[a-z]+$/i.test(specifier)
    ) {
      return next(specifier + ".ts", context);
    }
    throw error;
  }
}
`),
);

const {
  UPLOAD_RESPONSE_TIMEOUT_MS,
  UPLOAD_STALL_TIMEOUT_MS,
  UploadRequestError,
  explainUploadRejection,
  isUploadRejection,
  preflightUpload,
  sendUploadRequest,
  uploadErrorMessage,
  watchUploadStall,
} = await import("../src/lib/components/media/uploadRequest.ts");
// The SAME module instance `uploadRequest.ts` reads its cache from.
const { resetUploadLimitCache } =
  await import("../src/lib/components/media/uploadLimit.ts");

const MB = 1024 * 1024;
const FILE = { name: "clip.mp4", size: 33 * MB };

const t = (key, fallback = key, params = {}) =>
  fallback.replace(/\{(\w+)\}/g, (_, name) => String(params[name]));

/** Enough of `XMLHttpRequest` for the transport, driven by hand. */
class FakeXhr extends EventTarget {
  constructor() {
    super();
    this.upload = new EventTarget();
    this.status = 0;
    this.responseText = "";
    this.withCredentials = false;
    this.headers = {};
    this.aborted = 0;
    this.sent = null;
    this.done = false;
  }
  open(method, url) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name, value) {
    this.headers[name] = value;
  }
  send(body) {
    this.sent = body;
  }
  abort() {
    if (this.done) return;
    this.aborted += 1;
    this.#end("abort");
  }
  // --- driving it ---
  progress(loaded, total = FILE.size + 400) {
    const event = new Event("progress");
    Object.assign(event, { lengthComputable: true, loaded, total });
    this.upload.dispatchEvent(event);
  }
  bodySent() {
    this.upload.dispatchEvent(new Event("load"));
  }
  respond(status, text = "") {
    this.status = status;
    this.responseText = text;
    this.dispatchEvent(new Event("readystatechange"));
    this.#end("load");
  }
  fail() {
    this.#end("error");
  }
  #end(type) {
    if (this.done) return;
    this.done = true;
    this.dispatchEvent(new Event(type));
    this.dispatchEvent(new Event("loadend"));
  }
}

function send(extra = {}) {
  const xhr = new FakeXhr();
  const promise = sendUploadRequest({
    url: "/uploads/single-public",
    body: "BODY",
    file: FILE,
    headers: { "X-CSRFToken": "tok" },
    createXhr: () => xhr,
    ...extra,
  });
  // Observe the outcome without an unhandled rejection in between.
  const outcome = promise.then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  );
  return { xhr, promise, outcome };
}

/** Has the promise settled yet? (Microtasks only — no timers involved.) */
async function settled(promise) {
  const marker = Symbol("pending");
  const result = await Promise.race([
    promise,
    new Promise((resolve) => setImmediate(() => resolve(marker))),
  ]);
  return result !== marker;
}

function withFakeTimers(ctx) {
  mock.timers.enable({ apis: ["setTimeout"] });
  ctx.after(() => mock.timers.reset());
}

// ---------------------------------------------------------------------------
// The stall bound
// ---------------------------------------------------------------------------

test("an upload whose bytes stop moving is aborted and rejects as stalled", async (ctx) => {
  withFakeTimers(ctx);
  const { xhr, outcome } = send();
  assert.equal(xhr.method, "POST");
  assert.equal(xhr.sent, "BODY");
  assert.equal(xhr.withCredentials, true);
  assert.equal(xhr.headers["X-CSRFToken"], "tok");

  xhr.progress(1 * MB);
  mock.timers.tick(UPLOAD_STALL_TIMEOUT_MS - 1);
  assert.equal(xhr.aborted, 0, "not yet: the window has not elapsed");
  assert.equal(await settled(outcome), false);

  mock.timers.tick(1);
  assert.equal(xhr.aborted, 1);
  const { ok, error } = await outcome;
  assert.equal(ok, false);
  assert.ok(error instanceof UploadRequestError);
  assert.equal(error.kind, "stalled");
  assert.equal(error.status, 0);
  assert.equal(error.fileName, "clip.mp4");
  assert.equal(error.fileBytes, 33 * MB);
  // A stall is not an nginx refusal, so the limit is not re-read for it.
  assert.equal(isUploadRejection(error), false);

  const message = uploadErrorMessage(error, t);
  assert.match(message, /clip\.mp4/);
  assert.match(message, /33 MB/);
  assert.match(message, /stopped uploading/);
});

test("a request that never produces a single progress event is bounded too", async (ctx) => {
  withFakeTimers(ctx);
  const { xhr, outcome } = send();
  // Not by the short stall window: with no progress yet it may merely be
  // queued behind the browser's per-origin connection limit (a batch drop).
  mock.timers.tick(UPLOAD_STALL_TIMEOUT_MS * 3);
  assert.equal(xhr.aborted, 0, "a queued request is not a stalled one");
  mock.timers.tick(UPLOAD_RESPONSE_TIMEOUT_MS);
  assert.equal(xhr.aborted, 1);
  assert.equal((await outcome).error.kind, "stalled");
});

test("a slow upload that keeps moving is never cut off (idle time, not wall clock)", async (ctx) => {
  withFakeTimers(ctx);
  const progress = [];
  const { xhr, outcome } = send({
    onProgress: (loaded, total) => progress.push([loaded, total]),
  });

  // Ten minutes of a 33 MB video on a bad link: a trickle every 20 s.
  for (let i = 1; i <= 30; i += 1) {
    mock.timers.tick(20_000);
    xhr.progress(i * MB);
  }
  assert.equal(xhr.aborted, 0);
  assert.equal(progress.length, 30);
  assert.deepEqual(progress.at(-1), [30 * MB, FILE.size + 400]);

  xhr.bodySent();
  xhr.respond(201, '{"id":7,"url":"/uploadz/public/u/clip.mp4"}');
  const { ok, value } = await outcome;
  assert.equal(ok, true);
  assert.equal(value.status, 201);
  assert.match(value.responseText, /clip\.mp4/);

  // The watch disarmed itself: nothing fires later.
  mock.timers.tick(UPLOAD_RESPONSE_TIMEOUT_MS * 2);
  assert.equal(xhr.aborted, 0);
});

test("once the body is sent, the server gets the longer response window", async (ctx) => {
  withFakeTimers(ctx);
  const { xhr, outcome } = send();
  xhr.progress(FILE.size);
  xhr.bodySent();

  // Longer than the stall window: a server storing a video says nothing.
  mock.timers.tick(UPLOAD_STALL_TIMEOUT_MS * 2);
  assert.equal(xhr.aborted, 0);
  assert.equal(await settled(outcome), false);

  mock.timers.tick(UPLOAD_RESPONSE_TIMEOUT_MS);
  assert.equal(xhr.aborted, 1);
  assert.equal((await outcome).error.kind, "stalled");
});

test("watchUploadStall runs onStall BEFORE the abort, so onabort can tell", async (ctx) => {
  withFakeTimers(ctx);
  const xhr = new FakeXhr();
  const order = [];
  xhr.addEventListener("abort", () => order.push("abort"));
  watchUploadStall(xhr, {
    onStall: () => order.push("stall"),
    stallTimeoutMs: 1000,
    responseTimeoutMs: 1000,
  });
  mock.timers.tick(1000);
  assert.deepEqual(order, ["stall", "abort"]);
});

// ---------------------------------------------------------------------------
// Status handling: 403, 413, 500, network
// ---------------------------------------------------------------------------

const LIMIT = {
  tuzis: 0,
  max_bytes: 5 * MB,
  tiers: [
    { min_tuzis: 0, max_bytes: 5 * MB },
    { min_tuzis: 1, max_bytes: 250 * MB },
  ],
};

function limitRequest(payload, calls) {
  return async (url) => {
    calls?.push(url);
    return new Response(JSON.stringify(payload), { status: 200 });
  };
}

test("nginx's bodiless 403 is a refusal, explained from a FRESH limit", async () => {
  resetUploadLimitCache();
  const { xhr, outcome } = send();
  xhr.progress(1 * MB);
  xhr.respond(403, "");
  const { error } = await outcome;
  assert.equal(error.kind, "refused");
  assert.equal(error.status, 403);
  assert.equal(error.requestBytes, FILE.size + 400);
  assert.equal(isUploadRejection(error), true);

  const calls = [];
  await explainUploadRejection(error, {
    request: limitRequest(LIMIT, calls),
  });
  assert.deepEqual(calls, ["/api/uploads/limits/"]);
  assert.equal(error.oversize.maxBytes, 5 * MB);
  const message = uploadErrorMessage(error, t);
  assert.match(message, /clip\.mp4 is 33 MB — your upload limit is 5 MB\./);
  assert.match(message, /Hold 1 2Z/);
});

test("a 403 the limit does not explain says 'signed out', with name and size", async () => {
  resetUploadLimitCache();
  const { xhr, outcome } = send({ file: { name: "me.png", size: 2 * MB } });
  xhr.respond(403);
  const { error } = await outcome;
  await explainUploadRejection(error, { request: limitRequest(LIMIT) });
  assert.equal(error.oversize, null);
  const message = uploadErrorMessage(error, t);
  assert.match(message, /^me\.png \(2 MB\) was refused\./);
  assert.match(message, /signed out/);
});

test("a 413 is a refusal too, and says the server's cap was hit", async () => {
  resetUploadLimitCache();
  const { xhr, outcome } = send({ file: { name: "me.png", size: 2 * MB } });
  xhr.respond(413, "<html>413</html>");
  const { error } = await outcome;
  assert.equal(error.kind, "refused");
  assert.equal(error.status, 413);
  assert.equal(isUploadRejection(error), true);
  await explainUploadRejection(error, { request: limitRequest(LIMIT) });
  assert.match(
    uploadErrorMessage(error, t),
    /me\.png \(2 MB\) is larger than the server accepts/,
  );
});

test("a 500 rejects with its status and waits on no limit read", async () => {
  const { xhr, outcome } = send();
  xhr.progress(10 * MB);
  xhr.respond(500, "<html>500 Internal Server Error</html>");
  const { error } = await outcome;
  assert.equal(error.kind, "http");
  assert.equal(error.status, 500);
  assert.equal(isUploadRejection(error), false);

  const calls = [];
  await explainUploadRejection(error, { request: limitRequest(LIMIT, calls) });
  assert.deepEqual(calls, [], "a 500 has nothing to do with the quota");
  assert.equal(
    uploadErrorMessage(error, t),
    "clip.mp4 (33 MB) failed to upload (error 500). Please try again.",
  );
});

test("a 429 (the pod's upload spool is full, #2045) says 'busy, retry', not 'refused' or 'network'", async () => {
  const { xhr, outcome } = send();
  xhr.progress(1 * MB);
  xhr.respond(429, "<html>429 Too Many Requests</html>");
  const { error } = await outcome;
  assert.equal(error.kind, "busy");
  assert.equal(error.status, 429);
  assert.equal(
    isUploadRejection(error),
    false,
    "a busy pod is not a quota or sign-in refusal; re-reading the limit explains nothing",
  );
  const calls = [];
  await explainUploadRejection(error, { request: limitRequest(LIMIT, calls) });
  assert.deepEqual(calls, []);
  assert.equal(
    uploadErrorMessage(error, t),
    "clip.mp4 (33 MB) was not uploaded — the server is busy with other uploads right now. Try again in a few seconds.",
  );
});

test("a network error rejects, and is treated as a possible mid-body refusal", async () => {
  const { xhr, outcome } = send();
  xhr.progress(1 * MB);
  xhr.fail();
  const { error } = await outcome;
  assert.equal(error.kind, "network");
  assert.equal(error.status, 0);
  assert.equal(isUploadRejection(error), true);
  assert.match(
    uploadErrorMessage(error, t),
    /^clip\.mp4 \(33 MB\) did not reach the server\./,
  );
});

test("the caller's signal cancels quietly, as 'cancelled'", async () => {
  const controller = new AbortController();
  const { xhr, outcome } = send({ signal: controller.signal });
  controller.abort();
  assert.equal(xhr.aborted, 1);
  assert.equal((await outcome).error.kind, "cancelled");
});

test("a TypeError from fetch still counts as a rejection (legacy callers)", () => {
  assert.equal(isUploadRejection(new TypeError("Failed to fetch")), true);
  assert.equal(isUploadRejection(new Error("nope")), false);
});

// ---------------------------------------------------------------------------
// The pre-check
// ---------------------------------------------------------------------------

test("an oversize file is refused locally, naming the limit, before sending", async () => {
  resetUploadLimitCache();
  await assert.rejects(
    preflightUpload(FILE, { request: limitRequest(LIMIT) }),
    (error) => {
      assert.ok(error instanceof UploadRequestError);
      assert.equal(error.kind, "too-large");
      assert.equal(error.oversize.maxBytes, 5 * MB);
      assert.match(
        uploadErrorMessage(error, t),
        /^clip\.mp4 is 33 MB — your upload limit is 5 MB\. Hold 1 2Z/,
      );
      return true;
    },
  );
});

test("a file that fits, or an unreadable limit, is let through", async () => {
  resetUploadLimitCache();
  const fits = await preflightUpload(
    { name: "a.png", size: 1 * MB },
    { request: limitRequest(LIMIT) },
  );
  assert.equal(fits.max_bytes, 5 * MB);

  resetUploadLimitCache();
  const unknown = await preflightUpload(FILE, {
    request: async () => new Response("", { status: 502 }),
  });
  assert.equal(unknown, null, "an unknown limit refuses nothing");
});

test("a non-upload error still gets a message, never an empty string", () => {
  assert.equal(
    uploadErrorMessage(new Error("x"), t, "en", "a.png"),
    "a.png could not be uploaded. Please try again.",
  );
});

// ---------------------------------------------------------------------------
// Wiring: every client upload path goes through it (source, formatting-blind)
// ---------------------------------------------------------------------------

test("every upload caller is bounded and reports a named error", async () => {
  const { readFile } = await import("node:fs/promises");
  const read = (relative) =>
    readFile(new URL(relative, import.meta.url), "utf8");

  // The editor's uploader (cover crop, inline paste/drop, converse).
  const api = await read("../src/lib/api/uploads.ts");
  assert.match(api, /await\s+sendUploadRequest\(\{/);
  assert.equal(/apiFetch\(\s*["']\/uploads\//.test(api), false);

  // Settings: the surface the owner found the outage on.
  const settings = await read(
    "../src/routes/[username]/dashboard/settings/+page.svelte",
  );
  const uploadImage = settings.slice(
    settings.indexOf("async function uploadImage"),
    settings.indexOf("async function handleSave"),
  );
  assert.match(uploadImage, /uploadPublicFile\(file,\s*title\)/);
  assert.equal(/apiFetch\(\s*["']\/uploads\//.test(uploadImage), false);
  assert.match(
    settings,
    /error instanceof UploadRequestError\s*\?\s*uploadErrorMessage\(/,
  );

  // The cover field names the file instead of "Failed to update the cover".
  const cover = await read(
    "../src/lib/components/mdEditor/EditorCoverField.svelte",
  );
  assert.match(cover, /explainUploadRejection\(error,/);
  assert.match(cover, /uploadErrorMessage\(explained,/);

  // The inline pipeline is handed the shared sentence.
  const textarea = await read(
    "../src/lib/components/mdEditor/markdownTextarea.svelte.ts",
  );
  assert.match(textarea, /describeUploadError:/);
  assert.match(textarea, /limitChecked:\s*true/);

  // The media uploader keeps its own XHR, but arms the SAME watch before
  // send, and a stall-abort is reported rather than swallowed by onabort.
  const uploader = await read(
    "../src/lib/components/media/MediaUploader.svelte",
  );
  const armed = uploader.search(/watchUploadStall\(xhr,/);
  const sent = uploader.search(/xhr\.send\(formData\)/);
  assert.notEqual(armed, -1);
  assert.ok(armed < sent, "the watch must be armed before send()");
  const onabort = uploader.slice(
    uploader.indexOf("xhr.onabort"),
    uploader.indexOf("watchUploadStall(xhr,"),
  );
  assert.match(onabort, /if\s*\(stalled\s*&&\s*!destroyed\)/);
  assert.match(onabort, /kind:\s*["']stalled["']/);
  assert.match(onabort, /item\.notice\.error\(message\)/);
});
