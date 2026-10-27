// The SSR heap leak that  raised the ceiling for and did not stop.
//
// WHAT LEAKED
// -----------
// `+layout.svelte` builds one `QueryClient` per render — correct, and on the
// server that means per request. Every `createQuery()` under it builds a
// `Query` in that client's cache, and `Query extends Removable`, whose
// `scheduleGc()` arms `timeoutManager.setTimeout(() => this.optionalRemove(),
// gcTime)` as soon as the last observer goes away — i.e. the moment SSR
// finishes. A pending timer is a GC ROOT: the callback closes over the `Query`,
// which holds `options.queryFn`, which in a Svelte 5 SSR render closes back
// over the component's `$$store_subs` and the rest of its render context.
//
// So a finished page stays reachable for the whole `gcTime`. A heap snapshot of
// the adapter-node build under synthetic load names the path exactly:
//
//   synthetic root -> global.setTimeout -> [context].timerListMap
//     -> TimersList[300000] -> Timeout._onTimeout -> closure
//     -> Query.options.queryFn ->....$$store_subs -> QueryObserver
//
// `TimersList[300000]` is LiveIndicator's `gcTime: 5 * 60 * 1000`, and
// LiveIndicator renders once per card — ~20 on the homepage. Measured against
// the built server: ~290KB retained per `/` render, +26MB per 30s at 3 req/s,
// levelling at ~340MB — with a 320MB old-space cap.
//
// Note the retention is BOUNDED by gcTime, not infinite: it is a steady-state
// floor proportional to the request rate (rate x gcTime x page size), and the
// local run plateaus at exactly the 5-minute mark. It is fatal anyway, because
// at any crawler-scale rate that floor is bigger than the heap.
//
// TanStack already intends server renders not to arm this: `updateGcTime()`
// falls back to `isServer ? Infinity: 5 * 60 * 1000` and `isValidTimeout()`
// rejects Infinity. The leak is what an explicit finite `gcTime` does to that,
// since `Math.max(this.gcTime || 0, newGcTime ??...)` can only raise it.
//
// WHY THIS FILE CANNOT PASS VACUOUSLY
// -----------------------------------
// Two fixtures render the REAL LiveIndicator through the REAL
// QueryClientProvider via `svelte/server`, against the real `$lib/query-client`.
// They differ by exactly the one line the fix adds to `+layout.svelte`, and both
// run in the same process in the same file:
//
//   Unreleased.svelte -> query still cached, gc timer still armed  (the bug)
//   Released.svelte   -> cache empty, timer count back to baseline (the fix)
//
// The first is the negative control and it asserts positively that the leak
// exists. Neuter `releaseSsrQueryClient` and the second half goes red; change
// LiveIndicator so it builds no query and the first half goes red rather than
// making the whole file trivially true.
//
// ONE TRAP, since it cost an hour: Svelte 5's `render()` returns LAZY `head` /
// `body` getters. Nothing is rendered until one is read, so a test that
// inspects the query cache without touching `body` inspects a cache the
// component never reached and sees a reassuring, meaningless zero. Every test
// below reads `body` first, on purpose.
//
// WHAT THIS DOES NOT PROVE
// ------------------------
// That the leak is gone in production. It proves the mechanism, the teardown,
// and that Svelte runs the teardown at the end of a server render. End-to-end
// evidence is a heap measurement against the built adapter-node server, which
// does not fit in `node --test`.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { createServer } from "vite";

const LAYOUT = new URL("../src/routes/+layout.svelte", import.meta.url);
const LIVE_INDICATOR = new URL(
  "../src/lib/components/stream/LiveIndicator.svelte",
  import.meta.url,
);

// LiveIndicator's own option, and the TimersList bucket in the snapshot.
const LIVE_INDICATOR_GC_TIME_MS = 5 * 60 * 1000;

let server;
let render;
let createAppQueryClient;
let releaseSsrQueryClient;
let Unreleased;
let Released;

/** Pending `setTimeout`s owned by this process — i.e. live GC roots. */
function pendingTimers() {
  return process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
}

before(async () => {
  server = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  ({ render } = await server.ssrLoadModule("svelte/server"));
  ({ createAppQueryClient, releaseSsrQueryClient } = await server.ssrLoadModule(
    "/src/lib/query-client.ts",
  ));
  Unreleased = (
    await server.ssrLoadModule(
      "/tests/fixtures/ssr-query-teardown/Unreleased.svelte",
    )
  ).default;
  Released = (
    await server.ssrLoadModule(
      "/tests/fixtures/ssr-query-teardown/Released.svelte",
    )
  ).default;
});

after(async () => {
  await server?.close();
});

test("NEGATIVE CONTROL: an unreleased SSR render leaves a cached query and an armed gc timer", () => {
  const client = createAppQueryClient();
  const baseline = pendingTimers();

  // Reading `body` is what forces the render — see the trap in the header.
  const { body } = render(Unreleased, {
    props: { client, username: "leak-control" },
  });

  // The render happened and actually used the query. Without this the rest of
  // the file could pass against a fixture that renders nothing.
  assert.ok(
    typeof body === "string" && body.length > 0,
    "the fixture should have produced markup",
  );

  const queries = client.getQueryCache().getAll();
  assert.equal(queries.length, 1, "the render should have built one query");
  assert.equal(
    queries[0].gcTime,
    LIVE_INDICATOR_GC_TIME_MS,
    "a finite gcTime is what makes scheduleGc() arm a real timer",
  );
  assert.ok(
    pendingTimers() > baseline,
    "the finished render left a pending timer rooting its component graph",
  );

  // Don't leave the control's own timer armed for the rest of the suite.
  releaseSsrQueryClient(client);
  assert.equal(pendingTimers(), baseline);
});

test("a released SSR render leaves nothing behind", () => {
  const client = createAppQueryClient();
  const baseline = pendingTimers();

  const { body } = render(Released, {
    props: { client, username: "leak-fixed" },
  });

  assert.ok(
    typeof body === "string" && body.length > 0,
    "the fixed fixture must render the same component",
  );

  // Nothing is released by hand here. The teardown has to have been run by
  // Svelte's own end-of-SSR onDestroy pass, which is the whole claim.
  assert.deepEqual(
    client.getQueryCache().getAll(),
    [],
    "the request's query cache should be empty once the render ends",
  );
  assert.equal(
    pendingTimers(),
    baseline,
    "the render should leave no pending timer rooting its component graph",
  );
});

test("releaseSsrQueryClient clears the gc timeouts, not just the map", () => {
  const client = createAppQueryClient();
  const baseline = pendingTimers();
  // eslint-disable-next-line no-unused-expressions -- forces the lazy render
  render(Unreleased, { props: { client, username: "explicit-release" } }).body;

  const armed = pendingTimers();
  assert.equal(client.getQueryCache().getAll().length, 1);
  assert.ok(armed > baseline);

  releaseSsrQueryClient(client);

  assert.deepEqual(client.getQueryCache().getAll(), []);
  assert.equal(
    pendingTimers(),
    baseline,
    "clearing the client must destroy the queries, which clears their timers",
  );
});

test("LiveIndicator is still the component that arms a finite gc timer", async () => {
  const source = await readFile(LIVE_INDICATOR, "utf8");

  // Pins the number the assertions above read out of the live query, and the
  // one that appears as `TimersList[300000]` in the heap snapshot.
  // Formatting-agnostic so a prettier pass cannot turn it red.
  assert.match(
    source,
    /gcTime:\s*5\s*\*\s*60\s*\*\s*1000/,
    "LiveIndicator should still pass an explicit finite gcTime",
  );
});

test("the root layout wires the teardown to the client it provides", async () => {
  const raw = await readFile(LAYOUT, "utf8");

  // Strip `//` line comments before matching. Without this the assertions below
  // pass against a commented-out call — verified: commenting the registration
  // out left this test green, which is precisely the "passes without testing"
  // failure mode. `<!-- -->` blocks are left alone; nothing here matches inside
  // one, and stripping them would eat markup this test also checks.
  const source = raw.replace(/^[ \t]*\/\/.*$/gm, "");

  assert.match(
    source,
    /import\s*\{[^}]*registerSsrQueryClientRelease[^}]*\}\s*from\s*['"]\$lib\/query-client['"]/,
    "+layout.svelte should import the SSR teardown helper",
  );
  assert.match(
    source,
    /registerSsrQueryClientRelease\(\s*queryClient\s*\)/,
    "+layout.svelte should register the teardown for the client it creates",
  );
  assert.match(
    source,
    /<QueryClientProvider\s+client=\{queryClient\}/,
    "the registered client must be the one handed to QueryClientProvider",
  );
  assert.doesNotMatch(
    source,
    /new\s+QueryClient\s*\(/,
    "the client must come from createAppQueryClient so the teardown is not bypassed",
  );
});

test("a fetch completing after SSR teardown cannot rearm a GC timer", async () => {
  const client = createAppQueryClient();
  const baseline = pendingTimers();
  let finish;
  const pending = client
    .fetchQuery({
      queryKey: ["late-ssr-completion"],
      queryFn: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    })
    .catch(() => undefined);
  await Promise.resolve();
  assert.equal(typeof finish, "function", "the asynchronous query must start");
  assert.equal(client.getQueryCache().getAll().length, 1);
  releaseSsrQueryClient(client);
  finish("completed after teardown");
  await pending;
  await Promise.resolve();
  assert.deepEqual(client.getQueryCache().getAll(), []);
  assert.equal(
    pendingTimers(),
    baseline,
    "late completion must not retain the render",
  );
});
