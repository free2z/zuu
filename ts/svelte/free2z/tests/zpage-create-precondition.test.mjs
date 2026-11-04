//, browser half: when the editor STARTS a translation it opened blank,
// the save must carry `If-None-Match: *`, so a second tab (or an AI draft that
// landed meanwhile) is refused with 412 instead of being silently replaced —
// and the creator must be told that in their own language.
//
// Same reasoning as `zpage-preconditions.test.mjs`, which does this job for
// `If-Match`: **orval emits no code for `in: header` parameters**, so a green
// `api-client` job proves nothing about what a request carries. The only proof
// the browser SENDS the header is a real server receiving it, through the
// exact `apiFetch` the editor's save path calls. The call-site wiring inside
// the 6,000-line editor component is pinned against the source.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { createServer as createViteServer } from "vite";

import {
  IF_MATCH_HEADER,
  IF_NONE_MATCH_HEADER,
  PRECONDITION_FAILED,
  createOnlyHeaders,
  preconditionHeaders,
} from "../src/lib/zpage-preconditions.js";

const root = new URL("../", import.meta.url);
const read = (relative) =>
  readFileSync(fileURLToPath(new URL(relative, root)), "utf8");

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

test("a save that starts a variant asks for create-only", () => {
  assert.deepEqual(createOnlyHeaders({ startsVariant: true, etag: null }), {
    [IF_NONE_MATCH_HEADER]: "*",
  });
});

test("an edit of an existing variant never sends it", () => {
  assert.deepEqual(createOnlyHeaders({ startsVariant: false, etag: null }), {});
  assert.deepEqual(
    createOnlyHeaders({ startsVariant: false, etag: '"french"' }),
    {},
  );
});

test("a held validator wins: never 'exists AND does not exist'", () => {
  // Keeping your own text over an AI draft that arrived mid-sentence seeds
  // that draft's validator while the editor still thinks it is starting the
  // variant. Sending both headers would 412 every save forever.
  assert.deepEqual(
    createOnlyHeaders({ startsVariant: true, etag: '"ai-draft"' }),
    {},
  );
  const headers = {
    ...preconditionHeaders('"ai-draft"'),
    ...createOnlyHeaders({ startsVariant: true, etag: '"ai-draft"' }),
  };
  assert.deepEqual(headers, { [IF_MATCH_HEADER]: '"ai-draft"' });
});

// ---------------------------------------------------------------------------
// The header on the wire
// ---------------------------------------------------------------------------

let vite;
let apiFetch;
let server;
let origin;
/** @type {Array<{method: string, url: string, headers: Record<string, string>}>} */
let received;
/** Variants the fake server already has, by URL. */
const existing = new Set();

before(async () => {
  vite = await createViteServer({
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  ({ apiFetch } = await vite.ssrLoadModule("/src/lib/api/config.ts"));

  received = [];
  server = createServer((req, res) => {
    received.push({
      method: req.method,
      url: req.url,
      headers: { ...req.headers },
    });
    req.resume();
    // Answer the way `_save_variant` does: `*` fails when it exists.
    if (req.headers["if-none-match"] === "*" && existing.has(req.url)) {
      res.writeHead(PRECONDITION_FAILED, {
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify({ detail: "A version already exists." }));
      return;
    }
    existing.add(req.url);
    res.writeHead(200, {
      "Content-Type": "application/json",
      ETag: '"created"',
    });
    res.end(JSON.stringify({ free2zaddr: "abc" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server?.close(resolve));
  await vite?.close();
});

async function startTranslation(url) {
  return apiFetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...preconditionHeaders(null),
      ...createOnlyHeaders({ startsVariant: true, etag: null }),
    },
    body: JSON.stringify({ title: "t", content: "c", tags: [] }),
  });
}

test("the server receives If-None-Match: * and the second tab gets 412", async () => {
  const url = `${origin}/api/zpage/abc/translations/fr/`;
  received.length = 0;

  const tabA = await startTranslation(url);
  const tabB = await startTranslation(url);

  // The assertion that matters: the *server* saw it, on both requests.
  assert.equal(received.length, 2);
  for (const request of received) {
    assert.equal(request.method, "PUT");
    assert.equal(request.headers["if-none-match"], "*");
    assert.equal(request.headers["if-match"], undefined);
  }
  assert.equal(tabA.status, 200);
  assert.equal(tabB.status, PRECONDITION_FAILED);
});

// ---------------------------------------------------------------------------
// The call site
// ---------------------------------------------------------------------------

const editor = () => read("src/routes/edit/+page.svelte");

test("the editor decides create-only from a blank translation, not a canonical save", () => {
  const source = editor();
  assert.match(
    source,
    /const startsVariant =\s*!isCreate && !isCanonicalSave && isNewTranslationDraft;/,
  );
  // Fed the held validator, so a known-existing variant is an If-Match save.
  assert.match(
    source,
    /createOnlyHeaders\(\{\s*startsVariant,\s*etag: etags\.get\(preconditionKey\),\s*\}\)/,
  );
  // A successful first save clears the state, or every later autosave of the
  // now-existing translation would 412 against itself.
  assert.match(source, /isNewTranslationDraft = false;/);
});

test("keeping your text over a delivered draft leaves the create state", () => {
  // codex review: the keep path seeds the draft's validator, but a later
  // registry clear (a tag accept) would otherwise turn the next save back
  // into `If-None-Match: *` against the draft the creator chose to replace.
  const source = editor();
  const keep = source.slice(
    source.indexOf(
      '} else if (choice === "keep" && !published && !sharedChanged) {',
    ),
  );
  const branch = keep.slice(
    0,
    keep.indexOf("if (isDirty) scheduleAutoSave();"),
  );
  assert.match(branch, /isNewTranslationDraft = false;/);
});

test("the create-only header is spread into the request the editor sends", () => {
  const source = editor();
  const request = source.slice(
    source.indexOf("const response = await apiFetch(saveUrl, {"),
  );
  const headers = request.slice(0, request.indexOf("body,"));
  assert.match(headers, /\.\.\.createOnly,/);
  assert.match(source, /sentCreateOnly = IF_NONE_MATCH_HEADER in createOnly;/);
});

test("a lost create race shows localized copy before the server's English", () => {
  const source = editor();
  const branch = source.slice(
    source.indexOf("if (isPreconditionFailure(response)) {"),
    source.indexOf("if (!response.ok) {"),
  );
  const localized = branch.indexOf('"editor.createConflict"');
  const serverFallback = branch.indexOf("apiRequestErrorMessage(result)");
  assert.ok(localized > 0, "createConflict is rendered in the 412 branch");
  assert.ok(
    localized < serverFallback,
    "the localized string must not sit behind the server's detail",
  );
  assert.match(branch, /sentCreateOnly\s*\?/);
});

test("every locale carries the create-conflict copy, translated", () => {
  const english = JSON.parse(read("src/lib/locales/en.json")).editor;
  for (const locale of ["en", "es", "fr", "pt-BR"]) {
    const copy = JSON.parse(read(`src/lib/locales/${locale}.json`)).editor
      ?.createConflict;
    assert.equal(typeof copy, "string", `${locale}.editor.createConflict`);
    assert.match(copy, /\{language\}/, `${locale} names the language`);
    if (locale !== "en") {
      assert.notEqual(copy, english.createConflict, `${locale} is English`);
    }
  }
});
