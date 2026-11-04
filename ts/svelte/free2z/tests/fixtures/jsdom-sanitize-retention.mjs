/**
 * Child process for tests/sanitizer-jsdom-leak.test.mjs.
 *
 * Reports how many bytes a run of `DOMPurify.sanitize()` calls leaves behind
 * after a forced full GC. Lives in its own process because it needs
 * `--expose-gc` (the test runner does not have it) and because a dedicated heap
 * keeps the reading away from vite/node:test allocations.
 *
 * Prints one JSON line: {"calls":N,"retainedBytes":B}
 */
import DOMPurify from "isomorphic-dompurify";

if (typeof globalThis.gc !== "function") {
  console.error("jsdom-sanitize-retention.mjs requires --expose-gc");
  process.exit(2);
}

const CALLS = Number(process.argv[2] || 800);

/**
 * Deliberately carries NO `id` and NO `name` attribute.
 *
 * jsdom has a second, unrelated retention path — `living/window-properties.js`
 * keeps a `Map<string, Set<Element>>` per window for named property access, and
 * an element parsed with an `id` is added to it and never removed, because
 * DOMPurify drops its throwaway Document rather than detaching the nodes. That
 * one is present in jsdom 28 AND 30 and is tracked in; including an
 * `id` here would swamp the signal this probe exists to measure.
 */
const FIXTURE =
  "<p>Some <strong>bold</strong> text with a " +
  '<a href="https://example.com/x?y=1">link</a> and an ' +
  '<img src="/media/a.png" alt="a" loading="lazy"> image.</p>' +
  "<ul><li>one</li><li>two</li><li>three</li></ul>" +
  "<blockquote><p>quoted</p></blockquote>";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function retainedHeapBytes() {
  // One major GC is not always enough: incremental marking can leave a pass
  // unfinished, and a single reading then reports memory that is merely not yet
  // collected rather than genuinely reachable.
  await sleep(50);
  for (let i = 0; i < 8; i += 1) {
    globalThis.gc({ execution: "sync", type: "major" });
    await sleep(20);
  }
  return process.memoryUsage().heapUsed;
}

async function sanitizeMany(count) {
  for (let i = 0; i < count; i += 1) {
    DOMPurify.sanitize(FIXTURE);
    // Yield like a real server does between requests, so nothing is held alive
    // merely by sitting on one synchronous stack.
    if (i % 10 === 0) await sleep(0);
  }
}

// Warm up first: module init, hidden-class transitions and code caches are a
// one-off cost that would otherwise be charged to the measured run.
await sanitizeMany(200);
const before = await retainedHeapBytes();
await sanitizeMany(CALLS);
const after = await retainedHeapBytes();

console.log(JSON.stringify({ calls: CALLS, retainedBytes: after - before }));
