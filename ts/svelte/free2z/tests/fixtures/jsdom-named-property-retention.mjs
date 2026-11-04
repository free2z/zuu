/**
 * Child process for tests/sanitizer-named-property-leak.test.mjs.
 *
 * Reports how many bytes a run of `sanitizeMarkdownHtml()` calls leaves behind
 * after a forced full GC. Lives in its own process because it needs
 * `--expose-gc` (the test runner does not have it) and because a dedicated heap
 * keeps the reading away from the other suites' allocations.
 *
 * It drives the REAL `sanitizeMarkdownHtml` through vite, not
 * `DOMPurify.sanitize` directly: the leak is jsdom's, but the fix is ours, and
 * a probe that called DOMPurify itself would measure the leak with the fix
 * bypassed and pass forever.
 *
 * argv: [calls]
 * Prints one JSON line: {"calls":N,"retainedBytes":B}
 */
import { createServer } from "vite";

if (typeof globalThis.gc !== "function") {
  console.error("jsdom-named-property-retention.mjs requires --expose-gc");
  process.exit(2);
}

const CALLS = Number(process.argv[2] || 600);

/**
 * Deliberately id-BEARING, and shaped like what the real pipeline emits:
 * `marked-gfm-heading-id` puts an `id` on every heading, and footnotes carry
 * ids too. One tracked element is enough to retain the whole document, and the
 * table is here so the retained document is measurably fat.
 *
 * The sibling probe `jsdom-sanitize-retention.mjs`  is deliberately
 * id-FREE for the opposite reason — keep the two separate so each one measures
 * only its own leak.
 */
const FIXTURE =
  '<h2 id="a-heading">A heading</h2>' +
  "<p>Some <strong>bold</strong> text with a " +
  '<a href="https://example.com/x?y=1">link</a> and an ' +
  '<img src="/media/a.png" alt="a" loading="lazy"> image.</p>' +
  '<h3 id="another-heading">Another heading</h3>' +
  "<ul><li>one</li><li>two</li><li>three</li></ul>" +
  "<blockquote><p>quoted</p></blockquote>" +
  "<table><thead><tr><th>h1</th><th>h2</th></tr></thead>" +
  "<tbody><tr><td>a</td><td>b</td></tr></tbody></table>";

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

const server = await createServer({
  appType: "custom",
  logLevel: "silent",
  server: { middlewareMode: true },
});
const { sanitizeMarkdownHtml } = await server.ssrLoadModule(
  "/src/lib/utils/markdown-sanitize.ts",
);
// Vite has done its job once the module is loaded. Shut it down BEFORE the
// baseline reading so its module graph, watcher and esbuild service are not
// part of what the deltas measure.
await server.close();

// Fail loudly rather than measuring a no-op: if the module ever stops producing
// the ids, the fixture is no longer exercising the named-property tracker and a
// flat reading would mean nothing.
const sample = sanitizeMarkdownHtml(FIXTURE);
if (!sample.includes('id="a-heading"') || !sample.includes("<td>a</td>")) {
  console.error(`fixture did not survive sanitization: ${sample}`);
  process.exit(2);
}

async function sanitizeMany(count) {
  for (let i = 0; i < count; i += 1) {
    sanitizeMarkdownHtml(FIXTURE);
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
process.exit(0);
