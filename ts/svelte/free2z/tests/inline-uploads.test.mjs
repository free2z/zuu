/**
 * The inline image upload pipeline shared by the zPage body and the Converse
 * composer, driven end to end against stubs.
 *
 * Until  this lived inside `EditorContentField.svelte` and could only be
 * pinned by reading its source. Extracted with its dependencies injected, the
 * behaviour itself is testable here — in particular `pending`, which is what
 * stops Converse from publishing a placeholder token.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildUploadPlaceholder,
  createInlineUploader,
  findUploadPlaceholder,
  hasUploadPlaceholder,
  referencesUploadToken,
  stripUploadPlaceholders,
  stripUploadTokens,
} from "../src/lib/components/mdEditor/inlineUploads.ts";
import {
  supportedVideo,
  supportedVideoFile,
} from "../src/lib/components/mdEditor/videoMedia.ts";
import { checkUploadSize as realCheckUploadSize } from "../src/lib/components/media/uploadLimit.ts";

const MB = 1024 * 1024;
const LIMIT = {
  tuzis: 0,
  max_bytes: 5 * MB,
  tiers: [
    { min_tuzis: 0, max_bytes: 5 * MB },
    { min_tuzis: 1, max_bytes: 250 * MB },
  ],
};

const t = (key, fallback = key, params = {}) =>
  fallback.replace(/\{(\w+)\}/g, (_, name) => String(params[name]));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function file(name, size = 10) {
  return { name, size, type: "image/png" };
}

class Rejection extends Error {
  constructor(status) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

/** A document plus a pipeline wired to stubs that record what happened. */
function harness(overrides = {}) {
  const doc = {
    text: overrides.text ?? "",
    insertAt(offset, text) {
      this.text = this.text.slice(0, offset) + text + this.text.slice(offset);
    },
    read() {
      return this.text;
    },
    replace(start, end, text) {
      this.text = this.text.slice(0, start) + text + this.text.slice(end);
    },
  };
  const calls = { uploads: [], refreshes: 0, confirms: 0, toasts: [] };
  const pendingHistory = [];
  let abandoned = false;

  const uploader = createInlineUploader(doc, {
    t: () => t,
    locale: () => "en",
    editorAbandoned: () => abandoned,
    toast: { error: (message) => calls.toasts.push(message) },
    request: async () => new Response("{}"),
    uploadPublicFile:
      overrides.uploadPublicFile ??
      (async (f) => {
        calls.uploads.push(f.name);
        return { url: `/uploadz/public/u/${f.name}` };
      }),
    isUploadRejection: (error) => error instanceof Rejection,
    confirmOversize:
      overrides.confirmOversize ??
      (async () => {
        calls.confirms += 1;
        return { limit: LIMIT };
      }),
    checkUploadSize:
      overrides.checkUploadSize ??
      ((f, limit) =>
        limit && f.size > limit.max_bytes
          ? {
              fileName: f.name,
              fileBytes: f.size,
              comparedBytes: f.size,
              maxBytes: limit.max_bytes,
              nextTier: limit.tiers.find((tier) => tier.max_bytes > f.size),
            }
          : null),
    refreshUploadLimit: async () => {
      calls.refreshes += 1;
      return overrides.freshLimit ?? LIMIT;
    },
    formatByteLimit: (bytes) => `${bytes / MB} MB`,
    onPendingChange: (pending) => pendingHistory.push(pending),
  });

  return {
    doc,
    uploader,
    calls,
    pendingHistory,
    abandon: () => {
      abandoned = true;
    },
  };
}

test("a placeholder lands synchronously and is replaced by the image", async () => {
  const { doc, uploader, calls, pendingHistory } = harness({ text: "ab" });

  const run = uploader.startInlineUploads([file("cat.png")], 1);

  // Before any await: the placeholder is in, and the upload is counted.
  assert.match(doc.text, /^a!\[Uploading image…\]\(upload-[a-z0-9-]+\)b$/);
  assert.equal(uploader.pending, 1);

  await run;
  assert.equal(doc.text, "a![cat](/uploadz/public/u/cat.png)b");
  assert.deepEqual(calls.uploads, ["cat.png"]);
  assert.equal(uploader.pending, 0);
  assert.equal(pendingHistory.length, 2);
  assert.equal(pendingHistory[0].length, 1);
  assert.match(pendingHistory[0][0], /^upload-[a-z0-9-]+$/);
  assert.deepEqual(pendingHistory[1], []);
  assert.deepEqual(uploader.inFlight, []);
  assert.deepEqual(uploader.issued, pendingHistory[0]);
});

test("pending stays up for exactly as long as a placeholder is unresolved", async () => {
  const gate = deferred();
  const { doc, uploader } = harness({
    uploadPublicFile: async (f) => {
      await gate.promise;
      return { url: `/uploadz/public/u/${f.name}` };
    },
  });

  const run = uploader.startInlineUploads([file("a.png"), file("b.png")], 0);
  assert.equal(uploader.pending, 2);
  // Let the limit read resolve and both uploads start.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(uploader.pending, 2);
  assert.equal(hasUploadPlaceholder(doc.text), true);

  gate.resolve();
  await run;
  assert.equal(uploader.pending, 0);
  assert.equal(hasUploadPlaceholder(doc.text), false);
  assert.equal(
    doc.text,
    "![a](/uploadz/public/u/a.png)\n![b](/uploadz/public/u/b.png)",
  );
});

test("the placeholder is found by token after the user types around it", async () => {
  const gate = deferred();
  const { doc, uploader } = harness({
    text: "hello",
    uploadPublicFile: async (f) => {
      await gate.promise;
      return { url: `/uploadz/public/u/${f.name}` };
    },
  });

  const run = uploader.startInlineUploads([file("x.png")], 5);
  await new Promise((resolve) => setImmediate(resolve));
  // The user types BEFORE the placeholder, shifting every stored offset...
  doc.text = `well, ${doc.text} there`;
  //...and even edits its alt text.
  doc.text = doc.text.replace("Uploading image…", "still going");
  gate.resolve();
  await run;

  assert.equal(doc.text, "well, hello![x](/uploadz/public/u/x.png) there");
});

test("deleting the placeholder before the send cancels the upload", async () => {
  const limit = deferred();
  const { doc, uploader, calls } = harness({
    confirmOversize: () => limit.promise,
  });

  const run = uploader.startInlineUploads([file("gone.png")], 0);
  doc.text = stripUploadPlaceholders(doc.text);
  limit.resolve({ limit: LIMIT });
  await run;

  assert.deepEqual(calls.uploads, []);
  assert.equal(doc.text, "");
  assert.equal(uploader.pending, 0);
});

test("an abandoned page never sends", async () => {
  const limit = deferred();
  const { uploader, calls, abandon } = harness({
    confirmOversize: () => limit.promise,
  });

  const run = uploader.startInlineUploads([file("late.png")], 0);
  abandon();
  limit.resolve({ limit: LIMIT });
  await run;

  assert.deepEqual(calls.uploads, []);
  assert.equal(uploader.pending, 0);
});

test("an oversized file is refused before sending, with what raises the limit", async () => {
  const { doc, uploader, calls } = harness({ text: "x" });

  await uploader.startInlineUploads(
    [file("big.png", 6 * MB), file("ok.png")],
    1,
  );

  assert.deepEqual(calls.uploads, ["ok.png"]);
  assert.equal(doc.text, "x\n![ok](/uploadz/public/u/ok.png)");
  assert.deepEqual(calls.toasts, [
    "big.png exceeds your upload limit of 5 MB. Hold 1 2Z to raise the upload request cap to 250 MB.",
  ]);
  // One authoritative read for the batch.
  assert.equal(calls.confirms, 1);
  assert.equal(uploader.pending, 0);
});

test("an unrelated failure says so without reading the limit", async () => {
  const { doc, uploader, calls } = harness({
    uploadPublicFile: async () => {
      throw new Error("500");
    },
  });

  await uploader.startInlineUploads([file("a.png")], 0);

  assert.equal(doc.text, "");
  assert.deepEqual(calls.toasts, ["Image upload failed."]);
  assert.equal(calls.refreshes, 0);
  assert.equal(uploader.pending, 0);
});

test("rejections share ONE fresh limit read across the batch", async () => {
  const { uploader, calls } = harness({
    uploadPublicFile: async () => {
      throw new Rejection(403);
    },
  });

  await uploader.startInlineUploads(
    [file("a.png"), file("b.png"), file("c.png")],
    0,
  );

  assert.equal(calls.refreshes, 1);
  assert.deepEqual(calls.toasts, [
    "Upload failed. The file may exceed your upload limit.",
    "Upload failed. The file may exceed your upload limit.",
    "Upload failed. The file may exceed your upload limit.",
  ]);
});

test("a refusal after unmount clears the placeholder but stays silent", async () => {
  const gate = deferred();
  const { doc, uploader, calls, abandon } = harness({
    uploadPublicFile: async () => {
      await gate.promise;
      throw new Error("boom");
    },
  });

  const run = uploader.startInlineUploads([file("a.png")], 0);
  await new Promise((resolve) => setImmediate(resolve));
  abandon();
  gate.resolve();
  await run;

  assert.equal(doc.text, "");
  assert.deepEqual(calls.toasts, []);
  assert.equal(uploader.pending, 0);
});

test("a limit read that throws can never strand placeholders or pending", async () => {
  const { doc, uploader, calls } = harness({
    text: "keep",
    confirmOversize: async () => {
      throw new Error("surprise");
    },
  });

  await uploader.startInlineUploads([file("a.png"), file("b.png")], 4);

  // The newline that joined the two placeholders stays, exactly as it does
  // when both files are refused as oversize; the placeholders do not.
  assert.equal(doc.text, "keep\n");
  assert.equal(hasUploadPlaceholder(doc.text), false);
  assert.equal(uploader.pending, 0);
  assert.deepEqual(calls.uploads, []);
});

test("an empty batch does nothing at all", async () => {
  const { doc, uploader, calls, pendingHistory } = harness({ text: "x" });
  await uploader.startInlineUploads([], 0);
  assert.equal(doc.text, "x");
  assert.equal(calls.confirms, 0);
  assert.deepEqual(pendingHistory, []);
});

test("placeholder helpers agree with each other", () => {
  const token = "upload-abc-1";
  const placeholder = buildUploadPlaceholder(token, "Uploading image…");
  const text = `before ${placeholder} after`;

  assert.deepEqual(findUploadPlaceholder(text, token), {
    start: 7,
    end: 7 + placeholder.length,
  });
  assert.equal(findUploadPlaceholder(text, "upload-other-2"), null);
  assert.equal(hasUploadPlaceholder(text), true);
  // Called twice on purpose: a global regex with shared lastIndex would
  // answer differently the second time.
  assert.equal(hasUploadPlaceholder(text), true);
  assert.equal(stripUploadPlaceholders(text), "before  after");
  assert.equal(hasUploadPlaceholder("![real](/uploadz/public/a.png)"), false);
});

test("in-flight tokens are exactly the unsettled uploads; issued keeps them all", async () => {
  const gates = { a: deferred(), b: deferred() };
  const { doc, uploader } = harness({
    uploadPublicFile: async (f) => {
      await gates[f.name[0]].promise;
      return { url: `/uploadz/public/u/${f.name}` };
    },
  });

  const run = uploader.startInlineUploads([file("a.png"), file("b.png")], 0);
  await new Promise((resolve) => setImmediate(resolve));
  const [tokenA, tokenB] = uploader.inFlight;
  assert.ok(doc.text.includes(tokenA) && doc.text.includes(tokenB));

  gates.a.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(uploader.inFlight, [tokenB]);
  assert.equal(referencesUploadToken(doc.text, uploader.inFlight), true);

  gates.b.resolve();
  await run;
  assert.deepEqual(uploader.inFlight, []);
  assert.deepEqual(uploader.issued, [tokenA, tokenB]);
});

test("a placeholder mangled mid-upload is left behind, and strippable", async () => {
  const gate = deferred();
  const { doc, uploader } = harness({
    text: "hi ",
    uploadPublicFile: async (f) => {
      await gate.promise;
      return { url: `/uploadz/public/u/${f.name}` };
    },
  });

  const run = uploader.startInlineUploads([file("m.png")], 3);
  await new Promise((resolve) => setImmediate(resolve));
  const [token] = uploader.inFlight;
  // The writer deletes the "!" — no longer a placeholder, still our token.
  doc.text = doc.text.replace("![", "[");
  assert.equal(hasUploadPlaceholder(doc.text), false);
  assert.equal(referencesUploadToken(doc.text, uploader.inFlight), true);

  gate.resolve();
  await run;
  // The pipeline could not find its placeholder, so the text stays mangled...
  assert.equal(doc.text, `hi [Uploading image…](${token})`);
  //...no longer in flight...
  assert.equal(referencesUploadToken(doc.text, uploader.inFlight), false);
  //...and a host strips it by the tokens it issued.
  assert.equal(stripUploadTokens(doc.text, uploader.issued), "hi ");
});

test("token helpers only touch the tokens they are given", () => {
  const ours = "upload-k1-7";
  const theirs = "upload-zz-9";
  const text = [
    `a ![x](${ours}) b`,
    `c [y]( ${ours} ) d`,
    `stray ![Uploading image…](${theirs})`,
  ].join("\n");

  assert.equal(referencesUploadToken(text, [ours]), true);
  assert.equal(referencesUploadToken(text, []), false);
  assert.equal(referencesUploadToken("nothing here", [ours]), false);
  assert.equal(
    stripUploadTokens(text, [ours]),
    ["a  b", "c  d", `stray ![Uploading image…](${theirs})`].join("\n"),
  );
  // Placeholder-shaped text with no upload behind it is the writer's.
  assert.equal(stripUploadTokens(text, []), text);
});

test("stripping never eats the writer's own brackets", () => {
  // The alt pattern used to be `[^\]\n]*`, which let a match START at an
  // earlier, unrelated "[" and run forward into the placeholder (round 2).
  const t = "upload-abc-1";
  const cases = [
    [`I like [brackets [Uploading image…](${t}) ok`, "I like [brackets  ok"],
    [`I like [brackets ![Uploading image…](${t}) ok`, "I like [brackets  ok"],
    [`[a] [b [c](${t})`, "[a] [b "],
    [
      `see [docs](https://x.test) and [Uploading…](${t})`,
      "see [docs](https://x.test) and ",
    ],
    [
      `![keep](/uploadz/public/a.png)![Uploading…](${t})`,
      "![keep](/uploadz/public/a.png)",
    ],
  ];
  for (const [input, expected] of cases) {
    assert.equal(stripUploadTokens(input, [t]), expected, input);
    assert.equal(
      referencesUploadToken(stripUploadTokens(input, [t]), [t]),
      false,
    );
  }
  // The /edit payload cleaner and the live finder follow the same rule.
  assert.equal(
    stripUploadPlaceholders(`x [y ![Uploading image…](${t}) z`),
    "x [y  z",
  );
  const text = `x [y ![Uploading image…](${t}) z`;
  const found = findUploadPlaceholder(text, t);
  assert.equal(text.slice(found.start, found.end), `![Uploading image…](${t})`);
});

test("tokens are matched regardless of case", () => {
  const t = "upload-abc-1";
  const upper = `look ![Uploading image…](${t.toUpperCase()}) now`;
  assert.equal(referencesUploadToken(upper, [t]), true);
  assert.equal(hasUploadPlaceholder(upper), true);
  const placeholder = `![Uploading image…](${t.toUpperCase()})`;
  assert.deepEqual(findUploadPlaceholder(upper, t), {
    start: 5,
    end: 5 + placeholder.length,
  });
  assert.equal(stripUploadTokens(upper, [t]), "look  now");
  assert.equal(stripUploadPlaceholders(upper), "look  now");
  assert.equal(referencesUploadToken(`bare ${t.toUpperCase()}`, [t]), true);
  // Still whole tokens only.
  assert.equal(referencesUploadToken("UPLOAD-ABC-10", [t]), false);
});

test("an edit that cannot be stripped cleanly leaves the token for the caller to refuse", () => {
  // Deleting only the token would post the rest of the syntax.
  const t = "upload-abc-1";
  for (const mangled of [
    `a [Uploading image…]( ${t} x) b`,
    `a [Uploading [image]](${t}) b`,
    `a ${t} b`,
    `a [Uploading image…]\n(${t}) b`,
  ]) {
    const stripped = stripUploadTokens(mangled, [t]);
    assert.equal(referencesUploadToken(stripped, [t]), true, mangled);
  }
});

test("a token is never matched as the prefix of a longer one", () => {
  // One batch issues `…-1` and `…-10` in the same millisecond. Substring
  // matching turned `[x](upload-t-10)` into `[x](0)` when `-1` was stripped
  // first, and let a deleted `-1` keep blocking on a live `-10` (codex).
  const one = "upload-t-1";
  const ten = "upload-t-10";
  const text = `a [x](${ten}) b ${ten} c`;

  assert.equal(referencesUploadToken(text, [one]), false);
  assert.equal(referencesUploadToken(text, [ten]), true);
  assert.equal(stripUploadTokens(text, [one]), text);
  assert.equal(stripUploadTokens(text, [one, ten]), `a  b ${ten} c`);
  assert.equal(stripUploadTokens(text, [ten, one]), `a  b ${ten} c`);
  // A bare token is left for the caller to refuse, and is still found.
  assert.equal(referencesUploadToken(`${one}, x`, [one]), true);
  assert.equal(referencesUploadToken(`x,${one}`, [one]), true);
});

test("a file of exactly the limit refused on its ENVELOPE is explained as the limit", async () => {
  // Codex review of: nginx compares the whole multipart body, so a
  // file of exactly 5 MiB is refused with a 403 while the file itself fits.
  // Compared on the file alone that read as "you may have been signed out";
  // the transport measured the request, and that is what must be compared.
  class MeasuredRejection extends Rejection {
    constructor() {
      super(403);
      this.requestBytes = 5 * MB + 312;
    }
  }
  const { uploader, calls } = harness({
    checkUploadSize: realCheckUploadSize,
    uploadPublicFile: async () => {
      throw new MeasuredRejection();
    },
  });

  await uploader.startInlineUploads([file("exact.png", 5 * MB)], 0);

  assert.equal(calls.refreshes, 1);
  assert.deepEqual(calls.toasts, [
    "exact.png is 5 MB and your limit is 5 MB — the upload carries a little more than the file itself, so this one still does not fit. Try a slightly smaller file.",
  ]);
});

test("a big drop keeps at most three requests on the wire, and all finish", async () => {
  // Codex review of: every request's stall watch starts when it is
  // created, and the browser queues past six per origin. A drop of many large
  // images must wait HERE, before a request exists, or queue time is counted
  // as a stall and a healthy upload is reported as failed.
  const gates = [];
  let active = 0;
  let peak = 0;
  const { doc, uploader, calls } = harness({
    uploadPublicFile: async (f) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => gates.push(resolve));
      active -= 1;
      return { url: `/uploadz/public/u/${f.name}` };
    },
  });

  const files = Array.from({ length: 8 }, (_, i) => file(`p${i}.png`));
  const run = uploader.startInlineUploads(files, 0);
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  for (let released = 0; released < files.length; released += 1) {
    while (gates.length === 0) await tick();
    assert.ok(active <= 3, `at most 3 in flight, saw ${active}`);
    gates.shift()();
    await tick();
  }
  await run;

  assert.equal(peak, 3);
  assert.equal(uploader.pending, 0);
  assert.deepEqual(calls.toasts, []);
  for (const f of files) assert.match(doc.text, new RegExp(`${f.name}\\)`));
});

test("video completion stays on its own line and escapes directive delimiters", async () => {
  const { doc, uploader } = harness({
    text: "beforeafter",
    uploadPublicFile: async () => ({ url: "/uploadz/public/clip]name\n.mp4" }),
  });
  await uploader.startInlineUploads(
    [{ name: "clip.mp4", type: "video/mp4", size: 10 }],
    6,
  );
  assert.equal(
    doc.text,
    "before\n\n::embed[/uploadz/public/clip%5Dname%0A.mp4]\n\nafter",
  );
});

test("deleting a video placeholder before limit resolution publishes no file", async () => {
  const gate = deferred();
  const { doc, uploader, calls } = harness({
    confirmOversize: () => gate.promise,
  });
  const run = uploader.startInlineUploads(
    [{ name: "clip.mp4", type: "video/mp4", size: 10 }],
    0,
  );
  assert.match(doc.text, /Uploading video/);
  doc.text = "cancelled video";
  gate.resolve({ limit: LIMIT });
  await run;
  assert.equal(doc.text, "cancelled video");
  assert.deepEqual(calls.uploads, []);
});

test("video choices require video MIME and a native-player format", () => {
  for (const ext of ["mp4", "m4v", "webm", "mov", "qt"])
    assert.equal(supportedVideo("video/mp4", `/uploadz/clip.${ext}`), true);
  for (const [mime, path] of [
    ["image/png", "clip.mp4"],
    ["", "clip.mp4"],
    ["application/octet-stream", "clip.mp4"],
    ["video/x-msvideo", "clip.avi"],
    ["video/mp4", "clip.html"],
    ["video/mp4", "clip.html?name=clip.mp4"],
  ])
    assert.equal(supportedVideo(mime, path), false);
});

test("local video filenames and neutral MIME declarations reach server validation", async () => {
  for (const mime of ["video/mp4", "", "application/octet-stream"]) {
    assert.equal(supportedVideoFile(mime, "Lesson #1?.mp4"), true);
    assert.equal(supportedVideoFile(mime, "clip.mp4?x"), false);
    const { doc, uploader } = harness({
      uploadPublicFile: async () => ({
        url: "/uploadz/normalized.mp4",
        mime_type: "video/mp4",
      }),
    });
    await uploader.startInlineUploads(
      [{ name: "Lesson #1?.mp4", type: mime, size: 10 }],
      0,
      "video",
    );
    assert.equal(doc.text, "\n\n::embed[/uploadz/normalized.mp4]\n\n");
  }
  assert.equal(supportedVideoFile("image/png", "clip.mp4"), false);
});

test("server normalization keeps non-image uploads in native embeds", async () => {
  for (const [mime, extension] of [
    ["audio/mpeg", "mp3"],
    ["video/mp4", "mp4"],
    ["image/png", "png"],
  ]) {
    const url = `/uploadz/normalized.${extension}`;
    const { doc, uploader } = harness({
      uploadPublicFile: async () => ({ url, mime_type: mime }),
    });
    await uploader.startInlineUploads(
      [{ name: "recording.mp4", type: "application/octet-stream", size: 10 }],
      0,
      "video",
    );
    if (mime.startsWith("image/")) assert.match(doc.text, /^!\[/);
    else assert.equal(doc.text, `\n\n::embed[${url}]\n\n`);
  }
});
