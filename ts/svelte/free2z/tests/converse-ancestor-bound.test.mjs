import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, test } from "node:test";
import { createServer } from "vite";

import {
  CONVERSE_ANCESTOR_HOP_BUDGET_MS,
  CONVERSE_ANCESTOR_WALK_TIMEOUT_MS,
  CONVERSE_MAX_ANCESTOR_DEPTH,
} from "../src/lib/converse-ssr-bounds.js";
import { FIRST_PARTY_EMBED_TIMEOUT_MS } from "../src/lib/article-ssr-deadlines.js";

/**
 *  -- `/converse/<uuid>` resolves the thread root by walking `parent`
 * one `/api/comments/<uuid>/` read at a time. It had a cycle guard and nothing
 * else: a reply N levels deep cost N + 1 sequential backend calls per render,
 * for any anonymous visitor and (since ) every social unfurler, and one
 * stalled ancestor held the render until nginx's 60 s read timeout.
 */

let server;
let load;
const previousApiBase = process.env.PRIVATE_API_BASE_URL;
const LEAF = "00000000-0000-4000-8000-000000000000";
const CHAIN_DEPTH = 100;

// uuid of the comment `n` hops above the leaf (0 = the leaf itself).
const at = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hopsAbove = (uuid) => Number(uuid.slice(-12));

before(async () => {
  process.env.PRIVATE_API_BASE_URL = "https://api.free2z.test";
  server = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { hmr: false, middlewareMode: true },
  });
  ({ load } = await server.ssrLoadModule(
    "/src/routes/converse/[uuid]/+page.server.ts",
  ));
});

after(async () => {
  await server?.close();
  if (previousApiBase === undefined) delete process.env.PRIVATE_API_BASE_URL;
  else process.env.PRIVATE_API_BASE_URL = previousApiBase;
});

/**
 * A reply chain CHAIN_DEPTH levels deep. `stallAt` makes the read of that
 * ancestor never answer -- and ignore its abort signal, so only a deadline
 * the loader enforces itself can end the wait.
 */
function chain({ depth = CHAIN_DEPTH, stallAt = null, hopMs = 0 } = {}) {
  const calls = [];
  const fetchImpl = async (input) => {
    const uuid = new URL(String(input)).pathname.split("/")[3];
    calls.push(uuid);
    const n = hopsAbove(uuid);
    if (n === stallAt) return new Promise(() => {});
    if (hopMs > 0) await new Promise((resolve) => setTimeout(resolve, hopMs));
    return Response.json({
      uuid,
      parent: n < depth ? at(n + 1) : null,
      content: `comment ${n}`,
    });
  };
  return { calls, fetchImpl };
}

function event(fetchImpl, headers) {
  return {
    params: { uuid: LEAF },
    request: new Request(`https://free2z.cash/converse/${LEAF}`),
    fetch: fetchImpl,
    setHeaders: (h) => Object.assign(headers, h),
    locals: {},
    url: new URL(`https://free2z.cash/converse/${LEAF}`),
    // A data request skips the `::embed[]` card seed, which is not under test.
    isDataRequest: true,
  };
}

test("the bounds are positive and fit the SSR budget", () => {
  assert.ok(Number.isInteger(CONVERSE_MAX_ANCESTOR_DEPTH));
  assert.ok(CONVERSE_MAX_ANCESTOR_DEPTH >= 1);
  assert.ok(CONVERSE_ANCESTOR_WALK_TIMEOUT_MS > 0);
  // The walk and the root's awaited card seed run in series; keep their sum
  // inside the same 8 s ceiling the article routes hold themselves to.
  assert.ok(
    CONVERSE_ANCESTOR_WALK_TIMEOUT_MS + FIRST_PARTY_EMBED_TIMEOUT_MS <= 8_000,
  );
  // A healthy deep reply must hit the depth cap (200 + "view earlier")
  // before the deadline (503): the deadline must leave every hop its budget.
  assert.ok(
    CONVERSE_ANCESTOR_WALK_TIMEOUT_MS / CONVERSE_MAX_ANCESTOR_DEPTH >=
      CONVERSE_ANCESTOR_HOP_BUDGET_MS,
    `${CONVERSE_MAX_ANCESTOR_DEPTH} hops in ` +
      `${CONVERSE_ANCESTOR_WALK_TIMEOUT_MS} ms leaves under ` +
      `${CONVERSE_ANCESTOR_HOP_BUDGET_MS} ms a hop`,
  );
  assert.ok(CONVERSE_ANCESTOR_HOP_BUDGET_MS >= 1_000);
});

test("a deep chain of slow but healthy reads reaches the cap, not a 503", async (t) => {
  // Every read takes 90% of the hop budget, on a VIRTUAL clock: chained real
  // timers overran the deadline under a loaded `npm test` (an event-loop
  // stall delays each hop in turn but the deadline only once), which made
  // the end-to-end check a race instead of a proof of the cap/deadline ratio.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const hopMs = Math.floor(CONVERSE_ANCESTOR_HOP_BUDGET_MS * 0.9);
  const { calls, fetchImpl } = chain({ hopMs });
  let settled = false;
  const pending = load(event(fetchImpl, {}));
  pending.then(
    () => (settled = true),
    () => (settled = true),
  );
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  for (let step = 0; step < 100 && !settled; step += 1) {
    for (let i = 0; i < 10; i += 1) await flush();
    t.mock.timers.tick(hopMs / 4);
  }
  const data = await pending;
  assert.equal(calls.length, 1 + CONVERSE_MAX_ANCESTOR_DEPTH);
  assert.equal(data.comment.uuid, at(CONVERSE_MAX_ANCESTOR_DEPTH));
  assert.equal(data.earlierUuid, at(CONVERSE_MAX_ANCESTOR_DEPTH + 1));
});

test("a deep chain costs at most 1 + the depth cap backend reads", async () => {
  const { calls, fetchImpl } = chain();
  const headers = {};
  const data = await load(event(fetchImpl, headers));

  assert.equal(
    calls.length,
    1 + CONVERSE_MAX_ANCESTOR_DEPTH,
    `a ${CHAIN_DEPTH}-deep reply made ${calls.length} backend reads`,
  );
  // The deepest ancestor reached is rendered, the leaf stays focused, and the
  // page is handed the next stretch to link to.
  assert.equal(data.comment.uuid, at(CONVERSE_MAX_ANCESTOR_DEPTH));
  assert.equal(data.focusUuid, LEAF);
  assert.equal(data.earlierUuid, at(CONVERSE_MAX_ANCESTOR_DEPTH + 1));
  // Depth truncation is deterministic: no cache override.
  assert.equal(headers["cache-control"], undefined);
});

test("following 'view earlier' walks the next bounded stretch", async () => {
  const { calls, fetchImpl } = chain();
  const start = at(CONVERSE_MAX_ANCESTOR_DEPTH + 1);
  const data = await load({
    ...event(fetchImpl, {}),
    params: { uuid: start },
  });
  assert.equal(calls.length, 1 + CONVERSE_MAX_ANCESTOR_DEPTH);
  assert.equal(data.comment.uuid, at(2 * CONVERSE_MAX_ANCESTOR_DEPTH + 1));
  assert.equal(data.focusUuid, start);
});

test("a chain inside the cap still reaches the root, with no earlier link", async () => {
  const { calls, fetchImpl } = chain({ depth: CONVERSE_MAX_ANCESTOR_DEPTH });
  const data = await load(event(fetchImpl, {}));
  assert.equal(calls.length, 1 + CONVERSE_MAX_ANCESTOR_DEPTH);
  assert.equal(data.comment.uuid, at(CONVERSE_MAX_ANCESTOR_DEPTH));
  assert.equal(data.comment.parent, null);
  assert.equal(data.earlierUuid, null);
});

// Without a deadline the load never settles; fail on a clock, not a hung run.
const STALL_TEST = { timeout: CONVERSE_ANCESTOR_WALK_TIMEOUT_MS + 5_000 };

for (const stallAt of [1, 3]) {
  test(
    `a stalled ancestor (hop ${stallAt}) is a retryable 503 within the deadline`,
    STALL_TEST,
    async () => {
      const { fetchImpl } = chain({ stallAt });
      const headers = {};
      const started = Date.now();
      await assert.rejects(
        load(event(fetchImpl, headers)),
        (thrown) => thrown?.status === 503,
      );
      const elapsed = Date.now() - started;
      assert.ok(
        elapsed < CONVERSE_ANCESTOR_WALK_TIMEOUT_MS + 1_500,
        `the render waited ${elapsed} ms on one stalled ancestor`,
      );
      // Never a 200 card titled after whichever ancestor arrived in time
      // (codex review): an unfurler keeps it after the backend recovers.
    },
  );
}

test("the page links to the earlier stretch it was handed", () => {
  const page = fs.readFileSync(
    new URL("../src/routes/converse/[uuid]/+page.svelte", import.meta.url),
    "utf8",
  );
  assert.match(page, /data\.earlierUuid/);
  assert.match(page, /href=\{`\/converse\/\$\{earlierUuid\}`\}/);
  for (const locale of ["en", "es", "fr", "pt-BR"]) {
    const messages = JSON.parse(
      fs.readFileSync(
        new URL(`../src/lib/locales/${locale}.json`, import.meta.url),
        "utf8",
      ),
    );
    assert.ok(messages.converse?.viewEarlier, `${locale} lacks viewEarlier`);
  }
});
