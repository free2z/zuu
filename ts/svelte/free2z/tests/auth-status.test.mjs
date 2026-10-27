import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";

// Issue  — "not checked yet" and "authoritatively signed out" used to be
// the same store value (`isAuthenticated: false`), so a signed-in creator was
// shown a Sign In button for as long as `/api/auth/user/` took to answer.
//
// This file pins the state machine. `tests/browser/auth-resolving-flash.spec.ts`
// drives the real navbar and asserts the affordance and its geometry.

const AUTH_MODULE = "/src/lib/stores/auth.ts";
const CREATOR = { id: 1, username: "resolver", full_name: "Resolver" };
const originalFetch = globalThis.fetch;

let server;

before(async () => {
  server = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
});

after(async () => {
  globalThis.fetch = originalFetch;
  await server?.close();
});

/**
 * A store that has genuinely never resolved a session.
 *
 * Every assertion here is about the FIRST answer a cold client gets, and the
 * store is a module-level singleton that latches out of `unknown` for good —
 * so reusing one instance across tests would silently make the interesting
 * assertions vacuous. Invalidating the module graph re-executes the module and
 * gives each test its own bootstrap.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits out the store's whole bootstrap-retry schedule, plus a margin for the
 * awaits between a timer firing and the store applying the answer. Real timers
 * on purpose: the schedule is short by design, and faking them would let a
 * regression that made it long pass unnoticed.
 */
async function settleAllRetries(delays) {
  await sleep(delays.reduce((total, delay) => total + delay, 0) + 250);
}

async function freshStore() {
  server.moduleGraph.invalidateAll();
  const {
    authStore,
    AUTH_BOOTSTRAP_RETRY_DELAYS_MS: retryDelays,
    AUTH_CHECK_TIMEOUT_MS: timeoutMs,
  } = await server.ssrLoadModule(AUTH_MODULE);
  const read = () => {
    let value;
    authStore.subscribe((state) => {
      value = state;
    })();
    return value;
  };
  assert.equal(
    read().status,
    "unknown",
    "a fresh store must start unresolved, or this test proves nothing",
  );
  // `settled` waits out the retry schedule; a caller that expects recovery
  // uses it, one that expects the wait to be bounded uses settleAllRetries.
  const settled = () => settleAllRetries(retryDelays);
  return { authStore, read, retryDelays, timeoutMs, settled };
}

function respondWith(status, body = {}) {
  globalThis.fetch = async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
}

test("a cold store is unknown, not signed out", async () => {
  const { read } = await freshStore();

  // The very first value the navbar ever sees. `isAuthenticated` is false in
  // both this state and the signed-out one — that ambiguity is the bug.
  assert.equal(read().status, "unknown");
  assert.equal(read().isAuthenticated, false);
});

test("a 200 from the session endpoint resolves to authenticated", async () => {
  const { authStore, read } = await freshStore();
  respondWith(200, CREATOR);

  await authStore.checkAuth({ force: true, silent: true });

  assert.equal(read().status, "authenticated");
  assert.equal(read().isAuthenticated, true);
  assert.equal(read().creator.username, CREATOR.username);
});

test("a 401 resolves to anonymous — the only state that may show Sign In", async () => {
  const { authStore, read } = await freshStore();
  respondWith(401, { detail: "Not authenticated" });

  await authStore.checkAuth({ force: true, silent: true });

  assert.equal(read().status, "anonymous");
  assert.equal(read().isAuthenticated, false);
});

test("a single 5xx retries instead of declaring the visitor signed out", async () => {
  const { authStore, read, retryDelays, settled } = await freshStore();
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    return new Response("{}", { status: 503 });
  };

  await authStore.checkAuth({ force: true, silent: true });

  // A rolling backend restart is exactly when this fires. Claiming anonymous
  // on the first flap would hide Create, the bell and the profile menu from a
  // signed-in creator until something else happened to re-check.
  assert.equal(attempts, 1);
  assert.equal(read().status, "unknown");
  assert.ok(retryDelays.length > 0, "there must be at least one retry");

  // Drain the schedule so no armed timer outlives this test and fires against
  // the next one's fetch stub.
  await settled();
});

test("a backend that recovers mid-bootstrap resolves without ever showing Sign In", async () => {
  const { authStore, read, settled } = await freshStore();
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    if (attempts === 1) return new Response("{}", { status: 503 });
    return new Response(JSON.stringify(CREATOR), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  await authStore.checkAuth({ force: true, silent: true });
  assert.equal(read().status, "unknown");

  await settled();

  assert.ok(attempts >= 2, "the retry must actually re-request");
  assert.equal(read().status, "authenticated");
  assert.equal(read().creator.username, CREATOR.username);
});

test("a backend down for every attempt settles rather than hanging on the placeholder", async () => {
  const { authStore, read, retryDelays } = await freshStore();
  let attempts = 0;
  const attemptedAt = [];
  globalThis.fetch = async () => {
    attempts += 1;
    attemptedAt.push(performance.now());
    return new Response("{}", { status: 503 });
  };

  await authStore.checkAuth({ force: true, silent: true });
  // Wait for the observable terminal state. A fixed sum of delays races the
  // final callback when parallel SSR compilation briefly delays the event loop.
  const budget = retryDelays.reduce((sum, delay) => sum + delay, 0) + 2_000;
  const started = performance.now();
  while (read().status === "unknown") {
    assert.ok(
      performance.now() - started < budget,
      "bootstrap must settle within its bounded test budget",
    );
    await sleep(10);
  }

  // Bounded, not indefinite: an affordance that can never resolve is worse
  // than a wrong one, because Sign In is at least recoverable.
  assert.equal(attempts, retryDelays.length + 1);
  for (const [index, delay] of retryDelays.entries()) {
    assert.ok(
      attemptedAt[index + 1] - attemptedAt[index] >= delay - 5,
      "a retry must respect its configured backoff",
    );
  }
  assert.equal(read().status, "anonymous");
  assert.equal(read().isAuthenticated, false);
});

test("an auth-network failure settles the same bounded way", async () => {
  const { authStore, read, retryDelays } = await freshStore();
  globalThis.fetch = async () => {
    throw new TypeError("Failed to fetch");
  };

  await authStore.checkAuth({ force: true, silent: true });
  assert.equal(read().status, "unknown");

  await settleAllRetries(retryDelays);

  assert.equal(read().status, "anonymous");
  assert.equal(read().isAuthenticated, false);
});

test("a failed check never demotes an already-resolved session", async () => {
  const { authStore, read } = await freshStore();
  respondWith(200, CREATOR);
  await authStore.checkAuth({ force: true, silent: true });
  assert.equal(read().status, "authenticated");

  globalThis.fetch = async () => {
    throw new TypeError("Failed to fetch");
  };
  await authStore.checkAuth({ force: true, silent: true });

  // settleUnresolvedState() only ever moves `unknown` forward. A transient
  // network blip must not log a signed-in creator out of the UI.
  assert.equal(read().status, "authenticated");
  assert.equal(read().creator.username, CREATOR.username);
});

test("a cached creator marks the session authenticated without a round-trip", async () => {
  const { authStore, read } = await freshStore();

  // This is the localStorage-snapshot path the store runs at module init in
  // the browser: it is what makes a returning visitor skip the placeholder.
  authStore.hydrateFromSession(CREATOR);

  assert.equal(read().status, "authenticated");
});

test("a 429 is not retried — the backend asked for less traffic", async () => {
  const { authStore, read, settled } = await freshStore();
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    return new Response("{}", { status: 429 });
  };

  await authStore.checkAuth({ force: true, silent: true });
  await settled();

  // Retrying a rate limit is the one thing guaranteed to make an overloaded
  // backend worse.
  assert.equal(attempts, 1);
  assert.equal(read().status, "anonymous");
});

test("the session check is bounded by an abort signal, not by nginx", async () => {
  const { authStore, read, timeoutMs } = await freshStore();

  /** @type {AbortSignal | undefined} */
  let seenSignal;
  globalThis.fetch = async (_url, init) => {
    seenSignal = init?.signal;
    return new Response(JSON.stringify(CREATOR), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  await authStore.checkAuth({ force: true, silent: true });
  assert.equal(read().status, "authenticated");

  // `fetch` has no default timeout and nginx lets /api run to its 200s read
  // timeout, so a backend that accepts the connection and then stops talking
  // would hold the navbar placeholder for minutes. The timer behaviour itself
  // is pinned in tests/abort-signal.test.mjs; what matters here is that the
  // request is wired to one at all, and that the ceiling is short enough to
  // be worth having.
  assert.ok(seenSignal, "the session check must carry an abort signal");
  assert.equal(typeof seenSignal.addEventListener, "function");
  assert.equal(seenSignal.aborted, false);
  assert.ok(timeoutMs > 0 && timeoutMs <= 15_000, `ceiling was ${timeoutMs}ms`);
});

test("the server's no-session fact resolves the store with no request at all", async () => {
  const { authStore, read } = await freshStore();
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    return new Response("{}", { status: 503 });
  };

  // What `+layout.server.ts` reports when the request carried no `sessionid`.
  authStore.applyServerSessionHint(false);

  assert.equal(read().status, "anonymous");
  assert.equal(attempts, 0);
});

test("the hint is inert once the store has resolved, so a stale false cannot sign anyone out", async () => {
  const { authStore, read } = await freshStore();
  authStore.hydrateFromSession(CREATOR);
  assert.equal(read().status, "authenticated");

  // After a client-side login the already-loaded page data still says there
  // was no cookie on the original request.
  authStore.applyServerSessionHint(false);

  assert.equal(read().status, "authenticated");
  assert.equal(read().creator.username, CREATOR.username);
});

test("a session established by login invalidates a check that started before it", async () => {
  const { authStore, read } = await freshStore();

  // The race codex flagged: a bootstrap check armed while the backend was
  // flapping carries the PRE-login cookie, so it can come back 401 a moment
  // after the login has applied the new creator. Logout bumps `authGeneration`
  // for the mirror-image reason; login has to as well, or the stale answer
  // passes the staleness check and signs the visitor straight back out.
  let userCalls = 0;
  let releaseStaleCheck = () => {};
  const staleCheckSent = new Promise((resolveSent) => {
    globalThis.fetch = async (url) => {
      const target = String(url);
      if (target.includes("/api/auth/user/")) {
        userCalls += 1;
        if (userCalls === 1) {
          resolveSent();
          return new Promise((resolveResponse) => {
            releaseStaleCheck = () =>
              resolveResponse(new Response("{}", { status: 401 }));
          });
        }
        return new Response(JSON.stringify(CREATOR), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (target.includes("/api/auth/login/")) {
        return new Response("{}", { status: 200 });
      }
      return new Response("{}", { status: 404 });
    };
  });

  const stale = authStore.checkAuth({ force: true, silent: true });
  await staleCheckSent;

  const result = await authStore.loginOnly("resolver", "hunter2");
  assert.equal(result.success, true);
  assert.equal(read().status, "authenticated");

  releaseStaleCheck();
  await stale;

  assert.equal(read().status, "authenticated");
  assert.equal(read().creator.username, CREATOR.username);
});

test("a fresh auth check bypasses an older request and fences its answer", async () => {
  const { authStore, read } = await freshStore();
  authStore.hydrateFromSession(CREATOR);
  let calls = 0;
  let releaseOld;
  let oldStarted;
  const started = new Promise((resolve) => {
    oldStarted = resolve;
  });
  globalThis.fetch = async (input, init) => {
    calls += 1;
    if (calls === 1) {
      oldStarted();
      assert.equal(init.cache, "no-store");
      return new Promise((resolve) => {
        releaseOld = () => resolve(new Response("{}", { status: 401 }));
      });
    }
    assert.equal(init.cache, "no-store");
    return new Response(JSON.stringify({ ...CREATOR, username: "fresh" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const oldCheck = authStore.checkAuth({ fresh: true, silent: true });
  await started;
  const freshCheck = authStore.checkAuth({ fresh: true, silent: true });
  assert.equal(await freshCheck, true);
  assert.equal(read().creator.username, "fresh");
  releaseOld();
  assert.equal(await oldCheck, false);
  assert.equal(read().creator.username, "fresh");
});

test("a superseded fresh request that rejects fails closed", async () => {
  const { authStore, read } = await freshStore();
  authStore.hydrateFromSession(CREATOR);
  let calls = 0;
  let releaseOld;
  let oldStarted;
  const started = new Promise((resolve) => {
    oldStarted = resolve;
  });
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      oldStarted();
      return new Promise((_, reject) => {
        releaseOld = () => reject(new Error("old request failed"));
      });
    }
    return new Response(JSON.stringify({ ...CREATOR, username: "fresh" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const oldCheck = authStore.checkAuth({ fresh: true, silent: true });
  await started;
  const freshCheck = authStore.checkAuth({ fresh: true, silent: true });
  assert.equal(await freshCheck, true);
  assert.equal(read().creator.username, "fresh");
  releaseOld();
  assert.equal(await oldCheck, false);
  assert.equal(read().creator.username, "fresh");
});

for (const [label, respond] of [
  ["a 503", () => new Response("{}", { status: 503 })],
  ["a network failure", () => Promise.reject(new Error("offline"))],
]) {
  test(`a fresh auth check fails closed on ${label}`, async () => {
    const { authStore, read } = await freshStore();
    authStore.hydrateFromSession(CREATOR);
    globalThis.fetch = async () => respond();

    assert.equal(
      await authStore.checkAuth({ fresh: true, silent: true }),
      false,
    );
    assert.equal(
      read().creator.username,
      CREATOR.username,
      "a failed refresh does not erase the last known session",
    );
  });
}

test("a 401 mid-session is authoritative anonymous, not a return to unknown", async () => {
  const { authStore, read } = await freshStore();
  authStore.hydrateFromSession(CREATOR);
  assert.equal(read().status, "authenticated");

  assert.equal(authStore.handleAuthFailure(401), true);

  assert.equal(read().status, "anonymous");
  assert.equal(read().isAuthenticated, false);
});

for (const failure of ["handleAuthFailure", "clear"]) {
  test(`${failure} fences an outstanding successful identity response`, async () => {
    const { authStore, read } = await freshStore();
    authStore.hydrateFromSession(CREATOR);
    let release;
    globalThis.fetch = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const checking = authStore.checkAuth({ force: true, silent: true });
    if (failure === "clear") authStore.clear();
    else authStore.handleAuthFailure(401);
    release(new Response(JSON.stringify(CREATOR), { status: 200 }));
    await checking;
    assert.equal(
      read().creator,
      null,
      "a pre-failure identity cannot authorize the next save",
    );
    assert.equal(read().isAuthenticated, false);
  });
}

for (const loginMethod of ["loginOnly", "login"]) {
  test(`${loginMethod} discards the old identity when a changed session cannot be resolved`, async () => {
    const { authStore, read, settled } = await freshStore();
    authStore.hydrateFromSession(CREATOR);
    let releaseOldCheck;
    globalThis.fetch = () =>
      new Promise((resolve) => {
        releaseOldCheck = resolve;
      });
    const oldCheck = authStore.checkAuth({ force: true, silent: true });
    globalThis.fetch = async (input) =>
      new Response(JSON.stringify({}), {
        status: String(input).includes("/api/auth/user/") ? 503 : 200,
      });
    const result = await authStore[loginMethod]("another-creator", "password");
    assert.equal(result.success, false);
    assert.equal(
      read().creator,
      null,
      "the old creator is not proof of the new session's owner",
    );
    assert.equal(read().isAuthenticated, false);
    const nextCreator = { username: "another-creator" };
    respondWith(200, nextCreator);
    await settled();
    releaseOldCheck(new Response(JSON.stringify(CREATOR), { status: 200 }));
    await oldCheck;
    assert.equal(
      read().creator?.username,
      nextCreator.username,
      "bounded recovery resolves the new identity without another user action",
    );
  });
}

test(
  "a canceled queued sign-in never sends its credentials",
  { timeout: 5000 },
  async () => {
    const { authStore, read } = await freshStore();
    const credentials = [];
    let releaseFirst;
    let firstStarted;
    const started = new Promise((resolve) => {
      firstStarted = resolve;
    });
    globalThis.fetch = async (input, init) => {
      if (String(input).includes("/api/auth/login/")) {
        credentials.push(JSON.parse(init.body).username);
        if (JSON.parse(init.body).username !== "resolver")
          return new Response("{}", { status: 200 });
        firstStarted();
        return new Promise((resolve) => {
          releaseFirst = () => resolve(new Response("{}", { status: 200 }));
        });
      }
      return new Response(JSON.stringify(CREATOR), { status: 200 });
    };
    const first = authStore.loginOnly("resolver", "first-password");
    await started;
    let current = true;
    const canceled = authStore.loginOnly(
      "canceled-creator",
      "never-send-this",
      undefined,
      undefined,
      () => current,
    );
    current = false;
    releaseFirst();
    const [firstResult, canceledResult] = await Promise.all([first, canceled]);
    assert.equal(firstResult.success, true);
    assert.deepEqual(credentials, ["resolver"]);
    assert.equal(canceledResult.success, false);
    assert.equal(read().creator.username, CREATOR.username);
  },
);

test(
  "a stalled identity body releases queued logout at the auth deadline",
  { timeout: 12000 },
  async () => {
    const { authStore, read, timeoutMs } = await freshStore();
    const originalWindow = globalThis.window;
    let releaseBody;
    let identityStarted;
    const started = new Promise((resolve) => {
      identityStarted = resolve;
    });
    let logoutSent = false;
    globalThis.window = {
      location: {
        href: "https://free2z.test/converse",
        pathname: "/converse",
        reload() {},
        assign() {},
      },
    };
    globalThis.fetch = async (input, init) => {
      if (String(input).includes("/api/auth/logout/")) {
        logoutSent = true;
        assert.equal(
          read().creator,
          null,
          "a timed-out identity cannot restore the previous creator",
        );
        return new Response("{}", { status: 200 });
      }
      if (String(input).includes("/api/auth/login/"))
        return new Response("{}", { status: 200 });
      identityStarted();
      return {
        ok: true,
        json: () =>
          new Promise((resolve, reject) => {
            releaseBody = () => resolve(CREATOR);
            init.signal?.addEventListener(
              "abort",
              () => reject(init.signal.reason),
              { once: true },
            );
          }),
      };
    };
    const login = authStore.loginOnly("resolver", "password");
    await started;
    const logout = authStore.logout();
    try {
      await sleep(timeoutMs + 400);
      assert.equal(
        logoutSent,
        true,
        "logout must reach the server after the identity deadline",
      );
      assert.equal((await login).success, false);
      assert.equal(await logout, true);
      assert.equal(read().status, "anonymous");
    } finally {
      releaseBody?.();
      await Promise.all([login, logout]);
      globalThis.window = originalWindow;
    }
  },
);

//sign-in goes through `apiFetch`, so a bound can fire before the
// headers (fetch rejects) or while an ERROR body is read (`.json()` rejects).
// Either way the result must say the server did not answer -- "Login failed"
// reads as a wrong password. The body case is from the codex review.
for (const [when, respond] of [
  [
    "before the headers",
    async () => {
      throw new DOMException("signal timed out", "TimeoutError");
    },
  ],
  [
    "while the error body is read",
    async () => ({
      ok: false,
      status: 503,
      json: async () => {
        throw new DOMException("signal timed out", "TimeoutError");
      },
    }),
  ],
]) {
  test(`a sign-in that times out ${when} says so, not "Login failed"`, async () => {
    const { authStore } = await freshStore();
    const { REQUEST_TIMEOUT_CODE } = await server.ssrLoadModule(AUTH_MODULE);
    globalThis.fetch = respond;
    const result = await authStore.loginOnly("resolver", "hunter2");
    assert.equal(result.success, false);
    assert.equal(result.errorCode, REQUEST_TIMEOUT_CODE);
    assert.match(result.error, /stopped responding|did not respond/);
  });
}

//the credential throttles fail CLOSED -- when their Redis is down,
// /api/start/ and /api/auth/login/ answer 503 with a `detail`. That is not a
// wrong password, and a generic "Authentication failed" sends the visitor to
// reset one. Every sign-in entry point must surface the server's sentence
// (our own copy when there is none) under one errorCode.
const UNAVAILABLE_DETAIL =
  "Sign-in is temporarily unavailable. Please try again in a minute.";

function unavailableFetch(calls, body = { detail: UNAVAILABLE_DETAIL }) {
  return async (url) => {
    const target = String(url);
    calls.push(target);
    if (target.includes("/api/start/") || target.includes("/api/auth/login/")) {
      return new Response(
        typeof body === "string" ? body : JSON.stringify(body),
        {
          status: 503,
          headers: {
            "content-type":
              typeof body === "string" ? "text/html" : "application/json",
            "retry-after": "30",
          },
        },
      );
    }
    return new Response("{}", { status: 404 });
  };
}

test("combined sign-in: a 503 from /api/start/ surfaces its detail and does not fall through to login", async () => {
  const { authStore, read } = await freshStore();
  const { AUTH_UNAVAILABLE_CODE } = await server.ssrLoadModule(AUTH_MODULE);
  const calls = [];
  globalThis.fetch = unavailableFetch(calls);

  const result = await authStore.login("resolver", "hunter2", "captcha");

  assert.equal(result.success, false);
  assert.equal(result.errorCode, AUTH_UNAVAILABLE_CODE);
  assert.equal(result.error, UNAVAILABLE_DETAIL);
  assert.ok(
    !calls.some((url) => url.includes("/api/auth/login/")),
    `a 503 is not "the user exists"; login must not be tried: ${calls}`,
  );
  assert.equal(read().loading, false);
});

test("combined sign-in: a 503 from the login leg surfaces its detail too", async () => {
  const { authStore } = await freshStore();
  const { AUTH_UNAVAILABLE_CODE } = await server.ssrLoadModule(AUTH_MODULE);
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes("/api/start/")) {
      return new Response(
        JSON.stringify({
          username: ["A user with that username already exists!"],
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    return unavailableFetch([])(url);
  };

  const result = await authStore.login("resolver", "hunter2", "captcha");

  assert.equal(result.errorCode, AUTH_UNAVAILABLE_CODE);
  assert.equal(result.error, UNAVAILABLE_DETAIL);
});

test("loginOnly and signup surface a 503's detail", async () => {
  const { AUTH_UNAVAILABLE_CODE } = await server.ssrLoadModule(AUTH_MODULE);
  for (const call of [
    (store) => store.loginOnly("resolver", "hunter2", "captcha"),
    (store) => store.signup("resolver", "hunter2", "captcha"),
  ]) {
    const { authStore } = await freshStore();
    globalThis.fetch = unavailableFetch([]);
    const result = await call(authStore);
    assert.equal(result.success, false);
    assert.equal(result.errorCode, AUTH_UNAVAILABLE_CODE);
    assert.equal(result.error, UNAVAILABLE_DETAIL);
  }
});

test("a 503 with no usable body still says sign-in is unavailable, not 'failed'", async () => {
  const { authStore } = await freshStore();
  const { AUTH_UNAVAILABLE_CODE } = await server.ssrLoadModule(AUTH_MODULE);
  globalThis.fetch = unavailableFetch([], "<html><body>503</body></html>");

  const result = await authStore.login("resolver", "hunter2", "captcha");

  assert.equal(result.errorCode, AUTH_UNAVAILABLE_CODE);
  assert.match(result.error, /temporarily unavailable/);
});

test("a newer account snapshot fences older successful checks without adopting their stale balance", async () => {
  const { authStore, read } = await freshStore();
  authStore.hydrateFromSession({ ...CREATOR, tuzis: "75" });
  let release;
  globalThis.fetch = async () => new Promise((resolve) => (release = resolve));
  const old = authStore.checkAuth({ fresh: true, silent: true });
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  authStore.fenceAccountSnapshot(CREATOR.username);
  release(
    new Response(JSON.stringify({ ...CREATOR, tuzis: "100" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  assert.equal(await old, false);
  assert.equal(read().creator.tuzis, "75");
  let releaseOther;
  globalThis.fetch = async () =>
    new Promise((resolve) => (releaseOther = resolve));
  const relevant = authStore.checkAuth({ fresh: true, silent: true });
  while (!releaseOther) await new Promise((resolve) => setImmediate(resolve));
  authStore.fenceAccountSnapshot("other-account");
  releaseOther(
    new Response(JSON.stringify({ ...CREATOR, tuzis: "125" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  assert.equal(await relevant, true);
  assert.equal(read().creator.tuzis, "125");
});

test("balance-only fences preserve authoritative account switches and signed-out outcomes", async () => {
  const { authStore, read } = await freshStore();
  authStore.hydrateFromSession(CREATOR);
  let release;
  globalThis.fetch = async () => new Promise((resolve) => (release = resolve));
  const changing = authStore.checkAuth({ force: true, silent: true });
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  authStore.fenceAccountSnapshot(CREATOR.username);
  release(
    new Response(
      JSON.stringify({
        ...CREATOR,
        id: CREATOR.id + 1,
        username: "other-account",
        tuzis: "25",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
  assert.equal(await changing, true);
  assert.equal(read().creator.username, "other-account");
  let releaseFailure;
  globalThis.fetch = async () =>
    new Promise((resolve) => (releaseFailure = resolve));
  const expiring = authStore.checkAuth({ force: true, silent: true });
  while (!releaseFailure) await new Promise((resolve) => setImmediate(resolve));
  authStore.fenceAccountSnapshot("other-account");
  releaseFailure(new Response("{}", { status: 401 }));
  assert.equal(await expiring, false);
  assert.equal(read().status, "anonymous");
});

test("replacement checks retire older account and signed-out outcomes after a balance fence", async () => {
  for (const status of [200, 401]) {
    const { authStore, read } = await freshStore();
    authStore.hydrateFromSession(CREATOR);
    const releases = [];
    globalThis.fetch = async () =>
      new Promise((resolve) => releases.push(resolve));
    const older = authStore.checkAuth({ force: true, silent: true });
    while (releases.length < 1)
      await new Promise((resolve) => setImmediate(resolve));
    authStore.fenceAccountSnapshot(CREATOR.username);
    const replacement = authStore.checkAuth({ force: true, silent: true });
    while (releases.length < 2)
      await new Promise((resolve) => setImmediate(resolve));
    releases[1](
      new Response(
        JSON.stringify({
          ...CREATOR,
          id: CREATOR.id + 1,
          username: "new-account",
          tuzis: "25",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    assert.equal(await replacement, true);
    releases[0](
      new Response(JSON.stringify(CREATOR), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
    await older;
    assert.equal(read().creator.username, "new-account");
    assert.equal(read().status, "authenticated");
  }
});

test("DB route observations keep newer pending reads and cannot mutate account metadata", async () => {
  const { authStore, read } = await freshStore();
  const older = "8123:2",
    route = "8123:1",
    newer = "8123:0";
  authStore.hydrateFromSession({
    ...CREATOR,
    tuzis: "10",
    balance_snapshot: older,
    description: "keep",
  });
  let release;
  globalThis.fetch = async () => new Promise((resolve) => (release = resolve));
  const pending = authStore.checkAuth({ force: true, silent: true });
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  authStore.observeAccountBalanceSnapshot({
    ...CREATOR,
    tuzis: "15",
    balance_snapshot: route,
    description: "stale",
  });
  assert.equal(read().creator.tuzis, "15");
  assert.equal(read().creator.description, "keep");
  release(
    new Response(
      JSON.stringify({ ...CREATOR, tuzis: "25", balance_snapshot: newer }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
  await pending;
  assert.equal(read().creator.tuzis, "25");
  authStore.observeAccountBalanceSnapshot({
    ...CREATOR,
    tuzis: "5",
    balance_snapshot: route,
  });
  assert.equal(read().creator.tuzis, "25");
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ ...CREATOR, tuzis: "5", balance_snapshot: route }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  assert.equal(await authStore.checkAuth({ fresh: true, silent: true }), false);
  assert.equal(read().creator.tuzis, "25");
});

test("valid DB metadata does not disable a later quote request-order fence", async () => {
  const { authStore, read } = await freshStore();
  authStore.hydrateFromSession({
    ...CREATOR,
    tuzis: "25",
    balance_snapshot: "8123:2",
  });
  let release;
  globalThis.fetch = async () => new Promise((resolve) => (release = resolve));
  const pending = authStore.checkAuth({ fresh: true, silent: true });
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  authStore.fenceAccountSnapshot(CREATOR.username);
  release(
    new Response(
      JSON.stringify({
        ...CREATOR,
        tuzis: "100",
        balance_snapshot: "8123:1",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
  assert.equal(await pending, false);
  assert.equal(read().creator.tuzis, "25");
});

test("a cache-window check does not retire an in-flight session check unless it replaces it", async () => {
  const { authStore, read } = await freshStore();
  authStore.hydrateFromSession(CREATOR);
  globalThis.fetch = async () =>
    new Response(JSON.stringify(CREATOR), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  await authStore.checkAuth({ force: true, silent: true });
  let release;
  globalThis.fetch = async () => new Promise((resolve) => (release = resolve));
  const pending = authStore.checkAuth({ force: true, silent: true });
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  authStore.fenceAccountSnapshot(CREATOR.username);
  assert.equal(await authStore.checkAuth({ silent: true }), true);
  release(new Response("{}", { status: 401 }));
  assert.equal(await pending, false);
  assert.equal(read().status, "anonymous");
});

for (const startsAuthenticated of [false, true]) {
  test(`credential exchange invalidates request ownership before lookup even from ${startsAuthenticated ? "the same authenticated identity" : "unknown"}`, async () => {
    const { authStore, read } = await freshStore();
    if (startsAuthenticated) authStore.hydrateFromSession(CREATOR);
    const oldOwner = authStore.captureRequestOwnership();
    let releaseIdentity;
    globalThis.fetch = async (url) =>
      String(url).includes("/api/auth/login/")
        ? new Response("{}", { status: 200 })
        : new Promise((resolve) => {
            releaseIdentity = resolve;
          });
    const login = authStore.loginOnly(CREATOR.username, "password");
    while (!releaseIdentity)
      await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      oldOwner(),
      false,
      "new cookies invalidate requests while identity remains unresolved",
    );
    const lookupOwner = authStore.captureRequestOwnership();
    releaseIdentity(new Response(JSON.stringify(CREATOR), { status: 200 }));
    assert.equal((await login).success, true);
    assert.equal(
      lookupOwner(),
      false,
      "adopting a new credential session invalidates lookup-era requests",
    );
    assert.equal(read().creator.username, CREATOR.username);
    const balanceOwner = authStore.captureRequestOwnership();
    authStore.hydrateFromSession({ ...CREATOR, tuzis: "999" });
    assert.equal(
      balanceOwner(),
      true,
      "ordinary live balance refresh retains ownership",
    );
  });
}

for (const status of [401, 403]) {
  test(`owned ${status} expiry permits generic cohort feedback only until its anonymous epoch changes`, async () => {
    const { authStore, read } = await freshStore();
    authStore.hydrateFromSession(CREATOR);
    const first = authStore.captureRequestOwnership();
    const second = authStore.captureRequestOwnership();
    globalThis.fetch = async () => new Response("{}", { status });
    assert.equal(
      await authStore.checkAuth({ force: true, fresh: true, silent: true }),
      false,
    );
    assert.equal(read().status, "anonymous");
    assert.equal(first(), false);
    assert.equal(first.wasExpired(), true);
    assert.equal(
      second.wasExpired(),
      true,
      "captures share a session cohort, not unique operation identity",
    );
    assert.equal(authStore.handleAuthFailure(status), true);
    assert.equal(
      first.wasExpired(),
      true,
      "a duplicate auth failure in the same anonymous epoch cannot erase the expired owner's evidence",
    );
    assert.equal(authStore.captureRequestOwnership().wasExpired(), false);
    authStore.clear();
    assert.equal(
      first.wasExpired(),
      false,
      "intentional logout retires expiry guidance even while already anonymous",
    );
    authStore.hydrateFromSession(CREATOR);
    assert.equal(
      second.wasExpired(),
      false,
      "returning to the same identity cannot revive the old expiry cohort",
    );
  });
}

for (const status of [401, 403]) {
  test(`anonymous ${status} rejection fences delayed identity without erasing same-owner expiry feedback`, async () => {
    const { authStore, read } = await freshStore();
    authStore.hydrateFromSession(CREATOR);
    const paidOperation = authStore.captureRequestOwnership();

    globalThis.fetch = async () => new Response("{}", { status: 401 });
    assert.equal(
      await authStore.checkAuth({ force: true, fresh: true, silent: true }),
      false,
    );
    assert.equal(read().status, "anonymous");
    assert.equal(paidOperation.wasExpired(), true);

    let releaseIdentity;
    globalThis.fetch = () =>
      new Promise((resolve) => {
        releaseIdentity = resolve;
      });
    const delayedIdentity = authStore.checkAuth({ force: true, silent: true });
    assert.equal(typeof releaseIdentity, "function");

    assert.equal(authStore.handleAuthFailure(status), true);
    releaseIdentity(new Response(JSON.stringify(CREATOR), { status: 200 }));
    assert.equal(await delayedIdentity, false);
    assert.equal(read().status, "anonymous");
    assert.equal(read().creator, null);
    assert.equal(
      paidOperation.wasExpired(),
      true,
      "the same expired account can still receive generic guidance",
    );

    authStore.clear();
    assert.equal(
      paidOperation.wasExpired(),
      false,
      "an explicit clear retires the old expiry attribution",
    );
  });
}

test("a superseded owned preflight waits for authoritative expiry without authorizing a write", async () => {
  const { authStore, read } = await freshStore();
  authStore.hydrateFromSession(CREATOR);
  const owner = authStore.captureRequestOwnership();
  const releases = [];
  globalThis.fetch = () => new Promise((resolve) => releases.push(resolve));
  let completed = false;
  const preflight = authStore
    .checkAuth({ fresh: true, silent: true })
    .then((value) => {
      completed = true;
      return value;
    });
  const replacement = authStore.checkAuth({ fresh: true, silent: true });
  releases[0](new Response("{}", { status: 401 }));
  await sleep(10);
  const completedBeforeReplacement = completed;
  releases[1](new Response("{}", { status: 401 }));
  assert.equal(await replacement, false);
  assert.equal(await preflight, false);
  assert.equal(
    completedBeforeReplacement,
    false,
    "the retired response must wait for the owned replacement",
  );
  assert.equal(read().status, "anonymous");
  assert.equal(owner.wasExpired(), true);
});

for (const outcome of [
  "success",
  "logout",
  "other-account",
  "return-original",
]) {
  test(`a superseded owned preflight cannot authorize or claim expiry after ${outcome}`, async () => {
    const { authStore, read } = await freshStore();
    authStore.hydrateFromSession(CREATOR);
    const owner = authStore.captureRequestOwnership();
    const releases = [];
    globalThis.fetch = () => new Promise((resolve) => releases.push(resolve));
    const preflight = authStore.checkAuth({ fresh: true, silent: true });
    const replacement = authStore.checkAuth({ fresh: true, silent: true });
    releases[0](new Response("{}", { status: 401 }));
    await sleep(10);
    if (outcome !== "success") {
      authStore.clear();
      if (outcome === "other-account" || outcome === "return-original")
        authStore.hydrateFromSession({ ...CREATOR, id: 2, username: "other" });
      if (outcome === "return-original") {
        authStore.clear();
        authStore.hydrateFromSession(CREATOR);
      }
    }
    releases[1](new Response(JSON.stringify(CREATOR), { status: 200 }));
    await replacement;
    assert.equal(await preflight, false);
    assert.equal(owner.wasExpired(), false);
    assert.equal(
      read().creator?.username ?? null,
      outcome === "logout"
        ? null
        : outcome === "other-account"
          ? "other"
          : CREATOR.username,
    );
  });
}

test("superseding auth chains retain the original deadline", async () => {
  const { authStore, timeoutMs } = await freshStore();
  authStore.hydrateFromSession(CREATOR);
  const releases = [];
  // Deliberately ignore abort, as an uncooperative transport would: joining a
  // newer check must have its own bound even when that fetch never settles.
  globalThis.fetch = () => new Promise((resolve) => releases.push(resolve));
  const started = Date.now();
  const preflight = authStore.ensureAuthenticated();
  await sleep(200);
  const middle = authStore.checkAuth({ fresh: true, silent: true });
  const latest = authStore.checkAuth({ fresh: true, silent: true });
  releases[0](new Response("{}", { status: 401 }));
  releases[1](new Response("{}", { status: 401 }));
  try {
    assert.equal(await preflight, false);
    assert.ok(Date.now() - started >= timeoutMs - 100);
    assert.ok(
      Date.now() - started < timeoutMs + 1000,
      "joining must not restart the deadline",
    );
  } finally {
    releases[2](new Response(JSON.stringify(CREATOR), { status: 200 }));
    await Promise.all([middle, latest]);
  }
});

test("native ensureAuthenticated waits for a newer owned auth check", async () => {
  const { authStore } = await freshStore();
  authStore.hydrateFromSession(CREATOR);
  const owner = authStore.captureRequestOwnership();
  const releases = [];
  globalThis.fetch = () => new Promise((resolve) => releases.push(resolve));
  let completed = false;
  const preflight = authStore.ensureAuthenticated().then((value) => {
    completed = true;
    return value;
  });
  assert.equal(
    releases.length,
    1,
    "the native ordinary check must reach the transport",
  );
  const replacement = authStore.checkAuth({ fresh: true, silent: true });
  releases[0](new Response("{}", { status: 401 }));
  await sleep(10);
  const completedBeforeReplacement = completed;
  releases[1](new Response("{}", { status: 401 }));
  await replacement;
  assert.equal(await preflight, false);
  assert.equal(completedBeforeReplacement, false);
  assert.equal(owner.wasExpired(), true);
});

for (const transition of ["logout", "other-account", "return-original"]) {
  test(`ownership ${transition} promptly releases a preflight joining a hung replacement`, async () => {
    const { authStore } = await freshStore();
    authStore.hydrateFromSession(CREATOR);
    const releases = [];
    globalThis.fetch = () => new Promise((resolve) => releases.push(resolve));
    const preflight = authStore.ensureAuthenticated();
    const replacement = authStore.checkAuth({ fresh: true, silent: true });
    releases[0](new Response("{}", { status: 401 }));
    await sleep(10);
    authStore.clear();
    if (transition !== "logout")
      authStore.hydrateFromSession({ ...CREATOR, id: 2, username: "other" });
    if (transition === "return-original") {
      authStore.clear();
      authStore.hydrateFromSession(CREATOR);
    }
    try {
      assert.equal(
        await Promise.race([preflight, sleep(100).then(() => "pending")]),
        false,
      );
    } finally {
      releases[1](new Response("{}", { status: 401 }));
      await Promise.all([preflight, replacement]);
    }
  });
}

for (const status of [200, 401, 503]) {
  test(`native preflight accepts only its current same-owner replacement's actual ${status} response`, async () => {
    const { authStore } = await freshStore();
    authStore.hydrateFromSession(CREATOR);
    const releases = [];
    globalThis.fetch = () => new Promise((resolve) => releases.push(resolve));
    const preflight = authStore.ensureAuthenticated();
    const replacement = authStore.checkAuth({
      force: true,
      fresh: true,
      silent: true,
    });
    releases[0](new Response(JSON.stringify(CREATOR), { status: 200 }));
    await sleep(10);
    releases[1](
      new Response(JSON.stringify(status === 200 ? CREATOR : {}), { status }),
    );
    await replacement;
    assert.equal(await preflight, status === 200);
  });
}

for (const status of [200, 401, 503]) {
  test(`native preflight uses only a current ${status} replacement completed before its stale response`, async () => {
    const { authStore } = await freshStore();
    authStore.hydrateFromSession(CREATOR);
    const releases = [];
    globalThis.fetch = () => new Promise((resolve) => releases.push(resolve));
    const preflight = authStore.ensureAuthenticated();
    const replacement = authStore.checkAuth({
      force: true,
      fresh: true,
      silent: true,
    });
    releases[1](
      new Response(JSON.stringify(status === 200 ? CREATOR : {}), { status }),
    );
    await replacement;
    releases[0](new Response(JSON.stringify(CREATOR), { status: 200 }));
    assert.equal(await preflight, status === 200);
  });
}

for (const balanceFence of ["database-snapshot", "request-order"]) {
  test(`native preflight accepts current authentication while preserving a newer ${balanceFence}`, async () => {
    const { authStore, read } = await freshStore();
    authStore.hydrateFromSession({
      ...CREATOR,
      tuzis: "75",
      balance_snapshot: "8123:2",
    });
    const releases = [];
    globalThis.fetch = () => new Promise((resolve) => releases.push(resolve));
    const preflight = authStore.ensureAuthenticated();
    const replacement = authStore.checkAuth({ fresh: true, silent: true });
    if (balanceFence === "request-order")
      authStore.fenceAccountSnapshot(CREATOR.username);
    releases[0](new Response(JSON.stringify(CREATOR), { status: 200 }));
    await sleep(10);
    releases[1](
      new Response(
        JSON.stringify({
          ...CREATOR,
          tuzis: "100",
          balance_snapshot:
            balanceFence === "database-snapshot" ? "8123:3" : "8123:2",
        }),
        { status: 200 },
      ),
    );
    assert.equal(
      await replacement,
      false,
      "strict freshness must not accept the older balance",
    );
    assert.equal(
      await preflight,
      true,
      "the same-owner200 still validates the ordinary guard",
    );
    assert.equal(read().creator.tuzis, "75");
    assert.equal(read().creator.balance_snapshot, "8123:2");
  });
}

for (const status of [401, 403]) {
  test(`an overlapping fresh ${status} check preserves owned expiry until it resolves`, async () => {
    const { authStore, read } = await freshStore();
    authStore.hydrateFromSession(CREATOR);
    const paidOperation = authStore.captureRequestOwnership();

    globalThis.fetch = async () => new Response("{}", { status: 401 });
    assert.equal(
      await authStore.checkAuth({ force: true, fresh: true, silent: true }),
      false,
    );
    assert.equal(read().status, "anonymous");
    assert.equal(paidOperation.wasExpired(), true);

    let releaseCheck;
    globalThis.fetch = () =>
      new Promise((resolve) => {
        releaseCheck = resolve;
      });
    const overlappingCheck = authStore.checkAuth({
      force: true,
      fresh: true,
      silent: true,
    });
    assert.equal(typeof releaseCheck, "function");
    assert.equal(
      paidOperation.wasExpired(),
      true,
      "starting a fenced identity read is not an actor transition",
    );

    releaseCheck(new Response("{}", { status }));
    assert.equal(await overlappingCheck, false);
    assert.equal(read().status, "anonymous");
    assert.equal(
      paidOperation.wasExpired(),
      true,
      "a same-owner auth rejection cannot erase sign-in guidance",
    );

    authStore.clear();
    assert.equal(
      paidOperation.wasExpired(),
      false,
      "an explicit clear still retires the old expiry attribution",
    );
  });
}

for (const identity of [CREATOR, { ...CREATOR, id: 2, username: "other" }]) {
  test(`a successful overlapping identity check for ${identity.username} retires expired-owner guidance`, async () => {
    const { authStore, read } = await freshStore();
    authStore.hydrateFromSession(CREATOR);
    const paidOperation = authStore.captureRequestOwnership();

    globalThis.fetch = async () => new Response("{}", { status: 401 });
    assert.equal(
      await authStore.checkAuth({ force: true, fresh: true, silent: true }),
      false,
    );
    assert.equal(paidOperation.wasExpired(), true);

    let releaseCheck;
    globalThis.fetch = () =>
      new Promise((resolve) => {
        releaseCheck = resolve;
      });
    const overlappingCheck = authStore.checkAuth({
      force: true,
      fresh: true,
      silent: true,
    });
    assert.equal(paidOperation.wasExpired(), true);
    releaseCheck(
      new Response(JSON.stringify(identity), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    assert.equal(await overlappingCheck, true);
    assert.equal(read().creator.username, identity.username);
    assert.equal(
      paidOperation(),
      false,
      "new authentication cannot revive old ownership",
    );
    assert.equal(
      paidOperation.wasExpired(),
      false,
      "an authenticated actor cannot inherit the old expired cohort's guidance",
    );
  });
}
