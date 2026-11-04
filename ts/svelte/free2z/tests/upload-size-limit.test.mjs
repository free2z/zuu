/**
 * The upload ceiling used to be invisible: a creator picked a 40MB video, sat
 * through the upload, and got `Upload failed (403)`. Nothing said it was a
 * quota, that the quota is tiered, or that 2Z raise it.
 *
 * The fix is not "port the tier table into the Svelte app" — that is the same
 * duplicated monetization table the React app had, in a third place. The
 * server reports the caller's own ceiling (`GET /api/uploads/limits/`) and the
 * client renders what it is told. So these tests are, in order of importance:
 *
 *   1. there is NO tier table in the client (the anti-drift assertion);
 *   2. the number on screen and the refusal both come from the server payload;
 *   3. an unreadable limit refuses nothing;
 *   4. a 403 is explained, and explained from a FRESH read of the limit.
 *
 * Source-scraping assertions are written formatting-insensitively (`\s*`,
 * `['"]`, membership not order) so a prettier pass cannot turn them red.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  UPLOAD_LIMIT_PATH,
  checkUploadSize,
  confirmOversize,
  fetchUploadLimit,
  formatByteLimit,
  isEnvelopeOverage,
  isUploadLimit,
  loadUploadLimit,
  nextUploadTier,
  refreshUploadLimit,
  resetUploadLimitCache,
} from "../src/lib/components/media/uploadLimit.ts";

const read = (relative) => readFile(new URL(relative, import.meta.url), "utf8");

const uploaderSource = await read(
  "../src/lib/components/media/MediaUploader.svelte",
);
const contentFieldSource = await read(
  "../src/lib/components/mdEditor/EditorContentField.svelte",
);
// The inline upload pipeline was EditorContentField's until  extracted it
// so the Converse composer shares it instead of copying it. The contract below
// is pinned where the code now lives; `markdownTextarea.svelte.ts` is what
// wires it to a live textarea for both hosts.
const inlineUploadsSource = await read(
  "../src/lib/components/mdEditor/inlineUploads.ts",
);
const textareaControllerSource = await read(
  "../src/lib/components/mdEditor/markdownTextarea.svelte.ts",
);
const INLINE_END = "  return {\n    startInlineUploads";
const composerSource = await read(
  "../src/lib/components/mdEditor/EditorComposer.svelte",
);
const editPageSource = await read("../src/routes/edit/+page.svelte");
const limitModuleSource = await read(
  "../src/lib/components/media/uploadLimit.ts",
);
const uploadsApiSource = await read("../src/lib/api/uploads.ts");
const pythonLimitsSource = await read(
  "../../../../py/free2z/dj/apps/uploads/limits.py",
);

const localeNames = ["en", "es", "fr", "pt-BR"];
const localeMessages = Object.fromEntries(
  await Promise.all(
    localeNames.map(async (name) => [
      name,
      JSON.parse(await read(`../src/lib/locales/${name}.json`)),
    ]),
  ),
);

/** Strip `//` and `/* *​/` comments so prose about bytes is not code. */
const withoutComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** The ladder exactly as `py/free2z/dj/apps/uploads/limits.py` defines it. */
const LADDER = {
  tuzis: 0,
  max_bytes: 5 * MB,
  tiers: [
    { min_tuzis: 0, max_bytes: 5 * MB },
    { min_tuzis: 1, max_bytes: 250 * MB },
    { min_tuzis: 5000, max_bytes: 250 * MB },
  ],
};

const ladderAt = (maxBytes, tuzis = 0) => ({
  ...LADDER,
  tuzis,
  max_bytes: maxBytes,
});

/** A stub `Response` good enough for `fetchUploadLimit`. */
const jsonResponse = (body, { ok = true } = {}) => ({
  ok,
  json: async () => body,
});

// --- 1. the client must not know the numbers -------------------------------

test("the client carries no copy of the server's tier table", () => {
  // The literal balances (1, 5000) and the literal sizes (5MB, 250MB) are
  // the monetization table. `maxUploadBytesFor()` was a hand-copy of it; if one
  // reappears anywhere in the media/editor client, this is the alarm.
  const clientCode = [
    withoutComments(limitModuleSource),
    withoutComments(uploaderSource),
    withoutComments(contentFieldSource),
    withoutComments(inlineUploadsSource),
    withoutComments(textareaControllerSource),
    withoutComments(uploadsApiSource),
  ].join("\n");

  for (const forbidden of [
    /\b5000\b/,
    /\b250\s*\*/,
    /1024\s*\*\s*1024\s*\*\s*1024/,
    /\bmaxUploadBytesFor\b/,
  ]) {
    assert.equal(
      forbidden.test(clientCode),
      false,
      `the tier table is back in the client: ${forbidden}`,
    );
  }
});

test("the tier table exists exactly once, in Python", () => {
  // Not a value assertion — `py/free2z/dj/apps/uploads/test_upload_limits.py` owns
  // the numbers. This only proves the client is reading a table that IS
  // defined somewhere, so the check above cannot pass by the table having
  // been deleted outright.
  assert.match(pythonLimitsSource, /UPLOAD_SIZE_TIERS\s*=\s*\(/);
  assert.match(pythonLimitsSource, /\(\s*5000\s*,\s*250\s*\*\s*MB\s*\)/);
});

test("the module's endpoint is the one Django registered", async () => {
  const urlsSource = await read("../../../../py/free2z/dj/free2z/urls.py");
  assert.equal(UPLOAD_LIMIT_PATH, "/api/uploads/limits/");
  assert.match(
    urlsSource,
    /['"]api\/uploads\/limits\/['"]\s*,\s*uploadslimits\.UploadLimitView/,
  );
});

// --- 2. the ladder drives the message --------------------------------------

test("the next tier is the cheapest rung that actually raises the ceiling", () => {
  assert.deepEqual(nextUploadTier(ladderAt(5 * MB)), {
    min_tuzis: 1,
    max_bytes: 250 * MB,
  });
  assert.equal(nextUploadTier(ladderAt(250 * MB, 10)), null);
});

test("the 5000 2Z compatibility rung does not promise a larger upload", () => {
  const top = ladderAt(250 * MB, 5000);
  assert.equal(top.max_bytes, 250 * MB);
  assert.equal(nextUploadTier(top), null);
});

test("a rung that does not raise the ceiling is not an upgrade", () => {
  // A future ladder could carry two rungs at the same size (a rename, a
  // promotion). Offering "hold 5000 2Z" to get the size you already have is
  // worse than offering nothing.
  const flat = {
    tuzis: 1,
    max_bytes: 250 * MB,
    tiers: [
      { min_tuzis: 0, max_bytes: 5 * MB },
      { min_tuzis: 1, max_bytes: 250 * MB },
      { min_tuzis: 5000, max_bytes: 250 * MB },
    ],
  };
  assert.equal(nextUploadTier(flat), null);
});

test("an oversize file is named with the limit and what raises it", () => {
  const oversize = checkUploadSize(
    { name: "hike.mp4", size: 40 * MB },
    ladderAt(5 * MB),
  );

  assert.deepEqual(oversize, {
    fileName: "hike.mp4",
    fileBytes: 40 * MB,
    comparedBytes: 40 * MB,
    maxBytes: 5 * MB,
    nextTier: { min_tuzis: 1, max_bytes: 250 * MB },
  });
  assert.equal(isEnvelopeOverage(oversize), false);
});

test("a file exactly at the limit is sent, not refused", () => {
  // The server's own comparison is `> limit`, so equality must pass here too
  // or the client refuses a file the server would take.
  assert.equal(
    checkUploadSize({ name: "exact.png", size: 5 * MB }, ladderAt(5 * MB)),
    null,
  );
  assert.match(pythonLimitsSource, /max_bytes/);
});

test("the request envelope, not the file, is what a 403 is explained by", () => {
  // nginx compares `X-Original-Content-Length` — the whole multipart body. A
  // file of exactly the limit is refused because of the boundaries, part
  // headers and JSON metadata riding along with it. Explaining that as
  // "your session may have expired" is wrong twice over.
  const oversize = checkUploadSize(
    { name: "exact.png", size: 5 * MB },
    ladderAt(5 * MB),
    5 * MB + 412,
  );

  assert.notEqual(oversize, null);
  assert.equal(oversize.fileBytes, 5 * MB);
  assert.equal(oversize.comparedBytes, 5 * MB + 412);
  //...and it is a DIFFERENT message: the way out is a smaller file, not 2Z.
  assert.equal(isEnvelopeOverage(oversize), true);
});

test("a request size below the file size is ignored, not trusted", () => {
  // `xhr.upload`'s `total` can only ever be at least the file's own size. A
  // smaller figure is a broken event, and taking it would let a genuinely
  // oversize file through the pre-flight.
  const oversize = checkUploadSize(
    { name: "big.mp4", size: 40 * MB },
    ladderAt(5 * MB),
    1024,
  );
  assert.equal(oversize.comparedBytes, 40 * MB);
});

// --- 3. an unreadable limit refuses nothing --------------------------------

test("no limit means no client-side refusal", () => {
  assert.equal(checkUploadSize({ name: "a.png", size: 9 * GB }, null), null);
  assert.equal(
    checkUploadSize({ name: "a.png", size: 9 * GB }, undefined),
    null,
  );
});

test("a partial payload is treated as no answer at all", () => {
  // "Files up to NaN", or a comparison against `undefined`, are both worse
  // than saying nothing.
  assert.equal(isUploadLimit(LADDER), true);
  assert.equal(isUploadLimit({ max_bytes: 5 * MB, tuzis: 0 }), false);
  assert.equal(
    isUploadLimit({ max_bytes: "lots", tuzis: 0, tiers: [] }),
    false,
  );
  assert.equal(
    isUploadLimit({
      max_bytes: 5 * MB,
      tuzis: 0,
      tiers: [{ min_tuzis: 0 }],
    }),
    false,
  );
  assert.equal(isUploadLimit(null), false);
});

test("a failed or rejected read resolves to null rather than throwing", async () => {
  assert.equal(
    await fetchUploadLimit({
      request: async () => jsonResponse(LADDER, { ok: false }),
    }),
    null,
  );
  assert.equal(
    await fetchUploadLimit({
      request: async () => {
        throw new Error("offline");
      },
    }),
    null,
  );
  assert.equal(
    await fetchUploadLimit({ request: async () => jsonResponse({ x: 1 }) }),
    null,
  );
});

test("a file of unknown size is never refused", () => {
  assert.equal(checkUploadSize({ name: "a.png" }, ladderAt(5 * MB)), null);
});

// --- the request itself ----------------------------------------------------

test("the limit is read from the API base the caller passes", async () => {
  const seen = [];
  await fetchUploadLimit({
    request: async (url, init) => {
      seen.push([url, init?.method]);
      return jsonResponse(LADDER);
    },
    apiBase: "https://free2z.cash",
  });

  assert.deepEqual(seen, [["https://free2z.cash/api/uploads/limits/", "GET"]]);
});

test("concurrent mounts share one request; a refresh forces a new one", async () => {
  resetUploadLimitCache();
  let calls = 0;
  const request = async () => {
    calls += 1;
    return jsonResponse(ladderAt(5 * MB, calls));
  };

  const [first, second] = await Promise.all([
    loadUploadLimit({ request }),
    loadUploadLimit({ request }),
  ]);
  assert.equal(calls, 1);
  assert.equal(first, second);

  // A 403 must not be explained from a cached ceiling — the balance may have
  // dropped a rung since the page loaded, which is exactly the case where the
  // cache says the file should have fit.
  await refreshUploadLimit({ request });
  assert.equal(calls, 2);
  resetUploadLimitCache();
});

// --- a stale snapshot may permit, but never refuse -------------------------

test("a refusal is confirmed against a fresh limit, never a snapshot", async () => {
  // The failure this closes: the creator loads the page at 0 2Z, then buys
  // credits. The real ceiling is now 250MB, but the cached 5MB refuses the
  // file LOCALLY — so no request is made, so nothing ever discovers the new
  // limit, and the entitlement they just paid for is dead until a reload.
  resetUploadLimitCache();
  let calls = 0;
  const request = async () => {
    calls += 1;
    return jsonResponse(ladderAt(250 * MB, 10));
  };

  const { limit, oversize } = await confirmOversize(
    [{ name: "clip.mp4", size: 40 * MB }],
    { request, limit: ladderAt(5 * MB) },
  );

  assert.equal(calls, 1, "the snapshot said refuse; it must be re-read");
  assert.deepEqual(oversize, []);
  assert.equal(limit.max_bytes, 250 * MB);
  resetUploadLimitCache();
});

test("no snapshot means retry the read, not skip the gate", async () => {
  // A single failed mount-time read would otherwise disable the pre-flight and
  // the standing hint for the life of the page: with `limit: null` nothing
  // looks suspect, so nothing re-reads, so only a 403 — i.e. only AFTER the
  // doomed upload — could ever repair it.
  resetUploadLimitCache();
  let calls = 0;
  const request = async () => {
    calls += 1;
    return jsonResponse(ladderAt(5 * MB));
  };

  const { limit, oversize } = await confirmOversize(
    [{ name: "huge.mp4", size: 900 * MB }],
    { request, limit: null },
  );

  // EXACTLY two, not `>= 1`: `confirmOversize` reads once because the snapshot
  // is missing, then refreshes because that answer refuses the file. Codex
  // (round 8) flagged the loose assertion for hiding that second read. The
  // second read is deliberate and stays — `loadUploadLimit` returns the
  // process-wide cache, so "no snapshot" does not imply "fresh", and skipping
  // the refresh would reintroduce the stale-refusal bug `confirmOversize`
  // exists to prevent. Pinning the number means a future change to it is a
  // decision, not a drift.
  assert.equal(
    calls,
    2,
    "one read because there was no snapshot, one to confirm",
  );
  assert.equal(limit.max_bytes, 5 * MB);
  assert.deepEqual(
    oversize.map((entry) => entry.fileName),
    ["huge.mp4"],
  );
  resetUploadLimitCache();
});

test("a batch that fits the snapshot costs no extra request", async () => {
  resetUploadLimitCache();
  let calls = 0;
  const request = async () => {
    calls += 1;
    return jsonResponse(LADDER);
  };

  const { oversize } = await confirmOversize([{ name: "a.png", size: 1024 }], {
    request,
    limit: ladderAt(5 * MB),
  });

  assert.equal(calls, 0);
  assert.deepEqual(oversize, []);
});

test("a refusal that survives the fresh read still refuses", async () => {
  resetUploadLimitCache();
  const { oversize } = await confirmOversize(
    [
      { name: "small.png", size: 1024 },
      { name: "huge.mp4", size: 900 * MB },
    ],
    { request: async () => jsonResponse(ladderAt(5 * MB)), limit: LADDER },
  );

  assert.deepEqual(
    oversize.map((entry) => entry.fileName),
    ["huge.mp4"],
  );
  resetUploadLimitCache();
});

test("an unreadable fresh limit refuses nothing at all", async () => {
  // The re-read is what decides. If it fails, the honest answer is to send
  // and let the server enforce — not to fall back on the stale snapshot.
  resetUploadLimitCache();
  const { limit, oversize } = await confirmOversize(
    [{ name: "huge.mp4", size: 900 * MB }],
    { request: async () => jsonResponse(null, { ok: false }), limit: LADDER },
  );

  assert.equal(limit, null);
  assert.deepEqual(oversize, []);
  resetUploadLimitCache();
});

// --- a read the creator is waiting on must be bounded ----------------------

test("a limit read that never settles gives up instead of hanging", async () => {
  // Both callers AWAIT this on a path the creator is standing in front of —
  // dropping files, and explaining a 403 (which blocks the serial upload
  // queue). A wedged backend behind nginx's ~200s proxy timeout would
  // otherwise turn "I dropped a file" into a UI that does nothing at all.
  const started = Date.now();
  const limit = await fetchUploadLimit({
    request: (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      }),
    timeoutMs: 25,
  });

  assert.equal(limit, null);
  assert.ok(Date.now() - started < 5_000, "it must not wait for the network");
});

test("the read carries an abort signal, not just a promise race", () => {
  // A race that leaves the request in flight still holds a connection and
  // still resolves later into a discarded result.
  assert.match(limitModuleSource, /new AbortController\(\)/);
  assert.match(limitModuleSource, /signal:\s*controller\.signal/);
  assert.match(limitModuleSource, /clearTimeout\(timer\)/);
});

test("a failed read is not cached; the next caller tries again", async () => {
  // Caching "we could not find out" for the life of the page is the same dead
  // end the timeout exists to avoid.
  resetUploadLimitCache();
  let calls = 0;
  const request = async () => {
    calls += 1;
    return calls === 1
      ? jsonResponse(null, { ok: false })
      : jsonResponse(LADDER);
  };

  assert.equal(await loadUploadLimit({ request }), null);
  const second = await loadUploadLimit({ request });
  assert.equal(calls, 2);
  assert.equal(second.max_bytes, LADDER.max_bytes);

  //...and a successful answer IS cached.
  await loadUploadLimit({ request });
  assert.equal(calls, 2);
  resetUploadLimitCache();
});

// --- formatting ------------------------------------------------------------

test("byte counts render as the units a person reads", () => {
  assert.equal(formatByteLimit(5 * MB), "5 MB");
  assert.equal(formatByteLimit(250 * MB), "250 MB");
  // A file that just missed must not be reported as the same number as the
  // limit it missed.
  assert.equal(formatByteLimit(5.4 * MB), "5.4 MB");
  assert.notEqual(formatByteLimit(5.4 * MB), formatByteLimit(5 * MB));
});

test("byte counts are localized, not English with a unit glued on", () => {
  // Intl separates the number from the unit with U+202F here, not a plain
  // space — compare on the visible characters so an ICU data bump that only
  // changes the separator does not read as a regression.
  assert.equal(formatByteLimit(250 * MB, "fr").replace(/\s+/gu, " "), "250 Mo");
});

// --- 4. the wiring in the components ---------------------------------------

test("the uploader reads the limit on mount, before any file is picked", () => {
  assert.match(uploaderSource, /onMount\(/);
  assert.match(
    uploaderSource,
    /loadUploadLimit\(\s*\{\s*request:\s*apiFetch\s*,\s*apiBase\s*\}\s*\)/,
  );
});

test("the uploader renders the limit as standing text", () => {
  assert.match(uploaderSource, /data-upload-limit-hint/);
  assert.match(uploaderSource, /\{uploadLimitHint\}/);
  //...and renders nothing at all when it does not know.
  assert.match(uploaderSource, /\{#if\s+uploadLimitHint\}/);
});

test("the uploader drops an oversize file before opening a request", () => {
  const addFiles = uploaderSource.slice(
    uploaderSource.indexOf("const addFiles"),
    uploaderSource.indexOf("const imageFilesFromClipboard"),
  );
  assert.notEqual(addFiles.length, 0);
  //...and it re-reads before refusing, so a balance that went UP is not
  // locked out by a snapshot that no request can ever correct.
  assert.match(addFiles, /await\s+confirmOversize\(/);
  // The queue is built from the FILTERED list: `startUploads()` fires the
  // moment an item lands, so anything that reaches `uploadQueue` is already
  // on the wire.
  assert.match(addFiles, /sendableFiles\.map\(/);
  assert.match(addFiles, /if\s*\(sendableFiles\.length\s*===\s*0\)\s*return/);
});

test("the size check does not open a window to publish a private drop", () => {
  // The size confirmation put an `await` inside `addFiles`, and the queue
  // item's access level was read after it — so flipping the picker to Public
  // while the limit request was in flight would have published a file dropped
  // as private. The sample has to happen before anything is awaited.
  // Comments stripped first: the one explaining this very hazard contains the
  // word "await", and would otherwise be found before the code.
  const addFiles = withoutComments(
    uploaderSource.slice(
      uploaderSource.indexOf("const addFiles"),
      uploaderSource.indexOf("const imageFilesFromClipboard"),
    ),
  );
  const sampledAt = addFiles.search(/const\s+access\s*=\s*uploadAccess\s*;/);
  const firstAwait = addFiles.search(/\bawait\b/);
  assert.notEqual(sampledAt, -1);
  assert.notEqual(firstAwait, -1, "this test is only meaningful with an await");
  assert.ok(sampledAt < firstAwait);
  assert.equal(/access:\s*uploadAccess/.test(addFiles), false);
});

test("the 403 explanation is measured against the real request size", () => {
  // `xhr.upload`'s progress `total` IS `Content-Length` — the number nginx
  // compared. The file's own size is not.
  assert.match(uploaderSource, /xhr\.upload\.onloadstart\s*=/);
  assert.match(uploaderSource, /requestBytes\s*=\s*event\.total/);
  const describe = uploaderSource.slice(
    uploaderSource.indexOf("const describeUploadFailure"),
    uploaderSource.indexOf("const sendUpload"),
  );
  assert.match(
    describe,
    /checkUploadSize\(item\.file,\s*fresh,\s*requestBytes\)/,
  );
});

test("no copy promises a tier that a fractional balance does not reach", () => {
  // The server truncates: 0.5 2Z is still the 0 rung. "Hold ANY 2Z" was a
  // promise the ladder does not keep, so the shorthand is gone and
  // `min_tuzis` is stated literally.
  assert.equal(/uploadLimitUpgradeAny/.test(uploaderSource), false);
  assert.equal(/uploadLimitUpgradeAny/.test(contentFieldSource), false);
  assert.equal(/uploadLimitUpgradeAny/.test(inlineUploadsSource), false);
  for (const locale of localeNames) {
    assert.equal(
      "uploadLimitUpgradeAny" in localeMessages[locale].media,
      false,
      `${locale}.json still carries the "any 2Z" claim`,
    );
  }
  assert.match(localeMessages.en.media.uploadLimitUpgrade, /\{tuzis\}/);
});

test("a 403 is explained from a FRESH limit, not the cached one", () => {
  const describe = uploaderSource.slice(
    uploaderSource.indexOf("const describeUploadFailure"),
    uploaderSource.indexOf("const sendUpload"),
  );
  assert.notEqual(describe.length, 0);
  assert.match(describe, /status\s*!==\s*403/);
  assert.match(describe, /refreshUploadLimit\(/);
  assert.equal(/loadUploadLimit\(/.test(describe), false);
  assert.match(describe, /oversizeMessage\(/);
});

test("an upload refused mid-body is explained, not called a network error", () => {
  // `@deny_upload` sets `Connection: close` while the body is still being
  // sent (`proxy_request_buffering off`), so the SAME quota refusal can
  // arrive as `onerror` with status 0 instead of `onload` with 403.
  const onerror = uploaderSource.slice(
    uploaderSource.indexOf("xhr.onerror"),
    uploaderSource.indexOf("xhr.onabort"),
  );
  assert.notEqual(onerror.length, 0);
  assert.match(onerror, /describeUploadFailure\(\s*item,\s*0\b/);
  // The hardcoded, untranslated string it used to end at.
  assert.equal(/error:\s*["']Network error["']/.test(onerror), false);

  const describe = uploaderSource.slice(
    uploaderSource.indexOf("const describeUploadFailure"),
    uploaderSource.indexOf("const sendUpload"),
  );
  assert.match(describe, /status\s*!==\s*0\b/);
  assert.match(describe, /media\.uploadNetworkError/);
});

test("413 is a quota refusal too, not an unexplained status", () => {
  // `client_max_body_size 5g` is an INDEPENDENT boundary in both nginx layers.
  // A request at the top tier crosses it on the envelope alone, and nginx can
  // answer 413 before the auth subrequest ever returns 403.
  const describe = uploaderSource.slice(
    uploaderSource.indexOf("const describeUploadFailure"),
    uploaderSource.indexOf("const sendUpload"),
  );
  assert.match(describe, /status\s*!==\s*413\b/);
  //...and the generic branch is still reachable for everything else.
  assert.match(describe, /media\.uploadFailedStatus/);
});

test("a drop that resolves after unmount leaks no object URLs", () => {
  // The size confirmation is an await, so the component can be destroyed
  // while it is in flight. `onDestroy` has already walked an empty queue by
  // then, so any object URL created afterwards is never revoked — a
  // multi-gigabyte blob held until a full page reload.
  const addFiles = withoutComments(
    uploaderSource.slice(
      uploaderSource.indexOf("const addFiles"),
      uploaderSource.indexOf("const imageFilesFromClipboard"),
    ),
  );
  const guard = addFiles.search(/if\s*\(destroyed\)\s*return;/);
  const createsUrl = addFiles.search(/URL\.createObjectURL/);
  assert.notEqual(guard, -1, "addFiles must bail out if destroyed mid-await");
  assert.notEqual(createsUrl, -1);
  assert.ok(guard < createsUrl);
});

test("the editor explains a refusal instead of shrugging at it", () => {
  // The pre-flight snapshot can be stale HIGH — a balance that dropped a rung
  // in another tab — so the file goes out and comes back refused. That used
  // to end at "Image upload failed.", with no reason and no number.
  const failure = inlineUploadsSource.slice(
    inlineUploadsSource.indexOf("async function uploadFailureMessage"),
    inlineUploadsSource.indexOf("function oversizeMessage"),
  );
  assert.notEqual(failure.length, 0);
  // It takes the read; it does not perform one. Reading here is what produced
  // both the stale-cache bug and the per-file fan-out.
  assert.match(failure, /freshLimit:\s*\(\)\s*=>\s*Promise</);
  assert.match(
    failure,
    /checkUploadSize\(\s*file,\s*await\s+freshLimit\(\),\s*requestBytes,?\s*\)/,
  );
  assert.match(failure, /oversizeMessage\(file,\s*oversize\)/);
  // The file can fit and the REQUEST not: the status is then the only thing
  // that separates a quota refusal from anything else.
  assert.match(failure, /isUploadRejection\(error\)/);
  //...and the catch actually routes through it.
  assert.match(
    inlineUploadsSource,
    /uploadFailureMessage\(\s*file,\s*error,\s*limitAfterFailure,?\s*\)/,
  );
});

test("a refused upload keeps the status the server answered with", async () => {
  // A plain `Error` threw the status away with it, and the status is the whole
  // story: nginx refuses an oversize body with a bodiless 403 or a 413, and
  // neither carries any text to read. The error class moved to the shared
  // transport, whose BEHAVIOUR — 403/413/500/network/stall — is driven
  // in tests/upload-request.test.mjs; this pins the wiring.
  const transport = await read("../src/lib/components/media/uploadRequest.ts");
  assert.match(transport, /class UploadRequestError extends Error/);
  assert.match(transport, /status === 403 \|\| status === 413/);
  // A transport failure counts too — the refusal closes the connection while
  // the body is still going out, so `fetch` rejects instead of resolving.
  assert.match(transport, /error instanceof TypeError/);
  //...and the editor's uploader goes through it: pre-checked, bounded.
  assert.match(uploadsApiSource, /await\s+preflightUpload\(file,/);
  assert.match(uploadsApiSource, /await\s+sendUploadRequest\(\{/);
  assert.match(
    uploadsApiSource,
    /export\s*\{[^}]*\bUploadRequestError\b[^}]*\bisUploadRejection\b/,
  );
});

test("an inline upload the creator abandoned never sends", () => {
  // The send waits on a limit read, and an async job outlives the component
  // that started it. Without a guard, dropping an image and navigating away
  // still uploads it — PUBLIC, because that is what an editor upload is —
  // into a page the creator has left.
  const inline = inlineUploadsSource.slice(
    inlineUploadsSource.indexOf("async function startInlineUploads"),
    inlineUploadsSource.indexOf(INLINE_END),
  );
  const guard = inline.search(
    /if\s*\(editorAbandoned\(\)\s*\|\|\s*!uploadTokenIsLive\(token\)\)/,
  );
  const send = inline.search(/await\s+uploadPublicFile\(/);
  assert.notEqual(guard, -1, "the job must bail out after the await");
  assert.notEqual(send, -1);
  assert.ok(guard < send, "the guard must come BEFORE the bytes go up");
});

test("abandonment is the PAGE's signal, never this component's lifecycle", () => {
  // The regression this replaces: the guard read a `destroyed` flag set by
  // this component's own `onMount` cleanup. `/edit` mounts the composer under
  // `{#if mode === "write" || mode === "split"}`, so a Write -> Preview switch
  // DESTROYS the content field while the creator is still editing — and the
  // in-flight upload was abandoned without even clearing its placeholder,
  // silently dropping the image from the saved article.
  //
  // `resolveUploadToken` has carried a "textarea is unmounted (preview-only
  // mode)" branch since long before this PR, which is the proof that
  // surviving a Preview switch is intended behaviour and not an accident.
  assert.match(contentFieldSource, /preview-only mode/);
  assert.match(inlineUploadsSource, /preview-only mode/);
  assert.match(
    textareaControllerSource,
    /read:\s*\(\)\s*=>\s*this\.#textarea\?\.value\s*\?\?\s*this\.#value/,
  );

  // The component must own NO lifecycle-derived abandonment flag at all.
  assert.equal(
    /let\s+destroyed\b/.test(contentFieldSource),
    false,
    "EditorContentField must not derive abandonment from its own lifecycle",
  );
  assert.equal(/\bdestroyed\s*=\s*true/.test(contentFieldSource), false);
  assert.match(
    contentFieldSource,
    /const\s+editorAbandoned\s*=\s*\(\)\s*=>\s*isAbandoned\?\.\(\)\s*===\s*true/,
  );

  //...it reaches the shared pipeline unchanged...
  assert.match(contentFieldSource, /isAbandoned:\s*editorAbandoned,/);
  assert.match(
    textareaControllerSource,
    /editorAbandoned:\s*options\.isAbandoned,/,
  );
  //...and neither shared module derives it from a lifecycle either.
  for (const source of [inlineUploadsSource, textareaControllerSource]) {
    assert.equal(/\bdestroyed\b/.test(withoutComments(source)), false);
  }

  //...and the signal is plumbed from the page that actually knows.
  assert.match(composerSource, /isAbandoned\?:\s*\(\)\s*=>\s*boolean/);
  assert.match(composerSource, /\{isAbandoned\}/);
  assert.match(editPageSource, /isAbandoned=\{\(\)\s*=>\s*destroyed\}/);
  // The page's own flag is set from ITS onDestroy, which is the real thing.
  assert.match(
    editPageSource,
    /onDestroy\(\(\)\s*=>\s*\{\s*destroyed\s*=\s*true;/,
  );
});

test("the editor's failure path reads a limit taken AFTER the rejection", () => {
  // The pre-flight value cannot explain a rejection: the case it has to
  // explain is a balance that dropped a rung mid-batch, where the cached
  // ceiling is exactly what says the file should have fit.
  // Comments stripped before counting: the comment explaining the hazard
  // names `refreshUploadLimit()` and would be counted as a second call site.
  const inline = withoutComments(
    inlineUploadsSource.slice(
      inlineUploadsSource.indexOf("async function startInlineUploads"),
      inlineUploadsSource.indexOf(INLINE_END),
    ),
  );
  assert.match(inline, /freshLimit\s*\?\?=\s*refreshUploadLimit\(/);
  //...once for the whole batch, not once per failing job.
  assert.equal(
    (inline.match(/refreshUploadLimit\(/g) || []).length,
    1,
    "exactly one refresh call site, shared across the batch",
  );
  // The message helper takes the limit rather than reading a cached one.
  const failure = inlineUploadsSource.slice(
    inlineUploadsSource.indexOf("async function uploadFailureMessage"),
    inlineUploadsSource.indexOf("function oversizeMessage"),
  );
  assert.equal(/loadUploadLimit\(/.test(failure), false);
});

test("a failure the limit cannot explain waits on nothing", () => {
  // A 400 from serializer validation, or a 500, has nothing to do with the
  // quota. Reading the limit before saying so made every unrelated failure
  // wait out an unrelated endpoint: the placeholder vanished instantly and
  // the creator got no error for up to the full 8-second timeout, with the
  // batch's `Promise.all` pending behind it.
  const failure = withoutComments(
    inlineUploadsSource.slice(
      inlineUploadsSource.indexOf("async function uploadFailureMessage"),
      inlineUploadsSource.indexOf("function oversizeMessage"),
    ),
  );
  const classify = failure.search(/if\s*\(!isUploadRejection\(error\)\)/);
  const read = failure.search(/await\s+freshLimit\(\)/);
  assert.notEqual(classify, -1);
  assert.notEqual(read, -1);
  assert.ok(
    classify < read,
    "the status must be classified BEFORE any limit read",
  );
});

test("a failure that resolves after unmount stays silent", () => {
  // The explanation can wait on a limit read, and `onDestroy` cannot cancel
  // work already past the abort. A toast is global, so a dead component
  // otherwise pops an error onto whatever page the creator moved to.
  const editorCatch = inlineUploadsSource.slice(
    inlineUploadsSource.indexOf("} catch (error: any) {"),
  );
  assert.match(
    editorCatch,
    /if\s*\(!editorAbandoned\(\)\)\s*toast\.error\(message\)/,
  );

  // The pre-flight refusal is the same story: `addFiles` awaits the
  // confirmation, and a refusal toast raised after that must not surface on
  // the page the creator moved to. (Round 8 of the codex review.)
  const addFiles = withoutComments(
    uploaderSource.slice(
      uploaderSource.indexOf("const addFiles"),
      uploaderSource.indexOf("const imageFilesFromClipboard"),
    ),
  );
  const bail = addFiles.search(/if\s*\(destroyed\)\s*return;/);
  const refusalToast = addFiles.search(
    /operationNotice\.error\(oversizeMessage\(/,
  );
  assert.notEqual(bail, -1);
  assert.notEqual(refusalToast, -1);
  assert.ok(bail < refusalToast, "the refusal toast must be guarded too");

  for (const handler of ["xhr.onload", "xhr.onerror"]) {
    const body = uploaderSource.slice(
      uploaderSource.indexOf(handler),
      uploaderSource.indexOf(
        handler === "xhr.onload" ? "xhr.onerror" : "xhr.onabort",
      ),
    );
    const guard = body.search(/if\s*\(destroyed\)\s*\{/);
    const toastAt = body.search(/item\.notice\.error\(message\)/);
    assert.notEqual(guard, -1, `${handler} must bail out when destroyed`);
    assert.notEqual(toastAt, -1);
    assert.ok(guard < toastAt, `${handler}: the guard must precede the toast`);
  }
});

test("a blackholed limit endpoint costs one timeout, not two", () => {
  // `confirmOversize` already reads when the snapshot is missing. Reading
  // here too made a dead endpoint cost TWO serial 8-second timeouts — sixteen
  // seconds of placeholders with no uploads started.
  // Comments stripped: the one explaining this very hazard names
  // `loadUploadLimit()`, and would otherwise read as a call.
  const confirm = withoutComments(
    inlineUploadsSource.slice(
      inlineUploadsSource.indexOf("async function confirmUploadLimit"),
      inlineUploadsSource.indexOf("async function uploadFailureMessage"),
    ),
  );
  assert.notEqual(confirm.length, 0);
  assert.match(confirm, /limit:\s*null/);
  assert.equal(/loadUploadLimit\(/.test(confirm), false);
});

test("a bulk inline drop takes ONE authoritative read, not one per file", () => {
  // `startInlineUploads` runs every job through `Promise.all`. A per-file
  // confirmation fires one re-read per oversized file — two hundred at once
  // on a big drop, against the same rate limit the uploads need, and the ones
  // that come back 429 read as "limit unknown" and go up anyway.
  const inline = inlineUploadsSource.slice(
    inlineUploadsSource.indexOf("async function startInlineUploads"),
    inlineUploadsSource.indexOf(INLINE_END),
  );
  assert.notEqual(inline.length, 0);
  const confirmAt = inline.search(/await\s+confirmUploadLimit\(files\)/);
  // The fan-out is the async per-file map; `track(jobs.map(...))` above the
  // read only records the tokens and sends nothing.
  const fanOutAt = inline.search(/jobs\.map\(async/);
  assert.notEqual(confirmAt, -1);
  assert.notEqual(fanOutAt, -1);
  assert.ok(confirmAt < fanOutAt, "the read must happen before the fan-out");
  //...and nothing inside a job re-reads.
  const jobBody = inline.slice(fanOutAt);
  assert.equal(/confirmOversize\(|refreshUploadLimit\(/.test(jobBody), false);
});

test("`Upload failed (403)` is no longer a terminal state", () => {
  // The old error path put the bare status in `error` and toasted a generic
  // "failed to upload". Both had to change: the status string is now a
  // last-resort branch for statuses that are not 403.
  assert.equal(
    /error:\s*`Upload failed \(\$\{xhr\.status\}\)`/.test(uploaderSource),
    false,
  );
  const onload = uploaderSource.slice(
    uploaderSource.indexOf("xhr.onload"),
    uploaderSource.indexOf("xhr.onerror"),
  );
  assert.match(onload, /describeUploadFailure\(\s*item,\s*xhr\.status\b/);
  assert.match(onload, /item\.notice\.error\(message\)/);
});

test("the editor gates an inline upload on the server's limit too", () => {
  assert.match(inlineUploadsSource, /await\s+confirmUploadLimit\(files\)/);
  assert.match(inlineUploadsSource, /checkUploadSize\(file,\s*limit\)/);
  assert.match(inlineUploadsSource, /await\s+confirmOversize\(/);
  // It used to derive the ceiling from the session's 2Z balance.
  assert.equal(/creator\?\.tuzis/.test(inlineUploadsSource), false);
});

// --- copy ------------------------------------------------------------------

test("every locale carries the upload-limit copy", () => {
  const keys = [
    "uploadLimitHint",
    "uploadLimitUpgrade",
    "fileTooLarge",
    "fileAtLimit",
    "filesTooLarge",
    "uploadFailedStatus",
    "uploadRefused",
    "uploadNetworkError",
  ];

  for (const locale of localeNames) {
    for (const key of keys) {
      const value = localeMessages[locale].media?.[key];
      assert.equal(
        typeof value === "string" && value.trim().length > 0,
        true,
        `${locale}.json is missing media.${key}`,
      );
    }
  }
});

test("the standing limit describes request bytes, including multipart overhead", () => {
  for (const locale of localeNames) {
    assert.match(
      localeMessages[locale].media.uploadLimitHint,
      /multipart|formul[aá]rio|formulaire/i,
    );
    assert.match(localeMessages[locale].media.uploadLimitUpgrade, /\{limit\}/);
  }
});

test("the refusal copy names the limit and what raises it", () => {
  const media = localeMessages.en.media;
  // Placeholders, not prose: the numbers come from the server at render time,
  // so no catalog may ever contain a byte count of its own.
  assert.match(media.uploadLimitHint, /\{limit\}/);
  assert.match(media.fileTooLarge, /\{filename\}/);
  assert.match(media.fileTooLarge, /\{size\}/);
  assert.match(media.fileTooLarge, /\{limit\}/);
  assert.match(media.uploadLimitUpgrade, /\{tuzis\}/);
  assert.match(media.uploadLimitUpgrade, /\{limit\}/);

  for (const locale of localeNames) {
    for (const [key, value] of Object.entries(localeMessages[locale].media)) {
      if (!key.startsWith("upload") && !key.includes("TooLarge")) continue;
      assert.equal(
        /\b\d+\s*(MB|GB|Mo|Go|KB)\b/i.test(value),
        false,
        `${locale}.json media.${key} hardcodes a size`,
      );
    }
  }
});
