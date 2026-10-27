// Two-tier agreement for the live-stream viewer URLs .
//
// The same URL is answered by two different renderers — SvelteKit SSR for
// search engines and the Django prerender tier
// (`py/free2z/dj/apps/g12f/views/crawler.py`) for social unfurlers — and they used to
// declare DIFFERENT canonicals for it:
//
//   GET /live/skylar   SSR  → <link rel=canonical.../skylar/broadcast>
//   GET /live/skylar   card → <link rel=canonical.../live/skylar>
//
// A canonical is a claim about which URL a document IS. Two tiers making two
// different claims about one URL is the "Google chose a different canonical"
// class of report  opened on. Nothing in either test suite compared them,
// because each suite only ever loaded its own tier — so this file reads the
// Django source as DATA and checks the TypeScript side against it, the same
// trick `social-card-parity.test.mjs` uses on the card template.
//
// What this does NOT prove: that either tier is reachable, or that nginx routes
// a given user agent to the one you think. Status and markup are proved
// end-to-end in tests/browser/live-route-ssr.spec.ts (SSR) and
// py/free2z/dj/apps/g12f/test_crawler_prerender.py (card).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { createServer } from "vite";

const CRAWLER_PY = new URL(
  "../../../../py/free2z/dj/apps/g12f/views/crawler.py",
  import.meta.url,
);
const DYTE_MODELS_PY = new URL(
  "../../../../py/free2z/dj/apps/dyte/models.py",
  import.meta.url,
);
const VIEWER_COMPONENT = new URL(
  "../src/lib/components/stream/LiveStreamViewer.svelte",
  import.meta.url,
);

const crawlerPy = readFileSync(CRAWLER_PY, "utf8");
const dytePy = readFileSync(DYTE_MODELS_PY, "utf8");

let NOINDEX_FOLLOW_ROBOTS;
let PUBLIC_STREAM_TYPES;
let streamWatchPath;
let server;

before(async () => {
  server = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  ({ NOINDEX_FOLLOW_ROBOTS } = await server.ssrLoadModule("/src/lib/seo.ts"));
  ({ PUBLIC_STREAM_TYPES } = await server.ssrLoadModule(
    "/src/lib/streamTypes.js",
  ));
  ({ streamWatchPath } = await server.ssrLoadModule(
    "/src/lib/utils/stream-path.ts",
  ));
});

after(async () => {
  await server?.close();
});

/** The value of a bare `NAME = "..."` assignment in a Python module. */
function pythonString(source, name) {
  const match = source.match(
    new RegExp(`^${name}\\s*=\\s*["']([^"']*)["']`, "m"),
  );
  assert.ok(match, `${name} not found as a plain string literal`);
  return match[1];
}

test("#1178: both tiers spell the live-viewer robots directive identically", () => {
  assert.equal(
    NOINDEX_FOLLOW_ROBOTS,
    pythonString(crawlerPy, "NOINDEX_FOLLOW"),
  );
});

test("#1178: the card tier stamps that directive on every live viewer card", () => {
  // `_render_live_card` is the ONE renderer both `live_social` and
  // `pretty_live_social` go through, so this single assertion covers all four
  // URL shapes. If the helper is ever inlined again, this fails loudly rather
  // than silently covering nothing.
  const helper = crawlerPy.match(
    /def _render_live_card\(request, creator, stream_type\):[\s\S]*?\n\n\n/,
  );
  assert.ok(helper, "_render_live_card is gone; the shapes can drift again");
  assert.match(helper[0], /robots=NOINDEX_FOLLOW,/);
  assert.match(helper[0], /path=f"\/\{creator\.username\}\/\{stream_type\}"/);

  for (const view of ["live_social", "pretty_live_social"]) {
    const body = crawlerPy.match(
      new RegExp(`def ${view}\\(request[\\s\\S]*?\\n\\n\\n`),
    );
    assert.ok(body, `${view} not found`);
    assert.match(
      body[0],
      /_render_live_card\(request, creator, stream_type\)/,
      `${view} must render through the shared helper`,
    );
  }
});

test("#1178: the card tier no longer canonicalises /live/{u} to itself", () => {
  const live = crawlerPy.match(/def live_social\(request[\s\S]*?\n\n\n/)[0];
  assert.ok(
    !/path=f"\/live\//.test(live),
    "/live/{u} is an alias; declaring itself canonical is the #1139 drift",
  );
});

test("#1178: SSR canonicalises to the shape the card tier builds", () => {
  // Django builds `/{creator.username}/{stream_type}`; `streamWatchPath` is
  // where SSR builds its half. Same input, same string, or the two tiers are
  // making different claims about one URL again.
  for (const type of PUBLIC_STREAM_TYPES) {
    assert.equal(streamWatchPath("skylar", type), `/skylar/${type}`);
  }
});

test("#1178: the public stream enum is the same set on both tiers", () => {
  const python = dytePy
    .match(/^PUBLIC_MEETING_TYPES = \(([^)]*)\)/m)[1]
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean)
    .map((constant) => pythonString(dytePy, constant));

  assert.deepEqual([...PUBLIC_STREAM_TYPES].sort(), python.sort());
});

test("#1178: onDestroy never reaches for a browser global unguarded", () => {
  // The 500 itself. `onDestroy` is the ONE lifecycle hook Svelte also runs
  // during SSR, so an unguarded `window` there turns every server render of
  // that component into a hard 500 — after the markup was already built, which
  // is why it looks like a mystery rather than a missing route.
  //
  // Scoped to the file that had the bug rather than swept across `src/`: a
  // repo-wide regex gate on a hook this common invites the reflex of adding a
  // dead `browser` check to silence it. The property is proved end-to-end for
  // the routes that matter in tests/browser/live-route-ssr.spec.ts.
  const source = readFileSync(VIEWER_COMPONENT, "utf8");
  const start = source.indexOf("onDestroy(");
  assert.ok(start > -1, "LiveStreamViewer no longer registers onDestroy");

  let depth = 0;
  let end = start;
  for (let i = source.indexOf("(", start); i < source.length; i += 1) {
    if (source[i] === "(") depth += 1;
    else if (source[i] === ")") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = source.slice(start, end);

  if (/\b(window|document|navigator|localStorage)\b/.test(body)) {
    assert.match(
      body,
      /\bbrowser\b|typeof window/,
      "onDestroy touches a browser global with no server guard",
    );
  }
});
