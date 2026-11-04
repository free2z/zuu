import assert from "node:assert/strict";
import { after, afterEach, before, mock, test } from "node:test";
import { createServer } from "vite";

//  the SSR loaders mapped the API's 404 to a 404 page and EVERY other
// non-OK answer to a 500 (profile, zPage) or 503 (/article/[id]). So an API
// throttle (429) told a crawler "the site is broken" instead of "slow down",
// without the API's Retry-After, and a refusal (403) or a gone (410) read in
// the request log exactly like an outage.
//
// Pinned here, against the real loaders:
//   - 429 → 429, Retry-After forwarded when it is delta-seconds;
//   - 401/403 → 403 and 410 → 410;
//   - each of those is ONE stdout WARNING line carrying the upstream status
//     (SSR itself being throttled or refused is worth seeing) and nothing on
//     stderr, which GKE grades ERROR;
//   - any other 4xx (400) and every 5xx keep their old status and ERROR line.
//
// Negative control: restore the three route files from origin/main (keep
// this test and `upstream-status.ts`) and every mapped case goes red with a
// 500/503 where it expects 429/403/410.

const API = "https://api.free2z.test";
const previousApiBase = process.env.PRIVATE_API_BASE_URL;

let vite;
let profileLoad;
let vanityLoad;
let articleLoad;
let upstream;

before(async () => {
  process.env.PRIVATE_API_BASE_URL = API;
  vite = await createServer({
    appType: "custom",
    server: { hmr: false, middlewareMode: true },
  });
  ({ load: profileLoad } = await vite.ssrLoadModule(
    "/src/routes/[username]/+page.server.ts",
  ));
  ({ load: vanityLoad } = await vite.ssrLoadModule(
    "/src/routes/[username]/[vanity]/+page.server.ts",
  ));
  ({ load: articleLoad } = await vite.ssrLoadModule(
    "/src/routes/article/[id]/+page.server.ts",
  ));
  upstream = await vite.ssrLoadModule("/src/lib/server/upstream-status.ts");
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

function captureConsole() {
  const stderr = [];
  const stdout = [];
  mock.method(console, "error", (...args) => stderr.push(args));
  mock.method(console, "warn", (...args) => stderr.push(args));
  mock.method(console, "log", (...args) => stdout.push(args));
  return { stderr, stdout };
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A page event whose `setHeaders` behaves like SvelteKit's: no repeats. */
function pageEvent(pathname, params, fetch) {
  const headers = {};
  return {
    headers,
    params,
    url: new URL(`https://free2z.cash${pathname}`),
    request: new Request(`https://free2z.cash${pathname}`),
    cookies: { get: () => undefined },
    locals: { locale: "en" },
    setHeaders: (next) => {
      for (const [key, value] of Object.entries(next)) {
        const name = key.toLowerCase();
        if (name in headers) throw new Error(`"${key}" header is already set`);
        headers[name] = value;
      }
    },
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

function onlyWarning(stdout, event) {
  assert.equal(stdout.length, 1, "exactly one stdout line");
  const entry = JSON.parse(stdout[0][0]);
  assert.equal(entry.severity, "WARNING");
  assert.equal(entry.event, event);
  return entry;
}

// ------------------------------------------------------------------ helper

test("forwardableRetryAfter: delta-seconds only, bounded", () => {
  const { forwardableRetryAfter } = upstream;
  assert.equal(forwardableRetryAfter("30"), "30");
  assert.equal(forwardableRetryAfter(" 7 "), "7");
  assert.equal(forwardableRetryAfter("999999"), "86400");
  for (const bad of [
    null,
    undefined,
    "",
    "-1",
    "1.5",
    "Wed, 21 Oct 2026 07:28:00 GMT",
    "30\r\nSet-Cookie: x=1",
    "1234567",
  ]) {
    assert.equal(forwardableRetryAfter(bad), null, `refuses ${bad}`);
  }
});

test("upstreamClientError: only 401/403/410/429 are repeated", () => {
  const { upstreamClientError } = upstream;
  assert.deepEqual(upstreamClientError(429, "12"), {
    status: 429,
    retryAfter: "12",
  });
  assert.deepEqual(upstreamClientError(403, "12"), {
    status: 403,
    retryAfter: null,
  });
  assert.equal(upstreamClientError(401)?.status, 403);
  assert.equal(upstreamClientError(410)?.status, 410);
  for (const status of [undefined, 400, 404, 405, 422, 500, 502, 503]) {
    assert.equal(upstreamClientError(status), null, `status ${status}`);
  }
});

// -------------------------------------------------------- /[username] profile

test("profile: a creator API 429 is a 429 page with the API's Retry-After", async () => {
  const { stderr, stdout } = captureConsole();
  const backend = async () =>
    json({ detail: "Request was throttled." }, 429, { "Retry-After": "17" });
  const event = pageEvent("/alice", { username: "alice" }, backend);
  const thrown = await thrownBy(() => profileLoad(event));
  assert.equal(thrown.status, 429);
  assert.equal(event.headers["retry-after"], "17");
  assert.deepEqual(stderr, [], "a throttle is not an ERROR");
  const entry = onlyWarning(stdout, "profile_creator_lookup_upstream_4xx");
  assert.equal(entry.retry_after, "17");
  assert.equal(entry.upstream_status, 429);
});

test("profile: a 429 whose Retry-After is not delta-seconds forwards none", async () => {
  captureConsole();
  const backend = async () =>
    json({}, 429, { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" });
  const event = pageEvent("/alice", { username: "alice" }, backend);
  const thrown = await thrownBy(() => profileLoad(event));
  assert.equal(thrown.status, 429);
  assert.equal(event.headers["retry-after"], undefined);
});

for (const [apiStatus, pageStatus] of [
  [401, 403],
  [403, 403],
  [410, 410],
]) {
  test(`profile: a creator API ${apiStatus} is a ${pageStatus} page and one WARNING`, async () => {
    const { stderr, stdout } = captureConsole();
    const backend = async () => json({ detail: "no" }, apiStatus);
    const event = pageEvent("/alice", { username: "alice" }, backend);
    const thrown = await thrownBy(() => profileLoad(event));
    assert.equal(thrown.status, pageStatus);
    assert.equal(event.headers["retry-after"], undefined);
    assert.deepEqual(stderr, []);
    const entry = onlyWarning(stdout, "profile_creator_lookup_upstream_4xx");
    assert.equal(entry.upstream_status, apiStatus);
  });
}

test("profile: a creator API 400 is still our defect: 500 + one ERROR line", async () => {
  const { stderr } = captureConsole();
  const backend = async () => json({ detail: "bad" }, 400);
  const thrown = await thrownBy(() =>
    profileLoad(pageEvent("/alice", { username: "alice" }, backend)),
  );
  assert.equal(thrown.status, 500);
  assert.equal(stderr.length, 1);
  const entry = JSON.parse(stderr[0][0]);
  assert.equal(entry.event, "profile_creator_lookup_failed");
  assert.equal(entry.upstream_status, 400);
});

// ------------------------------------------------ /[username]/[vanity] zPage

test("zPage: an API 429 is a 429 page with the API's Retry-After", async () => {
  const { stderr, stdout } = captureConsole();
  const backend = async () => json({}, 429, { "Retry-After": "30" });
  const event = pageEvent(
    "/alice/post",
    { username: "alice", vanity: "post" },
    backend,
  );
  const thrown = await thrownBy(() => vanityLoad(event));
  assert.equal(thrown.status, 429);
  assert.equal(event.headers["retry-after"], "30");
  assert.equal(event.headers["cache-control"], "private, no-cache");
  assert.deepEqual(stderr, []);
  onlyWarning(stdout, "article_load_upstream_4xx");
});

for (const [apiStatus, pageStatus] of [
  [403, 403],
  [410, 410],
]) {
  test(`zPage: an API ${apiStatus} is a ${pageStatus} page and one WARNING`, async () => {
    const { stderr, stdout } = captureConsole();
    const backend = async () => json({ detail: "no" }, apiStatus);
    const thrown = await thrownBy(() =>
      vanityLoad(
        pageEvent(
          "/alice/post",
          { username: "alice", vanity: "post" },
          backend,
        ),
      ),
    );
    assert.equal(thrown.status, pageStatus);
    assert.deepEqual(stderr, []);
    const entry = onlyWarning(stdout, "article_load_upstream_4xx");
    assert.equal(entry.upstream_status, apiStatus);
  });
}

test("zPage: an API 500 is still a 500 page", async () => {
  captureConsole();
  const backend = async () => json({}, 500, { "Retry-After": "5" });
  const event = pageEvent(
    "/alice/post",
    { username: "alice", vanity: "post" },
    backend,
  );
  const thrown = await thrownBy(() => vanityLoad(event));
  assert.equal(thrown.status, 500);
  assert.equal(event.headers["retry-after"], undefined);
});

// ------------------------------------------------------------ /article/[id]

test("/article/[id]: an API 429 is a 429 page; a 403 is a 403", async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => json({}, 429, { "Retry-After": "9" });
    let { stderr, stdout } = captureConsole();
    let event = pageEvent("/article/abc", { id: "abc" }, globalThis.fetch);
    let thrown = await thrownBy(() => articleLoad(event));
    assert.equal(thrown.status, 429);
    assert.equal(event.headers["retry-after"], "9");
    assert.deepEqual(stderr, []);
    onlyWarning(stdout, "article_load_upstream_4xx");

    mock.restoreAll();
    globalThis.fetch = async () => json({ detail: "no" }, 403);
    ({ stderr, stdout } = captureConsole());
    event = pageEvent("/article/abc", { id: "abc" }, globalThis.fetch);
    thrown = await thrownBy(() => articleLoad(event));
    assert.equal(thrown.status, 403);
    assert.deepEqual(stderr, []);
    assert.equal(
      onlyWarning(stdout, "article_load_upstream_4xx").upstream_status,
      403,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ------------------------------------------------------------- error page

test("+error.svelte explains a 429 in every shipped locale", async () => {
  const { readFile } = await import("node:fs/promises");
  const page = await readFile(
    new URL("../src/routes/+error.svelte", import.meta.url),
    "utf8",
  );
  // Without an entry the forwarded 429 renders "Unknown Error / contact
  // support", inviting the immediate retries the throttle is asking against.
  assert.match(
    page,
    /429:\s*\{\s*titleKey:\s*["']errors\.http\.429\.title["']/,
  );
  for (const locale of ["en", "es", "fr", "pt-BR"]) {
    const messages = JSON.parse(
      await readFile(
        new URL(`../src/lib/locales/${locale}.json`, import.meta.url),
        "utf8",
      ),
    );
    const entry = messages.errors.http["429"];
    assert.ok(entry?.title && entry?.description, `${locale} has 429 copy`);
  }
});
