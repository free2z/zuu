import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

import {
  CANONICAL_URL_MAX_LENGTH,
  getCanonicalUrlError,
  selectCanonicalUrl,
} from "../src/lib/canonical-url.js";
import { saveWithCanonicalAutosaveFallback } from "../src/lib/canonical-save.js";
import {
  focusFirstInvalidField,
  setCanonicalDisclosureExpanded,
  shouldExpandCanonicalDisclosure,
} from "../src/lib/canonical-publish.js";

let vite;
let buildZPageMeta;
let legacyZPageRedirect;
let getSitemapIndex;
let getSitemapV2Index;
let getStaticSitemap;
let getSitemapChild;
let loadSitemapIndex;
let loadSitemapChunk;
let assertSitemapByteLength;
const previousApiBase = process.env.PRIVATE_API_BASE_URL;

before(async () => {
  process.env.PRIVATE_API_BASE_URL = "https://api.free2z.test";
  vite = await createServer({
    appType: "custom",
    server: { hmr: false, middlewareMode: true },
  });
  ({ buildZPageMeta } = await vite.ssrLoadModule("/src/lib/meta.ts"));
  ({ load: legacyZPageRedirect } = await vite.ssrLoadModule(
    "/src/routes/[username]/zpage/[slug]/+page.server.ts",
  ));
  ({ GET: getSitemapIndex, _loadSitemapIndex: loadSitemapIndex } =
    await vite.ssrLoadModule("/src/routes/sitemap.xml/+server.ts"));
  ({ GET: getSitemapV2Index } = await vite.ssrLoadModule(
    "/src/routes/sitemap-v2.xml/+server.ts",
  ));
  ({ GET: getStaticSitemap } = await vite.ssrLoadModule(
    "/src/routes/sitemap/static.xml/+server.ts",
  ));
  ({ GET: getSitemapChild, _loadSitemapChunk: loadSitemapChunk } =
    await vite.ssrLoadModule(
      "/src/routes/sitemap/[kind]/[page].xml/+server.ts",
    ));
  ({ assertSitemapByteLength } = await vite.ssrLoadModule(
    "/src/lib/server/sitemap.ts",
  ));
});

after(async () => {
  await vite?.close();
  if (previousApiBase === undefined) {
    delete process.env.PRIVATE_API_BASE_URL;
  } else {
    process.env.PRIVATE_API_BASE_URL = previousApiBase;
  }
});

test("accepts absolute HTTP(S) canonical URLs and optional blank values", () => {
  assert.equal(getCanonicalUrlError(""), null);
  assert.equal(getCanonicalUrlError("https://example.com/original"), null);
  assert.equal(
    getCanonicalUrlError("http://blog.example.test/posts/42?ref=archive"),
    null,
  );
});

test("rejects relative, non-HTTP, credentialed, and fragment URLs", () => {
  assert.equal(getCanonicalUrlError("example.com/original"), "invalid");
  assert.equal(getCanonicalUrlError("/original"), "invalid");
  assert.equal(getCanonicalUrlError("ftp://example.com/original"), "invalid");
  assert.equal(
    getCanonicalUrlError("https://user:secret@example.com/original"),
    "credentials",
  );
  assert.equal(
    getCanonicalUrlError("https://example.com/original#comments"),
    "fragment",
  );
  assert.equal(
    getCanonicalUrlError(
      `https://example.com/${"a".repeat(CANONICAL_URL_MAX_LENGTH)}`,
    ),
    "too_long",
  );
});

test("matches Django URL validation for host, slash, and whitespace edge cases", () => {
  for (const candidate of [
    "https://example..com/article",
    "https://-example.com/article",
    "https:example.com/article",
    "https://example.com/a b",
  ]) {
    assert.equal(getCanonicalUrlError(candidate), "invalid", candidate);
  }
});

test("canonical disclosure is compact by default and expanded for existing metadata", () => {
  assert.equal(shouldExpandCanonicalDisclosure(""), false);
  assert.equal(shouldExpandCanonicalDisclosure("   "), false);
  assert.equal(
    shouldExpandCanonicalDisclosure("https://publisher.example/original"),
    true,
  );
});

test("collapsing canonical disclosure preserves its value", () => {
  const value = "https://publisher.example/original";
  const state = setCanonicalDisclosureExpanded(
    { expanded: true, value },
    false,
  );

  assert.deepEqual(state, { expanded: false, value });
});

test("failed actions scroll and focus the first invalid field", () => {
  const calls = [];
  const field = {
    scrollIntoView(options) {
      calls.push(["scroll", options]);
    },
    focus(options) {
      calls.push(["focus", options]);
    },
  };
  const root = {
    querySelector(selector) {
      assert.equal(selector, '[aria-invalid="true"], [data-invalid="true"]');
      return field;
    },
  };

  assert.equal(focusFirstInvalidField(root), true);
  assert.deepEqual(calls, [
    ["scroll", { behavior: "smooth", block: "center" }],
    ["focus", { preventScroll: true }],
  ]);
  assert.equal(focusFirstInvalidField({ querySelector: () => null }), false);
});

test("selects a valid external canonical URL and otherwise keeps the fallback", () => {
  const fallback = "https://free2z.com/alice/article";
  assert.equal(
    selectCanonicalUrl("https://alice.example/original", fallback),
    "https://alice.example/original",
  );
  assert.equal(selectCanonicalUrl("", fallback), fallback);
  assert.equal(selectCanonicalUrl("/relative", fallback), fallback);
});

function article(canonicalUrl = "") {
  return {
    title: "Republished story",
    content: "Article body",
    description: "Article description",
    canonical_url: canonicalUrl,
    vanity: "republished-story",
    free2zaddr: "page-id",
    // Mirrors zPage.get_url() exactly: `/{username}/zpage/{vanity or addr}`.
    // The `zpage` segment sits in the MIDDLE, not at the start.
    get_url: "/alice/zpage/republished-story",
    creator: { username: "alice" },
    created_at: "2026-07-20T12:00:00Z",
    updated_at: "2026-07-21T12:00:00Z",
    publish_at: null,
    tags: ["publishing"],
    category: "TECHNOLOGY",
    is_subscriber_only: false,
  };
}

const translate = (_key, fallback, params = {}) =>
  fallback.replace("{title}", String(params.title ?? ""));

function tagContent(meta, selector, value) {
  return meta.tags.find((tag) => tag.props[selector] === value)?.props.content;
}

test("external canonical URL drives link, social, and structured metadata", () => {
  const external = "https://publisher.example/posts/original";
  const meta = buildZPageMeta(article(external), { translate });

  assert.equal(meta.canonical, external);
  assert.equal(tagContent(meta, "property", "og:url"), external);
  assert.equal(tagContent(meta, "name", "twitter:url"), external);
  assert.equal(meta.jsonLd.url, external);
  assert.deepEqual(meta.jsonLd.mainEntityOfPage, {
    "@type": "WebPage",
    "@id": external,
  });
  assert.equal(meta.jsonLd["@id"], `${external}#article`);
});

test("blank canonical URL falls back consistently to the Free2Z article URL", () => {
  const meta = buildZPageMeta(article(), { translate });
  const fallback = "https://free2z.cash/alice/republished-story";

  assert.equal(meta.canonical, fallback);
  assert.equal(tagContent(meta, "property", "og:url"), fallback);
  assert.equal(tagContent(meta, "name", "twitter:url"), fallback);
  assert.equal(meta.jsonLd.url, fallback);
  assert.equal(meta.jsonLd.mainEntityOfPage["@id"], fallback);
  assert.equal(meta.jsonLd["@id"], `${fallback}#article`);
});

// A zPage that never got a vanity: `vanity` is null, so the legacy
// `get_url` field resolves to `/{username}/zpage/{free2zaddr}`.
function vanitylessArticle(overrides = {}) {
  return {
    ...article(),
    vanity: null,
    free2zaddr: "3f9a1c2e-0000-4000-8000-abcdefabcdef",
    get_url: "/alice/zpage/3f9a1c2e-0000-4000-8000-abcdefabcdef",
    ...overrides,
  };
}

// Ask the real `[username]/zpage/[slug]` route where a path goes. Returns the
// 301 Location, or null when the route does not redirect that path.
async function legacyRedirectLocation(username, slug, page = {}) {
  const resolvedPage = {
    creator: { username },
    vanity: slug,
    free2zaddr: slug,
    ...page,
  };
  try {
    await legacyZPageRedirect({
      params: { username, slug },
      url: new URL(
        `https://free2z.test/${encodeURIComponent(username)}/zpage/${encodeURIComponent(slug)}`,
      ),
      request: { headers: new Headers() },
      setHeaders: () => {},
      fetch: async (input) => {
        assert.match(
          String(input),
          new RegExp(`/api/zpage/${encodeURIComponent(slug)}/$`),
        );
        return Response.json(resolvedPage);
      },
    });
  } catch (thrown) {
    if (thrown?.status === 301) return thrown.location;
    throw thrown;
  }
  return null;
}

test("vanity-less canonical points at the 200, not the URL that 301s", async () => {
  const page = vanitylessArticle();
  const meta = buildZPageMeta(page, { translate });
  const canonicalPath = new URL(meta.canonical).pathname;

  // The legacy shape genuinely redirects — assert it against the route that
  // performs the redirect, not against a hand-copied string.
  const location = await legacyRedirectLocation("alice", page.free2zaddr, page);
  assert.equal(location, `/alice/${page.free2zaddr}`);

  // Before  the canonical WAS the legacy shape, because the strip regex
  // was anchored with `^` and `zpage/` sits mid-path. Pin both directions.
  assert.equal(canonicalPath, location);
  assert.equal(canonicalPath, `/alice/${page.free2zaddr}`);
  assert.notEqual(
    canonicalPath,
    new URL(page.get_url, meta.canonical).pathname,
  );
  assert.doesNotMatch(canonicalPath, /\/zpage\//);

  // og:url, twitter:url and the JSON-LD identity all follow the canonical.
  const expected = `https://free2z.cash/alice/${page.free2zaddr}`;
  assert.equal(meta.canonical, expected);
  assert.equal(tagContent(meta, "property", "og:url"), expected);
  assert.equal(tagContent(meta, "name", "twitter:url"), expected);
  assert.equal(meta.jsonLd.url, expected);
  assert.equal(meta.jsonLd["@id"], `${expected}#article`);
});

test("vanity pages keep their existing canonical and never hit the 301 route", async () => {
  const meta = buildZPageMeta(article(), { translate });

  assert.equal(meta.canonical, "https://free2z.cash/alice/republished-story");
  assert.equal(
    await legacyRedirectLocation("alice", "republished-story", article()),
    "/alice/republished-story",
  );
  // An empty-string vanity is not a vanity; fall through to free2zaddr.
  assert.equal(
    buildZPageMeta(vanitylessArticle({ vanity: "" }), { translate }).canonical,
    `https://free2z.cash/alice/${vanitylessArticle().free2zaddr}`,
  );
});

test("legacy redirects resolve identity before escaping route collisions", async () => {
  assert.equal(
    await legacyRedirectLocation("alice", "broadcast", {
      creator: { username: "alice" },
      vanity: "broadcast",
      free2zaddr: "collision-safe-address",
    }),
    "/alice/collision-safe-address",
  );
  assert.equal(
    await legacyRedirectLocation("api", "ordinary-vanity", {
      creator: { username: "api" },
      vanity: "ordinary-vanity",
      free2zaddr: "immutable-address",
    }),
    "/article/immutable-address",
  );
  assert.equal(
    await legacyRedirectLocation("alice", "ordinary-vanity"),
    "/alice/ordinary-vanity",
  );
});

test("legacy redirect lookup encodes a decoded route parameter", async () => {
  assert.equal(
    await legacyRedirectLocation("alice", "../get-type/scanner-unique?x", {
      creator: { username: "alice" },
      vanity: "scanner-safe",
      free2zaddr: "scanner-address",
    }),
    "/alice/scanner-safe",
  );
});

test("canonical path segments are URL-encoded for both vanity and address", () => {
  const encoded = buildZPageMeta(
    { ...article(), creator: { username: "a b" }, vanity: "c/d" },
    { translate },
  );
  assert.equal(new URL(encoded.canonical).pathname, "/a%20b/c%2Fd");

  const addr = buildZPageMeta(
    vanitylessArticle({ free2zaddr: "e f", creator: { username: "alice" } }),
    { translate },
  );
  assert.equal(new URL(addr.canonical).pathname, "/alice/e%20f");
});

test("canonical metadata never points an article at a reserved subroute", () => {
  for (const vanity of [
    "broadcast",
    "dashboard",
    "null",
    "ppv",
    "private",
    "subscribers-only",
    "undefined",
    "zpage",
  ]) {
    const reservedVanity = buildZPageMeta(
      { ...article(), vanity, free2zaddr: "safe-address" },
      { translate },
    );
    assert.equal(
      new URL(reservedVanity.canonical).pathname,
      "/alice/safe-address",
      vanity,
    );
  }

  const reservedAddress = buildZPageMeta(
    { ...article(), vanity: "safe-vanity", free2zaddr: "broadcast" },
    { translate },
  );
  assert.equal(
    new URL(reservedAddress.canonical).pathname,
    "/alice/safe-vanity",
  );

  const noSafeIdentifier = buildZPageMeta(
    { ...article(), vanity: "broadcast", free2zaddr: "ppv", get_url: "" },
    { translate },
  );
  assert.equal(new URL(noSafeIdentifier.canonical).pathname, "/article/ppv");
});

test("every Svelte zPage URL emitter uses the collision-safe path helper", () => {
  for (const path of [
    "../src/lib/components/zpageActions/ShareButton.svelte",
    "../src/lib/components/ZpageCard.svelte",
    "../src/lib/components/RelatedZpageCard.svelte",
    "../src/lib/components/SearchResultCard.svelte",
    "../src/lib/components/SeriesSearchResultCard.svelte",
    "../src/lib/components/layout/SearchCommand.svelte",
    "../src/routes/[username]/[vanity]/+page.server.ts",
    "../src/routes/[username]/zpage/[slug]/+page.server.ts",
    "../src/routes/[username]/dashboard/pages/+page.svelte",
    "../src/routes/[username]/dashboard/profile/+page.svelte",
    "../src/routes/edit/+page.svelte",
    "../src/routes/+page.svelte",
    "../src/lib/server/sitemap.ts",
  ]) {
    const source = fs.readFileSync(new URL(path, import.meta.url), "utf8");
    assert.match(source, /zpageCanonicalPath\s*\(/, path);
  }

  const prettyLoader = fs.readFileSync(
    new URL(
      "../src/routes/[username]/[vanity]/+page.server.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    prettyLoader,
    /const canonicalPath = zpageCanonicalPath\(article\)/,
  );
  assert.match(
    prettyLoader,
    /redirect\(301, `\$\{canonicalPath\}\$\{url\.search\}`\)/,
  );
  assert.doesNotMatch(
    prettyLoader,
    /redirect\([\s\S]{0,100}encodeURIComponent\(canonicalUsername\)/,
  );
});

test("Svelte content API calls explicitly negotiate canonical URLs", () => {
  const headerSource = fs.readFileSync(
    new URL("../src/lib/api/canonical-content-url.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    headerSource,
    /["']X-Free2Z-Canonical-Content-URL["']\s*:\s*["']1["']/,
  );

  for (const path of [
    "../src/lib/api/events/eventNotificationsApi.ts",
    "../src/routes/converse/+page.svelte",
    "../src/routes/converse/[uuid]/+page.server.ts",
    "../src/lib/components/comments/DisplayThreadedComments.svelte",
    "../src/lib/components/comments/CommentChildren.svelte",
    "../src/lib/components/comments/CommentForm.svelte",
    "../src/lib/components/converse/ConverseReplies.svelte",
    "../src/lib/components/converse/ConverseComposer.svelte",
  ]) {
    const source = fs.readFileSync(new URL(path, import.meta.url), "utf8");
    assert.ok(
      source.match(/CANONICAL_CONTENT_URL_HEADERS/g)?.length >= 2,
      `${path} must import and use canonical URL negotiation`,
    );
  }
});

test("canonical metadata escapes reserved owner route pairs", () => {
  for (const [username, vanity] of [
    ["ai", "ordinary-vanity"],
    ["article", "ordinary-vanity"],
    ["checkout", "ordinary-vanity"],
    ["converse", "ordinary-vanity"],
    ["edit", "ordinary-vanity"],
    ["live", "ordinary-vanity"],
    ["projects", "ordinary-vanity"],
    ["tag", "ordinary-vanity"],
    ["begin", "alt"],
    ["profile", "kyc"],
    ["profile", "uploads"],
    ["sitemap", "static.xml"],
    ["tools", "p2pe2e"],
    ["api", "ordinary-vanity"],
    ["adminzzz", "ordinary-vanity"],
    ["feeds", "ordinary-vanity"],
    ["uploads", "ordinary-vanity"],
    ["uploadz", "ordinary-vanity"],
    ["djstatic", "ordinary-vanity"],
    ["static", "ordinary-vanity"],
    ["docs", "ordinary-vanity"],
    ["ws", "ordinary-vanity"],
    ["_app", "ordinary-vanity"],
    ["gcsproxy", "ordinary-vanity"],
    ["try-new-ui", "ordinary-vanity"],
    ["classic-ui", "ordinary-vanity"],
  ]) {
    const meta = buildZPageMeta(
      {
        ...article(),
        creator: { username },
        vanity,
        free2zaddr: "immutable-address",
      },
      { translate },
    );
    assert.equal(
      new URL(meta.canonical).pathname,
      "/article/immutable-address",
      `${username}/${vanity}`,
    );
  }

  const safePair = buildZPageMeta(
    {
      ...article(),
      creator: { username: "profile" },
      vanity: "ordinary-vanity",
      free2zaddr: "immutable-address",
    },
    { translate },
  );
  assert.equal(
    new URL(safePair.canonical).pathname,
    "/profile/ordinary-vanity",
  );
});

test("degenerate payloads still avoid emitting a canonical that redirects", () => {
  // No username: the get_url fallback must strip the MIDDLE `zpage` segment.
  const noUser = buildZPageMeta(vanitylessArticle({ creator: undefined }), {
    translate,
  });
  assert.equal(
    new URL(noUser.canonical).pathname,
    `/alice/${vanitylessArticle().free2zaddr}`,
  );

  // No vanity and no address: same fallback, same stripping.
  const noSlug = buildZPageMeta(
    vanitylessArticle({ free2zaddr: "", get_url: "/alice/zpage/legacy-slug" }),
    { translate },
  );
  assert.equal(new URL(noSlug.canonical).pathname, "/alice/legacy-slug");

  // Nothing usable at all: no canonical rather than a wrong one.
  const nothing = buildZPageMeta(
    vanitylessArticle({ creator: undefined, free2zaddr: "", get_url: "" }),
    { translate },
  );
  assert.equal(nothing.canonical, undefined);

  // A `zpage` username must not be eaten by the fallback strip.
  const literal = buildZPageMeta(
    vanitylessArticle({
      creator: undefined,
      free2zaddr: "",
      get_url: "/zpage/zpage/slug",
    }),
    { translate },
  );
  assert.equal(new URL(literal.canonical).pathname, "/zpage/slug");
});

function pagesFor(total) {
  const pages = [];
  for (let page = 0, remaining = total; remaining > 0; page += 1) {
    const count = Math.min(500, remaining);
    pages.push({ page, count, revision: `${count}-abcdefghijklmnop` });
    remaining -= count;
  }
  return pages;
}

test("root sitemap is an index and rolls over at and beyond 50,000 URLs", async () => {
  for (const total of [49_997, 50_000, 50_001]) {
    const pages = pagesFor(total - 1);
    const requested = [];
    const response = await getSitemapIndex({
      fetch: async (input) => {
        const url = new URL(input);
        requested.push(url.pathname);
        return Response.json({
          chunk_size: 500,
          creators: [{ page: 4, count: 1, revision: "1-abcdefghijklmnop" }],
          zpages: pages,
        });
      },
      url: new URL("https://free2z.test/sitemap.xml"),
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "public, max-age=300");
    const xml = await response.text();
    assert.match(xml, /<sitemapindex /);
    assert.doesNotMatch(xml, /<urlset /);
    assert.match(
      xml,
      /<loc>https:\/\/free2z\.cash\/sitemap\/static\.xml<\/loc>/,
    );
    assert.match(
      xml,
      /<loc>https:\/\/free2z\.cash\/sitemap\/creators\/4-1-abcdefghijklmnop\.xml<\/loc>/,
    );
    assert.ok(
      xml.includes(
        `<loc>https://free2z.cash/sitemap/zpages/${pages.at(-1).page}-${pages.at(-1).revision}.xml</loc>`,
      ),
    );
    assert.equal((xml.match(/<sitemap>/g) || []).length, pages.length + 2);
    assert.deepEqual(requested, ["/api/sitemap/"]);
  }
});

test("the phase-B capability route ships the v2 index contract", async () => {
  const requested = [];
  const response = await getSitemapV2Index({
    fetch: async (input) => {
      const url = new URL(input);
      requested.push(url.pathname);
      return Response.json({
        chunk_size: 500,
        creators: [],
        zpages: [],
      });
    },
    url: new URL("https://free2z.test/sitemap-v2.xml"),
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "public, max-age=300");
  assert.deepEqual(requested, ["/api/sitemap/"]);
  assert.match(await response.text(), /<sitemapindex /);
});

test("sitemap index accepts exactly 50,000 children and rejects 50,001", async () => {
  const exactDynamicPages = Array.from({ length: 49_999 }, (_, page) => ({
    page,
    count: 1,
    revision: "1-abcdefghijklmnop",
  }));
  const exact = await getSitemapIndex({
    fetch: async () =>
      Response.json({
        chunk_size: 500,
        creators: exactDynamicPages,
        zpages: [],
      }),
    url: new URL("https://free2z.test/sitemap.xml"),
  });
  assert.equal(exact.status, 200);
  assert.equal(((await exact.text()).match(/<sitemap>/g) || []).length, 50_000);

  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const overflow = await getSitemapIndex({
      fetch: async () =>
        Response.json({
          chunk_size: 500,
          creators: [
            ...exactDynamicPages,
            { page: 49_999, count: 1, revision: "1-abcdefghijklmnop" },
          ],
          zpages: [],
        }),
      url: new URL("https://free2z.test/sitemap.xml"),
    });
    assert.equal(overflow.status, 503);
    assert.equal(overflow.headers.get("cache-control"), "no-store");
  } finally {
    console.error = originalConsoleError;
  }
});

test("static child preserves the three canonical static URLs", async () => {
  const response = await getStaticSitemap({
    url: new URL("https://free2z.test/sitemap/static.xml"),
  });

  assert.equal(response.status, 200);
  const xml = await response.text();
  assert.match(xml, /<urlset /);
  assert.equal((xml.match(/<url>/g) || []).length, 3);
  for (const path of ["/", "/creators", "/trending"]) {
    assert.ok(xml.includes(`<loc>https://free2z.cash${path}</loc>`));
  }
});

test("dynamic children consume one slim strict chunk and emit a URL set", async () => {
  const requested = [];
  const response = await getSitemapChild({
    fetch: async (input) => {
      const url = new URL(input);
      requested.push(url.pathname);
      return Response.json({
        kind: "zpages",
        page: 10,
        zpages: [
          {
            username: "alice",
            vanity: "article",
            updated_at: "2026-07-28T12:00:00Z",
          },
          {
            username: "bob",
            vanity: "final-partial-entry",
            updated_at: "2026-07-29T12:00:00Z",
          },
        ],
      });
    },
    params: { kind: "zpages", page: "10-2-abcdefghijklmnop" },
    url: new URL(
      "https://free2z.test/sitemap/zpages/10-2-abcdefghijklmnop.xml",
    ),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(requested, ["/api/sitemap/zpages/10/2-abcdefghijklmnop/"]);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const xml = await response.text();
  assert.match(xml, /<urlset /);
  assert.equal((xml.match(/<url>/g) || []).length, 2);
  assert.match(xml, /<loc>https:\/\/free2z\.cash\/alice\/article<\/loc>/);
  assert.match(xml, /<lastmod>2026-07-28T12:00:00.000Z<\/lastmod>/);
  assert.match(
    xml,
    /<loc>https:\/\/free2z\.cash\/bob\/final-partial-entry<\/loc>/,
  );
});

test("a child invalidated by a canonical mutation degrades to valid XML", async () => {
  const response = await getSitemapChild({
    fetch: async () =>
      Response.json(
        { detail: "Sitemap page changed; reload the sitemap index." },
        {
          status: 409,
          headers: { "x-sitemap-protocol": "2" },
        },
      ),
    params: { kind: "zpages", page: "10-2-abcdefghijklmnop" },
    url: new URL(
      "https://free2z.test/sitemap/zpages/10-2-abcdefghijklmnop.xml",
    ),
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const xml = await response.text();
  assert.match(xml, /<urlset /);
  assert.equal((xml.match(/<url>/g) || []).length, 1);
  assert.match(xml, /<loc>https:\/\/free2z\.cash\/<\/loc>/);
  assert.doesNotMatch(xml, /alice|article/);
});

test("a protocol-less 409 fails closed instead of masquerading as a stale v2 child", async () => {
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const response = await getSitemapChild({
      fetch: async () => new Response("Conflict", { status: 409 }),
      params: { kind: "zpages", page: "10-2-abcdefghijklmnop" },
      url: new URL(
        "https://free2z.test/sitemap/zpages/10-2-abcdefghijklmnop.xml",
      ),
    });

    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
  } finally {
    console.error = originalConsoleError;
  }
});

test("root and child fail closed while backend endpoints are rolling out", async () => {
  const fetch = async () => new Response("Not found", { status: 404 });
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const root = await getSitemapIndex({
      fetch,
      url: new URL("https://free2z.test/sitemap.xml"),
    });
    const child = await getSitemapChild({
      fetch,
      params: { kind: "creators", page: "0-1-abcdefghijklmnop" },
      url: new URL(
        "https://free2z.test/sitemap/creators/0-1-abcdefghijklmnop.xml",
      ),
    });
    for (const response of [root, child]) {
      assert.equal(response.status, 503);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("retry-after"), "300");
      assert.match(await response.text(), /temporarily unavailable/);
    }
  } finally {
    console.error = originalConsoleError;
  }
});

test("sitemap backend fetches time out and preserve request cancellation", async () => {
  const pendingFetch = async (_input, { signal }) =>
    new Promise((_resolve, reject) => {
      const rejectWithReason = () => reject(signal.reason);
      if (signal.aborted) rejectWithReason();
      else signal.addEventListener("abort", rejectWithReason, { once: true });
    });

  for (const load of [
    () => loadSitemapIndex(pendingFetch, undefined, 5),
    () =>
      loadSitemapChunk(
        pendingFetch,
        "creators",
        0,
        "1-abcdefghijklmnop",
        undefined,
        5,
      ),
  ]) {
    await assert.rejects(load, (error) => error?.name === "TimeoutError");
  }

  const requestController = new AbortController();
  requestController.abort(
    new DOMException("Crawler disconnected.", "AbortError"),
  );
  await assert.rejects(
    () => loadSitemapIndex(pendingFetch, requestController.signal, 60_000),
    (error) => error?.name === "AbortError",
  );

  const stalledBodyFetch = async (_input, { signal }) =>
    new Response(
      new ReadableStream({
        start(controller) {
          signal.addEventListener(
            "abort",
            () => controller.error(signal.reason),
            { once: true },
          );
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  await assert.rejects(
    () => loadSitemapIndex(stalledBodyFetch, undefined, 5),
    (error) => error?.name === "TimeoutError",
  );
});

test("busy backend retry hints survive the Svelte boundary", async () => {
  const busy = async () =>
    Response.json(
      { detail: "Sitemap is temporarily busy." },
      {
        status: 503,
        headers: {
          "retry-after": "30",
          "x-sitemap-protocol": "2",
        },
      },
    );
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const root = await getSitemapIndex({
      fetch: busy,
      request: new Request("https://free2z.test/sitemap.xml"),
      url: new URL("https://free2z.test/sitemap.xml"),
    });
    const child = await getSitemapChild({
      fetch: busy,
      params: { kind: "creators", page: "0-1-abcdefghijklmnop" },
      request: new Request(
        "https://free2z.test/sitemap/creators/0-1-abcdefghijklmnop.xml",
      ),
      url: new URL(
        "https://free2z.test/sitemap/creators/0-1-abcdefghijklmnop.xml",
      ),
    });

    for (const response of [root, child]) {
      assert.equal(response.status, 503);
      assert.equal(response.headers.get("retry-after"), "30");
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
  } finally {
    console.error = originalConsoleError;
  }
});

test("sitemap fails closed when the private API base is missing", async () => {
  const configuredApiBase = process.env.PRIVATE_API_BASE_URL;
  const originalConsoleError = console.error;
  delete process.env.PRIVATE_API_BASE_URL;
  console.error = () => {};
  try {
    const response = await getSitemapIndex({
      fetch: async () =>
        assert.fail("missing API configuration must not fetch"),
      url: new URL("https://free2z.test/sitemap.xml"),
    });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("retry-after"), "300");
  } finally {
    process.env.PRIVATE_API_BASE_URL = configuredApiBase;
    console.error = originalConsoleError;
  }
});

test("all sitemap surfaces reject cache busting and invalid child paths cheaply", async () => {
  const neverFetch = async () => assert.fail("invalid request must not fetch");
  const responses = [
    await getSitemapIndex({
      fetch: neverFetch,
      url: new URL("https://free2z.test/sitemap.xml?nonce=unique"),
    }),
    await getStaticSitemap({
      url: new URL("https://free2z.test/sitemap/static.xml?nonce=unique"),
    }),
    await getSitemapChild({
      fetch: neverFetch,
      params: { kind: "zpages", page: "0-1-abcdefghijklmnop" },
      url: new URL("https://free2z.test/sitemap/zpages/0.xml?nonce=unique"),
    }),
    await getSitemapChild({
      fetch: neverFetch,
      params: { kind: "unknown", page: "0-1-abcdefghijklmnop" },
      url: new URL("https://free2z.test/sitemap/unknown/0.xml"),
    }),
    await getSitemapChild({
      fetch: neverFetch,
      params: { kind: "zpages", page: "01-1-abcdefghijklmnop" },
      url: new URL("https://free2z.test/sitemap/zpages/01.xml"),
    }),
  ];

  assert.deepEqual(
    responses.map((response) => response.status),
    [400, 400, 400, 404, 404],
  );
  assert.ok(
    responses.every(
      (response) => response.headers.get("cache-control") === "no-store",
    ),
  );
});

test("strict chunk validation rejects external-canonical fields and malformed dates", async () => {
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    for (const row of [
      {
        username: "alice",
        vanity: "article",
        updated_at: "2026-07-28T12:00:00Z",
        canonical_url: "https://publisher.example/original",
      },
      {
        username: "alice",
        vanity: "article",
        updated_at: "not-a-date",
      },
    ]) {
      const response = await getSitemapChild({
        fetch: async () =>
          Response.json({
            kind: "zpages",
            page: 0,
            zpages: [row],
          }),
        params: { kind: "zpages", page: "0-1-abcdefghijklmnop" },
        url: new URL("https://free2z.test/sitemap/zpages/0.xml"),
      });
      assert.equal(response.status, 503);
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
  } finally {
    console.error = originalConsoleError;
  }
});

test("strict root validation rejects malformed manifests", async () => {
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    for (const payload of [
      { chunk_size: 499, creators: [], zpages: [] },
      {
        chunk_size: 500,
        creators: [
          {
            page: 0,
            count: 501,
            revision: "501-abcdefghijklmnop",
          },
        ],
        zpages: [],
      },
      {
        chunk_size: 500,
        creators: [
          { page: 1, count: 1, revision: "1-abcdefghijklmnop" },
          { page: 1, count: 1, revision: "1-abcdefghijklmnop" },
        ],
        zpages: [],
      },
      { chunk_size: 500, creators: [], zpages: [], unexpected: true },
    ]) {
      const response = await getSitemapIndex({
        fetch: async () => Response.json(payload),
        url: new URL("https://free2z.test/sitemap.xml"),
      });
      assert.equal(response.status, 503);
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
  } finally {
    console.error = originalConsoleError;
  }
});

test("sitemap byte guard accepts exactly 50 MiB and rejects one byte more", () => {
  const limit = 50 * 1024 * 1024;
  assert.doesNotThrow(() => assertSitemapByteLength(limit));
  assert.throws(() => assertSitemapByteLength(limit + 1), /50 MiB/);
});

test("article routes render exactly one canonical link", () => {
  for (const route of [
    "../src/routes/[username]/[vanity]/+page.svelte",
    "../src/routes/article/[id]/+page.svelte",
  ]) {
    const source = fs.readFileSync(
      fileURLToPath(new URL(route, import.meta.url)),
      "utf8",
    );
    assert.equal(source.match(/<link rel="canonical"/g)?.length, 1, route);
  }
});

test("publish sheet is viewport-safe and associates canonical feedback", () => {
  const source = fs.readFileSync(
    fileURLToPath(
      new URL(
        "../src/lib/components/mdEditor/PublishSheet.svelte",
        import.meta.url,
      ),
    ),
    "utf8",
  );

  assert.match(
    source,
    /class="flex w-full max-w-full flex-col[^\"]*sm:w-\[540px\] sm:max-w-\[540px\]"/,
  );
  assert.match(source, /aria-describedby=\{canonicalFeedbackId\}/);
  assert.match(source, /aria-errormessage=\{validationErrors\.canonical_url/);
  assert.match(source, /id=\{canonicalFeedbackId\}/);
  assert.match(source, /aria-live="polite"/);
  assert.match(source, /aria-expanded=\{canonicalExpanded\}/);
  assert.match(source, /onblur=\{\(event\) => onCanonicalBlur/);
  assert.match(source, /oninput=\{\(event\) =>\s*notifyCanonicalChange/);
  assert.match(
    source,
    /runAction\(\(\) => onPublish\(canSchedule \? scheduleDraft : ""\)\)/,
  );
  assert.match(source, /zpageCanonicalPath\(\{/);
  assert.match(source, /free2z\.cash\{publicPathPreview\}/);
  assert.doesNotMatch(
    source,
    /free2z\.cash\/\{currentUser\.username\}\/zpage\//,
  );
});

// The SSR write proxy this test also covered (src/routes/edit/+server.ts) was
// deleted as dead code: its last caller went away in, when the editor
// started saving straight to /api/zpage/. The editor-side half of the
// assertion is the half that still runs in production, so it stays.
test("saves preserve unconfirmed canonical metadata", () => {
  const editorSource = fs.readFileSync(
    fileURLToPath(new URL("../src/routes/edit/+page.svelte", import.meta.url)),
    "utf8",
  );

  assert.match(editorSource, /if \(Object\.hasOwn\(zpage, "canonical_url"\)\)/);
  assert.match(editorSource, /!Object\.hasOwn\(result, "canonical_url"\)/);
});

test("autosave retries a canonical-only 400 exactly once without that field", async () => {
  const payloads = [];
  const responses = [
    {
      response: { ok: false, status: 400 },
      result: { canonical_url: ["Enter a valid URL."] },
    },
    {
      response: { ok: true, status: 200 },
      result: { free2zaddr: "page-id" },
    },
  ];
  const result = await saveWithCanonicalAutosaveFallback({
    isAuto: true,
    payload: {
      title: "Updated title",
      content: "Updated body",
      canonical_url: "https://publisher.example/original",
    },
    send: async (payload) => {
      payloads.push(payload);
      return responses.shift();
    },
  });

  assert.equal(result.response.ok, true);
  assert.equal(result.canonicalRejected, true);
  assert.equal(result.attempts, 2);
  assert.equal(payloads.length, 2);
  assert.equal(payloads[0].canonical_url, "https://publisher.example/original");
  assert.equal(Object.hasOwn(payloads[1], "canonical_url"), false);
  assert.equal(payloads[1].title, "Updated title");
  assert.equal(payloads[1].content, "Updated body");
});

test("autosave fallback cannot retry more than once", async () => {
  let requests = 0;
  const result = await saveWithCanonicalAutosaveFallback({
    isAuto: true,
    payload: { content: "Body", canonical_url: "https://example.com/post" },
    send: async () => {
      requests += 1;
      return {
        response: { ok: false, status: 400 },
        result: { canonical_url: ["Still invalid."] },
      };
    },
  });

  assert.equal(requests, 2);
  assert.equal(result.attempts, 2);
  assert.equal(result.canonicalRejected, true);
});

test("manual saves and mixed validation failures retain normal error semantics", async () => {
  for (const testCase of [
    { isAuto: false, result: { canonical_url: ["Invalid."] } },
    {
      isAuto: true,
      result: { canonical_url: ["Invalid."], title: ["Required."] },
    },
  ]) {
    let requests = 0;
    const result = await saveWithCanonicalAutosaveFallback({
      isAuto: testCase.isAuto,
      payload: { title: "", canonical_url: "https://example.com/post" },
      send: async () => {
        requests += 1;
        return {
          response: { ok: false, status: 400 },
          result: testCase.result,
        };
      },
    });

    assert.equal(requests, 1);
    assert.equal(result.attempts, 1);
    assert.equal(result.canonicalRejected, false);
    assert.deepEqual(result.result, testCase.result);
  }
});

// --- the `tags` sitemap kind  ---------------------------------------

test("the root index lists tag-hub children when the backend sends them", async () => {
  const requested = [];
  const response = await getSitemapIndex({
    fetch: async (input) => {
      requested.push(new URL(input).pathname);
      return Response.json({
        chunk_size: 500,
        creators: [],
        zpages: [],
        tags: [{ page: 0, count: 2, revision: "2-abcdefghijklmnop" }],
      });
    },
    url: new URL("https://free2z.test/sitemap.xml"),
  });

  assert.equal(response.status, 200);
  const xml = await response.text();
  assert.match(
    xml,
    /<loc>https:\/\/free2z\.cash\/sitemap\/tags\/0-2-abcdefghijklmnop\.xml<\/loc>/,
  );
  assert.deepEqual(requested, ["/api/sitemap/"]);
});

test("the root index still works against a backend with no tags key", async () => {
  // Django and SvelteKit roll independently, so a NEW frontend pod will answer
  // requests against an OLD backend for the length of a rollout. A strict
  // exact-key check would 503 the whole root sitemap for that window instead
  // of merely omitting the tag hubs.
  const response = await getSitemapIndex({
    fetch: async () =>
      Response.json({ chunk_size: 500, creators: [], zpages: [] }),
    url: new URL("https://free2z.test/sitemap.xml"),
  });

  assert.equal(response.status, 200);
  const xml = await response.text();
  assert.match(xml, /<sitemapindex /);
  assert.doesNotMatch(xml, /\/sitemap\/tags\//);
});

test("an unrecognised extra key in the index still fails closed", async () => {
  // Tolerating a MISSING `tags` must not become tolerating anything at all —
  // the strictness is the guard, and it is easy to widen by accident.
  const response = await getSitemapIndex({
    fetch: async () =>
      Response.json({
        chunk_size: 500,
        creators: [],
        zpages: [],
        tags: [],
        surprise: [],
      }),
    url: new URL("https://free2z.test/sitemap.xml"),
  });

  assert.equal(response.status, 503);
});

test("a tag child emits one self-canonical hub URL per row", async () => {
  const requested = [];
  const response = await getSitemapChild({
    fetch: async (input) => {
      requested.push(new URL(input).pathname);
      return Response.json({
        kind: "tags",
        page: 0,
        tags: [{ slug: "zcash" }, { slug: "t-shirts" }, { slug: "日本語" }],
      });
    },
    params: { kind: "tags", page: "0-3-abcdefghijklmnop" },
    url: new URL("https://free2z.test/sitemap/tags/0-3-abcdefghijklmnop.xml"),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(requested, ["/api/sitemap/tags/0/3-abcdefghijklmnop/"]);
  const xml = await response.text();
  assert.equal((xml.match(/<url>/g) || []).length, 3);
  assert.match(xml, /<loc>https:\/\/free2z\.cash\/tag\/zcash<\/loc>/);
  assert.match(xml, /<loc>https:\/\/free2z\.cash\/tag\/t-shirts<\/loc>/);
  // Percent-encoded, and byte-identical to what `tagPageHref` puts in the
  // page's own `rel=canonical` — a `<loc>` that canonicalises elsewhere costs
  // the whole entry.
  assert.match(
    xml,
    /<loc>https:\/\/free2z\.cash\/tag\/%E6%97%A5%E6%9C%AC%E8%AA%9E<\/loc>/,
  );
  // No invented lastmod: taggit's Tag has no updated_at.
  assert.doesNotMatch(xml, /<lastmod>/);
});

test("a tag row whose slug is not canonical fails the chunk closed", async () => {
  // The backend is a separate deployment and can be older than this one. A
  // slug is about to become a path segment in an XML document we publish, so
  // it is validated rather than trusted.
  for (const slug of ["Zcash", "a--b", "..", "", "t shirts", "/etc/passwd"]) {
    const response = await getSitemapChild({
      fetch: async () =>
        Response.json({ kind: "tags", page: 0, tags: [{ slug }] }),
      params: { kind: "tags", page: "0-1-abcdefghijklmnop" },
      url: new URL("https://free2z.test/sitemap/tags/0-1-abcdefghijklmnop.xml"),
    });
    assert.equal(response.status, 503, JSON.stringify(slug));
  }
});
