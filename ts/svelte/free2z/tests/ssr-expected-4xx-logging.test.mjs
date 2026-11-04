import assert from "node:assert/strict";
import { after, afterEach, before, mock, test } from "node:test";
import { createServer } from "vite";

//  ~99.5% of the prod `sveltekit` container's ERROR entries were
// expected 404s, almost all of them vulnerability scanners (`/wp-admin`,
// `/.env`, `/api/zpage/.env/`), and they were Error Reporting's top group at
// ~1,200 a day. Cloud Logging grades a plain-text stderr line ERROR — so
// `console.error` AND `console.warn` — and every line of a dumped object is
// its own entry.
//
// Pinned here, against the real loaders and the real `handleError` hook:
//   - an expected 4xx logs NOTHING on stderr (no console.error / warn);
//   - a genuine failure logs EXACTLY ONE line, JSON, `severity: "ERROR"`,
//     with the stack in `message` so Error Reporting still groups it.
//
// Negative control: restore the four route/hook files and `mutator.ts` from
// origin/main (keep this test) and every "logs nothing" case goes red —
// `Error loading creator profile: Unknown error`, `Failed to load article`,
// `API request failed`, and SvelteKit's default ANSI `[404] GET /wp-admin`.

const API = "https://api.free2z.test";
const previousApiBase = process.env.PRIVATE_API_BASE_URL;

let vite;
let hooks;
let profileLoad;
let vanityLoad;
let articleLoad;
let customInstance;
let kit;

before(async () => {
  process.env.PRIVATE_API_BASE_URL = API;
  vite = await createServer({
    appType: "custom",
    server: { hmr: false, middlewareMode: true },
  });
  hooks = await vite.ssrLoadModule("/src/hooks.server.ts");
  ({ load: profileLoad } = await vite.ssrLoadModule(
    "/src/routes/[username]/+page.server.ts",
  ));
  ({ load: vanityLoad } = await vite.ssrLoadModule(
    "/src/routes/[username]/[vanity]/+page.server.ts",
  ));
  ({ load: articleLoad } = await vite.ssrLoadModule(
    "/src/routes/article/[id]/+page.server.ts",
  ));
  ({ customInstance } = await vite.ssrLoadModule("/src/lib/api/mutator.ts"));
  kit = await vite.ssrLoadModule("@sveltejs/kit");
});

after(async () => {
  await vite?.close();
  if (previousApiBase === undefined) {
    delete process.env.PRIVATE_API_BASE_URL;
  } else {
    process.env.PRIVATE_API_BASE_URL = previousApiBase;
  }
});

afterEach(() => mock.restoreAll());

/** Capture every stderr-bound console call (both are ERROR in Cloud Logging). */
function captureConsole() {
  const stderr = [];
  const stdout = [];
  mock.method(console, "error", (...args) => stderr.push(args));
  mock.method(console, "warn", (...args) => stderr.push(args));
  mock.method(console, "log", (...args) => stdout.push(args));
  return { stderr, stdout };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function pageEvent(pathname, params, fetch) {
  return {
    params,
    url: new URL(`https://free2z.cash${pathname}`),
    request: new Request(`https://free2z.cash${pathname}`),
    cookies: { get: () => undefined },
    locals: { locale: "en" },
    setHeaders: () => {},
    isDataRequest: false,
    route: { id: null },
    fetch,
  };
}

async function thrownBy(fn) {
  try {
    await fn();
  } catch (thrown) {
    return thrown;
  }
  assert.fail("expected the load to throw");
}

/** Exactly one stderr call, a single JSON line at ERROR with a stack. */
function assertOneErrorLine(stderr, event) {
  assert.equal(
    stderr.length,
    1,
    `expected one ERROR line, got ${stderr.length}`,
  );
  assert.equal(stderr[0].length, 1, "one argument, not a label plus an object");
  const [line] = stderr[0];
  assert.equal(typeof line, "string");
  assert.ok(!line.includes("\n"), "the line itself must not be multi-line");
  const entry = JSON.parse(line);
  assert.equal(entry.severity, "ERROR");
  assert.equal(entry.event, event);
  return entry;
}

// ---------------------------------------------------------------- handleError

test("handleError: an unmatched route (scanner 404) logs nothing", async () => {
  const { stderr, stdout } = captureConsole();
  const event = pageEvent("/storage/logs/laravel.log", {}, fetch);
  for (const status of [404, 405]) {
    const result = await hooks.handleError({
      kind: "framework",
      error: { status, message: "Not found: /storage/logs/laravel.log" },
      event,
    });
    assert.equal(result, undefined, "SvelteKit keeps its own { message }");
  }
  assert.deepEqual(stderr, []);
  assert.deepEqual(stdout, []);
});

test("handleError: an unexpected exception is ONE ERROR line with its stack", async () => {
  const { stderr } = captureConsole();
  const boom = new TypeError("Cannot read properties of undefined");
  await hooks.handleError({
    kind: "unknown",
    error: boom,
    event: pageEvent("/free2z/some-article", {}, fetch),
  });
  const entry = assertOneErrorLine(stderr, "ssr_unhandled_error");
  assert.equal(entry.status, 500);
  assert.equal(entry.path, "/free2z/some-article");
  assert.equal(entry.error_name, "TypeError");
  assert.match(entry.message, /^TypeError: Cannot read properties/);
  assert.match(
    entry.message,
    /\n\s+at /,
    "the stack is what Error Reporting groups on",
  );
});

// -------------------------------------------------------- /[username] profile

test("profile: an unknown one-segment path (/wp-admin) 404s and logs nothing", async () => {
  const { stderr } = captureConsole();
  const backend = async (input) => {
    const url = String(input);
    if (url.includes("/api/creator/")) return json({ detail: "nope" }, 404);
    if (url.includes("/api/get-type/")) return json({ detail: "nope" }, 404);
    throw new Error(`unexpected fetch ${url}`);
  };
  const thrown = await thrownBy(() =>
    profileLoad(pageEvent("/wp-admin", { username: "wp-admin" }, backend)),
  );
  assert.equal(thrown.status, 404);
  assert.deepEqual(stderr, []);
});

test("profile: a historic root link's 301 logs nothing", async () => {
  const { stderr } = captureConsole();
  const backend = async (input) => {
    const url = String(input);
    if (url.includes("/api/creator/")) return json({}, 404);
    if (url.includes("/api/get-type/")) return json("zpage");
    if (url.includes("/api/zpage/"))
      return json({
        free2zaddr: "abc",
        vanity: "my-post",
        creator: { username: "alice" },
      });
    throw new Error(`unexpected fetch ${url}`);
  };
  const thrown = await thrownBy(() =>
    profileLoad(pageEvent("/my-post", { username: "my-post" }, backend)),
  );
  assert.equal(thrown.status, 301);
  assert.deepEqual(stderr, []);
});

test("profile: a backend failure is still ONE ERROR line", async () => {
  const { stderr } = captureConsole();
  const backend = async () => {
    throw new TypeError("fetch failed");
  };
  const thrown = await thrownBy(() =>
    profileLoad(pageEvent("/alice", { username: "alice" }, backend)),
  );
  assert.equal(thrown.status, 503);
  const entry = assertOneErrorLine(stderr, "profile_load_failed");
  assert.match(entry.message, /TypeError: fetch failed/);
});

test("profile: a creator API 5xx is ONE ERROR line carrying the upstream status", async () => {
  const { stderr } = captureConsole();
  const backend = async () => json({}, 502);
  const thrown = await thrownBy(() =>
    profileLoad(pageEvent("/alice", { username: "alice" }, backend)),
  );
  assert.equal(thrown.status, 500);
  const entry = assertOneErrorLine(stderr, "profile_creator_lookup_failed");
  assert.equal(entry.upstream_status, 502);
});

// ------------------------------------------------ /[username]/[vanity] zPage

test("zPage: the API's 404 (/x/.env) 404s and logs nothing", async () => {
  const { stderr } = captureConsole();
  const backend = async () => json({ detail: "Not found." }, 404);
  const thrown = await thrownBy(() =>
    vanityLoad(
      pageEvent("/x/.env", { username: "x", vanity: ".env" }, backend),
    ),
  );
  assert.equal(thrown.status, 404);
  assert.deepEqual(stderr, []);
});

test("zPage: an API 503 is ONE ERROR line", async () => {
  const { stderr } = captureConsole();
  const backend = async () => json({ detail: "busy" }, 503);
  const thrown = await thrownBy(() =>
    vanityLoad(
      pageEvent("/alice/post", { username: "alice", vanity: "post" }, backend),
    ),
  );
  assert.equal(thrown.status, 500);
  const entry = assertOneErrorLine(stderr, "article_load_failed");
  assert.equal(entry.status, 503);
  assert.equal(entry.path, "/alice/post");
});

test("zPage: an unusable ?lang= is a stdout WARNING, never stderr", async () => {
  const { stderr, stdout } = captureConsole();
  const backend = async (input) => {
    const url = new URL(String(input));
    if (url.searchParams.get("lang") === "zz-ZZ")
      return json({ lang: ["bad"] }, 400);
    // Default variant: a 404 is enough to finish the load deterministically.
    return json({ detail: "Not found." }, 404);
  };
  const thrown = await thrownBy(() =>
    vanityLoad(
      pageEvent(
        "/alice/post?lang=zz-ZZ",
        { username: "alice", vanity: "post" },
        backend,
      ),
    ),
  );
  assert.equal(thrown.status, 404);
  assert.deepEqual(stderr, []);
  assert.equal(stdout.length, 1);
  const entry = JSON.parse(stdout[0][0]);
  assert.equal(entry.severity, "WARNING");
  assert.equal(entry.event, "article_lang_selector_unusable");
});

// ------------------------------------------------------------ /article/[id]

test("/article/[id]: a 404 logs nothing; a 503 is ONE ERROR line", async () => {
  const realFetch = globalThis.fetch;
  try {
    let status = 404;
    globalThis.fetch = async () => json({ detail: "x" }, status);

    let { stderr } = captureConsole();
    let thrown = await thrownBy(() =>
      articleLoad(pageEvent("/article/.env", { id: ".env" }, globalThis.fetch)),
    );
    assert.equal(thrown.status, 404);
    assert.deepEqual(
      stderr,
      [],
      "neither the route nor the API client logs a 404",
    );

    mock.restoreAll();
    status = 503;
    ({ stderr } = captureConsole());
    thrown = await thrownBy(() =>
      articleLoad(pageEvent("/article/abc", { id: "abc" }, globalThis.fetch)),
    );
    assert.equal(thrown.status, 503);
    // The API client still reports the 5xx, and the route adds its one line.
    const lines = stderr.filter(
      (args) => typeof args[0] === "string" && args[0].startsWith("{"),
    );
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0][0]).event, "article_load_failed");
    assert.ok(
      stderr.some((args) => args[0] === "API request failed:"),
      "a 5xx from the API client is still logged",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ------------------------------------------------------ generated API client

test("API client: a 4xx is not logged; a 5xx still is", async () => {
  const realFetch = globalThis.fetch;
  try {
    for (const [status, logged] of [
      [404, false],
      [410, false],
      [400, false],
      [500, true],
      [503, true],
    ]) {
      mock.restoreAll();
      const { stderr } = captureConsole();
      globalThis.fetch = async () =>
        json({ detail: "No published pages carry this tag." }, status);
      await assert.rejects(
        customInstance("/api/tags/nope/", { method: "GET" }),
      );
      assert.equal(stderr.length > 0, logged, `status ${status}`);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("kit sanity: the loaders' error() is the HttpError the helper checks", () => {
  // If a second copy of @sveltejs/kit ever got bundled, isHttpError would
  // silently return false and every scanner 404 would log again.
  let thrown;
  try {
    kit.error(404, "x");
  } catch (e) {
    thrown = e;
  }
  assert.ok(kit.isHttpError(thrown, 404));
});
