//, browser half: the zPage editor must actually put `If-Match` on the
// wire, and must treat a 412 as a conflict the creator can act on rather than
// as "Failed to save article".
//
// Why this file exists at all, and why it stands up a real HTTP server:
// **orval emits no code for `in: header` parameters.** Regenerating the client
// from `f2z.yaml` can never make the browser send `If-Match`, and a green
// `api-client` job proves shape parity with the spec while proving nothing
// about what a request carries. The backend suite proves the server honours
// the header; the only thing that proves the browser SENDS it is watching a
// server receive it. So `apiFetch` — the exact function the editor's save path
// calls — is loaded through Vite (aliases and all) and pointed at a real
// `node:http` listener that records the headers it got.
//
// The call-site assertions are the second layer, in the same spirit as
// `subscribe-idempotency.test.mjs`: the save path lives inside a 2,700-line
// Svelte component whose click path needs a session, a route and a live
// editor, so the wiring itself is asserted against the source.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { createServer as createViteServer } from "vite";

import {
  IF_MATCH_HEADER,
  PRECONDITION_FAILED,
  createEtagRegistry,
  isPreconditionFailure,
  preconditionHeaders,
  readEtag,
} from "../src/lib/zpage-preconditions.js";
import { saveNoticeReason } from "../src/lib/save-errors.js";

const root = new URL("../", import.meta.url);
const read = (relative) =>
  readFileSync(fileURLToPath(new URL(relative, root)), "utf8");

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

test("no stored validator means no header, which is the pre-#1039 behaviour", () => {
  const etags = createEtagRegistry();
  assert.deepEqual(preconditionHeaders(etags.get("/api/zpage/abc/")), {});
});

test("validators are keyed by URL so a variant's never rides a canonical save", () => {
  const etags = createEtagRegistry();
  etags.set("/api/zpage/abc/", '"canonical"');
  etags.set("/api/zpage/abc/variants/fr/", '"french"');

  assert.deepEqual(preconditionHeaders(etags.get("/api/zpage/abc/")), {
    [IF_MATCH_HEADER]: '"canonical"',
  });
  assert.deepEqual(
    preconditionHeaders(etags.get("/api/zpage/abc/variants/fr/")),
    { [IF_MATCH_HEADER]: '"french"' },
  );
});

test("a response with no ETag clears the entry instead of keeping a stale one", () => {
  // Keeping the old validator would send it on every later save and be refused
  // forever — the failure mode is silent and permanent, so it gets a test.
  const etags = createEtagRegistry();
  etags.set("/api/zpage/abc/", '"old"');
  etags.remember("/api/zpage/abc/", {
    headers: { get: () => null },
  });
  assert.equal(etags.get("/api/zpage/abc/"), null);
});

test("readEtag survives a response object with no headers at all", () => {
  // SSR stubs and `tests/browser/mock-api.mjs` produce these. A missing
  // validator must degrade to "no precondition", never throw inside a save.
  assert.equal(readEtag({}), null);
  assert.equal(readEtag(undefined), null);
});

test("only 412 is a conflict", () => {
  assert.equal(isPreconditionFailure({ status: PRECONDITION_FAILED }), true);
  assert.equal(isPreconditionFailure({ status: 409 }), false);
  assert.equal(isPreconditionFailure({ status: 200 }), false);
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
    // Answer the way the Django route does: a strong validator on the read,
    // 412 when the precondition does not match it.
    if (req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        ETag: '"server-state-1"',
      });
      res.end(JSON.stringify({ free2zaddr: "abc" }));
      return;
    }
    if (
      req.headers["if-match"] &&
      req.headers["if-match"] !== '"server-state-1"'
    ) {
      res.writeHead(PRECONDITION_FAILED, {
        "Content-Type": "application/json",
      });
      res.end(
        JSON.stringify({ detail: "This page changed since you loaded it." }),
      );
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/json",
      ETag: '"server-state-2"',
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

test("the header a real server receives is the one the read handed out", async () => {
  const etags = createEtagRegistry();
  const url = `${origin}/api/zpage/abc/`;
  received.length = 0;

  // 1. Read the article the way the editor's `load` does, and keep its ETag.
  const readResponse = await apiFetch(url);
  etags.remember(url, readResponse);
  assert.equal(etags.get(url), '"server-state-1"');

  // 2. Save it the way the editor's `send` does.
  const saveResponse = await apiFetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...preconditionHeaders(etags.get(url)),
    },
    body: JSON.stringify({ title: "t", content: "c", tags: [] }),
  });

  const save = received.at(-1);
  // The assertion that matters: the *server* saw it. Nothing about the client
  // object, nothing about the spec.
  assert.equal(save.method, "PUT");
  assert.equal(save.headers["if-match"], '"server-state-1"');
  assert.equal(saveResponse.status, 200);

  // 3. And the write response's validator replaces the read's, so the next
  //    autosave is conditional too rather than 412ing against its own save.
  etags.remember(url, saveResponse);
  assert.equal(etags.get(url), '"server-state-2"');
});

test("a stale validator gets a 412 from the server, not a silent overwrite", async () => {
  const url = `${origin}/api/zpage/abc/`;
  const response = await apiFetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...preconditionHeaders('"a-version-that-is-gone"'),
    },
    body: JSON.stringify({ title: "t", content: "c", tags: [] }),
  });

  assert.equal(response.status, PRECONDITION_FAILED);
  assert.equal(isPreconditionFailure(response), true);
});

test("no validator, no header — an existing client is unaffected", async () => {
  const url = `${origin}/api/zpage/abc/`;
  received.length = 0;

  await apiFetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...preconditionHeaders(null),
    },
    body: JSON.stringify({ title: "t", content: "c", tags: [] }),
  });

  assert.equal(received.at(-1).headers["if-match"], undefined);
});

// ---------------------------------------------------------------------------
// The call site
// ---------------------------------------------------------------------------

test("the editor's save passes the precondition into the request headers", () => {
  const source = read("src/routes/edit/+page.svelte");
  assert.match(
    source,
    /preconditionHeaders\(\s*options\.approvedRevision\s*\?\?\s*etags\.get\(\s*preconditionKey\s*\)\s*,?\s*\)/,
  );
  // Recorded on the way back out, or the second autosave in a session goes
  // out unconditioned.
  assert.match(source, /etags\.remember\(/);
});

test("the editor treats 412 as its own outcome, not as a generic failure", () => {
  const source = read("src/routes/edit/+page.svelte");
  assert.match(source, /isPreconditionFailure\(response\)/);
  assert.match(source, /failSave\("conflict"\)/);
  // The branch has to come BEFORE the `!response.ok` catch-all, or a 412 is
  // absorbed into "Failed to save article" — the withholding-the-useful-fact
  // failure  names explicitly.
  assert.ok(
    source.indexOf("isPreconditionFailure(response)") <
      source.indexOf("if (!response.ok) {"),
  );
});

test("the editor's load carries the article's validator into the page data", () => {
  const source = read("src/routes/edit/+page.ts");
  assert.match(source, /headers\?\.get\?\.\("ETag"\)/);
  assert.match(source, /zpageEtag/);
});

test("the always-visible save notice shows the conflict sentence", () => {
  // An autosave shows no toast of its own, so if this notice fell back to the
  // generic reason the creator would be told the server was unreachable — and
  // would retry a save that is refused identically every time.
  assert.equal(
    saveNoticeReason("conflict", "Someone else saved this article.", "generic"),
    "Someone else saved this article.",
  );
  assert.equal(
    saveNoticeReason("request-failed", "ignored", "generic"),
    "generic",
  );
});

test("every locale carries the conflict copy", () => {
  // A missing key ships a blank string, and a blank string here means a save
  // that fails with no explanation at all.
  const keys = ["saveConflict", "saveConflictReload", "saveBlockedConflict"];
  for (const locale of ["en", "es", "fr", "pt-BR"]) {
    const catalog = JSON.parse(read(`src/lib/locales/${locale}.json`));
    for (const key of keys) {
      assert.equal(
        typeof catalog.editor?.[key],
        "string",
        `${locale}.editor.${key}`,
      );
      assert.ok(catalog.editor[key].trim().length > 0, `${locale}.${key}`);
    }
  }
  const english = JSON.parse(read("src/lib/locales/en.json")).editor;
  for (const locale of ["es", "fr", "pt-BR"]) {
    const catalog = JSON.parse(read(`src/lib/locales/${locale}.json`)).editor;
    for (const key of keys) {
      assert.notEqual(
        catalog[key],
        english[key],
        `${locale}.editor.${key} is untranslated English`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Findings from the codex adversarial review of this change
// ---------------------------------------------------------------------------

test("a conflicted save keeps its validator instead of dropping it", () => {
  // Dropping it would make the retry unconditional, and the backend accepts
  // unconditional writes by design — so the tab would warn the creator about a
  // conflict and then silently clobber the other tab seconds later.
  const source = read("src/routes/edit/+page.svelte");
  assert.doesNotMatch(source, /etags\.forget\(saveUrl\)/);
  assert.match(source, /saveConflicted = true/);
  // And it stops sending saves at all, or every keystroke is another 412.
  assert.match(
    source,
    /if \(saveConflicted\) \{\s*\n\s*return failSave\("conflict"\)/,
  );
  // Cleared when the editor hydrates onto freshly read state.
  assert.match(source, /saveConflicted = false/);
});

test("the load obtains an existing translation's own validator", () => {
  // The article GET returns the CANONICAL validator even under `?lang=`, so
  // without this the FIRST save of an existing translation goes out
  // unconditioned — the original lost-update bug, narrowed to translations.
  // Round three moved this from a second request to the variant read itself;
  // see "a translation's body and its validator come from ONE response".
  const source = read("src/routes/edit/+page.ts");
  assert.match(source, /\/variants\//);
  assert.match(source, /variantEtag/);
});

test("deleting a translation carries the precondition when one is held", () => {
  const source = read("src/routes/edit/+page.svelte");
  assert.match(
    source,
    /zpageVariantsDestroy\(identifier, language, \{\s*\n\s*headers: preconditionHeaders\(/,
  );
  assert.match(source, /editor\.deleteTranslationConflict/);
});

test("every locale carries the delete-conflict copy too", () => {
  const english = JSON.parse(read("src/lib/locales/en.json")).editor;
  assert.equal(typeof english.deleteTranslationConflict, "string");
  for (const locale of ["es", "fr", "pt-BR"]) {
    const catalog = JSON.parse(read(`src/lib/locales/${locale}.json`)).editor;
    assert.ok(catalog.deleteTranslationConflict?.trim().length > 0, locale);
    assert.notEqual(
      catalog.deleteTranslationConflict,
      english.deleteTranslationConflict,
      `${locale} is untranslated English`,
    );
    // The interpolation has to survive translation, or the sentence names no
    // language at all.
    assert.match(catalog.deleteTranslationConflict, /\{language\}/, locale);
  }
});

// ---------------------------------------------------------------------------
// Round two of the codex adversarial review
// ---------------------------------------------------------------------------

test("one validator key per RESOURCE, not per route", () => {
  // The editor SAVES a translation through the deprecated
  // `/translations/{lang}/` alias and DELETES it through `/variants/{lang}/`.
  // Keying the registry by the URL each request happens to use makes the two
  // drift the moment a translation is saved: the delete then keeps reading the
  // page-load validator and 412s on a change the same tab made — and the 412
  // handler used to drop it, so the retry went out unconditional.
  const source = read("src/routes/edit/+page.svelte");
  assert.match(source, /function preconditionKeyFor\(/);
  assert.match(
    source,
    /preconditionHeaders\(\s*options\.approvedRevision\s*\?\?\s*etags\.get\(\s*preconditionKey\s*\)\s*,?\s*\)/,
  );
  // Nothing is filed under the alias any more.
  assert.doesNotMatch(source, /etags\.set\(\s*\n\s*translationVariantUrl\(/);
  assert.doesNotMatch(source, /etags\.remember\([^)]*saveUrl/);
});

test("a refused delete keeps its validator so the retry is refused too", () => {
  const source = read("src/routes/edit/+page.svelte");
  const deleteFn = source.slice(
    source.indexOf("async function deleteTranslation("),
  );
  assert.match(deleteFn, /status === PRECONDITION_FAILED/);
  // An unconditional retry is precisely the deletion the 412 just prevented.
  assert.doesNotMatch(deleteFn, /etags\.forget\(/);
});

test("a save and a delete of the same translation share one registry entry", () => {
  // The behavioural version of the source assertions above, driven through the
  // real registry: save under the resource key, delete reads the same key.
  const etags = createEtagRegistry();
  const resourceKey = "/api/zpage/abc/variants/fr/";

  etags.set(resourceKey, '"from-page-load"');
  // A translation save comes back with a newer validator.
  etags.remember(resourceKey, { headers: { get: () => '"after-save"' } });

  assert.deepEqual(preconditionHeaders(etags.get(resourceKey)), {
    [IF_MATCH_HEADER]: '"after-save"',
  });
});

// ---------------------------------------------------------------------------
// Round three of the codex adversarial review
// ---------------------------------------------------------------------------

test("a translation's body and its validator come from ONE response", () => {
  // Fetching the validator in a separate request was worse than the bug it
  // fixed: between the two reads another tab can save, and this tab then holds
  // stale text with a FRESH validator — a PUT that passes its precondition and
  // overwrites the newer version while looking protected. It also ran the
  // detail endpoint twice (64 published + 64 draft translations at the
  // documented ceilings) to read one header.
  const source = read("src/routes/edit/+page.ts");
  assert.match(source, /async function fetchOwnedVariant\(/);
  // And it is actually reached — a helper nothing calls is not a fix.
  assert.match(
    source,
    /await fetchOwnedVariant\(fetch, requestedId, explicitLanguage\)/,
  );
  assert.match(
    source,
    /return \{ zpage: \(await response\.json\(\)\) as ZPage, etag \}/,
  );
  assert.doesNotMatch(source, /fetchVariantEtag/);
  // And the fallback is still the article read, so a language with no variant
  // yet opens exactly as it did before.
  // Formatting factored out: prettier breaks after `??` once the call takes
  // a fourth argument (the login return path, ).
  assert.match(source, /exact \?\?\s*\(await fetchOwnedZPage\(/);
});

test("a variant read of the article's own language is a canonical validator", () => {
  // Writing the source language writes the article, so the API returns the
  // canonical validator for it — filing it under the variant key would point
  // a canonical save at the wrong registry entry.
  const source = read("src/routes/edit/+page.ts");
  assert.match(source, /explicitLanguage !== zpage\.source_language/);
  assert.match(source, /const zpageEtag = isVariantValidator \? null : etag/);
});

test("a canonical write outside the save path drops the stale validator", () => {
  // The relabel PATCH and accepting an AI tag suggestion both rewrite the
  // canonical row without returning a readable ETag. Keeping the old one turns
  // the next autosave into a 412 and latches `saveConflicted` — telling the
  // creator somebody else edited their article when they did it themselves,
  // and offering a reload that discards their unsaved work.
  const source = read("src/routes/edit/+page.svelte");
  assert.match(source, /function invalidateEtags\(/);
  assert.match(
    source,
    /zpagePartialUpdate\([\s\S]{0,400}source_language: language[\s\S]{0,1600}invalidateEtags\(identifier\)/,
  );
  assert.match(source, /onTagSuggestionWrite=\{\(\) =>\s*invalidateEtags\(/);
});

test("the tag-suggestion write signal reaches the editor through every layer", () => {
  // A prop that stops one component short of the editor is silently inert, and
  // the symptom (a dead-ended editor) shows up nowhere near the missing line.
  assert.match(
    read("src/lib/components/TagSuggestions.svelte"),
    /onServerWrote\?\.\(\)/,
  );
  assert.match(
    read("src/lib/components/mdEditor/PublishSheet.svelte"),
    /onServerWrote=\{onTagSuggestionWrite\}/,
  );
  assert.match(
    read("src/lib/components/mdEditor/EditorTopbar.svelte"),
    /\{onTagSuggestionWrite\}/,
  );
});

test("the article-language relabel is conditional too", () => {
  // DRF loads the whole row, sets one field and calls `.save()`, so a PUT that
  // commits between that load and that save is written straight back out of a
  // stale instance. `isRelabelling` already serializes the in-tab half of that
  // race; `If-Match` is the cross-tab half. (codex adversarial review.)
  const source = read("src/routes/edit/+page.svelte");
  assert.match(
    source,
    /zpagePartialUpdate\([\s\S]{0,200}headers: preconditionHeaders\(etags\.get\(canonicalEtagKey\(identifier\)\)\)/,
  );
  const relabel = source.slice(
    source.indexOf("async function changeArticleLanguage"),
  );
  assert.match(relabel, /status === PRECONDITION_FAILED/);
});

// ---------------------------------------------------------------------------
// Round five of the codex adversarial review
// ---------------------------------------------------------------------------

test("a refused relabel latches instead of dropping its validator", () => {
  // The relabel's `finally` restarts the autosave clock whenever the editor is
  // dirty. Dropping the validator on a 412 put an unconditional PUT of this
  // tab's stale body on the wire 2.5s after the precondition correctly refused
  // it — performing the exact overwrite the 412 prevented.
  const source = read("src/routes/edit/+page.svelte");
  const relabel = source.slice(
    source.indexOf("async function changeArticleLanguage"),
    source.indexOf("async function startNewTranslation"),
  );
  assert.ok(relabel.length > 0, "found the relabel implementation");
  const conflictBranch = relabel.slice(
    relabel.indexOf("status === PRECONDITION_FAILED"),
    relabel.indexOf("if (status === 401"),
  );
  assert.ok(conflictBranch.length > 0, "found the 412 branch");
  assert.match(conflictBranch, /saveConflicted = true/);
  // The success path legitimately invalidates; the refusal path must not, or
  // the autosave the `finally` restarts goes out unconditioned.
  assert.doesNotMatch(conflictBranch, /invalidateEtags/);
});

test("an out-of-band canonical write drops EVERY validator", () => {
  // A translation's validator digests the canonical row too, because a
  // translation PUT writes `p2paddr`, `vanity` and tags onto the parent. So
  // after a canonical write outside the save path there is no entry left that
  // describes current state; keeping the variant one latched a translation
  // editor into a permanent false conflict.
  const etags = createEtagRegistry();
  etags.set("/api/zpage/abc/", '"canonical"');
  etags.set("/api/zpage/abc/variants/fr/", '"french"');
  assert.equal(etags.size(), 2);

  etags.clear();

  assert.equal(etags.size(), 0);
  assert.equal(etags.get("/api/zpage/abc/variants/fr/"), null);
  assert.match(read("src/routes/edit/+page.svelte"), /etags\.clear\(\)/);
});

test("a vanity-addressed variant read is accepted", () => {
  // The editor rewrites its own URL to the vanity after a save, so the vanity
  // is the COMMON identifier here. Comparing only against `free2zaddr`
  // rejected every correct response and fell back to the unprotected path.
  const source = read("src/routes/edit/+page.ts");
  assert.match(
    source,
    /zpage\?\.free2zaddr === identifier \|\| zpage\?\.vanity === identifier/,
  );
});

test("dismissing a tag suggestion does not drop the validator", () => {
  // A dismissal updates the suggestion row and leaves the zPage untouched.
  // Signalling a write there dropped a still-valid validator and put the next
  // autosave on the wire unconditioned.
  const source = read("src/lib/components/TagSuggestions.svelte");
  assert.match(source, /if \(accept\) onServerWrote\?\.\(\)/);
});
