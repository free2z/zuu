import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

//  the dashboard, buy-2z, KYC and protected-stream server loads used to
// answer ANY failure of `/api/auth/user/` with a 302 to /login: a 502 from a
// rollout draining gunicorn, a 429 from the throttle, a stalled Django. A
// signed-in user was told they were logged out and asked for credentials that
// were never the problem. Only a 401/403 is "signed out"; everything else is a
// 503 error page. And the lookup is bounded, so a stalled backend cannot hold
// the SSR render for the sidecar's 200s.
//
// Negative control: restore the pre- loaders and `backend.ts` from
// origin/main and this file goes red on every non-401/403 case (they 302 to
// /login) and on the deadline test (no signal is ever passed).

const UI_ROOT = fileURLToPath(new URL("..", import.meta.url));
const API = "https://api.free2z.test";
const AUTH_USER_URL = `${API}/api/auth/user/`;

let vite;
let backend;
const loaders = {};
let billingActions;

const previousApiBase = process.env.PRIVATE_API_BASE_URL;

before(async () => {
  process.env.PRIVATE_API_BASE_URL = API;
  vite = await createServer({
    appType: "custom",
    server: { hmr: false, middlewareMode: true },
  });
  backend = await vite.ssrLoadModule("/src/lib/server/backend.ts");
  for (const [name, route] of Object.entries({
    buy2z: "/src/routes/buy-2z/+page.server.ts",
    pages: "/src/routes/[username]/dashboard/pages/+page.server.ts",
    stream: "/src/routes/[username]/dashboard/stream/+page.server.ts",
    profile: "/src/routes/[username]/dashboard/profile/+page.server.ts",
    settings: "/src/routes/[username]/dashboard/settings/+page.server.ts",
    billing: "/src/routes/[username]/dashboard/billing/+page.server.ts",
    kyc: "/src/routes/[username]/dashboard/kyc/+page.server.ts",
  })) {
    const module = await vite.ssrLoadModule(route);
    loaders[name] = module.load;
    if (name === "billing") billingActions = module.actions;
  }
});

after(async () => {
  await vite?.close();
  if (previousApiBase === undefined) {
    delete process.env.PRIVATE_API_BASE_URL;
  } else {
    process.env.PRIVATE_API_BASE_URL = previousApiBase;
  }
});

const signedIn = {
  get: (name) => (name === "sessionid" ? "sess-alice" : undefined),
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A backend whose `/api/auth/user/` answers with `identity()`; every other
 * read succeeds with an empty page, so a load that gets past the identity
 * check returns data instead of failing somewhere unrelated.
 */
function backendFetch(identity, seen = []) {
  return async (input, init) => {
    const url = String(input);
    seen.push({ url, init });
    if (url === AUTH_USER_URL) return identity(init);
    if (url.includes("/api/kyc/")) return json({});
    if (url.includes("/pricing")) return json({});
    return json({ results: [], count: 0, next: null, previous: null });
  };
}

function eventFor(name, fetchFn) {
  const pathname = {
    buy2z: "/buy-2z",
    pages: "/alice/dashboard/pages",
    stream: "/alice/dashboard/stream",
    profile: "/alice/dashboard/profile",
    settings: "/alice/dashboard/settings",
    billing: "/alice/dashboard/billing",
    kyc: "/alice/dashboard/kyc",
  }[name];
  return {
    params: { username: "alice" },
    cookies: signedIn,
    fetch: fetchFn,
    url: new URL(`https://free2z.test${pathname}`),
    setHeaders: () => {},
    depends: () => {},
  };
}

test("KYC preserves large decimal balance text when its route snapshot updates auth", async () => {
  const decimal = "9007199254740.991";
  const data = await loaders.kyc(
    eventFor(
      "kyc",
      backendFetch(() =>
        json({
          id: 1,
          username: "alice",
          tuzis: decimal,
          balance_snapshot: "8123:1",
        }),
      ),
    ),
  );
  assert.equal(data.tuzis, decimal);
  const { authStore } = await vite.ssrLoadModule("/src/lib/stores/auth.ts");
  try {
    authStore.hydrateFromSession({
      id: 1,
      username: "alice",
      tuzis: "5",
      balance_snapshot: "8123:2",
    });
    authStore.observeAccountBalanceSnapshot(data);
    let state;
    authStore.subscribe((value) => {
      state = value;
    })();
    assert.equal(state.creator.tuzis, decimal);
    assert.equal(state.creator.balance_snapshot, "8123:1");
  } finally {
    authStore.hydrateFromSession(null);
  }
});

/** What a load threw: `{status, location}` for a redirect, `{status}` for an HttpError. */
async function outcomeOf(run) {
  try {
    await run();
  } catch (thrown) {
    if (thrown && typeof thrown.status === "number") {
      return thrown.location
        ? { status: thrown.status, location: thrown.location }
        : { status: thrown.status, message: thrown.body?.message };
    }
    throw thrown;
  }
  return { status: "returned" };
}

async function quietly(run) {
  // The helper logs every non-2xx on purpose ( asks for the line); keep
  // the test output readable without hiding a real failure.
  const error = mock.method(console, "error", () => {});
  const warn = mock.method(console, "warn", () => {});
  try {
    return await run();
  } finally {
    error.mock.restore();
    warn.mock.restore();
  }
}

const OUTAGES = {
  "429 throttle": () => json({ detail: "Request was throttled." }, 429),
  500: () => new Response("boom", { status: 500 }),
  "502 draining pod": () => new Response("bad gateway", { status: 502 }),
  503: () => new Response("unavailable", { status: 503 }),
  504: () => new Response("gateway timeout", { status: 504 }),
  "a 302 instead of a user": () =>
    new Response(null, { status: 302, headers: { location: "/elsewhere" } }),
  "a network failure": () => {
    throw new TypeError("fetch failed");
  },
  "a 200 that is not JSON": () =>
    new Response("<html>proxy error</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    }),
  "a 200 with no username": () => json({ detail: "ok" }),
};

// --- the helper --------------------------------------------------------------

test("only a 401/403 from /api/auth/user/ means signed out", async () => {
  for (const status of [401, 403]) {
    const result = await quietly(() =>
      outcomeOf(() =>
        backend.requireAuthenticatedUser(
          backendFetch(() => json({ detail: "nope" }, status)),
          signedIn,
          "/alice/dashboard/kyc",
        ),
      ),
    );
    assert.deepEqual(
      result,
      { status: 302, location: "/login?next=%2Falice%2Fdashboard%2Fkyc" },
      `a ${status} is a real logout`,
    );
    assert.equal(
      await quietly(() =>
        backend.resolveAuthenticatedUser(
          backendFetch(() => json({}, status)),
          signedIn,
        ),
      ),
      null,
    );
  }
});

test("no session cookie is signed out without asking the backend", async () => {
  const result = await outcomeOf(() =>
    backend.requireAuthenticatedUser(
      async () => assert.fail("no cookie, no backend call"),
      { get: () => undefined },
      "/buy-2z",
    ),
  );
  assert.deepEqual(result, { status: 302, location: "/login?next=%2Fbuy-2z" });
});

for (const [label, identity] of Object.entries(OUTAGES)) {
  test(`the helper answers 503, not /login, for ${label}`, async () => {
    const result = await quietly(() =>
      outcomeOf(() =>
        backend.requireAuthenticatedUser(
          backendFetch(identity),
          signedIn,
          "/alice/dashboard/kyc",
        ),
      ),
    );
    assert.equal(result.status, 503, JSON.stringify(result));
    assert.equal(result.location, undefined);
    assert.equal(result.message, "errors.http.503.title");
  });
}

test("the identity lookup is abandoned on a deadline, body included", async () => {
  assert.equal(backend.AUTH_USER_TIMEOUT_MS, 10_000);
  assert.ok(
    backend.AUTH_USER_TIMEOUT_MS < 60_000,
    "the deadline must fire before the public proxy stops waiting",
  );

  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    // Headers arrive; the body never does unless the signal aborts it.
    let bodyAborted = false;
    const stalledBody = async (_url, init) => ({
      status: 200,
      ok: true,
      json: () =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            bodyAborted = true;
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    });
    const pending = quietly(() =>
      outcomeOf(() => backend.requireAuthenticatedUser(stalledBody, signedIn)),
    );
    // Let the fetch resolve and the body read start before advancing time.
    await new Promise((resolve) => setImmediate(resolve));
    mock.timers.tick(backend.AUTH_USER_TIMEOUT_MS - 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(bodyAborted, false, "must not abort before the deadline");
    mock.timers.tick(1);
    const result = await pending;
    assert.equal(bodyAborted, true, "the deadline must cover the body read");
    assert.equal(result.status, 503);

    // And a fetch that never even produces headers.
    let fetchAborted = false;
    const stalledFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          fetchAborted = true;
          reject(new DOMException("aborted", "TimeoutError"));
        });
      });
    const pendingFetch = quietly(() =>
      outcomeOf(() => backend.requireAuthenticatedUser(stalledFetch, signedIn)),
    );
    mock.timers.tick(backend.AUTH_USER_TIMEOUT_MS);
    assert.equal((await pendingFetch).status, 503);
    assert.equal(fetchAborted, true);
  } finally {
    mock.timers.reset();
  }
});

// --- every loader that asks who the visitor is -------------------------------

for (const name of [
  "buy2z",
  "pages",
  "stream",
  "profile",
  "settings",
  "billing",
  "kyc",
]) {
  test(`${name}: a 401 still sends the visitor to /login`, async () => {
    const event = eventFor(
      name,
      backendFetch(() => json({}, 401)),
    );
    const result = await quietly(() => outcomeOf(() => loaders[name](event)));
    assert.equal(result.status, 302);
    assert.ok(
      result.location.startsWith("/login?next="),
      `${name} -> ${result.location}`,
    );
  });

  for (const label of [
    "429 throttle",
    "502 draining pod",
    "a network failure",
  ]) {
    test(`${name}: ${label} is a 503 error page, not a /login bounce`, async () => {
      const event = eventFor(name, backendFetch(OUTAGES[label]));
      const result = await quietly(() => outcomeOf(() => loaders[name](event)));
      assert.equal(result.status, 503, `${name} -> ${JSON.stringify(result)}`);
      assert.equal(result.location, undefined);
    });
  }

  test(`${name}: the identity fetch carries a deadline signal`, async () => {
    const seen = [];
    const event = eventFor(
      name,
      backendFetch(() => json({ username: "alice", tuzis: 0 }), seen),
    );
    await quietly(() => outcomeOf(() => loaders[name](event)));
    const identity = seen.find(({ url }) => url === AUTH_USER_URL);
    assert.ok(identity, `${name} must ask /api/auth/user/`);
    assert.ok(
      identity.init?.signal instanceof AbortSignal,
      `${name}'s identity lookup must be bounded`,
    );
  });
}

test("billing actions: a backend outage is a 503, not a /login bounce", async () => {
  const cookies = {
    get: (name) =>
      name === "sessionid" ? "sess-alice" : name === "csrftoken" ? "csrf" : "",
    set: () => {},
  };
  const result = await quietly(() =>
    outcomeOf(() =>
      billingActions.checkout({
        params: { username: "alice" },
        cookies,
        fetch: backendFetch(OUTAGES["502 draining pod"]),
        url: new URL("https://free2z.test/alice/dashboard/billing?/checkout"),
        request: new Request("https://free2z.test/alice/dashboard/billing", {
          method: "POST",
        }),
      }),
    ),
  );
  assert.equal(result.status, 503, JSON.stringify(result));
});

// --- no loader grows its own copy again --------------------------------------

test("no server load fetches /api/auth/user/ and redirects on !ok by hand", () => {
  // The bug was five hand-rolled copies of one check. The allowed readers are
  // the shared helper, the login page (which only ever redirects AWAY from
  // /login on success), and the public profile (which only decides isOwner
  // and never redirects). The root layout only names the endpoint in a
  // comment: it reads the cookie's presence and never fetches.
  const allowed = new Set([
    "src/lib/server/backend.ts",
    "src/routes/+layout.server.ts",
    "src/routes/(auth)/login/+page.server.ts",
    "src/routes/[username]/+page.server.ts",
  ]);
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "api" && dir.endsWith(path.join("src", "lib")))
          continue; // the generated orval client
        walk(full);
        continue;
      }
      if (!/\.(ts|js)$/.test(entry.name)) continue;
      const relative = path.relative(UI_ROOT, full).split(path.sep).join("/");
      const isServer =
        relative.includes("/server/") || /\.server\.(ts|js)$/.test(relative);
      if (!isServer || allowed.has(relative)) continue;
      if (fs.readFileSync(full, "utf8").includes("/api/auth/user/")) {
        offenders.push(relative);
      }
    }
  };
  walk(path.join(UI_ROOT, "src"));
  assert.deepEqual(
    offenders,
    [],
    "use requireAuthenticatedUser / resolveAuthenticatedUser from $lib/server/backend",
  );
});

test("card checkout refuses an original actor mismatch before creating a session", async () => {
  const seen = [];
  const fields = new FormData();
  fields.set("quantity", "1000");
  fields.set("expected_actor_id", "7");
  const result = await billingActions.checkout({
    params: { username: "alice" },
    cookies: {
      get: (name) =>
        name === "sessionid"
          ? "sess-alice"
          : name === "csrftoken"
            ? "csrf"
            : undefined,
      set: () => {},
    },
    fetch: backendFetch(
      () => json({ id: 8, username: "alice", tuzis: 0 }),
      seen,
    ),
    url: new URL("https://free2z.test/alice/dashboard/billing?/checkout"),
    request: new Request("https://free2z.test/alice/dashboard/billing", {
      method: "POST",
      body: fields,
    }),
  });
  assert.equal(result.status, 409);
  assert.equal(result.data.messageKey, "economy.signInAgain");
  assert.equal(
    seen.some(({ url }) => url.includes("create-checkout-session")),
    false,
  );
});
