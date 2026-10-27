// Tag-COVERAGE gate for issue  phase 3 — "retire the card tier".
//
// Free2Z serves social cards from two places today: the Django crawler
// prerender (`py/free2z/dj/apps/g12f/views/crawler.py` + `templates/zpage/social.html`,
// reached by a UA sniff in nginx) and SvelteKit SSR. The plan is to delete the
// Django tier and point every unfurler at SSR. So this file derives the
// expected tag set from the Django template FILE and checks it against what
// `buildZPageMeta()` returns at runtime. Add a `<meta>` to `zpage/social.html`
// and this fails until SSR covers it too; delete the Django tier and the whole
// file goes with it.
//
// READ THIS BEFORE TREATING A GREEN RUN AS "the cards will not change":
// it is a check on which tag NAMES exist, plus value assertions on the handful
// of tags whose values must be identical. The two tiers deliberately disagree
// on several VALUES and always have:
//
//   og:title / twitter:title  SSR appends " | Free2Z"; Django does not.
//   og:site_name              SSR "Free2Z"; Django "Free2Z - {creator name}".
//   og:type                   SSR "article" (correct); Django "website".
//   og:image / twitter:image  SSR renders a branded card at /og/zpage/*.png;
//                             Django links the creator's featured image.
//   description               different truncation rules and lengths.
//
// Those are intended improvements, not regressions, but they mean the cards
// WILL look different after the cutover. Nothing here — and nothing in CI —
// proves otherwise, which is why  phase 3 also requires a human to verify
// real unfurls on X, Facebook, Slack, Discord, WhatsApp and Telegram before the
// Django tier is deleted. Do not let this file stand in for that.
//
// Known live blocker as of this writing: `/og/zpage/*.png` 404s in production
// (nginx never routes `/og/` to SSR), so SSR's `og:image` currently
// points at nothing. That must be fixed before, not after, the cutover.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { deflateSync } from "node:zlib";
import { createServer } from "vite";

const DJANGO_CARD_TEMPLATE = new URL(
  "../../../../py/free2z/dj/apps/g12f/templates/zpage/social.html",
  import.meta.url,
);
const VANITY_ROUTE = new URL(
  "../src/routes/[username]/[vanity]/+page.svelte",
  import.meta.url,
);
const ARTICLE_ROUTE = new URL(
  "../src/routes/article/[id]/+page.svelte",
  import.meta.url,
);
const OG_IMAGE_ROUTE = new URL(
  "../src/routes/og/zpage/[id].png/+server.ts",
  import.meta.url,
);

// Django tags SSR deliberately does NOT mirror, each with the reason it is not
// a regression. This map is the escape hatch and it is meant to stay tiny — a
// NEW Django tag is a failure, not a silent addition here.
const NOT_MIRRORED = {
  // Microdata from the Google+ era. Django's own copies are inert: `itemprop`
  // is only meaningful inside an element carrying `itemscope`/`itemtype`, and
  // nothing in `social.html` does. SSR states the same three facts in the
  // JSON-LD `Article` block (`headline`, `description`, `image`), which is the
  // form Google actually documents. Mirroring invalid markup to make a set
  // comparison come out even would be the tail wagging the dog.
  itemprop:
    "superseded by the JSON-LD Article graph; Django's copies are inert",
};

let buildZPageMeta;
let fetchCoverImage;
let readImageDimensions;
let selectCoverSource;
let server;

before(async () => {
  server = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  ({ buildZPageMeta } = await server.ssrLoadModule("/src/lib/meta.ts"));
  ({ fetchCoverImage, readImageDimensions, selectCoverSource } =
    await server.ssrLoadModule("/src/lib/server/og-image.ts"));
});

after(async () => {
  await server?.close();
});

/** Every `<meta>` key the Django card template emits, as `attr:value` pairs. */
function djangoCardKeys() {
  const html = readFileSync(DJANGO_CARD_TEMPLATE, "utf8")
    // Drop the `{% comment %}` header so its prose cannot be mined for tags.
    .replace(/\{%\s*comment\s*%\}[\s\S]*?\{%\s*endcomment\s*%\}/g, "");
  const keys = new Set();
  for (const [, tag] of html.matchAll(/<meta\s([^>]*?)\/?>/g)) {
    const attr = /\b(property|name|itemprop)\s*=\s*"([^"]+)"/.exec(tag);
    if (!attr) continue; // `<meta charset>` carries no key
    keys.add(`${attr[1]}:${attr[2]}`);
  }
  return keys;
}

/** A representative published zPage payload, shaped like `ZPageDetail`. */
function article(overrides = {}) {
  return {
    free2zaddr: "0f7e1a2b-3c4d-5e6f-7a8b-9c0d1e2f3a4b",
    vanity: "flavored-markdown",
    title: "Free2z-Flavored Markdown",
    description: "Special Free2z flavored Markdown extensions.",
    content: "# Heading\n\nBody copy.",
    creator: { username: "free2z" },
    created_at: "2024-09-01T00:00:00Z",
    updated_at: "2024-09-06T21:52:47.050295Z",
    tags: ["markdown"],
    ...overrides,
  };
}

function ssrKeys(meta) {
  return new Set(
    meta.tags.map((tag) =>
      tag.props.property
        ? `property:${tag.props.property}`
        : `name:${tag.props.name}`,
    ),
  );
}

test("SSR emits every tag the Django card tier emits", () => {
  const emitted = ssrKeys(buildZPageMeta(article()));
  const missing = [...djangoCardKeys()]
    .filter((key) => !emitted.has(key))
    .filter((key) => !(key.split(":")[0] in NOT_MIRRORED))
    .sort();

  assert.deepEqual(
    missing,
    [],
    "These <meta> tags exist in py/free2z/dj/apps/g12f/templates/zpage/social.html " +
      "but not in buildZPageMeta(). The Django card tier cannot be retired " +
      "(#953 phase 3) while SSR drops information a card already carries — " +
      "add them to src/lib/meta.ts, or, if a tag genuinely should not be " +
      "mirrored, record it in NOT_MIRRORED with the reason.",
  );
});

test("the exemption list stays honest", () => {
  const djangoAttrs = new Set(
    [...djangoCardKeys()].map((key) => key.split(":")[0]),
  );
  const stale = Object.keys(NOT_MIRRORED).filter(
    (attr) => !djangoAttrs.has(attr),
  );
  assert.deepEqual(
    stale,
    [],
    "NOT_MIRRORED excuses something the Django template no longer emits — " +
      "delete the entry.",
  );
});

const value = (meta, name) =>
  meta.tags.find(
    (tag) => tag.props.name === name || tag.props.property === name,
  )?.props.content;

// Spelled out literally as well as set-wise, because the set check above would
// also pass if someone deleted these from BOTH sides.
test("attribution tags match the Django card verbatim", () => {
  const meta = buildZPageMeta(article());

  assert.equal(value(meta, "twitter:site"), "@free2zcash");
  assert.equal(value(meta, "twitter:creator"), "@free2zcash");
  assert.equal(value(meta, "fb:app_id"), "278755727751440");
  assert.ok(value(meta, "twitter:image")?.startsWith("https://"));
  assert.ok(value(meta, "twitter:image:alt"));
});

// `und` is what `actual_language` resolves to for the pre-multilingual back
// catalogue, and production really does serve `og:locale` content="und" — a
// value no consumer accepts. Django emits no og:locale at all, so this is not
// a parity gap; it is a defect that only starts to matter once SSR is the sole
// card tier.
test("og:locale is a locale, never a bare or undetermined subtag", () => {
  const localeOf = (actual_language) =>
    value(buildZPageMeta(article({ actual_language })), "og:locale");

  assert.equal(localeOf("und"), "en_US");
  assert.equal(localeOf(undefined), "en_US");
  assert.equal(localeOf("en"), "en_US");
  assert.equal(localeOf("es"), "es_ES");
  assert.equal(localeOf("fr"), "fr_FR");
  assert.equal(localeOf("pt-BR"), "pt_BR");
});

test("og:locale names the article's own language, not the UI's", () => {
  // This table was the last reader-path UI-locale lookup: a published
  // `zh-Hans` article unfurled as `en_US` beside a Chinese `og:title`. The
  // region comes from CLDR, so the value is a real locale rather than a guess.
  const localeOf = (actual_language) =>
    value(buildZPageMeta(article({ actual_language })), "og:locale");

  assert.equal(localeOf("zh-Hans"), "zh_CN");
  assert.equal(localeOf("zh-Hant"), "zh_TW");
  assert.equal(localeOf("ja"), "ja_JP");
  assert.equal(localeOf("pt-PT"), "pt_PT");
  // A tag that is not a language at all keeps the historical default...
  assert.equal(localeOf("und"), "en_US");
  //...but a "language" no runtime can expand into a locale is OMITTED rather
  // than asserted as English. Facebook ignores what it does not know, so an
  // absent tag costs nothing and a false one is a false claim about the text.
  const meta = buildZPageMeta(article({ actual_language: "klingon" }));
  assert.equal(
    meta.tags.filter((tag) => tag.props.property === "og:locale").length,
    0,
  );
});

test("the head is not the place to leak a paywalled body", () => {
  const secret = "PAYWALLED BODY COPY THAT MUST NOT UNFURL";
  // The API redacts `content` for gated pages — but only for readers who are
  // not the author, and SSR forwards the reader's cookie. Django never falls
  // back to the body for a subscriber-only card regardless of who is asking;
  // that is the stricter rule, so it is the one SSR keeps.
  const meta = buildZPageMeta(
    article({ description: "", content: secret, is_subscriber_only: true }),
  );
  for (const tag of meta.tags) {
    assert.ok(
      !tag.props.content.includes(secret),
      `paywalled body reached ${tag.props.name || tag.props.property}`,
    );
  }
  assert.equal(
    meta.tags.find((tag) => tag.props.name === "description")?.props.content,
    // Verbatim `crawler.SUBSCRIBER_ONLY_DESCRIPTION`. Describes access, not a
    // price: 2Z are platform credits, never money.
    "This page is available to subscribers on Free2Z.",
  );
  assert.equal(JSON.stringify(meta.jsonLd).includes(secret), false);

  // An author-written description is theirs to publish and still wins.
  const described = buildZPageMeta(
    article({
      description: "A teaser.",
      content: secret,
      is_subscriber_only: true,
    }),
  );
  assert.equal(
    described.tags.find((tag) => tag.props.name === "description")?.props
      .content,
    "A teaser.",
  );
});

// `og:image` points at `/og/zpage/{id}.png`, which re-fetches the article to
// draw the card. A subscriber-only zPage answers that call with
// `{show_modal, page}` instead of the article, and the handler used to cast the
// wrapper straight to `OgArticle` — so every gated page, the ones whose link
// someone is actually trying to sell, rendered a titleless, coverless card.
// Asserted against the source because the real handler needs Resvg plus a live
// API; the shape it must survive is the thing worth pinning.
test("the OG image handler survives the gated response shape", () => {
  const source = readFileSync(OG_IMAGE_ROUTE, "utf8");
  // The unwrap itself is now proved BEHAVIOURALLY, through the real handler,
  // in tests/og-card-failure-caching.test.mjs ("the gated {show_modal, page}
  // envelope is still a settled answer") — a source grep could only ever
  // confirm that a string is present. What is pinned here is the surrounding
  // contract, which has no runtime observable.
  assert.match(
    source,
    /record\.page/,
    "the /og/zpage handler must unwrap the gated {show_modal, page} envelope",
  );
  // The response is public media with a short shared TTL, so the request
  // that produces it must not depend on who asked. SvelteKit's `fetch` defaults to
  // `credentials: 'same-origin'` and `apiBase` falls back to `url.origin`, so
  // "we never pass a cookie" is only true because nobody writes one — the
  // forwarding would be implicit. Pin the explicit opt-out next to the cache
  // policy that protects a response after it leaves origin.
  // Quote style is the formatter's business  -- accept either.
  assert.match(source, /credentials: ['"]omit['"]/);
  // Every settled card has a short shared TTL, while errors and transient
  // fallbacks are no-store; tests cover both. Credentials are omitted so
  // this public image can never contain a session-only article response.
  assert.match(
    source,
    /ARTICLE_CARD_CACHE_CONTROL =\s*['"]public, max-age=0, s-maxage=60, must-revalidate['"]/,
  );
  // Comments stripped — they explain the hazard by naming it.
  assert.doesNotMatch(source.replace(/\/\/.*$/gm, ""), /\bcookie\b/i);
});

//  residual 3: Facebook, X and Slack keep their OWN copy of an unfurled
// card and do not honour origin cache headers, so a degraded card unfurled
// during a blip outlives any TTL we choose. The only lever we have over a
// third-party cache is the URL, and `?v=<updated_at>` is it: edit the page —
// which is what a creator does when they notice a wrong card — and the
// scrapers see a new resource.
//
// It has never been pinned by a test, which for a one-expression mitigation
// buried in `buildImage` means it could be dropped in a refactor and nothing
// would say so until someone reported a stale card weeks later. Note what this
// does NOT claim: `updated_at` changes with the CONTENT, not with the health
// of our media storage, so it cannot bust a card that went wrong while the
// page itself stayed still. That residual is unfixable from here — we cannot
// know at unfurl time that a PREVIOUS unfurl was degraded.
test("the OG image URL carries a cache buster the scrapers can see", () => {
  const imageOf = (overrides) =>
    buildZPageMeta(article(overrides)).tags.find(
      (tag) => tag.props.property === "og:image",
    )?.props.content;

  const url = new URL(imageOf());
  assert.equal(url.pathname, "/og/zpage/flavored-markdown.png");
  assert.equal(
    url.searchParams.get("renderer"),
    "5",
    "renderer fixes must retire cached blank cards",
  );
  assert.equal(
    url.searchParams.get("v"),
    "2024-09-06T21:52:47.050295Z",
    "og:image lost its ?v=<updated_at> buster — FB/X/Slack caches ignore " +
      "Cache-Control, so nothing else can retire a bad card (#1314)",
  );
  assert.match(
    url.searchParams.get("text") ?? "",
    /^[0-9a-f]{16}$/,
    "the image identity must include the rendered title/subtitle fingerprint",
  );

  // The property that matters: editing the page yields a DIFFERENT URL. A
  // constant, or a value keyed to something that never changes, would satisfy
  // the assertion above and still be inert.
  assert.notEqual(
    imageOf({ updated_at: "2025-01-02T03:04:05.000000Z" }),
    imageOf(),
    "the buster does not move when the page is edited, so it busts nothing",
  );
  assert.notEqual(
    imageOf({
      description: "A changed subtitle",
      updated_at: article().updated_at,
    }),
    imageOf(),
    "a text edit with an unchanged timestamp must still change derivative identity",
  );

  // twitter:image must carry it too, or X keeps unfurling the old card while
  // Facebook picks up the new one.
  assert.equal(
    buildZPageMeta(article()).tags.find(
      (tag) => tag.props.name === "twitter:image",
    )?.props.content,
    imageOf(),
  );
});

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, payload) {
  const chunk = new Uint8Array(payload.byteLength + 12);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, payload.byteLength);
  chunk.set(
    [...type].map((character) => character.charCodeAt(0)),
    4,
  );
  chunk.set(payload, 8);
  view.setUint32(
    payload.byteLength + 8,
    crc32(chunk.subarray(4, 8 + payload.byteLength)),
  );
  return chunk;
}

// A genuinely valid PNG: signature, IHDR, a real deflated IDAT, IEND.
//
// Both the IDAT and the IEND are load-bearing since. The cover reader
// treats a chunk chain that never terminates as a truncated TRANSFER
// (retryable), and a chain that terminates WITHOUT ever carrying an IDAT as a
// corrupt object -- because neither is something Resvg will complain about. It
// does not report a broken embedded raster at all; it silently drops the
// <image> and renders a card byte-identical to the coverless one. A
// signature+IHDR+IEND payload is exactly that shape: a well-formed chunk chain
// containing no pixels, which is why this fixture carries real image data
// rather than just a plausible header.
function pngHeader(width, height) {
  const raster = new Uint8Array(height * (1 + width * 4)); // filter byte + RGBA
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk(
      "IHDR",
      (() => {
        const ihdr = new Uint8Array(13);
        const view = new DataView(ihdr.buffer);
        view.setUint32(0, width);
        view.setUint32(4, height);
        ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit depth, RGBA, no interlace
        return ihdr;
      })(),
    ),
    pngChunk("IDAT", deflateSync(raster)),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const bytes = new Uint8Array(
    parts.reduce((total, p) => total + p.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

//  moved cover downloads onto a streaming, incrementally capped read, so
// fixtures must look like real undici responses: bytes arrive through `body`
// (a ReadableStream), not through `arrayBuffer()`. A bodyless fixture reads as
// an EMPTY payload, which the declared Content-Length then misclassifies as a
// short transfer (`length_mismatch`) before any image check can run.
function streamOf(bytes) {
  return new ReadableStream({
    start(controller) {
      if (bytes.byteLength > 0) controller.enqueue(bytes);
      controller.close();
    },
  });
}

function imageResponse(bytes, type = "image/png") {
  return {
    ok: true,
    headers: new Headers({
      "content-length": String(bytes.byteLength),
      "content-type": type,
    }),
    get body() {
      return streamOf(bytes);
    },
    arrayBuffer: async () => bytes.slice().buffer,
  };
}

test("the OG cover prefers a right-sized ladder rung before legacy fallbacks", () => {
  const image = {
    url: "/original.jpg",
    thumbnail: "/legacy.webp",
    variants: [
      { width: 1600, url: "/banner.webp" },
      { width: 400, url: "/card.webp" },
      { width: 800, url: "/og.webp" },
    ],
  };

  assert.equal(selectCoverSource(image), "/og.webp");
  assert.equal(
    selectCoverSource({
      ...image,
      variants: [{ width: 400, url: "/card.webp" }],
    }),
    "/card.webp",
  );
  assert.equal(selectCoverSource({ ...image, variants: [] }), "/legacy.webp");
  assert.equal(selectCoverSource({ url: "/original.jpg" }), "/original.jpg");
});

test("the OG image guard rejects oversized pixels before creating a data URI", async () => {
  // Both dimensions are below the per-axis ceiling, but the image still
  // represents more decoded pixels than the guard permits — and it compresses
  // to a few KB, so the byte ceiling never gets a chance to reject it first.
  const oversized = pngHeader(1600, 1600);
  const safe = pngHeader(800, 630);
  const base = new URL("https://free2z.cash/");

  assert.deepEqual(readImageDimensions(oversized, "image/png"), {
    width: 1600,
    height: 1600,
  });
  assert.deepEqual(
    await fetchCoverImage(
      async () => imageResponse(oversized),
      "/oversized.png",
      base,
    ),
    {
      dataUri: null,
      outcome: "permanent",
      reason: "pixel_budget_exceeded",
      status: undefined,
    },
  );
  const rendered = await fetchCoverImage(
    async () => imageResponse(safe),
    "/safe.png",
    base,
  );
  assert.equal(rendered.outcome, "ok");
  assert.match(rendered.dataUri, /^data:image\/png;base64,/);
  assert.equal(readImageDimensions(safe.subarray(0, 24), "image/png"), null);
  // The same header with its chunk chain cut off is not a usable image, and
  // Resvg will not say so -- it drops the <image> and renders a card that is
  // byte-identical to the coverless one. Caught here instead.
  assert.equal(
    (
      await fetchCoverImage(
        async () => imageResponse(safe.subarray(0, 33)),
        "/truncated.png",
        base,
      )
    ).reason,
    "corrupt_image_data",
  );
  assert.equal(readImageDimensions(safe, "image/gif"), null);
});

test("a short transfer of an oversized image is classified by its delivery, not its pixels", async () => {
  // Deliberate precedence: Content-Length disagreement means the TRANSFER is
  // broken and a retry may deliver intact bytes, so it wins over every
  // verdict about the object — even one as serious as the pixel bomb below.
  // Calling this `pixel_budget_exceeded` would cache the rejection for an
  // hour on evidence from a payload we never received in full; calling the
  // delivery broken keeps the security guarantee (an INTACT over-budget image
  // is still permanent, per the test above) without baking a verdict into a
  // body we cannot trust.
  const oversized = pngHeader(1600, 1600);
  const base = new URL("https://free2z.cash/");
  const result = await fetchCoverImage(
    async () => ({
      ok: true,
      headers: new Headers({
        // Declares more than arrives: an internally inconsistent delivery.
        "content-length": String(oversized.byteLength),
        "content-type": "image/png",
      }),
      body: streamOf(oversized.subarray(0, 64)),
    }),
    "/short-bomb.png",
    base,
  );
  assert.equal(result.outcome, "transient");
  assert.equal(result.reason, "length_mismatch");
});

// Production served `<meta property="og:description" … class="svelte-pq5o27"/>`
// because the head loop spread `{...tag.props}` onto `<meta>`: a spread hides
// the attribute names from the compiler, so Svelte cannot rule out a match
// against the component's scoped `<style>` and stamps the scoping class on
// defensively. Parsers ignore it, but SSR is about to be the only tier
// producing cards, so it emits the attributes explicitly instead.
test("meta tags are written out, not spread", () => {
  for (const route of [VANITY_ROUTE, ARTICLE_ROUTE]) {
    const source = readFileSync(route, "utf8");
    const head = /<svelte:head>([\s\S]*?)<\/svelte:head>/
      .exec(source)?.[1]
      // The comments in there explain the bug by quoting the broken form.
      .replace(/<!--[\s\S]*?-->/g, "");
    assert.ok(head, `no <svelte:head> in ${route.pathname}`);
    assert.doesNotMatch(
      head,
      /<meta\s+\{\.\.\./,
      `${route.pathname} spreads props onto <meta>, which makes Svelte stamp ` +
        "a scoped-style class onto every social tag",
    );
    assert.match(head, /<meta property=\{tag\.props\.property\}/);
    assert.match(head, /<meta name=\{tag\.props\.name\}/);
  }
});

test("translated variants have distinct language-specific image URLs", () => {
  const imageOf = (language) =>
    buildZPageMeta(article({ actual_language: language })).tags.find(
      (tag) => tag.props.property === "og:image",
    ).props.content;
  const english = new URL(imageOf("en"));
  const chinese = new URL(imageOf("zh-Hans"));
  assert.equal(english.searchParams.get("lang"), "en");
  assert.equal(chinese.searchParams.get("lang"), "zh-Hans");
  assert.notEqual(english.href, chinese.href);
  assert.equal(new URL(imageOf("cmn")).searchParams.get("lang"), "cmn");
  assert.notEqual(imageOf("cmn"), imageOf("zh"));
  assert.equal(new URL(imageOf("und")).searchParams.has("lang"), false);
});

test("translation text edits invalidate the image without a parent timestamp change", () => {
  const variant = article({
    actual_language: "es",
    title: "Título",
    description: "Descripción",
  });
  const imageOf = (value) =>
    buildZPageMeta(value).tags.find((tag) => tag.props.property === "og:image")
      .props.content;
  const initial = new URL(imageOf(variant));
  for (const edited of [
    { ...variant, title: "Título corregido" },
    { ...variant, description: "Descripción corregida" },
  ]) {
    const image = new URL(imageOf(edited));
    assert.equal(image.searchParams.get("v"), initial.searchParams.get("v"));
    assert.equal(image.searchParams.get("lang"), "es");
    assert.notEqual(
      image.searchParams.get("text"),
      initial.searchParams.get("text"),
    );
  }
  assert.equal(imageOf({ ...variant }), initial.href);
});

test("card text revision tracks public body fallback but excludes hidden and unused body", () => {
  const imageOf = (value) =>
    buildZPageMeta(value).tags.find((tag) => tag.props.property === "og:image")
      .props.content;
  const variant = article({
    actual_language: "es",
    description: "",
    content: "Texto original",
  });
  assert.notEqual(
    imageOf(variant),
    imageOf({ ...variant, content: "Texto corregido" }),
  );
  const described = { ...variant, description: "Visible description" };
  assert.equal(
    imageOf(described),
    imageOf({ ...described, content: "Unused content" }),
  );
  const gated = { ...variant, is_subscriber_only: true };
  assert.equal(
    imageOf(gated),
    imageOf({ ...gated, content: "Hidden correction" }),
  );
});

test("card revisions use the media-filtered text and retire old rendered cards", () => {
  const imageOf = (value) =>
    new URL(
      buildZPageMeta(value).tags.find(
        (tag) => tag.props.property === "og:image",
      ).props.content,
    );
  const directive = `::embed[/uploadz/public/creator/${"x".repeat(220)}.mp4]`;
  const variant = article({
    actual_language: "es",
    description: "",
    content: `${directive}\n\nVisible original text.`,
  });
  const original = imageOf(variant);

  assert.equal(original.searchParams.get("renderer"), "5");
  assert.notEqual(
    imageOf({
      ...variant,
      content: `${directive}\n\nVisible corrected text.`,
    }).searchParams.get("text"),
    original.searchParams.get("text"),
  );
  assert.equal(
    imageOf({
      ...variant,
      content: `::embed[/uploadz/public/creator/other.mp4]\n\nVisible original text.`,
    }).searchParams.get("text"),
    original.searchParams.get("text"),
  );
});

test("card revisions use bounded visible text after markup removal", () => {
  const imageOf = (value) =>
    buildZPageMeta(value).tags.find((tag) => tag.props.property === "og:image")
      .props.content;
  const variant = article({
    actual_language: "es",
    description: "",
    content: "Visible text. ".repeat(7500),
  });
  const original = imageOf(variant);
  assert.equal(
    imageOf({
      ...variant,
      content: variant.content + "Changed after the visible subtitle",
    }),
    original,
  );
  // Raw-prefix truncation would lose both visible strings behind this markup.
  const markup = '<span data-note="' + "x".repeat(99_000) + '"></span>';
  assert.notEqual(
    imageOf({ ...variant, content: markup + "First visible text" }),
    imageOf({ ...variant, content: markup + "Corrected visible text" }),
  );
  // Equivalent renderer-facing text must not churn the consumer image cache.
  assert.equal(
    imageOf({ ...variant, content: "**Same** subtitle" }),
    imageOf({ ...variant, content: "Same subtitle" }),
  );
});
