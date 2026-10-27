/**
 * the regression contract
 *
 * `isomorphic-dompurify` builds ONE jsdom `Window` for the lifetime of the
 * process and parses every `sanitize()` call into a fresh `Document` hanging off
 * it. jsdom 28 built a `DOMSelector` eagerly in the `Document` constructor, and
 * `@asamuzakjp/dom-selector`'s `Finder` registers nine listeners
 * (`focus` `focusin` `keydown` `keyup` `mouseover` `mousedown` `mouseup`
 * `click` `mouseout`) on that shared window for `:hover`/`:focus`/`:active`
 * support. The class has no removal path, so every listener array on the window
 * grew by one per sanitize, for ever, and each listener retained the throwaway
 * Document behind it. Measured at ~7.3 KB retained per call, dead linear, with
 * a forced full GC reclaiming nothing.
 *
 * jsdom 30 makes the selector engine lazy, so DOMPurify — which never queries a
 * selector — never constructs a `Finder` at all.
 *
 * These two tests approach the same defect from opposite ends: the first pins
 * the MECHANISM and is exactly deterministic, the second measures the
 * CONSEQUENCE in bytes. Both go red on jsdom 28.
 *
 * WHAT GREEN HERE DOES NOT MEAN. jsdom has a SECOND retention path that these
 * tests deliberately exclude: `window-properties.js` keeps a
 * `Map<string, Set<Element>>` per window for named property access, adds every
 * parsed element carrying an `id`, and removes it only on detach — which used
 * never to happen, because DOMPurify drops its throwaway Document instead of
 * emptying it. One retained element drags in its whole Document, and
 * `marked-gfm-heading-id` gives every heading an `id`, so real articles hit it.
 * Measured on the built adapter-node server at /trending, 12 cards per render:
 *
 *   content        jsdom 28.1.0      jsdom 30.0.1 (this change)
 *   with headings  2.20 MB/render    1.82 MB/render   <- untouched by this
 *   no headings    73 KB/render      flat
 *
 * That one is, and it is fixed separately, in `sanitizeMarkdownHtml`,
 * which now empties the throwaway Document at the end of every call —
 * `tests/sanitizer-named-property-leak.test.mjs` is what pins it.
 *
 * So these tests keep their ID-FREE fixtures on purpose: mixing the two in one
 * budget would measure the bigger leak and say nothing about this one. A green
 * run here is evidence about the DOMSelector path only. Do not "simplify" the
 * two suites into one.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import DOMPurify from "isomorphic-dompurify";
import { listenerCounts, sharedWindow } from "./fixtures/jsdom-internals.mjs";

const FIXTURE =
  "<p>Some <strong>bold</strong> text with a " +
  '<a href="https://example.com/x?y=1">link</a>.</p>' +
  "<ul><li>one</li><li>two</li></ul>";

test("sanitizing does not accumulate listeners on the shared jsdom window", () => {
  const window = sharedWindow(DOMPurify);
  const before = listenerCounts(window);

  // POSITIVE CONTROL: prove the observer sees a real listener added to the
  // same shared Window and sees it removed again before measuring sanitize().
  const controlListener = () => {};
  window.addEventListener("mouseover", controlListener);
  const withControl = listenerCounts(window);
  assert.equal(
    withControl.mouseover,
    (before.mouseover ?? 0) + 1,
    "listener observer did not see a listener added to the shared Window",
  );
  window.removeEventListener("mouseover", controlListener);
  assert.deepEqual(listenerCounts(window), before);

  const calls = 200;
  for (let i = 0; i < calls; i += 1) {
    DOMPurify.sanitize(FIXTURE);
  }

  const after = listenerCounts(window);

  // On jsdom 28 this reads +200 on each of nine event types. Comparing the
  // whole map rather than one type also catches a future engine that registers
  // a different set.
  assert.deepEqual(
    after,
    before,
    `sanitize() registered listeners on the shared window that are never removed: ` +
      `${JSON.stringify(before)} -> ${JSON.stringify(after)}`,
  );
});

test("sanitizing ID-FREE html 800 times retains almost nothing after a full GC", () => {
  const probe = fileURLToPath(
    new URL("./fixtures/jsdom-sanitize-retention.mjs", import.meta.url),
  );

  // `--expose-gc` in a child, because `node --test` does not run with it and a
  // reading taken without a forced major GC measures collection lag, not
  // retention.
  const stdout = execFileSync(process.execPath, ["--expose-gc", probe, "800"], {
    encoding: "utf8",
  });

  const result = JSON.parse(stdout.trim().split("\n").at(-1));
  assert.equal(result.calls, 800);

  // Readings, both taken on this suite's own ID-FREE fixture:
  //   jsdom 28.1.0 (the leak)   ~5.9 MB   (~7.3 KB per call)
  //   jsdom 30.0.1 (the fix)    ~0.30 MB  (~0.37 KB per call, +/- 4 KB across runs)
  // 2 MB sits 6.7x above the fixed reading and 3x below the leaking one, so it
  // is neither flaky nor satisfiable by a partial fix.
  const budgetBytes = 2 * 1024 * 1024;
  assert.ok(
    result.retainedBytes < budgetBytes,
    `800 sanitize() calls on ID-FREE html retained ${(result.retainedBytes / 1048576).toFixed(2)} MB ` +
      `after a forced full GC (budget ${(budgetBytes / 1048576).toFixed(2)} MB) — ` +
      `~${Math.round(result.retainedBytes / result.calls)} bytes per call`,
  );
});
