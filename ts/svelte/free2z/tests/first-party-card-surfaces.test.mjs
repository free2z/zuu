import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";

/**
 *  first-party `::embed[]` cards on every surface that renders
 * markdown: comments, converse, bios and the author previews. ONE resolver
 * (`$lib/utils/first-party-embed-resolve.ts`) with a server half (SSR'd
 * bodies) and a browser half (`$lib/first-party-card-resolver.ts`). The
 * properties and the tests that pin them:
 *
 *   page-level budget across bodies....... "a page's bodies share ONE budget…"
 *   cross-body dedupe..................... "fifty comments embedding the same…"
 *   per-body cap still applies............ "one body still gets at most…"
 *   seeded calls count, never repeat...... "the server seed counts against…"
 *   request can't be steered off the API.. "only the two card API paths…"
 *   pruned answers give the same card..... "a kept answer is pruned…"
 *   viewer's credentials (browser)........ "the browser asks as the viewer…"
 *   no redirect / non-200................. "a redirect or any non-200…"
 *   new page view / identity forgets...... "a reset drops…", "a change of identity…"
 *   editor debounce + session cache....... "the preview waits…", "the preview caches…"
 *   bounded concurrency + timeout......... "at most four calls in flight…"
 *   SSR loaders forward only the reader... "converse detail…", "converse feed…",
 *                                           "profile bio…"
 *
 * The API itself (what a 200 means per reader) is pinned against the real
 * database in py/free2z/dj/apps/g12f/test_first_party_embed_card_contract.py.
 */

let server;
let resolve;
let cards;
let client;
let converseDetailLoad;
let converseFeedLoad;
let profileLoad;
const previousApiBase = process.env.PRIVATE_API_BASE_URL;
const API = "https://api.free2z.test";
const HOST = "free2z.cash";

before(async () => {
  process.env.PRIVATE_API_BASE_URL = API;
  server = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { hmr: false, middlewareMode: true },
  });
  resolve = await server.ssrLoadModule(
    "/src/lib/utils/first-party-embed-resolve.ts",
  );
  cards = await server.ssrLoadModule(
    "/src/lib/utils/first-party-embed-cards.ts",
  );
  client = await server.ssrLoadModule("/src/lib/first-party-card-resolver.ts");
  ({ load: converseDetailLoad } = await server.ssrLoadModule(
    "/src/routes/converse/[uuid]/+page.server.ts",
  ));
  ({ load: converseFeedLoad } = await server.ssrLoadModule(
    "/src/routes/converse/+page.server.ts",
  ));
  ({ load: profileLoad } = await server.ssrLoadModule(
    "/src/routes/[username]/+page.server.ts",
  ));
});

after(async () => {
  await server?.close();
  if (previousApiBase === undefined) delete process.env.PRIVATE_API_BASE_URL;
  else process.env.PRIVATE_API_BASE_URL = previousApiBase;
});

const UUID_A = "0b7a3c1e-1111-4222-8333-944455556666";
const UUID_B = "1c8b4d2f-2222-4333-8444-a55566667777";
const embed = (path) => `::embed[https://${HOST}${path}]`;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function zpageBody(vanity, overrides = {}) {
  return {
    free2zaddr: `${vanity}-addr`,
    vanity,
    title: `Title of ${vanity}`,
    description: "",
    content: `Body of ${vanity}.`,
    creator: { username: "alice" },
    ...overrides,
  };
}

/**
 * The backend at the HTTP boundary. `/api/zpage/<v>/` answers a page by
 * `alice` for every vanity unless `routes` says otherwise; every call is
 * recorded with the init it carried.
 */
function fakeApi(routes = {}, { delay = 0 } = {}) {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input), "https://viewer.free2z.test");
    const headers = new Headers(init.headers || {});
    calls.push({
      url: String(input),
      path: url.pathname,
      search: url.search,
      cookie: headers.get("cookie"),
      init,
    });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (delay) await sleep(delay);
      const route = routes[url.pathname];
      if (typeof route === "function") return await route({ url, init });
      if (route !== undefined) return Response.json(route);
      const zpage = url.pathname.match(/^\/api\/zpage\/([^/]+)\/$/);
      if (zpage) return Response.json(zpageBody(zpage[1]));
      return new Response("{}", { status: 404 });
    } finally {
      inFlight -= 1;
    }
  };
  return {
    fetch,
    calls,
    get maxInFlight() {
      return maxInFlight;
    },
  };
}

async function settled(resolver, predicate, timeoutMs = 3000) {
  const started = Date.now();
  for (;;) {
    let value;
    resolver.subscribe((state) => (value = state))();
    if (predicate(value)) return value;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`resolver never settled: ${JSON.stringify(value)}`);
    }
    await sleep(5);
  }
}

function current(resolver) {
  let value;
  resolver.subscribe((state) => (value = state))();
  return value;
}

function pageResolver(api, overrides = {}) {
  return client.createFirstPartyCardResolver({
    enabled: true,
    host: HOST,
    locale: () => "en",
    apiBase: "",
    fetch: api.fetch,
    ...overrides,
  });
}

// --- The shared ledger --------------------------------------------------------

test("a page's bodies share ONE budget: many comments with distinct embeds open at most MAX_PAGE_FIRST_PARTY_CARD_CALLS calls", () => {
  const ledger = resolve.createFirstPartyCardLedger({
    host: HOST,
    maxCalls: resolve.MAX_PAGE_FIRST_PARTY_CARD_CALLS,
  });
  const opened = [];
  // 50 comments × 4 distinct embeds each = 200 embeds, 200 distinct pages.
  for (let comment = 0; comment < 50; comment += 1) {
    const body = Array.from({ length: 4 }, (_, i) =>
      embed(`/alice/c${comment}-e${i}`),
    ).join("\n\n");
    opened.push(...ledger.plan(body, "en").calls);
  }
  assert.equal(resolve.MAX_PAGE_FIRST_PARTY_CARD_CALLS, 16);
  assert.equal(opened.length, 16);
  assert.equal(ledger.calls().length, 16);
});

test("fifty comments embedding the same pages are ONE call per page, fanned out to every spelling", () => {
  const ledger = resolve.createFirstPartyCardLedger({
    host: HOST,
    maxCalls: 16,
  });
  const opened = [];
  for (let comment = 0; comment < 50; comment += 1) {
    const spelling = comment % 2 ? "/ALICE/post" : "/alice/post";
    const body = [embed(spelling), embed(`/converse/${UUID_A}`)].join("\n\n");
    opened.push(...ledger.plan(`${body}\n\ncomment ${comment}`, "en").calls);
  }
  assert.deepEqual(
    opened.map((call) => call.apiPath),
    ["/api/zpage/post/", `/api/comments/${UUID_A}/`],
  );
  const zpageCall = opened[0];
  const settledCards = ledger.settle(zpageCall.key, zpageBody("post"));
  // Usernames fold case: both spellings are ONE key of the one answer.
  assert.deepEqual(Object.keys(settledCards), [`zpage:${HOST}/alice/post`]);
  assert.equal(Object.values(settledCards)[0].title, "Title of post");
  // A body planned AFTER the answer, spelling the same call another way
  // (a different key), gets its card at once, with no call.
  const later = ledger.plan(embed("/article/post"), "en");
  assert.deepEqual(later.calls, []);
  assert.equal(Object.values(later.cards)[0]?.title, "Title of post");
  // The answer is consumed once: a second settle is a no-op.
  assert.deepEqual(ledger.settle(zpageCall.key, zpageBody("post")), {});
});

test("one body still gets at most MAX_FIRST_PARTY_CARDS calls, even with page budget left", () => {
  const ledger = resolve.createFirstPartyCardLedger({
    host: HOST,
    maxCalls: 16,
  });
  const body = Array.from({ length: 7 }, (_, i) => embed(`/alice/p${i}`)).join(
    "\n\n",
  );
  assert.equal(
    ledger.plan(body, "en").calls.length,
    cards.MAX_FIRST_PARTY_CARDS,
  );
});

test("the server seed counts against the page budget and its calls are never repeated", () => {
  const seedLedger = resolve.createFirstPartyCardLedger({
    host: HOST,
    maxCalls: 4,
  });
  const seeded = seedLedger
    .plan(
      [embed("/alice/a"), embed("/alice/b"), embed("/alice/c")].join("\n\n"),
      "en",
    )
    .calls.map((call) => call.key);
  const ledger = resolve.createFirstPartyCardLedger({
    host: HOST,
    maxCalls: 5,
    seed: { cards: {}, calls: seeded },
  });
  const opened = ledger.plan(
    [
      embed("/alice/a"),
      embed("/alice/d"),
      embed("/alice/e"),
      embed("/alice/f"),
    ].join("\n\n"),
    "en",
  ).calls;
  // a was the server's; d fits (4th of 5 with the seed's 3); e fits (5th); f
  // is over the page budget.
  assert.deepEqual(
    opened.map((call) => call.apiPath),
    ["/api/zpage/d/", "/api/zpage/e/"],
  );
  // Settling a seeded call does nothing: the server already answered it.
  assert.deepEqual(ledger.settle(seeded[0], zpageBody("a")), {});
});

test("only the two card API paths can ever be requested: hostile calls and embeds build nothing", () => {
  const good = [
    [
      { apiPath: "/api/zpage/post/", language: "en" },
      "/api/zpage/post/?lang=en",
    ],
    [
      { apiPath: "/api/zpage/post/", language: "zh-Hans" },
      "/api/zpage/post/?lang=zh-Hans",
    ],
    [{ apiPath: "/api/zpage/post/", language: null }, "/api/zpage/post/"],
    [
      { apiPath: `/api/comments/${UUID_A}/`, language: null },
      `/api/comments/${UUID_A}/`,
    ],
  ];
  for (const [call, expected] of good) {
    assert.equal(resolve.firstPartyCardRequestPath(call), expected);
  }
  for (const apiPath of [
    "/api/zpage/../logout/",
    "/api/zpage/./",
    "/api/zpage/a/b/",
    "/api/zpage/a%2Fb/",
    "/api/zpage/a/?next=//evil.example",
    "/api/zpage/a",
    "/api/auth/user/",
    "/api/comments/not-a-uuid/",
    `/api/comments/${UUID_A}/replies/`,
    "//evil.example/api/zpage/a/",
    "https://evil.example/api/zpage/a/",
    "/api/zpage/a/#x",
    "/api/zpage/.hidden/",
    "",
    null,
  ]) {
    assert.equal(
      resolve.firstPartyCardRequestPath({ apiPath, language: null }),
      null,
      String(apiPath),
    );
  }
  for (const language of ["en&x=1", "en/..", "../en", "en us", "e", "#"]) {
    assert.equal(
      resolve.firstPartyCardRequestPath({ apiPath: "/api/zpage/a/", language }),
      null,
      language,
    );
  }
  // Through the planner: lookalikes and other routes never open a call.
  const ledger = resolve.createFirstPartyCardLedger({
    host: HOST,
    maxCalls: 16,
  });
  const opened = ledger.plan(
    [
      embed("/converse/../logout"),
      embed("/alice/post/edit"),
      embed("/og/alice/post"),
      embed("/alice%2Fpost/x"),
      embed("/accounts/logout/?next=//evil.example"),
      "::embed[https://stage.free2z.cash/alice/post]",
      "::embed[https://evil.example/api/zpage/x/]",
    ].join("\n\n"),
    "en",
  ).calls;
  for (const call of opened) {
    assert.ok(resolve.isFirstPartyCardApiPath(call.apiPath), call.apiPath);
  }
  // `/accounts/logout` IS the zPage shape (identifier `logout`); it may be
  // looked up — by identifier, on the API — and the builder refuses a page
  // `accounts` does not own. Nothing else is.
  assert.deepEqual(
    opened.map((call) => call.apiPath),
    ["/api/zpage/logout/"],
  );
});

test("a kept answer is pruned to what the builders read, and gives the same card", () => {
  const long = "x".repeat(50_000);
  const bodies = [
    zpageBody("post"),
    zpageBody("post", { description: "A **described** page." }),
    zpageBody("post", { content: `Lead. ${long}` }),
    zpageBody("post", { description: `${" ".repeat(5000)}late text` }),
    zpageBody("post", {
      actual_language: "en",
      available_languages: ["en", "fr"],
    }),
    { show_modal: true, page: zpageBody("post", { content: "GATED" }) },
    zpageBody("post", { creator: { username: "mallory" } }),
  ];
  const zpage = {
    kind: "zpage",
    username: "alice",
    identifier: "post",
    href: `https://${HOST}/alice/post`,
  };
  for (const body of bodies) {
    assert.deepEqual(
      cards.zpageCardFromApi(
        zpage,
        resolve.pruneFirstPartyCardBody(body),
        "en",
      ),
      cards.zpageCardFromApi(zpage, body, "en"),
    );
  }
  const thread = {
    kind: "converse",
    uuid: UUID_A,
    href: `https://${HOST}/converse/${UUID_A}`,
  };
  for (const body of [
    {
      uuid: UUID_A,
      headline: "H",
      content: "Body",
      author: { username: "bob", email: "x@y" },
    },
    { uuid: UUID_A, headline: "", content: `Only ${long}`, author: null },
    { uuid: UUID_B, headline: "H", content: "wrong thread" },
  ]) {
    assert.deepEqual(
      cards.converseCardFromApi(thread, resolve.pruneFirstPartyCardBody(body)),
      cards.converseCardFromApi(thread, body),
    );
  }
  // The upsell keeps presence only — never the redacted page.
  const upsell = resolve.pruneFirstPartyCardBody(bodies[5]);
  assert.equal(upsell.page, true);
  assert.ok(!JSON.stringify(upsell).includes("GATED"));
  // Nothing but a username survives of a person.
  assert.deepEqual(
    resolve.pruneFirstPartyCardBody({
      author: { username: "bob", email: "x@y" },
    }).author,
    { username: "bob" },
  );
  assert.ok(
    JSON.stringify(resolve.pruneFirstPartyCardBody(bodies[2])).length < 5000,
  );
});

// --- The browser resolver -------------------------------------------------------

test("the browser asks as the viewer: same-origin credentials, no redirect, no HTTP cache, our API base, no forged cookie", async () => {
  const api = fakeApi();
  const resolver = pageResolver(api, { apiBase: "https://api.free2z.test/" });
  resolver.request(embed("/alice/post"));
  const state = await settled(
    resolver,
    (s) => Object.keys(s.cards).length === 1,
  );
  assert.equal(api.calls.length, 1);
  const [call] = api.calls;
  assert.equal(call.url, "https://api.free2z.test/api/zpage/post/?lang=en");
  // A configured API origin of our own gets the cookie like the app's API
  // client sends it; the production same-origin base is asserted below.
  assert.equal(call.init.credentials, "include");
  assert.equal(call.init.redirect, "manual");
  assert.equal(call.init.cache, "no-store");
  assert.equal(call.cookie, null);
  assert.equal(Object.values(state.cards)[0].title, "Title of post");
  resolver.destroy();

  const sameOrigin = fakeApi();
  const production = pageResolver(sameOrigin, { apiBase: "" });
  production.request(embed("/alice/post"));
  await settled(production, (s) => Object.keys(s.cards).length === 1);
  assert.equal(sameOrigin.calls[0].url, "/api/zpage/post/?lang=en");
  assert.equal(sameOrigin.calls[0].init.credentials, "same-origin");
  production.destroy();
});

test("a redirect or any non-200 is no card", async () => {
  const api = fakeApi({
    "/api/zpage/moved/": () =>
      new Response(null, { status: 302, headers: { location: "/logout" } }),
    "/api/zpage/opaque/": () => {
      // What `redirect: "manual"` yields in a browser.
      const response = new Response(null, { status: 200 });
      Object.defineProperty(response, "status", { value: 0 });
      return response;
    },
    "/api/zpage/gone/": () => new Response("{}", { status: 404 }),
    "/api/zpage/created/": () =>
      Response.json(zpageBody("created"), { status: 201 }),
    "/api/zpage/ok/": zpageBody("ok"),
  });
  const resolver = pageResolver(api);
  resolver.request(
    ["moved", "opaque", "gone", "created"]
      .map((v) => embed(`/alice/${v}`))
      .join("\n\n"),
  );
  resolver.request(embed("/alice/ok"));
  const state = await settled(resolver, (s) => Object.keys(s.cards).length > 0);
  await sleep(50);
  assert.equal(api.calls.length, 5);
  assert.deepEqual(
    Object.values(current(resolver).cards).map((card) => card.title),
    ["Title of ok"],
  );
  assert.ok(state);
  resolver.destroy();
});

test("the page resolver makes each call once and never more than the page budget, however many bodies ask", async () => {
  const api = fakeApi();
  const resolver = pageResolver(api);
  // 50 comments: each embeds the same two pages plus one of its own.
  for (let comment = 0; comment < 50; comment += 1) {
    resolver.request(
      [
        embed("/alice/shared-a"),
        embed("/alice/shared-b"),
        embed(`/alice/own-${comment}`),
      ].join("\n\n"),
    );
  }
  // Re-requesting from reactive statements costs nothing.
  for (let again = 0; again < 5; again += 1) {
    resolver.request(
      [
        embed("/alice/shared-a"),
        embed("/alice/shared-b"),
        embed("/alice/own-0"),
      ].join("\n\n"),
    );
  }
  await settled(resolver, (s) => Object.keys(s.cards).length === 16);
  await sleep(50);
  assert.equal(api.calls.length, 16);
  assert.equal(new Set(api.calls.map((call) => call.path)).size, 16);
  assert.equal(
    api.calls.filter((call) => call.path === "/api/zpage/shared-a/").length,
    1,
  );
  resolver.destroy();
});

test("the server seed renders at once, and its calls are neither repeated nor free", async () => {
  const api = fakeApi();
  const resolver = pageResolver(api, { maxCalls: 3 });
  const seededKey = `${HOST}/api/zpage/seeded/?lang=en`;
  const gatedKey = `${HOST}/api/zpage/gated/?lang=en`;
  const seededCard = cards.zpageCardFromApi(
    {
      kind: "zpage",
      username: "alice",
      identifier: "seeded",
      href: `https://${HOST}/alice/seeded`,
    },
    zpageBody("seeded"),
    "en",
  );
  const contentKey = `zpage:${HOST}/alice/seeded`;
  const seed = {
    cards: { [contentKey]: seededCard },
    calls: [seededKey, gatedKey],
  };
  resolver.seed(seed);
  // Synchronously there: this is what hydration renders.
  assert.deepEqual(current(resolver).cards, { [contentKey]: seededCard });
  resolver.request(
    [
      embed("/alice/seeded"),
      embed("/alice/gated"),
      embed("/alice/new"),
      embed("/alice/over"),
    ].join("\n\n"),
  );
  await settled(resolver, (s) => Object.keys(s.cards).length === 2);
  await sleep(50);
  // Only `new` was fetched: seeded + gated were the server's, `over` is past
  // the budget of 3.
  assert.deepEqual(
    api.calls.map((call) => call.path),
    ["/api/zpage/new/"],
  );
  // The same seed object again is not a new page view.
  resolver.seed(seed);
  assert.equal(Object.keys(current(resolver).cards).length, 2);
  resolver.destroy();
});

test("a reset drops every card and ignores answers from the page view it ended", async () => {
  let release;
  const gate = new Promise((done) => (release = done));
  const api = fakeApi({
    "/api/zpage/slow/": async () => {
      await gate;
      return Response.json(zpageBody("slow"));
    },
  });
  const resolver = pageResolver(api);
  resolver.request([embed("/alice/fast"), embed("/alice/slow")].join("\n\n"));
  await settled(resolver, (s) => Object.keys(s.cards).length === 1);
  const before = current(resolver).generation;
  resolver.reset();
  assert.deepEqual(current(resolver).cards, {});
  assert.equal(current(resolver).generation, before + 1);
  release();
  await sleep(50);
  assert.deepEqual(current(resolver).cards, {});
  // The new page view re-resolves what it is asked for, as a new call.
  resolver.request(embed("/alice/fast"));
  await settled(resolver, (s) => Object.keys(s.cards).length === 1);
  assert.equal(
    api.calls.filter((call) => call.path === "/api/zpage/fast/").length,
    2,
  );
  resolver.destroy();
});

test("a change of identity is a new page view; settling the first identity is not", async () => {
  const { writable } = await import("svelte/store");
  const identity = writable(null);
  const api = fakeApi();
  const resolver = pageResolver(api, { identity });
  resolver.request(embed("/alice/post"));
  await sleep(30);
  assert.equal(api.calls.length, 0); // nothing before the viewer is known
  identity.set("anonymous"); // the auth check answered: not a change
  await settled(resolver, (s) => Object.keys(s.cards).length === 1);
  identity.set("user:bob"); // signed in as someone: forget everything
  assert.deepEqual(current(resolver).cards, {});
  identity.set("user:bob");
  resolver.request(embed("/alice/post"));
  await settled(resolver, (s) => Object.keys(s.cards).length === 1);
  assert.equal(api.calls.length, 2);
  resolver.destroy();
});

test("the preview waits until typing stops and resolves only the latest text", async () => {
  const api = fakeApi();
  const resolver = client.createFirstPartyCardResolver({
    enabled: true,
    host: HOST,
    locale: () => "en",
    fetch: api.fetch,
    debounceMs: 80,
    maxCalls: client.MAX_PREVIEW_FIRST_PARTY_CARD_CALLS,
  });
  // An author typing the vanity one keystroke at a time.
  for (const partial of ["p", "po", "pos", "post"]) {
    resolver.request(embed(`/alice/${partial}`), "editor");
    await sleep(20);
  }
  assert.equal(api.calls.length, 0);
  await settled(resolver, (s) => Object.keys(s.cards).length === 1);
  assert.deepEqual(
    api.calls.map((call) => call.path),
    ["/api/zpage/post/"],
  );
  resolver.destroy();
});

test("the preview caches per API path + language for the session, and has its own budget", async () => {
  const api = fakeApi();
  const resolver = client.createFirstPartyCardResolver({
    enabled: true,
    host: HOST,
    locale: () => "en",
    fetch: api.fetch,
    debounceMs: 10,
    maxCalls: 3,
  });
  resolver.request(`${embed("/alice/post")}\n\nfirst draft`, "editor");
  await settled(resolver, (s) => Object.keys(s.cards).length === 1);
  // More typing elsewhere, the same embed, the preview toggled: no new call.
  resolver.request(`${embed("/alice/post")}\n\nsecond draft`, "editor");
  resolver.request(`intro\n\n${embed("/alice/post")}\n\nthird`, "editor");
  await sleep(60);
  assert.equal(api.calls.length, 1);
  // A different language is a different call.
  resolver.request(`${embed("/alice/post?lang=fr")}`, "editor");
  await sleep(60);
  assert.deepEqual(
    api.calls.map((call) => call.url),
    ["/api/zpage/post/?lang=en", "/api/zpage/post/?lang=fr"],
  );
  // The session budget: one more distinct call, then nothing.
  resolver.request(
    [embed("/alice/b"), embed("/alice/c")].join("\n\n"),
    "editor",
  );
  await sleep(60);
  assert.equal(api.calls.length, 3);
  assert.equal(client.FIRST_PARTY_PREVIEW_DEBOUNCE_MS, 600);
  assert.equal(client.MAX_PREVIEW_FIRST_PARTY_CARD_CALLS, 32);
  resolver.destroy();
});

test("at most four calls in flight, and a stalled call times out to the neutral card without holding the rest", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const turn = () => new Promise((resolve) => setImmediate(resolve));
  const until = async (predicate) => {
    for (let count = 0; count < 200 && !predicate(); count++) await turn();
    assert.ok(
      predicate(),
      "controlled resolver work must settle without advancing its deadline",
    );
  };
  const stalled = [];
  const api = fakeApi({
    "/api/zpage/stalled/": ({ init }) => {
      stalled.push(init.signal);
      return new Promise(() => {});
    },
  });
  const resolver = pageResolver(api, { timeoutMs: 100 });
  t.after(() => resolver.destroy());
  for (let i = 0; i < 3; i += 1)
    resolver.request(
      [0, 1, 2, 3].map((j) => embed(`/alice/p${i}-${j}`)).join("\n\n"),
    );
  resolver.request(embed("/alice/stalled"));
  t.mock.timers.tick(0);
  await until(
    () =>
      Object.keys(current(resolver).cards).length === 12 &&
      stalled.length === 1,
  );
  assert.ok(
    api.maxInFlight <= client.FIRST_PARTY_CARD_CLIENT_CONCURRENCY,
    String(api.maxInFlight),
  );
  assert.equal(client.FIRST_PARTY_CARD_CLIENT_CONCURRENCY, 4);
  t.mock.timers.tick(99);
  await turn();
  assert.equal(stalled[0].aborted, false);
  t.mock.timers.tick(1);
  await until(() => stalled[0].aborted);
  assert.equal(stalled[0].reason.name, "TimeoutError");
  assert.equal(Object.keys(current(resolver).cards).length, 12);
  assert.ok(
    !Object.keys(current(resolver).cards).some((key) =>
      key.includes("stalled"),
    ),
  );
  resolver.destroy();

  const nextCalls = [];
  const single = pageResolver(
    fakeApi({
      "/api/zpage/stalled/": ({ init }) => {
        nextCalls.push(init.signal);
        return new Promise(() => {});
      },
    }),
    { timeoutMs: 100, concurrency: 1 },
  );
  t.after(() => single.destroy());
  single.request(embed("/alice/stalled"));
  single.request(embed("/alice/after"));
  t.mock.timers.tick(0);
  await until(() => nextCalls.length === 1);
  t.mock.timers.tick(99);
  await turn();
  assert.equal(nextCalls[0].aborted, false);
  assert.equal(Object.keys(current(single).cards).length, 0);
  t.mock.timers.tick(1);
  await until(() => Object.keys(current(single).cards).length === 1);
  assert.equal(nextCalls[0].reason.name, "TimeoutError");
  assert.ok(
    Object.values(current(single).cards).some(
      (card) => card.vanity === "after",
    ),
  );
});

test("a disabled (server-side) resolver never fetches, and outside a provider nothing resolves", async () => {
  const api = fakeApi();
  const resolver = pageResolver(api, { enabled: false });
  resolver.request(embed("/alice/post"));
  await sleep(30);
  assert.equal(api.calls.length, 0);
  resolver.destroy();
});

// --- SSR loaders -----------------------------------------------------------------

function converseEvent({ cookie = null, uuid = UUID_A, fetch }) {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  const set = {};
  return {
    params: { uuid },
    request: new Request(`https://${HOST}/converse/${uuid}`, { headers }),
    url: new URL(`https://${HOST}/converse/${uuid}`),
    locals: { locale: "en" },
    fetch,
    setHeaders: (h) => Object.assign(set, h),
    headersSet: set,
  };
}

test("converse detail: the root post's cards are resolved as THIS reader and seeded, gated ones absent", async () => {
  const root = {
    uuid: UUID_A,
    parent: null,
    content: [
      embed("/alice/public"),
      embed("/alice/members"),
      embed(`/converse/${UUID_B}`),
    ].join("\n\n"),
  };
  for (const [cookie, expected] of [
    [null, ["Title of public"]],
    [
      "sessionid=subscriber",
      ["Title of public", "Title of members", "Hidden thread"],
    ],
  ]) {
    const api = fakeApi({
      [`/api/comments/${UUID_A}/`]: root,
      "/api/zpage/members/": ({ init }) =>
        new Headers(init.headers).get("cookie")
          ? Response.json(zpageBody("members"))
          : Response.json({ show_modal: true, page: zpageBody("members") }),
      [`/api/comments/${UUID_B}/`]: ({ init }) =>
        new Headers(init.headers).get("cookie")
          ? Response.json({
              uuid: UUID_B,
              headline: "Hidden thread",
              content: "x",
            })
          : new Response("{}", { status: 404 }),
    });
    const event = converseEvent({ cookie, fetch: api.fetch });
    const data = await converseDetailLoad(event);
    const titles = Object.values(data.firstPartyCardSeed.cards).map(
      (c) => c.title,
    );
    assert.deepEqual(titles.sort(), [...expected].sort(), String(cookie));
    assert.equal(data.firstPartyCardSeed.calls.length, 3);
    const cardCalls = api.calls.filter(
      (c) => c.path !== `/api/comments/${UUID_A}/`,
    );
    assert.equal(cardCalls.length, 3);
    for (const call of cardCalls) assert.equal(call.cookie, cookie);
    assert.equal(cardCalls[0].init.redirect, "manual");
    if (!cookie) {
      assert.ok(
        !JSON.stringify(data.firstPartyCardSeed).includes("Hidden thread"),
      );
    }
  }
});

test("converse feed: page one's twelve posts share ONE server budget and one deduped set of calls", async () => {
  const results = Array.from({ length: 12 }, (_, i) => ({
    uuid: `0b7a3c1e-1111-4222-8333-9444555566${String(i).padStart(2, "0")}`,
    content: [embed("/alice/shared"), embed(`/alice/own-${i}`)].join("\n\n"),
  }));
  const api = fakeApi({
    "/api/comments/": { results, next: null },
  });
  const event = {
    request: new Request(`https://${HOST}/converse`, {
      headers: { cookie: "sessionid=viewer" },
    }),
    url: new URL(`https://${HOST}/converse`),
    cookies: { get: (name) => (name === "sessionid" ? "viewer" : undefined) },
    locals: { locale: "en" },
    fetch: api.fetch,
    setHeaders: () => {},
  };
  const data = await converseFeedLoad(event);
  const cardCalls = api.calls.filter((c) => c.path.startsWith("/api/zpage/"));
  assert.equal(cardCalls.length, cards.MAX_FIRST_PARTY_CARDS);
  assert.equal(
    cardCalls.filter((c) => c.path === "/api/zpage/shared/").length,
    1,
  );
  for (const call of cardCalls) assert.equal(call.cookie, "sessionid=viewer");
  assert.equal(
    data.firstPartyCardSeed.calls.length,
    cards.MAX_FIRST_PARTY_CARDS,
  );
});

test("profile bio: cards resolved as the READER (their cookie), from the same body the page renders", async () => {
  const description = [
    "---",
    "twitter: alice",
    "---",
    "About me.",
    "",
    embed("/alice/public"),
  ].join("\n");
  const api = fakeApi({
    "/api/creator/alice/": { username: "alice", description },
    "/api/tagging/autocomplete": [],
    "/api/zpage/": { results: [], count: 0, next: null, previous: null },
  });
  for (const cookie of [null, "sessionid=reader; free2z-locale=en"]) {
    api.calls.length = 0;
    const headers = new Headers();
    if (cookie) headers.set("cookie", cookie);
    const data = await profileLoad({
      params: { username: "alice" },
      request: new Request(`https://${HOST}/alice`, { headers }),
      url: new URL(`https://${HOST}/alice`),
      cookies: { get: () => undefined },
      locals: { locale: "en" },
      fetch: api.fetch,
      setHeaders: () => {},
    });
    const cardCalls = api.calls.filter((c) => c.path === "/api/zpage/public/");
    assert.equal(cardCalls.length, 1);
    assert.equal(cardCalls[0].cookie, cookie);
    assert.deepEqual(
      Object.values(data.firstPartyCardSeed.cards).map((c) => c.title),
      ["Title of public"],
    );
  }
});

test("during a navigation the page being left cannot spend the next page's budget; the next page's seed survives", async () => {
  const api = fakeApi();
  const resolver = pageResolver(api);
  resolver.request(embed("/alice/old"));
  await settled(resolver, (s) => Object.keys(s.cards).length === 1);
  resolver.suspend();
  assert.deepEqual(current(resolver).cards, {});
  // The old page is still mounted and re-requests on the generation bump.
  resolver.request(embed("/alice/old"));
  resolver.request(embed("/alice/old-2"));
  // The new page's data arrives with its seed.
  const seed = { cards: {}, calls: [`${HOST}/api/zpage/seeded/?lang=en`] };
  resolver.seed(seed);
  resolver.request(embed("/alice/new")); // still suspended: ignored
  await sleep(40);
  assert.equal(api.calls.length, 1);
  const before = current(resolver).generation;
  resolver.resume();
  assert.equal(current(resolver).generation, before + 1);
  // The new page's bodies re-request: the seeded call is not repeated.
  resolver.request([embed("/alice/seeded"), embed("/alice/new")].join("\n\n"));
  await settled(resolver, (s) => Object.keys(s.cards).length === 1);
  assert.deepEqual(
    api.calls.map((call) => call.path),
    ["/api/zpage/old/", "/api/zpage/new/"],
  );
  // resume() without a suspend is a no-op (the first page load).
  const settledGeneration = current(resolver).generation;
  resolver.resume();
  assert.equal(current(resolver).generation, settledGeneration);
  resolver.destroy();
});

test("a session-bearing seed is re-resolved as the browser's viewer once identity is known, without flashing", async () => {
  const { writable } = await import("svelte/store");
  // The server rendered with Alice's cookie; by the time this page asks, the
  // browser's cookie is someone who may open `public` but not `members`.
  const api = fakeApi({
    "/api/zpage/members/": () =>
      Response.json({ show_modal: true, page: zpageBody("members") }),
  });
  const card = (vanity) =>
    cards.zpageCardFromApi(
      {
        kind: "zpage",
        username: "alice",
        identifier: vanity,
        href: `https://${HOST}/alice/${vanity}`,
      },
      zpageBody(vanity),
      "en",
    );
  const seed = {
    cards: {
      [`zpage:${HOST}/alice/public`]: card("public"),
      [`zpage:${HOST}/alice/members`]: card("members"),
    },
    calls: [
      `${HOST}/api/zpage/public/?lang=en`,
      `${HOST}/api/zpage/members/?lang=en`,
    ],
    session: true,
  };
  const identity = writable(null);
  const resolver = pageResolver(api, { identity });
  const sizes = [];
  const unsubscribe = resolver.subscribe((state) =>
    sizes.push(Object.keys(state.cards).length),
  );
  resolver.seed(seed);
  const body = [embed("/alice/public"), embed("/alice/members")].join("\n\n");
  resolver.request(body); // hydration: seeded, nothing fetched
  await sleep(20);
  assert.equal(api.calls.length, 0);
  identity.set("user:bob");
  // The component re-requests on the generation bump.
  resolver.request(body, undefined, current(resolver).generation);
  await settled(resolver, (s) => Object.keys(s.cards).length === 1);
  assert.deepEqual(api.calls.map((call) => call.path).sort(), [
    "/api/zpage/members/",
    "/api/zpage/public/",
  ]);
  assert.deepEqual(Object.keys(current(resolver).cards), [
    `zpage:${HOST}/alice/public`,
  ]);
  // Never an empty page between the seed and the fresh answer.
  assert.ok(
    sizes.slice(1).every((n) => n >= 1),
    JSON.stringify(sizes),
  );
  unsubscribe();
  resolver.destroy();

  // An anonymous render's seed is not re-resolved.
  const api2 = fakeApi();
  const identity2 = writable(null);
  const anonymous = pageResolver(api2, { identity: identity2 });
  anonymous.seed({ ...seed, session: false });
  identity2.set("anonymous");
  anonymous.request(body, undefined, current(anonymous).generation);
  await sleep(40);
  assert.equal(api2.calls.length, 0);
  assert.equal(Object.keys(current(anonymous).cards).length, 2);
  anonymous.destroy();
});

test("codex R1: a new spelling of a server-seeded call reopens it once; a key the server already planned never does", () => {
  const server = resolve.createFirstPartyCardLedger({
    host: HOST,
    maxCalls: 4,
  });
  const [publicCall, gatedCall] = server.plan(
    [embed("/alice/post"), embed("/alice/gated")].join("\n\n"),
    "en",
  ).calls;
  server.settle(publicCall.key, zpageBody("post"));
  server.settle(gatedCall.key, null);
  const seed = { cards: {}, calls: server.calls(), keys: server.keys() };
  assert.deepEqual(seed.keys, [
    `zpage:${HOST}/alice/post`,
    `zpage:${HOST}/alice/gated`,
  ]);
  const browser = resolve.createFirstPartyCardLedger({
    host: HOST,
    maxCalls: 3,
    seed,
  });
  // Hydration re-plans the server's body: nothing is repeated, gated included.
  assert.deepEqual(
    browser.plan(
      [embed("/alice/post"), embed("/alice/gated")].join("\n\n"),
      "en",
    ).calls,
    [],
  );
  // A reply spells the seeded page another way: the call reopens, as a
  // second request that needs budget of its own (2 seeded + 1 = 3; with a
  // full budget it would stay neutral — codex R2).
  const reopened = browser.plan(embed("/article/post"), "en");
  assert.deepEqual(
    reopened.calls.map((call) => call.apiPath),
    ["/api/zpage/post/"],
  );
  const settled = browser.settle(reopened.calls[0].key, zpageBody("post"));
  assert.equal(settled[`zpage:${HOST}//post`]?.title, "Title of post");
  // Once, not per spelling.
  assert.deepEqual(
    browser.plan(embed("/ALICE/post") + "\n\nx", "en").calls,
    [],
  );
});

test("codex R1: re-checking a session seed stays inside the page budget", async () => {
  const { writable } = await import("svelte/store");
  const api = fakeApi();
  const identity = writable(null);
  const resolver = pageResolver(api, { identity, maxCalls: 5 });
  resolver.seed({
    cards: {},
    calls: [0, 1, 2].map((i) => `${HOST}/api/zpage/s${i}/?lang=en`),
    keys: [0, 1, 2].map((i) => `zpage:${HOST}/alice/s${i}`),
    session: true,
  });
  identity.set("user:bob");
  resolver.request(
    [0, 1, 2, 3, 4, 5, 6].map((i) => embed(`/alice/p${i}`)).join("\n\n"),
  );
  resolver.request([0, 1, 2].map((i) => embed(`/alice/s${i}`)).join("\n\n"));
  await sleep(100);
  // 3 by the server + at most 2 by the browser = the page budget of 5.
  assert.equal(api.calls.length, 2);
  resolver.destroy();
});

test("codex R1: a language change is a new page view; the same body in another locale is planned again", async () => {
  const { writable } = await import("svelte/store");
  const ledger = resolve.createFirstPartyCardLedger({
    host: HOST,
    maxCalls: 16,
  });
  assert.equal(ledger.plan(embed("/alice/post"), "en").calls.length, 1);
  assert.deepEqual(
    ledger.plan(embed("/alice/post"), "fr").calls.map((call) => call.key),
    [`${HOST}/api/zpage/post/?lang=fr`],
  );

  const localeStore = writable("en");
  let current_locale = "en";
  const api = fakeApi();
  const resolver = pageResolver(api, {
    localeStore,
    locale: () => current_locale,
  });
  resolver.request(embed("/alice/post"));
  await settled(resolver, (s) => Object.keys(s.cards).length === 1);
  current_locale = "fr";
  localeStore.set("fr");
  assert.deepEqual(current(resolver).cards, {});
  resolver.request(
    embed("/alice/post"),
    undefined,
    current(resolver).generation,
  );
  await settled(resolver, (s) => Object.keys(s.cards).length === 1);
  assert.deepEqual(
    api.calls.map((call) => call.url),
    ["/api/zpage/post/?lang=en", "/api/zpage/post/?lang=fr"],
  );
  resolver.destroy();
});

test("codex R2: reopened aliases spend budget like any request — server + browser never exceed the page budget", () => {
  const server = resolve.createFirstPartyCardLedger({
    host: HOST,
    maxCalls: 4,
  });
  const opened = server.plan(
    [0, 1, 2, 3].map((i) => embed(`/alice/s${i}`)).join("\n\n"),
    "en",
  ).calls;
  assert.equal(opened.length, 4);
  const browser = resolve.createFirstPartyCardLedger({
    host: HOST,
    maxCalls: 16,
    seed: { cards: {}, calls: server.calls(), keys: server.keys() },
  });
  // Comments spell the four seeded pages as /article/<id>, plus 16 others.
  const calls = browser.plan(
    [...[0, 1, 2, 3].map((i) => embed(`/article/s${i}`))].join("\n\n"),
    "en",
  ).calls;
  let total = calls.length;
  for (let i = 0; i < 16; i += 1) {
    total += browser.plan(embed(`/alice/other-${i}`), "en").calls.length;
  }
  assert.equal(opened.length + total, 16);
});

test("codex R2: a session seed arriving after the identity is known is never shown; an unconfirmed stale card drops at once", async () => {
  const { writable } = await import("svelte/store");
  const identity = writable("user:bob");
  let release;
  const gate = new Promise((done) => (release = done));
  const api = fakeApi({
    "/api/zpage/hidden/": () => new Response("{}", { status: 404 }),
    "/api/zpage/slow/": async () => {
      await gate;
      return Response.json(zpageBody("slow"));
    },
  });
  const resolver = pageResolver(api, { identity });
  const aliceCard = cards.zpageCardFromApi(
    {
      kind: "zpage",
      username: "alice",
      identifier: "hidden",
      href: `https://${HOST}/alice/hidden`,
    },
    zpageBody("hidden", { content: "ALICE-PRIVATE" }),
    "en",
  );
  resolver.resume(); // the first page view has been entered
  // A preloaded route's data, fetched with Alice's cookie, lands after Bob.
  resolver.seed({
    cards: { [`zpage:${HOST}/alice/hidden`]: aliceCard },
    calls: [`${HOST}/api/zpage/hidden/?lang=en`],
    keys: [`zpage:${HOST}/alice/hidden`],
    session: true,
  });
  assert.deepEqual(current(resolver).cards, {});
  release();
  resolver.destroy();

  // Hydration case: identity unknown when the seed arrives, revalidated
  // once known — and the card the fresh answer refuses is gone as soon as
  // THAT answer is in, while another call is still pending.
  let release2;
  const gate2 = new Promise((done) => (release2 = done));
  const api2 = fakeApi({
    "/api/zpage/hidden/": () => new Response("{}", { status: 404 }),
    "/api/zpage/slow/": async () => {
      await gate2;
      return Response.json(zpageBody("slow"));
    },
  });
  const identity2 = writable(null);
  const hydrating = pageResolver(api2, { identity: identity2 });
  hydrating.seed({
    cards: { [`zpage:${HOST}/alice/hidden`]: aliceCard },
    calls: [`${HOST}/api/zpage/hidden/?lang=en`],
    keys: [`zpage:${HOST}/alice/hidden`],
    session: true,
  });
  assert.equal(Object.keys(current(hydrating).cards).length, 1);
  identity2.set("user:bob");
  hydrating.request(
    [embed("/alice/hidden"), embed("/alice/slow")].join("\n\n"),
    undefined,
    current(hydrating).generation,
  );
  await settled(hydrating, (s) => Object.keys(s.cards).length === 0);
  assert.ok(!JSON.stringify(current(hydrating)).includes("ALICE-PRIVATE"));
  release2();
  await settled(hydrating, (s) => Object.keys(s.cards).length === 1);
  hydrating.destroy();
});

test("codex R2: resuming after a navigation publishes what is visible, not an empty map", async () => {
  const { writable } = await import("svelte/store");
  const identity = writable(null);
  const resolver = pageResolver(fakeApi(), { identity });
  const card = cards.zpageCardFromApi(
    {
      kind: "zpage",
      username: "alice",
      identifier: "post",
      href: `https://${HOST}/alice/post`,
    },
    zpageBody("post"),
    "en",
  );
  resolver.suspend();
  resolver.seed({
    cards: { [`zpage:${HOST}/alice/post`]: card },
    calls: [`${HOST}/api/zpage/post/?lang=en`],
    keys: [`zpage:${HOST}/alice/post`],
    session: true,
  });
  identity.set("anonymous"); // first answer: revalidate keeps the seed visible
  assert.equal(Object.keys(current(resolver).cards).length, 1);
  resolver.resume();
  assert.equal(Object.keys(current(resolver).cards).length, 1);
  resolver.destroy();
});

test("codex R3: losing a known identity clears at once; a new membership re-resolves", async () => {
  const { writable } = await import("svelte/store");
  const identity = writable("user:alice|");
  const api = fakeApi();
  const resolver = pageResolver(api, { identity });
  resolver.request(embed("/alice/draft"));
  await settled(resolver, (s) => Object.keys(s.cards).length === 1);
  identity.set(null); // a credential exchange re-checks who this is
  assert.deepEqual(current(resolver).cards, {});
  identity.set("user:bob|");
  identity.set("user:bob|alice"); // bought a membership in place
  resolver.request(
    embed("/alice/draft"),
    undefined,
    current(resolver).generation,
  );
  await settled(resolver, (s) => Object.keys(s.cards).length === 1);
  assert.equal(api.calls.length, 2);
  resolver.destroy();

  // The real identity key moves when a membership is bought in place.
  const { authStore } = await server.ssrLoadModule("/src/lib/stores/auth.ts");
  const keys = [];
  const stop = client.firstPartyCardIdentity.subscribe((value) =>
    keys.push(value),
  );
  authStore.updateCreator({ username: "carol", stars: ["zed"] });
  authStore.setSubscription("amy", true);
  stop();
  assert.deepEqual(keys.slice(-2), ["user:carol|zed", "user:carol|amy,zed"]);
});

test("codex R4: nothing resolves before the viewer is known, so a slow auth check costs no cards", async () => {
  const { writable } = await import("svelte/store");
  const identity = writable(null);
  const api = fakeApi();
  const resolver = pageResolver(api, { identity, maxCalls: 6 });
  resolver.seed({
    cards: {},
    calls: [0, 1].map((i) => `${HOST}/api/zpage/s${i}/?lang=en`),
    keys: [0, 1].map((i) => `zpage:${HOST}/alice/s${i}`),
    session: true,
  });
  for (let i = 0; i < 4; i += 1) resolver.request(embed(`/alice/p${i}`));
  await sleep(40);
  assert.equal(api.calls.length, 0);
  identity.set("user:bob|");
  for (let i = 0; i < 4; i += 1) {
    resolver.request(
      embed(`/alice/p${i}`),
      undefined,
      current(resolver).generation,
    );
  }
  await settled(resolver, (s) => Object.keys(s.cards).length === 4);
  await sleep(40);
  assert.equal(Object.keys(current(resolver).cards).length, 4);
  resolver.destroy();
});

test("codex R4: an anonymous seed is trusted only for a viewer known to be anonymous", async () => {
  const { writable } = await import("svelte/store");
  const seedFor = () => ({
    cards: {},
    calls: [`${HOST}/api/zpage/members/?lang=en`],
    keys: [`zpage:${HOST}/alice/members`],
    session: false,
  });
  // Preloaded while anonymous, opened after an in-place login.
  const identity = writable("user:bob|alice");
  const api = fakeApi();
  const resolver = pageResolver(api, { identity });
  resolver.seed(seedFor());
  resolver.request(
    embed("/alice/members"),
    undefined,
    current(resolver).generation,
  );
  await settled(resolver, (s) => Object.keys(s.cards).length === 1);
  assert.equal(api.calls.length, 1);
  resolver.destroy();

  // Hydration: identity unknown at seed time, then signed in.
  const identity2 = writable(null);
  const api2 = fakeApi();
  const hydrating = pageResolver(api2, { identity: identity2 });
  hydrating.seed(seedFor());
  identity2.set("user:bob|alice");
  hydrating.request(
    embed("/alice/members"),
    undefined,
    current(hydrating).generation,
  );
  await settled(hydrating, (s) => Object.keys(s.cards).length === 1);
  assert.equal(api2.calls.length, 1);
  hydrating.destroy();

  // A viewer known to be anonymous keeps it: nothing is repeated.
  const identity3 = writable("anonymous");
  const api3 = fakeApi();
  const anonymous = pageResolver(api3, { identity: identity3 });
  anonymous.seed(seedFor());
  anonymous.request(
    embed("/alice/members"),
    undefined,
    current(anonymous).generation,
  );
  await sleep(40);
  assert.equal(api3.calls.length, 0);
  anonymous.destroy();
});

test("review F1: the hydration seed of a returning signed-in reader (identity already known) stays on screen while it is re-checked", async () => {
  const { writable } = await import("svelte/store");
  // `localStorage.auth` rehydrated the identity before the page seeded.
  const identity = writable("user:bob|alice");
  const api = fakeApi();
  const resolver = pageResolver(api, { identity });
  const sizes = [];
  const stop = resolver.subscribe((state) =>
    sizes.push(Object.keys(state.cards).length),
  );
  const card = cards.zpageCardFromApi(
    {
      kind: "zpage",
      username: "alice",
      identifier: "post",
      href: `https://${HOST}/alice/post`,
    },
    zpageBody("post"),
    "en",
  );
  resolver.seed({
    cards: { [`zpage:${HOST}/alice/post`]: card },
    calls: [`${HOST}/api/zpage/post/?lang=en`],
    keys: [`zpage:${HOST}/alice/post`],
    session: true,
  });
  assert.equal(Object.keys(current(resolver).cards).length, 1);
  resolver.resume(); // afterNavigate "enter"
  resolver.request(
    embed("/alice/post"),
    undefined,
    current(resolver).generation,
  );
  await settled(resolver, () => api.calls.length === 1);
  await sleep(30);
  assert.equal(Object.keys(current(resolver).cards).length, 1);
  // Never neutral in between.
  assert.ok(
    sizes.slice(1).every((n) => n === 1),
    JSON.stringify(sizes),
  );
  stop();
  resolver.destroy();
});

test("review F3: a body's selection changes only when ITS cards change", async () => {
  const api = fakeApi();
  const resolver = pageResolver(api, { identity: undefined });
  const a = `Body A.\n\n${embed("/alice/a")}`;
  const b = `Body B.\n\n${embed("/alice/b")}`;
  const c = "Body C, no embeds.";
  resolver.request(a);
  await settled(resolver, (s) => Object.keys(s.cards).length === 1);
  const before = { b: resolver.signature(b), c: resolver.signature(c) };
  const aSig = resolver.signature(a);
  resolver.request(b);
  await settled(resolver, (s) => Object.keys(s.cards).length === 2);
  assert.equal(resolver.signature(a), aSig);
  assert.equal(resolver.signature(c), before.c);
  assert.notEqual(resolver.signature(b), before.b);
  assert.deepEqual(Object.keys(resolver.cardsFor(a)), [
    `zpage:${HOST}/alice/a`,
  ]);
  assert.deepEqual(resolver.cardsFor(c), {});
  resolver.destroy();
});

test("review F3: a feed of more than 256 bodies is not re-lexed on every flush", () => {
  const ledger = resolve.createFirstPartyCardLedger({
    host: HOST,
    maxCalls: 16,
  });
  const bodies = Array.from(
    { length: 600 },
    (_, i) => `Post ${i}.\n\n${embed(`/alice/p${i % 20}`)}`,
  );
  for (const body of bodies) ledger.plan(body, "en");
  // Re-planning every body (each flush re-requests them) finds them all in
  // the memo: nothing new is opened and, observably, no body is re-lexed.
  const started = Date.now();
  let opened = 0;
  for (let round = 0; round < 20; round += 1) {
    for (const body of bodies) opened += ledger.plan(body, "en").calls.length;
  }
  assert.equal(opened, 0);
  assert.ok(resolve.PLANNED_MEMO_MAX >= 4096);
  // 12 000 re-plans answered from the memo: well under a lexing budget.
  assert.ok(Date.now() - started < 1500, String(Date.now() - started));
});

test("review F2: a signed-in client navigation's __data.json resolves no card; full renders and anonymous navigations still do", async () => {
  const root = {
    uuid: UUID_A,
    parent: null,
    content: embed("/alice/public"),
  };
  const run = async ({ cookie, isDataRequest }) => {
    const api = fakeApi({ [`/api/comments/${UUID_A}/`]: root });
    const event = {
      ...converseEvent({ cookie, fetch: api.fetch }),
      isDataRequest,
    };
    const data = await converseDetailLoad(event);
    return {
      calls: api.calls.filter((c) => c.path.startsWith("/api/zpage/")).length,
      seed: data.firstPartyCardSeed,
    };
  };
  const signedInNavigation = await run({
    cookie: "sessionid=reader",
    isDataRequest: true,
  });
  assert.equal(signedInNavigation.calls, 0);
  assert.deepEqual(signedInNavigation.seed.cards, {});
  assert.deepEqual(signedInNavigation.seed.calls, []);
  assert.equal(
    (await run({ cookie: "sessionid=reader", isDataRequest: false })).calls,
    1,
  );
  assert.equal((await run({ cookie: null, isDataRequest: true })).calls, 1);
  // A cookie that is not a session (locale only) is an anonymous reader.
  assert.equal(
    (await run({ cookie: "free2z-locale=en", isDataRequest: true })).calls,
    1,
  );

  // The other two routes take the same option.
  const api = fakeApi({
    "/api/creator/alice/": {
      username: "alice",
      description: embed("/alice/public"),
    },
    "/api/comments/": {
      results: [{ uuid: UUID_B, content: embed("/alice/public") }],
      next: null,
    },
  });
  await profileLoad({
    params: { username: "alice" },
    request: new Request(`https://${HOST}/alice`, {
      headers: { cookie: "sessionid=reader" },
    }),
    url: new URL(`https://${HOST}/alice`),
    cookies: { get: () => undefined },
    locals: { locale: "en" },
    fetch: api.fetch,
    setHeaders: () => {},
    isDataRequest: true,
  });
  await converseFeedLoad({
    request: new Request(`https://${HOST}/converse`, {
      headers: { cookie: "sessionid=reader" },
    }),
    url: new URL(`https://${HOST}/converse`),
    cookies: { get: (name) => (name === "sessionid" ? "reader" : undefined) },
    locals: { locale: "en" },
    fetch: api.fetch,
    setHeaders: () => {},
    isDataRequest: true,
  });
  assert.equal(
    api.calls.filter((c) => c.path === "/api/zpage/public/").length,
    0,
  );
});
