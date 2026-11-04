/**
 * the regression contract
 *
 * jsdom's `living/window-properties.js` implements named property access
 * (`window.someId`) with a module-level
 * `WeakMap<Window, Map<string, Set<Element>>>`. `elementAttached()` adds every
 * parsed element carrying an `id` — or a `name`, on
 * `embed`/`form`/`img`/`object`/`iframe`/`frame` — and `elementDetached()` is
 * the only thing that ever removes one.
 *
 * `isomorphic-dompurify` keeps ONE jsdom `Window` for the life of the process
 * and parses each `sanitize()` into a throwaway `Document` hanging off it.
 * DOMPurify serialises `body.innerHTML` and DROPS that Document — it never
 * detaches the nodes. So the `Set` on the shared window holds the element for
 * ever, and one held element drags its whole Document in behind it through
 * jsdom's `SymbolTree` sibling links. `marked-gfm-heading-id` gives every
 * heading an `id`, so this fired on essentially every article and every
 * `/trending` card, and it is what killed the SSR pods with
 * `Reached heap limit` roughly every 15 hours.
 *
 * `sanitizeMarkdownHtml` now empties the throwaway Document at the end of every
 * call. These two tests approach that from opposite ends: the first pins the
 * MECHANISM and is exactly deterministic, the second measures the CONSEQUENCE
 * in bytes.
 *
 * NOT the same defect as `tests/sanitizer-jsdom-leak.test.mjs`, which
 * is about `DOMSelector` registering nine unremovable listeners per sanitize
 * and is fixed by jsdom 30. That suite uses ID-FREE fixtures on purpose so the
 * two never share a budget; this one is deliberately id-BEARING. Keep them
 * separate.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { createServer } from "vite";
import DOMPurify from "isomorphic-dompurify";
import {
  detachedParserDocumentsRetainNamedProperties,
  sharedWindow,
} from "./fixtures/jsdom-internals.mjs";

let sanitizeMarkdownHtml;
let server;

before(async () => {
  server = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  ({ sanitizeMarkdownHtml } = await server.ssrLoadModule(
    "/src/lib/utils/markdown-sanitize.ts",
  ));
});

after(async () => {
  await server?.close();
});

test("sanitizeMarkdownHtml leaves no element in the shared window's named-property tracker", () => {
  const window = sharedWindow(DOMPurify);

  // The tracker has no public handle, but its read side is public named
  // property access. This associated-document control proves the observation
  // works even on jsdom versions that no longer track detached parser docs.
  const trackerControl = window.document.createElement("div");
  trackerControl.id = "f2z-named-property-observer-control";
  window.document.body.append(trackerControl);
  assert.equal(window[trackerControl.id], trackerControl);
  trackerControl.remove();
  assert.equal(window[trackerControl.id], undefined);

  // On jsdom 30.0.x this raw call is the negative control for our cleanup: it
  // leaves a detached parser node in the shared window's tracker. jsdom 30.1.x
  // added an associated-document guard and no longer tracks detached parser
  // docs, so the raw call is expected not to leak there. Both paths use the
  // same DOMPurify instance as production.
  assert.equal(window["f2z-leak-control"], undefined);
  DOMPurify.sanitize('<h2 id="f2z-leak-control">control</h2>');
  const rawSanitizerLeak = window["f2z-leak-control"];
  if (detachedParserDocumentsRetainNamedProperties) {
    assert.ok(
      rawSanitizerLeak,
      "raw DOMPurify.sanitize no longer leaks on jsdom 30.0.x",
    );
    assert.equal(rawSanitizerLeak.id, "f2z-leak-control");
  } else {
    assert.equal(rawSanitizerLeak, undefined);
  }

  // The real assertion.
  assert.equal(window["f2z-leak-subject"], undefined);
  const html = sanitizeMarkdownHtml(
    '<h2 id="f2z-leak-subject">subject</h2><p>body</p>',
  );

  // The id must survive INTO THE OUTPUT — the fix must not be a
  // strip-the-ids-and-call-it-fixed.
  assert.match(html, /<h2 id="f2z-leak-subject">subject<\/h2>/);

  assert.equal(
    window["f2z-leak-subject"],
    undefined,
    "sanitizeMarkdownHtml left its parsed <h2> in jsdom's named-property " +
      "tracker on the shared window; the whole sanitized document is retained " +
      "behind it, for ever",
  );

  // The same must hold for a `name=` on one of the element types jsdom tracks
  // by name as well as by id. This is a second conditional raw-path control for
  // jsdom 30.0.x; the production path is asserted on both supported layouts.
  DOMPurify.sanitize('<img name="f2z-leak-name-control" src="/a.png">');
  const rawNameLeak = window["f2z-leak-name-control"];
  if (detachedParserDocumentsRetainNamedProperties) {
    assert.ok(
      rawNameLeak,
      "raw DOMPurify.sanitize no longer leaks names on jsdom 30.0.x",
    );
    assert.equal(rawNameLeak.getAttribute("name"), "f2z-leak-name-control");
  } else {
    assert.equal(rawNameLeak, undefined);
  }
  sanitizeMarkdownHtml('<img name="f2z-leak-name" src="/a.png">');
  assert.equal(
    window["f2z-leak-name"],
    undefined,
    "sanitizeMarkdownHtml left a name-tracked element on the shared window",
  );
});

test("sanitizing ID-BEARING markdown 600 times retains almost nothing after a full GC", () => {
  const probe = fileURLToPath(
    new URL("./fixtures/jsdom-named-property-retention.mjs", import.meta.url),
  );

  // `--expose-gc` in a child, because `node --test` does not run with it and a
  // reading taken without a forced major GC measures collection lag, not
  // retention.
  const stdout = execFileSync(process.execPath, ["--expose-gc", probe, "600"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });

  const result = JSON.parse(stdout.trim().split("\n").at(-1));
  assert.equal(result.calls, 600);

  // Readings on this suite's own ID-BEARING fixture, 600 calls:
  //   leaking (release removed)  ~54 MB   (~90,000 bytes per call)
  //   fixed                      ~0.44 MB (~740 bytes per call, and FLAT: the
  //                                        same ~0.44 MB total at 2,400 calls,
  //                                        i.e. a fixed one-off, ~7 B/call
  //                                        marginal)
  // 4 MB sits 9x above the fixed reading and 13x below the leaking one, so it
  // is neither flaky nor satisfiable by a partial fix.
  const budgetBytes = 4 * 1024 * 1024;
  assert.ok(
    result.retainedBytes < budgetBytes,
    `600 sanitizeMarkdownHtml() calls on ID-BEARING html retained ${(result.retainedBytes / 1048576).toFixed(2)} MB ` +
      `after a forced full GC (budget ${(budgetBytes / 1048576).toFixed(2)} MB) — ` +
      `~${Math.round(result.retainedBytes / result.calls)} bytes per call`,
  );
});
