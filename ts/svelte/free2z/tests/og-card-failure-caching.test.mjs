// Article cards must not add another cache lifetime beyond their source inputs
// issue.
//
// `/og/zpage/<id>.png` renders the social card every unfurler and search
// Stable article cards have a 60-second shared TTL, within the upload source's
// one-hour shared boundary. Errors and transient fallbacks are `no-store`.
// No origin directive can revoke copies already held by social platforms.
// This suite proves response headers, not CDN behavior or deployed reachability.
import assert from "node:assert/strict";
import sharp from "sharp";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { createServer } from "vite";

// Written out literally rather than imported from the handler: importing the
// constant would make the test agree with whatever the handler says, which is
// the one thing it must not do.
const NO_STORE = "no-store";
const ARTICLE_CARD_CACHE = "public, max-age=0, s-maxage=60, must-revalidate";

const ZPAGE_ID = "0f7e1a2b-3c4d-5e6f-7a8b-9c0d1e2f3a4b";
const ORIGIN = "https://free2z.cash";
const COVER_PATH = "/media/cover.png";

let GET;
let realCoverBytes;
let Resvg;
let resetOgRenderRateLimiterForTest;
let server;

before(async () => {
  server = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  ({ GET } = await server.ssrLoadModule(
    "/src/routes/og/zpage/[id].png/+server.ts",
  ));
  ({ resetOgRenderRateLimiterForTest } = await server.ssrLoadModule(
    "/src/lib/server/og-render-gate.ts",
  ));
  // A genuinely decodable PNG, produced by the same rasterizer the handler
  // uses, so "the cover rendered" is a real result and not a stubbed one.
  ({ Resvg } = await import("@resvg/resvg-js"));
  // `Uint8Array.from`, not the Buffer resvg hands back: Buffer overrides
  // `slice()` to return a VIEW, so `bytes.slice(0, 400).buffer` would be the
  // whole original object and the "truncated" fixtures below would silently
  // carry the complete image.
  realCoverBytes = Uint8Array.from(
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

function articleResponse(featured_image) {
  return jsonResponse({
    // Required and read-only on `zPageDetailSerializer`, so a real detail
    // response always carries it. It is the handler's witness that the 200 it
    // parsed is actually a zPage; a fixture without it is not a zPage either.
    free2zaddr: ZPAGE_ID,
    title: "Free2z-Flavored Markdown",
    description: "Special Free2z flavored Markdown extensions.",
    creator: { username: "free2z" },
    ...(featured_image ? { featured_image } : {}),
  });
}

/** A 200 carrying whatever body the caller wants the article fetch to yield. */
function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  };
}

//  moved the cover body read onto a streaming, incrementally capped
// path, so every media fixture below must look like a REAL undici response:
// bytes arrive through `body` (a ReadableStream), not through `arrayBuffer()`.
// A fixture carrying only `arrayBuffer()` would silently exercise a code path
// production never takes.
function streamOf(bytes) {
  return new ReadableStream({
    start(controller) {
      if (bytes.byteLength > 0) controller.enqueue(bytes);
      controller.close();
    },
  });
}

function failingStream() {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(64));
      controller.error(new Error("terminated"));
    },
  });
}

function imageResponse(bytes, type = "image/png", extraHeaders = {}) {
  return {
    ok: true,
    status: 200,
    headers: new Headers({
      "content-length": String(bytes.byteLength),
      "content-type": type,
      ...extraHeaders,
    }),
    body: streamOf(bytes),
  };
}

function statusResponse(status) {
  return {
    ok: false,
    status,
    headers: new Headers(),
    arrayBuffer: async () => new ArrayBuffer(0),
    json: async () => ({}),
  };
}

/**
 * Drive the real handler. `cover` decides what the media fetch does; passing
 * `null` means the article carries no featured image at all.
 */
async function renderCard(
  cover,
  { logs, article, language, onArticleFetch } = {},
) {
  // This suite covers independent response/cache cases. Give each fixture a
  // fresh admission token; sustained-rate behavior is covered separately by
  // og-render-capacity.test.mjs.
  resetOgRenderRateLimiterForTest();
  const headers = {};
  const fetch = async (input) => {
    const href = typeof input === "string" ? input : input.href;
    if (href.includes("/api/zpage/")) {
      onArticleFetch?.(href);
      return article
        ? article()
        : articleResponse(cover ? { url: COVER_PATH } : undefined);
    }
    assert.ok(href.endsWith(COVER_PATH), `unexpected fetch: ${href}`);
    return cover();
  };

  const write = console.log;
  if (logs) console.log = (line) => logs.push(line);
  try {
    const response = await GET({
      params: { id: ZPAGE_ID },
      fetch,
      url: new URL(
        `${ORIGIN}/og/zpage/${ZPAGE_ID}.png${language !== undefined ? `?lang=${encodeURIComponent(language)}` : ""}`,
      ),
      setHeaders: (values) => Object.assign(headers, values),
    });
    Object.assign(headers, Object.fromEntries(response.headers.entries()));
    return {
      headers,
      body: new Uint8Array(await response.arrayBuffer()),
      status: response.status,
    };
  } finally {
    console.log = write;
  }
}

/**
 * A minimal but structurally valid WebP (RIFF + VP8X), built by hand because
 * the rasterizer only emits PNG. Cover *variants* are generated as WebP, so
 * the truncation path below is the dominant one in production, not an edge.
 */
function webpBytes() {
  const bytes = new Uint8Array(30);
  const view = new DataView(bytes.buffer);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  view.setUint32(4, 22, true); // everything after this field
  bytes.set([0x57, 0x45, 0x42, 0x50], 8); // "WEBP"
  bytes.set([0x56, 0x50, 0x38, 0x58], 12); // "VP8X"
  view.setUint32(16, 10, true); // VP8X payload length
  // flags + reserved, then (width-1) and (height-1) as uint24 LE: 800x630.
  bytes.set([0, 0, 0, 0], 20);
  bytes.set([0x1f, 0x03, 0x00], 24); // 799
  bytes.set([0x75, 0x02, 0x00], 27); // 629
  return bytes;
}

const healthy = () => imageResponse(realCoverBytes);

test("a real WebP cover paints visible pixels in the returned card", async () => {
  const bytes = await sharp({
    create: { width: 800, height: 630, channels: 3, background: "#ff00aa" },
  })
    .webp({ lossless: true })
    .toBuffer();
  const { headers, body } = await renderCard(() =>
    imageResponse(bytes, "image/webp"),
  );
  assert.equal(headers["x-og-cover"], "ok");
  assert.equal(headers["cache-control"], ARTICLE_CARD_CACHE);
  const { data, info } = await sharp(body)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 1200);
  assert.equal(info.height, 630);
  const center = (315 * info.width + 850) * 4;
  assert.deepEqual([...data.subarray(center, center + 4)], [255, 0, 170, 255]);
});

test("a WebP with a valid header but corrupt pixels is not reported as a successful cover", async () => {
  const bytes = await sharp({
    create: { width: 800, height: 630, channels: 3, background: "#ff00aa" },
  })
    .webp({ lossless: true })
    .toBuffer();
  bytes.fill(0, bytes.length - 8);
  const logs = [];
  const { headers } = await renderCard(
    () => imageResponse(bytes, "image/webp"),
    { logs },
  );
  assert.equal(headers["x-og-cover"], "transient");
  assert.equal(headers["cache-control"], NO_STORE);
  assert.ok(logs.some((line) => JSON.parse(line).reason === "decode_failed"));
});

test("a healthy cover derivative has a short shared TTL and no stale window", async () => {
  const { headers, body } = await renderCard(healthy);
  assert.equal(headers["cache-control"], ARTICLE_CARD_CACHE);
  assert.equal(headers["x-og-cover"], "ok");
  assert.ok(body.byteLength > 0);
});

test("derivative policy stays inside the source boundary and drops source age metadata", async () => {
  const { headers, body } = await renderCard(() =>
    imageResponse(realCoverBytes, "image/png", {
      // Production reads the article and cover through the uncached private
      // sidecar, so this synthetic Age:3599 fixture is a defensive check that
      // upstream freshness headers are not copied onto the derivative.
      "cache-control": "public, max-age=300, s-maxage=3600, proxy-revalidate",
      age: "3599",
      date: new Date(Date.now() - 3_599_000).toUTCString(),
      expires: "Mon, 12 Oct 2026 23:05:00 GMT",
    }),
  );
  assert.ok(body.byteLength > 0);
  assert.equal(headers["x-og-cover"], "ok");
  assert.equal(headers["cache-control"], ARTICLE_CARD_CACHE);
  assert.equal(headers.age, undefined);
  assert.equal(headers.date, undefined);
  assert.equal(headers.expires, undefined);
  assert.equal(headers["stale-while-revalidate"], undefined);
});

test("unexpected renderer failures are logged safely and remain uncached", async () => {
  const originalRender = Resvg.prototype.render;
  const originalError = console.error;
  const lines = [];
  Resvg.prototype.render = () => {
    throw new Error("private fixture payload must not be logged");
  };
  console.error = (line) => lines.push(line);

  let result;
  try {
    result = await renderCard(healthy);
  } finally {
    Resvg.prototype.render = originalRender;
    console.error = originalError;
  }

  assert.equal(result.status, 503);
  assert.equal(result.headers["cache-control"], NO_STORE);
  assert.equal(lines.length, 1);
  const event = JSON.parse(lines[0]);
  assert.equal(event.severity, "ERROR");
  assert.equal(event.event, "og_render");
  assert.equal(event.reason, "render_failed");
  assert.equal(event.zpage_id, ZPAGE_ID);
  assert.doesNotMatch(lines[0], /private fixture payload/);
});

test("a page with no featured image returns a short-lived settled card", async () => {
  // A coverless card is a settled, correct representation and can use the same
  // short shared TTL as a card with a cover.
  //
  // This is also the positive control for the `absent` validation below: the
  // check must admit a real coverless zPage, or every such page gets a
  // retryable 502 instead of its valid card.
  const { headers } = await renderCard(null);
  assert.equal(headers["cache-control"], ARTICLE_CARD_CACHE);
  assert.equal(headers["x-og-cover"], "absent");
});

test("a revoked source cannot create a new cached article derivative", async () => {
  // The public upload authorization subrequest now denies this previously
  // readable cover. The card may degrade for this request, but it must not
  // create a new derivative cache entry. A pre-existing edge copy still needs
  // explicit invalidation.
  const { headers, body } = await renderCard(() => statusResponse(403));
  assert.ok(body.byteLength > 0);
  assert.equal(headers["x-og-cover"], "transient");
  assert.equal(headers["cache-control"], NO_STORE);
});

test("a restricted or deleted article returns 404 instead of a new card", async () => {
  const { headers, status, body } = await renderCard(null, {
    article: () => statusResponse(404),
  });
  assert.equal(status, 404);
  assert.ok(body.byteLength > 0);
  assert.equal(headers["cache-control"], NO_STORE);
  assert.equal(headers["content-type"], "text/plain; charset=utf-8");
});

test("an article API outage remains retryable instead of returning a derivative", async () => {
  const { headers, status, body } = await renderCard(null, {
    article: () => statusResponse(503),
  });
  assert.equal(status, 502);
  assert.ok(body.byteLength > 0);
  assert.equal(headers["cache-control"], NO_STORE);
  assert.equal(headers["content-type"], "text/plain; charset=utf-8");
});

//  residual 4 of: `absent` was the one outcome pinned for an hour
// on the strength of a payload nothing had checked. `featured_image` is
// `undefined` on a real coverless zPage AND on every 200 that is not a zPage
// at all — an LB error page, a service-mesh interstitial, a body that parses
// but is not the article, a future Django response shape. All of them took the
// `absent` branch and got a long shared TTL.
//
// Each fixture here is a 200. None is a zPage.
for (const [name, body] of [
  ["an empty object", {}],
  ["a DRF error body", { detail: "Not found." }],
  ["an LB interstitial that happens to be JSON", { error: "backend_error" }],
  // The gated envelope with a wrapper but no page inside it: the handler must
  // not fall back to reading the WRAPPER as the article.
  ["a gated envelope with no page", { show_modal: true }],
  // Shape-alike: everything a card is drawn from, and no zPage identity.
  // Proves the check is identity, not "does it have a title".
  [
    "a payload that merely looks article-shaped",
    {
      title: "Free2z-Flavored Markdown",
      description: "Special Free2z flavored Markdown extensions.",
      creator: { username: "free2z" },
    },
  ],
  ["a JSON null", null],
  ["a JSON array", []],
  ["a JSON string", "not an article"],
  // Identity-only: it carries the id it was asked about and is still an
  // ANSWER, not the article. This is the shape an auth or redaction change
  // would most plausibly grow, and an id-only recognition test waves it
  // through — house card, cacheable response, no signal.
  [
    "an envelope carrying the id but not the article",
    {
      free2zaddr: ZPAGE_ID,
      detail: "Authentication credentials were not provided.",
    },
  ],
  [
    "an article with an id and a title but no creator",
    { free2zaddr: ZPAGE_ID, title: "Free2z-Flavored Markdown" },
  ],
  [
    "an article whose creator is not an object",
    { free2zaddr: ZPAGE_ID, title: "t", creator: "free2z" },
  ],
  // `typeof [] === "object"`, so an array satisfies a naive object test,
  // reads `.username` as undefined, and renders the generic author.
  [
    "an article whose creator is an array",
    { free2zaddr: ZPAGE_ID, title: "t", creator: [] },
  ],
  // `{}` is what an answer-shaped envelope produces, and it renders as the
  // generic "Free2Z creator" byline. `username` is required on SimpleCreator,
  // so no real zPage looks like this.
  [
    "an article whose creator carries no username",
    { free2zaddr: ZPAGE_ID, title: "t", creator: {} },
  ],
]) {
  test(`an unvalidated 200 is not a settled \`absent\`: ${name}`, async () => {
    // Refused, not degraded. A 502 is retryable and explicitly no-store; a
    // social platform can still retain a copy it fetched before this response.
    const logs = [];
    const { status, headers } = await renderCard(null, {
      article: () => jsonResponse(body),
      logs,
    });
    assert.equal(status, 502, "a 200 that is not a zPage rendered a card");
    assert.equal(headers["cache-control"], NO_STORE);

    // Observable, not silent: `absent` is deliberately never logged, so
    // refusing without a line would make an upstream-shape incident invisible.
    const events = logs
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const refusals = events.filter((entry) => entry.event === "og_article");
    assert.equal(refusals.length, 1, "expected exactly one og_article line");
    assert.equal(refusals[0].reason, "unrecognized_article_payload");
    assert.equal(refusals[0].severity, "WARNING");
    assert.equal(refusals[0].zpage_id, ZPAGE_ID);
    // NOT on the cover-failure metric: no card was rendered, so counting this
    // as "a card rendered without its cover" would corrupt that alert.
    assert.deepEqual(
      events.filter((entry) => entry.event === "og_card"),
      [],
    );
  });
}

test("a real zPage with an empty title still renders a settled card", async () => {
  // The other side of the recognition predicate. It checks PRESENCE and TYPE,
  // never non-emptiness: `title` may legitimately be `''` — `buildSvg` has a
  // fallback for exactly that — and a check that demanded content would 502 a
  // real page.
  const { headers, body } = await renderCard(null, {
    article: () =>
      jsonResponse({
        free2zaddr: ZPAGE_ID,
        title: "",
        creator: { username: "free2z" },
      }),
  });
  assert.equal(headers["cache-control"], ARTICLE_CARD_CACHE);
  assert.equal(headers["x-og-cover"], "absent");
  assert.ok(body.byteLength > 0);
});

test("the fields the recognition check requires are all required on ZPageDetail", () => {
  // The fail-closed cost of the check above, made loud. The handler refuses
  // any article payload missing `free2zaddr`, `title` or `creator`, so if the
  // API ever drops, renames or optionalises one of them EVERY card 502s in
  // production. This pins the contract against the generated client — which CI
  // regenerates from `f2z.yaml`, which CI regenerates from the Django
  // serializers — so the shape change fails here, next to the code that
  // depends on it, instead of at the edge.
  //
  // Note the limit: this proves the DECLARED schema. A runtime envelope, a
  // proxy interstitial or an auth change that only appears in production is
  // invisible to it, which is what the og_article_refused metric and
  // monitoring/alert-policies/prod-og-article-refused.json exist for.
  const schemas = readFileSync(
    new URL("../src/lib/api/f2z.schemas.ts", import.meta.url),
    "utf8",
  );
  const detail = /export interface ZPageDetail \{([\s\S]*?)\n\}/.exec(schemas);
  assert.ok(detail, "ZPageDetail is no longer in the generated client");
  // Required (no `?` before the colon) AND of the type the handler checks.
  // Requiredness alone is not enough: a serializer change to
  // `free2zaddr: number` or `title: string | null` keeps the field required,
  // and the handler's `typeof` test would then reject real pages — a total
  // OG card outage with this test still green. `readonly` varies by field:
  // `title` and `creator` are writable, `free2zaddr` is not.
  for (const [field, type] of [
    ["free2zaddr", "string"],
    ["title", "string"],
    ["creator", "SimpleCreator"],
  ]) {
    assert.match(
      detail[1],
      new RegExp(`^\\s*(readonly )?${field}: ${type};$`, "m"),
      `the /og/zpage handler requires \`${field}\` to be present and to be ` +
        `\`${type}\`, and answers 502 otherwise. Making it optional, ` +
        "renaming it, or widening its type is a total OG card outage — " +
        "update the handler in the same change.",
    );
  }
  // The witness is `creator.username`, so SimpleCreator must still be an
  // object carrying a REQUIRED string `username`. If it became a bare id, or
  // username became optional or nullable, the handler would reject every real
  // zPage.
  const creator = /export interface SimpleCreator \{([\s\S]*?)\n\}/.exec(
    schemas,
  );
  assert.ok(creator, "SimpleCreator is no longer an object type in the client");
  assert.match(
    creator[1],
    /^\s*username: string;$/m,
    "the /og/zpage handler uses a required string `creator.username` as its " +
      "witness that a payload is a real zPage. Optionalising, nullabling or " +
      "renaming it is a total OG card outage.",
  );
});

test("the gated {show_modal, page} envelope is still a settled answer", async () => {
  // The other half of the identity check, driven through the REAL handler
  // rather than grepped from the source: a subscriber-only zPage answers 200
  // with the article nested under `page`, and those are exactly the pages
  // whose link someone is trying to sell. The card must carry the real title
  // and return the short shared-cache policy used for public articles.
  const gated = await renderCard(null, {
    article: () =>
      jsonResponse({
        show_modal: true,
        page: {
          free2zaddr: ZPAGE_ID,
          title: "Free2z-Flavored Markdown",
          description: "Special Free2z flavored Markdown extensions.",
          creator: { username: "free2z" },
        },
      }),
  });
  const bare = await renderCard(null);

  assert.equal(gated.headers["cache-control"], ARTICLE_CARD_CACHE);
  assert.equal(gated.headers["x-og-cover"], "absent");
  // Byte-identical to the same article delivered unwrapped: the envelope was
  // unwrapped, not rendered as a titleless card.
  assert.deepEqual(gated.body, bare.body);
});

test("a 200 whose body is not JSON fails retryably, not as a 500", async () => {
  // An HTML error page from an LB or ingress. `response.json()` throws, and an
  // unhandled throw here is a SvelteKit 500 whose edge caching contract this
  // route never chose. 502 is the same retryable answer the !response.ok
  // branch gives, which nginx maps to @seo_unavailable (no-store).
  const logs = [];
  const { status, headers } = await renderCard(null, {
    logs,
    article: () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/html" }),
      json: async () => {
        throw new SyntaxError("Unexpected token '<'");
      },
    }),
  });
  assert.equal(status, 502);
  assert.equal(headers["cache-control"], NO_STORE);

  // And it must land on the SAME metric as the unrecognized-JSON refusal.
  // These are one incident wearing two hats — an interstitial that arrives as
  // HTML versus one that arrives as JSON — so a proxy returning HTML would
  // otherwise leave `og_article_refused` at zero while every card 502s, with
  // /healthz green and nobody paged.
  const events = logs
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((entry) => entry?.event === "og_article");
  assert.equal(events.length, 1, "the non-JSON refusal is silent");
  assert.equal(events[0].reason, "article_body_not_json");
  assert.equal(events[0].severity, "WARNING");
  assert.equal(events[0].zpage_id, ZPAGE_ID);
});

// The regression this file exists for. Each of these is a failure a retry can
// fix, and each one used to be indistinguishable from "this page has no
// cover" by the time the cache-control header was written.
for (const [name, cover] of [
  ["storage 503s", () => statusResponse(503)],
  ["storage times out", () => Promise.reject(new Error("ETIMEDOUT"))],
  [
    "the connection resets",
    () => {
      throw new Error("ECONNRESET");
    },
  ],
  ["storage rate limits us", () => statusResponse(429)],
  // Covers are public objects read through our own gcsproxy, so "forbidden"
  // is a statement about OUR credentials — a Workload Identity or bucket-IAM
  // incident — not about the cover. Classifying it permanent would pin every
  // card rendered during such an incident coverless for an hour afterwards.
  ["our own credentials are refused", () => statusResponse(403)],
  [
    "the body truncates mid-transfer",
    () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "image/png" }),
      body: failingStream(),
    }),
  ],
  // Fewer bytes than the origin promised. A proxy can end the transfer
  // cleanly and leave a partial object behind, so nothing throws.
  [
    "the transfer is short of its declared length",
    () => ({
      ok: true,
      status: 200,
      headers: new Headers({
        "content-type": "image/png",
        "content-length": String(realCoverBytes.byteLength),
      }),
      body: streamOf(realCoverBytes.slice(0, 400)),
    }),
  ],
  // A body with no declared length that stops mid-image. Nothing distinguishes
  // a corrupt object from a cut-off stream here, so the tie goes to retryable.
  [
    "an undeclared-length body stops mid-image",
    () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "image/png" }),
      body: streamOf(realCoverBytes.slice(0, 40)),
    }),
  ],
  // The same thing for WebP, and it is NOT redundant: a truncated WebP fails
  // to parse rather than failing to terminate, so it reaches a different
  // branch. gcsproxy can answer chunked (no content-length), and a WebP cut
  // off after the RIFF/VP8X header used to be filed as a permanent
  // `undecodable_header` and cached for an hour -- the exact bug this file is
  // about, on the format covers are actually generated in.
  [
    "an undeclared-length WebP stops after its RIFF header",
    () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "image/webp" }),
      body: streamOf(webpBytes().slice(0, 20)),
    }),
  ],
  // A PNG whose IEND carries a non-zero length: not a terminated image, just
  // corruption that spells IEND. Resvg drops the raster silently, so without
  // the length check this renders a coverless card and reports `ok`.
  [
    "an undeclared-length PNG ends in a malformed IEND",
    () => {
      const head = realCoverBytes.slice(0, 33);
      const bytes = new Uint8Array(head.byteLength + 12);
      bytes.set(head, 0);
      new DataView(bytes.buffer).setUint32(head.byteLength, 1);
      bytes.set([0x49, 0x45, 0x4e, 0x44], head.byteLength + 4);
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "image/png" }),
        body: streamOf(bytes),
      };
    },
  ],
]) {
  test(`a transient failure remains uncached: ${name}`, async () => {
    const { headers, body } = await renderCard(cover);

    // A card still comes back — degrading to no image at all would be worse.
    assert.ok(body.byteLength > 0);
    assert.equal(headers["content-type"], "image/png");

    assert.equal(
      headers["cache-control"],
      NO_STORE,
      "a transient media failure must not create a derivative cache entry",
    );
    assert.equal(headers["x-og-cover"], "transient");
  });
}

test("the next request after a transient failure renders the real cover", async () => {
  // No derivative is cached, so after storage recovers the next origin render
  // can return the cover immediately.
  const degraded = await renderCard(() => statusResponse(502));
  const recovered = await renderCard(healthy);

  assert.equal(degraded.headers["cache-control"], NO_STORE);
  assert.equal(recovered.headers["cache-control"], ARTICLE_CARD_CACHE);
  assert.equal(recovered.headers["x-og-cover"], "ok");
  assert.notDeepEqual(
    recovered.body,
    degraded.body,
    "the retry produced a byte-identical card, so the cover never made it in",
  );
});

// The other half: a cover that is genuinely broken will not be fixed by
// asking again, so the generic card is a settled response eligible for the
// same short shared TTL. Transient failures above remain uncached.
for (const [name, cover] of [
  ["the cover 404s", () => statusResponse(404)],
  ["the cover is gone", () => statusResponse(410)],
  [
    "the object is not an image we render",
    () => imageResponse(realCoverBytes, "image/gif"),
  ],
  [
    "the object is not decodable",
    () => imageResponse(new Uint8Array(64), "image/png"),
  ],
  // The one Resvg cannot report. A PNG cut off after IHDR has a perfectly
  // valid signature, header and dimensions; @resvg/resvg-js 2.6.2 does not
  // throw on it, it silently DROPS the <image> and renders a card that is
  // byte-identical to the coverless one — so with only a header parse this was
  // reported `ok`, cached for an hour and logged as nothing. It lands here
  // rather than above because the declared length matches what arrived: the
  // transfer completed and the stored object is the broken part, which asking
  // again will not change.
  [
    "the stored object ends before its image data",
    () => imageResponse(realCoverBytes.slice(0, 40)),
  ],
  // The nastier sibling of the case above, and the one a chunk walk that only
  // looks for a terminator would wave through: signature + IHDR + a perfectly
  // well-formed zero-length IEND, and no IDAT anywhere. The chain terminates
  // correctly and carries no pixels at all. Pinned Resvg 2.6.2 renders it to a
  // card byte-identical to the coverless one without throwing, so before the
  // IDAT requirement this was `ok`, cached for an hour, and logged as nothing.
  [
    "the stored object terminates cleanly but carries no image data",
    () => {
      const bytes = new Uint8Array(45);
      bytes.set(realCoverBytes.slice(0, 33), 0); // signature + IHDR
      bytes.set([0x49, 0x45, 0x4e, 0x44], 37); // zero-length IEND, then its CRC
      bytes.set([0xae, 0x42, 0x60, 0x82], 41);
      return imageResponse(bytes);
    },
  ],
  // The same shape on the format covers are actually generated in, which makes
  // it the one that matters most. `readWebpDimensions` reads 800x630 straight
  // out of VP8X, so a RIFF that contains nothing BUT a VP8X parses cleanly,
  // passes the pixel budget and has no encoded image in it at all. Resvg
  // renders it to the coverless card without complaint.
  [
    "a WebP declares a canvas but contains no encoded image",
    () => imageResponse(webpBytes(), "image/webp"),
  ],
]) {
  test(`a permanent cover failure returns a short-lived generic card: ${name}`, async () => {
    const { headers } = await renderCard(cover);
    assert.equal(headers["cache-control"], ARTICLE_CARD_CACHE);
    assert.equal(headers["x-og-cover"], "permanent");
  });
}

test("a silently undecodable cover is not mistaken for a rendered one", async () => {
  // Belt and braces for the case above: assert the premise, so that a Resvg
  // upgrade which starts throwing (or starts rendering a placeholder) shows up
  // here rather than as a quietly wrong classification.
  const { Resvg } = await import("@resvg/resvg-js");
  const card = (href) =>
    new Resvg(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">' +
        (href ? `<image href="${href}" width="690" height="630"/>` : "") +
        '<rect width="8" height="630" fill="#a3e635"/></svg>',
      { fitTo: { mode: "width", value: 1200 } },
    )
      .render()
      .asPng();
  const truncated =
    "data:image/png;base64," +
    Buffer.from(realCoverBytes.slice(0, 40)).toString("base64");

  assert.deepEqual(
    Buffer.from(card(truncated)),
    Buffer.from(card(null)),
    "Resvg now reports a broken embedded raster somehow — good, but the " +
      "handler's classification should be revisited rather than left to " +
      "depend on a behaviour that changed",
  );
});

test("a degraded card is observable, not silent", async () => {
  // Before this, a swallowed `null` produced no signal anywhere: nobody could
  // have known this was happening, let alone how often. One bare JSON line per
  // degraded card, the shape `dj.apps.g12f.views.sitemap._log_sitemap_event`
  // uses, so Cloud Logging turns it into `jsonPayload` and
  // monitoring/log-metrics/og-card-cover-failures.json can count it.
  //
  // Per  the metric file counts nothing until bin/apply-monitoring.sh is
  // run; what is asserted here is only that the log line exists and parses.
  const logs = [];
  await renderCard(() => statusResponse(503), { logs });
  const events = logs
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((entry) => entry?.event === "og_card");

  assert.equal(events.length, 1, "expected exactly one og_card log line");
  assert.equal(events[0].outcome, "transient");
  assert.equal(events[0].status, 503);
  assert.equal(events[0].severity, "WARNING");
  assert.equal(events[0].zpage_id, ZPAGE_ID);

  // A page with a perfectly good cover must not log at all — a per-request log
  // line on the hot path is a cost, and a counter that also counts successes
  // cannot be alerted on.
  const quiet = [];
  await renderCard(healthy, { logs: quiet });
  assert.deepEqual(
    quiet.filter((line) => line.includes('"og_card"')),
    [],
  );
});

test("OG requests forward the canonical content language", async () => {
  let apiUrl;
  await renderCard(null, {
    language: "zh-Hans",
    onArticleFetch: (url) => {
      apiUrl = url;
    },
  });
  assert.equal(new URL(apiUrl).searchParams.get("lang"), "zh-Hans");
  await renderCard(null, {
    language: "cmn",
    onArticleFetch: (url) => {
      apiUrl = url;
    },
  });
  assert.equal(new URL(apiUrl).searchParams.get("lang"), "cmn");
  for (const language of ["", "ZH_hans", "en-x-private", "a".repeat(100)]) {
    const { status, headers } = await renderCard(null, { language });
    assert.equal(status, 400);
    assert.equal(headers["cache-control"], NO_STORE);
  }
});

test("a noisy photographic cover stays visible below the encoded byte budget", async () => {
  const pixels = Buffer.alloc(800 * 630 * 3);
  let state = 123456789;
  for (let i = 0; i < pixels.length; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    pixels[i] = state & 255;
  }
  const cover = await sharp(pixels, {
    raw: { width: 800, height: 630, channels: 3 },
  })
    .jpeg({ quality: 95 })
    .toBuffer();
  const { headers, body } = await renderCard(() =>
    imageResponse(cover, "image/jpeg"),
  );
  assert.equal(headers["x-og-cover"], "ok");
  assert.ok(body.byteLength <= 550_000, `encoded ${body.byteLength} bytes`);
  const { data, info } = await sharp(body)
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 1200);
  assert.equal(info.height, 630);
  const center = (315 * info.width + 850) * info.channels;
  assert.ok(
    data[center] + data[center + 1] + data[center + 2] > 100,
    "cover must not disappear into the dark fallback",
  );
});
