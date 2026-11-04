// Uncached article cards must have a per-process work-rate ceiling as well as
// the existing concurrency/memory gate. Exercise the real route and Resvg
// renderer so a steady stream of valid articles cannot monopolize the same
// Node process that serves /healthz.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";

const ZPAGE_ID = "0f7e1a2b-3c4d-5e6f-7a8b-9c0d1e2f3a4b";
const ORIGIN = "https://free2z.cash";
const CARD_CACHE = "public, max-age=0, s-maxage=60, must-revalidate";
const NO_STORE = "no-store";
const READINESS_DEADLINE_MS = 10_000;

let cardGet;
let healthGet;
let OgArticleLookupLimiter;
let OgRenderRateLimiter;
let resetOgRenderRateLimiterForTest;
let coverBytes;
let server;

before(async () => {
  server = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  ({ GET: cardGet } = await server.ssrLoadModule(
    "/src/routes/og/zpage/[id].png/+server.ts",
  ));
  ({ GET: healthGet } = await server.ssrLoadModule(
    "/src/routes/healthz/+server.ts",
  ));
  ({
    OgArticleLookupLimiter,
    OgRenderRateLimiter,
    resetOgRenderRateLimiterForTest,
  } = await server.ssrLoadModule("/src/lib/server/og-render-gate.ts"));
  const { Resvg } = await import("@resvg/resvg-js");
  coverBytes = Uint8Array.from(
    new Resvg(
      '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="630">' +
        '<rect width="800" height="630" fill="#ff00aa"/></svg>',
      { fitTo: { mode: "width", value: 800 } },
    )
      .render()
      .asPng(),
  );
});

after(async () => {
  await server?.close();
});

function validArticle() {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => ({
      free2zaddr: ZPAGE_ID,
      title: "A real uncached article card",
      description: "A fixture that exercises the actual Resvg renderer.",
      creator: { username: "capacity-test" },
      featured_image: { url: "/media/cover.png" },
    }),
  };
}

async function requestCard({
  clientAddress = "198.51.100.1",
  onArticleFetch = () => {},
  onCoverFetch = () => {},
  articleFetch = async () => validArticle(),
} = {}) {
  const headers = {};
  const requestUrl = new URL(`${ORIGIN}/og/zpage/${ZPAGE_ID}.png`);
  const response = await cardGet({
    params: { id: ZPAGE_ID },
    request: new Request(requestUrl, {
      headers: { "x-forwarded-for": clientAddress },
    }),
    fetch: async (input, init) => {
      const href = typeof input === "string" ? input : input.href;
      if (href.includes("/api/zpage/")) {
        onArticleFetch();
        return articleFetch(href, init);
      }
      assert.ok(href.endsWith("/media/cover.png"), `unexpected fetch: ${href}`);
      onCoverFetch();
      return new Response(coverBytes, {
        headers: {
          "content-length": String(coverBytes.byteLength),
          "content-type": "image/png",
        },
      });
    },
    url: new URL(`${ORIGIN}/og/zpage/${ZPAGE_ID}.png`),
    setHeaders: (values) => Object.assign(headers, values),
  });
  Object.assign(headers, Object.fromEntries(response.headers.entries()));
  return {
    body: new Uint8Array(await response.arrayBuffer()),
    headers,
    response,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("one noisy client cannot occupy both lookup slots, and render cooldown follows measured CPU", async () => {
  const lookups = new OgArticleLookupLimiter();
  const firstLookup = lookups.tryAcquire("203.0.113.10", 100);
  const sameClientLookup = lookups.tryAcquire("203.0.113.10", 100);
  const legitimateLookup = lookups.tryAcquire("203.0.113.11", 100);
  assert.equal(firstLookup.admitted, true);
  assert.deepEqual(sameClientLookup, {
    admitted: false,
    reason: "client_lookup_busy",
    retryAfterMs: 1_000,
  });
  assert.equal(legitimateLookup.admitted, true);
  assert.deepEqual(lookups.tryAcquire("203.0.113.12", 100), {
    admitted: false,
    reason: "lookup_busy",
    retryAfterMs: 1_000,
  });
  firstLookup.release();
  firstLookup.release();
  legitimateLookup.release();
  const afterGlobalRefill = lookups.tryAcquire("203.0.113.10", 600);
  assert.equal(afterGlobalRefill.admitted, true);
  afterGlobalRefill.release();
  assert.deepEqual(lookups.tryAcquire("203.0.113.10", 600), {
    admitted: false,
    reason: "client_lookup_rate_limited",
    retryAfterMs: 500,
  });
  assert.equal(lookups.tryAcquire("203.0.113.10", 1_100).admitted, true);

  const renders = new OgRenderRateLimiter();
  const firstRender = renders.tryAcquire(100);
  const secondRender = renders.tryAcquire(100);
  assert.equal(firstRender.admitted, true);
  assert.equal(secondRender.admitted, true);
  assert.deepEqual(renders.tryAcquire(100), {
    admitted: false,
    retryAfterMs: 1_000,
  });
  firstRender.complete(100, 200);
  secondRender.complete(100, 300);
  assert.deepEqual(renders.tryAcquire(1_099), {
    admitted: false,
    retryAfterMs: 1,
  });
  assert.equal(renders.tryAcquire(1_100).admitted, true);
});

test("a slow noisy client leaves a lookup for a legitimate client and releases after timeout", async () => {
  resetOgRenderRateLimiterForTest();
  const noisyStarted = deferred();
  const noisyFetch = deferred();
  const legitimateStarted = deferred();
  const legitimateFetch = deferred();
  const noisy = requestCard({
    clientAddress: "203.0.113.40",
    articleFetch: () => {
      noisyStarted.resolve();
      return noisyFetch.promise;
    },
  });
  await noisyStarted.promise;

  const noisyDuplicate = await requestCard({
    clientAddress: "203.0.113.40",
  });
  assert.equal(noisyDuplicate.response.status, 503);
  assert.equal(noisyDuplicate.headers["cache-control"], NO_STORE);

  const legitimate = requestCard({
    clientAddress: "203.0.113.41",
    articleFetch: () => {
      legitimateStarted.resolve();
      return legitimateFetch.promise;
    },
  });
  await legitimateStarted.promise;
  const thirdClient = await requestCard({
    clientAddress: "203.0.113.42",
  });
  assert.equal(thirdClient.response.status, 503);

  // A timeout or network abort rejects fetch through the handler's finally
  // block. Once that lease is released, the same client can retry while the
  // legitimate client's slow lookup still occupies its own slot.
  noisyFetch.reject(new Error("simulated article lookup timeout"));
  const noisyTimeout = await noisy;
  assert.equal(noisyTimeout.response.status, 504);
  assert.equal(noisyTimeout.headers["cache-control"], NO_STORE);

  // The aggregate bucket refills while the other lookup remains in flight.
  await new Promise((resolve) => setTimeout(resolve, 510));
  legitimateFetch.resolve(validArticle());
  const noisyRetryResult = requestCard({
    clientAddress: "203.0.113.40",
  });
  const [noisyRetry, legitimateResult] = await Promise.all([
    noisyRetryResult,
    legitimate,
  ]);
  assert.equal(noisyRetry.response.status, 200);
  assert.equal(noisyRetry.headers["cache-control"], CARD_CACHE);
  assert.equal(legitimateResult.response.status, 200);
  assert.equal(legitimateResult.headers["cache-control"], CARD_CACHE);
});

test("sustained valid-card traffic is refused while the SSR health probe stays within deadline", async () => {
  resetOgRenderRateLimiterForTest();
  let articleLookups = 0;
  const firstStart = performance.now();
  const firstProbe = new Promise((resolve) => {
    setTimeout(async () => {
      resolve({
        response: await healthGet(),
        elapsedMs: performance.now() - firstStart,
      });
    }, 0);
  });
  let coverReads = 0;
  const firstBurst = await Promise.all(
    Array.from({ length: 2 }, (_, index) =>
      requestCard({
        clientAddress: `198.51.100.${index + 1}`,
        onArticleFetch: () => {
          articleLookups += 1;
        },
        onCoverFetch: () => {
          coverReads += 1;
        },
      }),
    ),
  );
  const probeDuringRealRender = await firstProbe;
  assert.equal(probeDuringRealRender.response.status, 200);
  assert.ok(
    probeDuringRealRender.elapsedMs < READINESS_DEADLINE_MS,
    `health probe waited ${probeDuringRealRender.elapsedMs.toFixed(1)}ms behind a real rasterization`,
  );
  assert.ok(firstBurst.every(({ response }) => response.status === 200));
  assert.ok(
    firstBurst.every(({ headers }) => headers["cache-control"] === CARD_CACHE),
  );
  assert.ok(
    firstBurst.every(({ headers }) => headers["content-type"] === "image/png"),
  );
  assert.ok(
    firstBurst.every(({ body }) => body.byteLength > 0),
    "both real Resvg renders returned PNGs within the two-card burst",
  );

  const immediateBurst = await Promise.all(
    Array.from({ length: 32 }, () =>
      requestCard({
        onArticleFetch: () => {
          articleLookups += 1;
        },
        onCoverFetch: () => {
          coverReads += 1;
        },
      }),
    ),
  );
  assert.ok(immediateBurst.every(({ response }) => response.status === 503));
  assert.ok(
    immediateBurst.every(
      ({ headers }) => headers["cache-control"] === NO_STORE,
    ),
  );
  assert.ok(
    immediateBurst.every(({ headers }) => Number(headers["retry-after"]) > 0),
    "rate-limited 503s tell callers when to retry",
  );
  assert.ok(articleLookups >= 2, "the real article lookup path was exercised");
  assert.equal(
    coverReads,
    2,
    "rate-limited requests never read the featured upload",
  );
  // Negative control: the same real handler and valid article is refused while
  // its process budget is exhausted; the positive controls are the successful
  // two-render burst above and a real render after cooldown below.

  const maxProbeMs = { value: 0 };
  const loadUntil = performance.now() + 750;
  const loadLogs = [];
  const previousLog = console.log;
  console.log = (line) => loadLogs.push(line);
  try {
    while (performance.now() < loadUntil) {
      const startedAt = performance.now();
      const [wave, probe] = await Promise.all([
        Promise.all(Array.from({ length: 12 }, () => requestCard())),
        Promise.resolve(healthGet()),
      ]);
      const probeResponse = await probe;
      maxProbeMs.value = Math.max(
        maxProbeMs.value,
        performance.now() - startedAt,
      );
      assert.equal(probeResponse.status, 200);
      assert.equal(probeResponse.headers.get("cache-control"), NO_STORE);
      assert.ok(wave.every(({ response }) => response.status === 503));
    }
  } finally {
    console.log = previousLog;
  }
  assert.ok(
    maxProbeMs.value < READINESS_DEADLINE_MS,
    `health probe took ${maxProbeMs.value.toFixed(1)}ms; Kubernetes deadline is ${READINESS_DEADLINE_MS}ms`,
  );

  const remainingWaitMs = Math.max(
    0,
    10_000 - (performance.now() - firstStart) + 5,
  );
  await new Promise((resolve) => setTimeout(resolve, remainingWaitMs));
  const recovered = await requestCard({
    onArticleFetch: () => {
      articleLookups += 1;
    },
    onCoverFetch: () => {
      coverReads += 1;
    },
  });
  assert.equal(recovered.response.status, 200);
  assert.equal(recovered.headers["cache-control"], CARD_CACHE);
  assert.ok(recovered.body.byteLength > 0);
  assert.equal(coverReads, 3);
});
