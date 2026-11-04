import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";

/**
 *  part 2 — `::embed[]` of a zPage or converse thread renders as a TEXT
 * card built from our own API with the READER's credentials, or as one neutral
 * link card. The security properties and the tests that pin them:
 *
 *   reader's credentials only............ "the loader forwards exactly…"
 *   gated/absent → neutral, no oracle.... "gated, missing, mismatched…"
 *   API by identifier, never the route... "the loader asks the API by…"
 *   no redirect following................ "a redirect is never followed"
 *   per-page cap......................... "the cap bounds fetches…",
 *                                          "the renderer enforces the cap…"
 *   one-level nesting / recursion........ "self-embed…", "mutual embed…"
 *   text only, no HTML sink.............. "a card is text…"
 *   label is the destination............. "a neutral card links to…"
 *   hostile card data in options......... "a card handed to the renderer…"
 *   deadline............................. "a stalled API cannot hold…"
 *   SSR routes........................... "the zPage route…", "/article…"
 *
 * The API itself (what a 200 means per reader) is pinned against the real
 * database in py/free2z/dj/apps/g12f/test_first_party_embed_card_contract.py.
 */

let server;
let md;
let cards;
let loader;
let deadlines;
let vanityLoad;
let articleLoad;
const previousApiBase = process.env.PRIVATE_API_BASE_URL;
const API = "https://api.free2z.test";

before(async () => {
  process.env.PRIVATE_API_BASE_URL = API;
  server = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { hmr: false, middlewareMode: true },
  });
  md = await server.ssrLoadModule("/src/lib/utils/markdown.ts");
  cards = await server.ssrLoadModule(
    "/src/lib/utils/first-party-embed-cards.ts",
  );
  loader = await server.ssrLoadModule(
    "/src/lib/server/first-party-embed-cards.ts",
  );
  deadlines = await server.ssrLoadModule("/src/lib/article-ssr-deadlines.js");
  ({ load: vanityLoad } = await server.ssrLoadModule(
    "/src/routes/[username]/[vanity]/+page.server.ts",
  ));
  ({ load: articleLoad } = await server.ssrLoadModule(
    "/src/routes/article/[id]/+page.server.ts",
  ));
});

after(async () => {
  await server?.close();
  if (previousApiBase === undefined) delete process.env.PRIVATE_API_BASE_URL;
  else process.env.PRIVATE_API_BASE_URL = previousApiBase;
});

const UUID_A = "0b7a3c1e-1111-4222-8333-944455556666";
const UUID_B = "1c8b4d2f-2222-4333-8444-a55566667777";

function zpageBody(overrides = {}) {
  return {
    free2zaddr: "5d1f8a8e-0000-4000-8000-000000000001",
    vanity: "post",
    title: "Alice's post",
    description: "",
    content: "Hello **world**, this is the body.",
    creator: { username: "alice" },
    ...overrides,
  };
}

function commentBody(overrides = {}) {
  return {
    uuid: UUID_A,
    headline: "A thread",
    content: "Replying with *emphasis*.",
    author: { username: "bob" },
    ...overrides,
  };
}

/**
 * A stand-in for the backend at the HTTP boundary (not the DB: the DB side of
 * this contract is the pytest matrix). `routes` maps an API path to a body or
 * a Response factory; every request is recorded with the headers it carried.
 */
function fakeApi(routes = {}) {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers || {});
    calls.push({
      url: url.href,
      path: url.pathname,
      search: url.search,
      cookie: headers.get("cookie"),
      redirect: init.redirect,
    });
    const route = routes[url.pathname];
    if (route === undefined) {
      return new Response(JSON.stringify({ detail: "Not found." }), {
        status: 404,
      });
    }
    if (typeof route === "function") return route({ url, headers, init });
    return Response.json(route);
  };
  return { fetch, calls };
}

const embed = (url) => `::embed[${url}]`;
const doc = (...lines) => lines.join("\n\n") + "\n";

// ---------------------------------------------------------------------------
// Collection: which embeds may have a card at all.
// ---------------------------------------------------------------------------

test("collect: canonical-host zPage and converse embeds, in order, once each", () => {
  const found = md.collectFirstPartyContentEmbeds(
    doc(
      embed("https://free2z.cash/alice/post"),
      embed(`https://free2z.cash/converse/${UUID_A}`),
      embed("https://free2z.cash/ALICE/post"), // same key: usernames fold
      embed("https://free2z.cash/alice/post?next=/x#frag"), // same key
      embed("https://free2z.cash/alice/post?lang=fr#x"), // a translation
      embed("https://free2z.cash/article/5d1f8a8e"),
    ),
    "free2z.cash",
  );
  assert.deepEqual(
    found.map((item) => cards.firstPartyContentKey(item)),
    [
      "zpage:free2z.cash/alice/post",
      `converse:free2z.cash/${UUID_A}`,
      "zpage:free2z.cash/alice/post?lang=fr",
      "zpage:free2z.cash//5d1f8a8e",
    ],
  );
});

test("collect: lookalikes, other shapes, other hosts and code blocks are never resolved", () => {
  const found = md.collectFirstPartyContentEmbeds(
    doc(
      embed("https://free2z.cash/alice/post/edit"),
      embed("https://free2z.cash/og/zpage/abc.png"),
      embed("https://free2z.cash/converse/../logout"),
      embed("https://free2z.cash/alice%2Fpost/x"),
      embed("https://free2z.cash/converse/not-a-uuid"),
      embed("https://free2z.cash/uploadz/public/alice/talk.mp4"),
      embed("https://free2z.cash/login?next=//evil.example"),
      embed("https://free2z.cash/bridge/anything"),
      embed("https://free2z.cash.evil.example/alice/post"),
      embed("https://stage.free2z.cash/alice/post"),
      embed("https://free2z.com/alice/post"),
      "```\n::embed[https://free2z.cash/alice/in-code]\n```",
      "::qrcode[https://free2z.cash/alice/qr]",
    ),
    "free2z.cash",
  );
  assert.deepEqual(found, []);
});

test("collecting never disturbs the next render (stateful footnote/heading extensions)", () => {
  // The collector runs on EVERY article, before the page renders it. Lexing on
  // the renderer's global marked instance ran marked-footnote and
  // gfm-heading-id outside a render, and the article that followed rendered
  // wrong: this is the regression the browser suite caught (outbound-link,
  // ssr-article-body) and that this test pins without a browser.
  const article = [
    "## Heading one",
    "",
    "Text with a [link](https://external.example/x) and a note[^1].",
    "",
    "[^1]: The note.",
    "",
    "## Heading two",
    "",
    embed("https://free2z.cash/alice/post"),
    "",
  ].join("\n");
  const before = md.processMarkdown(article);
  for (let i = 0; i < 3; i += 1) {
    md.collectFirstPartyContentEmbeds(article, "free2z.cash");
  }
  assert.equal(md.processMarkdown(article), before);
  assert.match(before, /markdown-author-link/);
  assert.match(before, /id="heading-one"/);
});

test("the cap bounds collection: at most MAX_FIRST_PARTY_CARDS distinct embeds", () => {
  const many = Array.from({ length: 9 }, (_, index) =>
    embed(`https://free2z.cash/alice/post-${index}`),
  );
  const found = md.collectFirstPartyContentEmbeds(doc(...many), "free2z.cash");
  assert.equal(cards.MAX_FIRST_PARTY_CARDS, 4);
  assert.deepEqual(
    found.map((item) => item.identifier),
    ["post-0", "post-1", "post-2", "post-3"],
  );
});

// ---------------------------------------------------------------------------
// Card builders: what counts as "the reader may see this".
// ---------------------------------------------------------------------------

const zpageEmbed = (username, identifier) => ({
  kind: "zpage",
  href: `https://free2z.cash/${username ?? "article"}/${identifier}`,
  username,
  identifier,
});

test("a full, ungated zPage answer becomes a card linking to the API's canonical path", () => {
  const card = cards.zpageCardFromApi(zpageEmbed("Alice", "post"), zpageBody());
  assert.deepEqual(card, {
    kind: "zpage",
    href: "/alice/post",
    title: "Alice's post",
    excerpt: "Hello world, this is the body.",
    author: "alice",
    vanity: "post",
    free2zaddr: "5d1f8a8e-0000-4000-8000-000000000001",
  });
  // The fallback shape carries no username to check.
  assert.equal(
    cards.zpageCardFromApi(zpageEmbed(null, "5d1f8a8e"), zpageBody())?.href,
    "/alice/post",
  );
  // A creator whose name collides with a route gets the /article/ path, as
  // the product's own canonical-path rule says.
  assert.equal(
    cards.zpageCardFromApi(
      zpageEmbed("static", "post"),
      zpageBody({ creator: { username: "static" } }),
    )?.href,
    "/article/5d1f8a8e-0000-4000-8000-000000000001",
  );
});

test("gated, missing, mismatched or malformed zPage answers are all the neutral card (null)", () => {
  const e = zpageEmbed("alice", "post");
  // The subscriber-only upsell: a 200 with the page redacted inside it.
  assert.equal(
    cards.zpageCardFromApi(e, {
      show_modal: true,
      page: zpageBody({ content: "Subscribe" }),
    }),
    null,
  );
  assert.equal(
    cards.zpageCardFromApi(e, { page: zpageBody() }),
    null,
    "a wrapped page is gated even without the flag",
  );
  // `/accounts/logout/` classifies as username `accounts` + identifier
  // `logout`: the API resolves `logout` globally, and whoever owns that vanity
  // must NOT lend their card to a URL that is really the logout route.
  assert.equal(
    cards.zpageCardFromApi(
      zpageEmbed("accounts", "logout"),
      zpageBody({ vanity: "logout", creator: { username: "mallory" } }),
    ),
    null,
  );
  assert.equal(cards.zpageCardFromApi(e, zpageBody({ creator: null })), null);
  assert.equal(cards.zpageCardFromApi(e, zpageBody({ title: "" })), null);
  assert.equal(cards.zpageCardFromApi(e, { count: 0, results: [] }), null);
  assert.equal(cards.zpageCardFromApi(e, null), null);
  assert.equal(cards.zpageCardFromApi(e, [zpageBody()]), null);
});

test("a card describes the variant its link will open (the route's retry rule)", () => {
  const withLang = {
    kind: "zpage",
    href: "https://free2z.cash/alice/post?lang=zh",
    username: "alice",
    identifier: "post",
  };
  const asked = cards.firstPartyCardLanguage(withLang, "en");
  assert.equal(asked, "zh", "an embed's own ?lang= wins over the UI locale");
  // `zh` asked, API fell back to English; the route would retry to zh-Hans.
  assert.equal(
    cards.zpageCardFromApi(
      withLang,
      zpageBody({
        actual_language: "en",
        available_languages: ["en", "zh-Hans"],
      }),
      asked,
    ),
    null,
  );
  // The API's answer IS what the route lands on: a card.
  assert.ok(
    cards.zpageCardFromApi(
      withLang,
      zpageBody({
        actual_language: "zh-Hans",
        available_languages: ["en", "zh-Hans"],
      }),
      asked,
    ),
  );

  // No ?lang=: asked in the reader's locale, exactly like the route (codex R3:
  // a Spanish-source article with an en-US translation, read in English).
  const plainEmbed = zpageEmbed("alice", "post");
  const implicit = cards.firstPartyCardLanguage(plainEmbed, "en");
  assert.equal(implicit, "en");
  assert.equal(
    cards.zpageCardFromApi(
      plainEmbed,
      zpageBody({
        actual_language: "es",
        available_languages: ["es", "en-US"],
      }),
      implicit,
    ),
    null,
  );
  assert.ok(
    cards.zpageCardFromApi(
      plainEmbed,
      zpageBody({ actual_language: "es", available_languages: ["es"] }),
      implicit,
    ),
    "no better variant exists: the route shows this one too",
  );
});

test("collect: an ::embed[] line inside a math block is math, as on the page", () => {
  const content = doc(
    // Blank lines inside the block: each `::embed[]` line would otherwise
    // start a block of its own.
    "$$\n\n::embed[https://free2z.cash/alice/in-math-1]\n\n::embed[https://free2z.cash/alice/in-math-2]\n\n$$",
    "\\[\n\n::embed[https://free2z.cash/alice/in-math-3]\n\n\\]",
    embed("https://free2z.cash/alice/real"),
  );
  assert.deepEqual(
    md
      .collectFirstPartyContentEmbeds(content, "free2z.cash")
      .map((item) => item.identifier),
    ["real"],
  );
  const html = md.processMarkdown(content);
  assert.equal(html.match(/first-party-embed-zpage/g)?.length, 1);
});

test("converse: a card only for the uuid that was asked for", () => {
  const e = { kind: "converse", href: "x", uuid: UUID_A };
  assert.deepEqual(cards.converseCardFromApi(e, commentBody()), {
    kind: "converse",
    href: `/converse/${UUID_A}`,
    title: "A thread",
    excerpt: "Replying with emphasis.",
    author: "bob",
  });
  assert.equal(
    cards.converseCardFromApi(e, commentBody({ uuid: UUID_B })),
    null,
  );
  assert.equal(cards.converseCardFromApi(e, { detail: "Not found." }), null);
  // No headline: titled by its own opening text, no duplicate excerpt.
  const untitled = cards.converseCardFromApi(e, commentBody({ headline: "" }));
  assert.equal(untitled.title, "Replying with emphasis.");
  assert.equal(untitled.excerpt, "");
});

test("the excerpt is summarised without rendering: pathological markdown is cheap", () => {
  assert.equal(
    cards.markdownExcerptText(
      "## Title\n\n> Quote with **bold**, `code` and a [link](https://x.example/a).\n\n- item ![img](/a.png) <b>tag</b>[^1]\n\n::embed[https://free2z.cash/alice/post]",
      500,
    ),
    "Title Quote with bold, code and a link. item img tag free2z.cash/alice/post",
  );

  // codex R5: structure-heavy sources that are expensive for a renderer.
  const hostile = [
    `${"> ".repeat(1900)}hello`,
    `${"[".repeat(3000)}x${"]".repeat(900)}`,
    `${"*".repeat(3999)}a`,
    `${"<".repeat(2000)}${">".repeat(1999)}`,
    `${"- ".repeat(1999)}x`,
    `${"![".repeat(1000)}](${"(".repeat(1500)}`,
    "\\".repeat(3999),
  ];
  const started = performance.now();
  for (const source of hostile) {
    for (let i = 0; i < 4; i += 1) {
      const card = cards.zpageCardFromApi(
        zpageEmbed("alice", "post"),
        zpageBody({ description: "", content: source }),
      );
      assert.ok(card.excerpt.length <= cards.FIRST_PARTY_CARD_EXCERPT_MAX);
    }
  }
  const elapsed = performance.now() - started;
  // 28 cards. The renderer-based excerpt took ~1 s for ONE of the first kind.
  assert.ok(elapsed < 250, `28 hostile excerpts took ${elapsed.toFixed(0)}ms`);
});

test("card text is bounded and stripped of controls and bidi overrides", () => {
  const card = cards.zpageCardFromApi(
    zpageEmbed("alice", "post"),
    zpageBody({
      title: `‮gnp.exe ${"T".repeat(400)}\u0000`,
      description: "x".repeat(5000),
    }),
  );
  assert.ok(card.title.length <= cards.FIRST_PARTY_CARD_TITLE_MAX);
  assert.ok(card.excerpt.length <= cards.FIRST_PARTY_CARD_EXCERPT_MAX);
  assert.doesNotMatch(card.title, /[\u0000‮]/);
});

// ---------------------------------------------------------------------------
// Rendering.
// ---------------------------------------------------------------------------

const KEY = "zpage:free2z.cash/alice/post";
const aliceCard = {
  kind: "zpage",
  href: "/alice/post",
  title: 'T <img src=x onerror="alert(1)">',
  excerpt: "<script>alert(1)</script> & more",
  author: "alice",
};

test("a card is text: title, excerpt and author are escaped, and it links where it says", () => {
  const html = md.processMarkdown(embed("https://free2z.cash/alice/post"), {
    firstPartyCards: { [KEY]: aliceCard },
  });
  assert.match(html, /first-party-embed-resolved/);
  assert.match(
    html,
    /<a class="first-party-embed-card first-party-embed-content-card" href="\/alice\/post">/,
  );
  // No element was created from card text: the markup stays text.
  assert.doesNotMatch(html, /<script|<img/);
  assert.match(html, /T &lt;img src=x onerror="alert\(1\)"&gt;<\/span>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; more/);
  assert.match(html, /@alice/);
  assert.match(html, /free2z\.cash\/alice\/post</);
  assert.doesNotMatch(html, /<iframe|data-embed-url/);
});

test("a neutral card links to the classified path and its label IS that destination", () => {
  // No card map: every content embed is the neutral card — an absolute link
  // to the host the author named. Unknown query parameters and unsafe
  // fragments are dropped from BOTH the href and the label.
  const html = md.processMarkdown(
    doc(
      embed("https://free2z.cash/alice/post?next=//evil.example#x%22y"),
      embed(`https://free2z.cash/converse/${UUID_A.toUpperCase()}`),
      embed("https://stage.free2z.cash/alice/post?x=1"),
      embed("http://free2z.cash/alice/other"),
    ),
  );
  const links = [
    ...html.matchAll(
      /<a class="first-party-embed-card" href="([^"]*)"><span class="first-party-embed-name" dir="ltr">([^<]*)<\/span>/g,
    ),
  ].map((match) => [match[1], match[2]]);
  assert.deepEqual(links, [
    ["https://free2z.cash/alice/post", "free2z.cash/alice/post"],
    [
      `https://free2z.cash/converse/${UUID_A}`,
      `free2z.cash/converse/${UUID_A}`,
    ],
    // Another environment's host stays exactly that host.
    ["https://stage.free2z.cash/alice/post", "stage.free2z.cash/alice/post"],
    ["https://free2z.cash/alice/other", "free2z.cash/alice/other"],
  ]);
  for (const [href, label] of links) assert.equal(href, `https://${label}`);
  assert.doesNotMatch(
    html,
    /evil\.example|x%22y|x=1|first-party-embed-resolved/,
  );
});

test("a translated-article deep link keeps its validated ?lang= and a plain anchor", () => {
  const html = md.processMarkdown(
    doc(
      embed(
        "https://free2z.cash/alice/post?lang=zh-Hans&next=//evil.example#part-2",
      ),
      embed(`https://free2z.cash/converse/${UUID_A}#comment-${UUID_B}`),
      embed("https://free2z.cash/alice/post?lang=%3Cscript%3E"),
    ),
    {
      firstPartyCards: {
        "zpage:free2z.cash/alice/post?lang=zh-Hans": {
          ...aliceCard,
          title: "译文",
          excerpt: "摘要",
        },
      },
    },
  );
  // The card for the translation links to the translation, and says so.
  assert.match(
    html,
    /first-party-embed-resolved"><a class="first-party-embed-card first-party-embed-content-card" href="\/alice\/post\?lang=zh-Hans#part-2">/,
  );
  assert.match(html, /free2z\.cash\/alice\/post\?lang=zh-Hans#part-2</);
  // A comment anchor survives on a converse link.
  assert.match(
    html,
    new RegExp(
      `href="https://free2z.cash/converse/${UUID_A}#comment-${UUID_B}"`,
    ),
  );
  // A `lang` that is not a language tag is dropped, like any other parameter.
  assert.match(
    html,
    /href="https:\/\/free2z\.cash\/alice\/post"><span class="first-party-embed-name" dir="ltr">free2z\.cash\/alice\/post</,
  );
  assert.doesNotMatch(html, /evil|%3Cscript|&lt;script/);
});

test("Unicode heading anchors survive; anything else after # does not", () => {
  const html = md.processMarkdown(
    doc(
      embed("https://free2z.cash/alice/post#résumé"),
      embed(
        "https://free2z.cash/alice/p2#%E4%B8%AD%E6%96%87%E6%A0%87%E9%A2%98",
      ),
      embed("https://free2z.cash/alice/p3#a%22onmouseover%3D1"),
      embed("https://free2z.cash/alice/p4#%2F%2Fevil.example"),
    ),
  );
  assert.match(
    html,
    /href="https:\/\/free2z\.cash\/alice\/post#r%C3%A9sum%C3%A9"/,
  );
  assert.match(
    html,
    /href="https:\/\/free2z\.cash\/alice\/p2#%E4%B8%AD%E6%96%87%E6%A0%87%E9%A2%98"/,
  );
  assert.match(html, /href="https:\/\/free2z\.cash\/alice\/p3"/);
  assert.match(html, /href="https:\/\/free2z\.cash\/alice\/p4"/);
  assert.doesNotMatch(html, /onmouseover|evil/);
});

test("cards resolve only for the host being read (stage never shows production's page)", () => {
  assert.equal(cards.firstPartyCardHost("free2z.cash"), "free2z.cash");
  assert.equal(
    cards.firstPartyCardHost("stage.free2z.cash"),
    "stage.free2z.cash",
  );
  // Not a deployment of ours: the canonical host (dev, the browser suite).
  assert.equal(cards.firstPartyCardHost("127.0.0.1"), "free2z.cash");
  assert.equal(cards.firstPartyCardHost("evil.example"), "free2z.cash");
  assert.equal(cards.firstPartyCardHost(null), "free2z.cash");

  const content = doc(
    embed("https://free2z.cash/alice/prod"),
    embed("https://stage.free2z.cash/alice/stage"),
  );
  assert.deepEqual(
    md
      .collectFirstPartyContentEmbeds(content, "stage.free2z.cash")
      .map((item) => item.identifier),
    ["stage"],
  );
  assert.deepEqual(
    md
      .collectFirstPartyContentEmbeds(content, "free2z.cash")
      .map((item) => item.identifier),
    ["prod"],
  );
  // And a card resolved for one host is never looked up for the other.
  const html = md.processMarkdown(
    embed("https://stage.free2z.cash/alice/post"),
    {
      firstPartyCards: { [KEY]: aliceCard },
    },
  );
  assert.doesNotMatch(html, /first-party-embed-resolved/);
});

test("any other first-party route: the label shows the query a redirect keeps its target in", () => {
  const html = md.processMarkdown(
    embed("https://free2z.cash/login?next=//evil.example"),
  );
  assert.match(
    html,
    /href="https:\/\/free2z\.cash\/login\?next=\/\/evil\.example"><span class="first-party-embed-name" dir="ltr">free2z\.cash\/login\?next=\/\/evil\.example</,
  );
});

test("a card handed to the renderer must still be one of our content routes", () => {
  const hostile = [
    { ...aliceCard, href: "//evil.example/x" },
    { ...aliceCard, href: "https://evil.example/alice/post" },
    { ...aliceCard, href: "javascript:alert(1)" },
    { ...aliceCard, href: "/login?next=//evil.example" },
    { ...aliceCard, href: "/alice/post?next=//evil.example" },
    { ...aliceCard, href: "/alice/post#x" },
    { ...aliceCard, href: "/accounts/logout/" },
    { ...aliceCard, href: "/api/zpage" },
    { ...aliceCard, href: "/alice/../logout" },
    { ...aliceCard, href: "/alice%2F..%2Flogout/x" },
    { ...aliceCard, href: "/uploadz/public" },
    { ...aliceCard, kind: "converse" },
    { ...aliceCard, title: "" },
    "not a card",
  ];
  for (const card of hostile) {
    const html = md.processMarkdown(embed("https://free2z.cash/alice/post"), {
      firstPartyCards: { [KEY]: card },
    });
    assert.doesNotMatch(
      html,
      /first-party-embed-resolved/,
      JSON.stringify(card),
    );
    assert.match(html, /href="https:\/\/free2z\.cash\/alice\/post"/);
  }
  // A converse card must link to the very thread that was embedded.
  const html = md.processMarkdown(
    embed(`https://free2z.cash/converse/${UUID_A}`),
    {
      firstPartyCards: {
        [`converse:free2z.cash/${UUID_A}`]: {
          kind: "converse",
          href: `/converse/${UUID_B}`,
          title: "x",
          excerpt: "",
          author: "",
        },
      },
    },
  );
  assert.doesNotMatch(html, /first-party-embed-resolved/);
});

test("a zPage card renders only under the key of the page it describes", () => {
  // The loader's map is data; a card filed under the wrong key must not
  // render there. `/alice/post` may only show a card in alice's namespace.
  for (const href of ["/bob/other", "/bob/post", "/alicex/post"]) {
    const html = md.processMarkdown(embed("https://free2z.cash/alice/post"), {
      firstPartyCards: { [KEY]: { ...aliceCard, href } },
    });
    assert.doesNotMatch(html, /first-party-embed-resolved/, href);
  }
  // Username case folds, as everywhere else in the product.
  assert.match(
    md.processMarkdown(embed("https://free2z.cash/ALICE/post"), {
      firstPartyCards: { [KEY]: aliceCard },
    }),
    /first-party-embed-resolved/,
  );

  // `/article/<id>`: no username, so the id must be the card's own address
  // (exactly) or its vanity (case-insensitively).
  const ADDR = "5d1f8a8e-0000-4000-8000-000000000001";
  const own = { ...aliceCard, vanity: "post", free2zaddr: ADDR };
  const render = (id, card) =>
    md.processMarkdown(embed(`https://free2z.cash/article/${id}`), {
      firstPartyCards: { [`zpage:free2z.cash//${id}`]: card },
    });
  assert.match(render(ADDR, own), /first-party-embed-resolved/);
  assert.match(render("POST", own), /first-party-embed-resolved/);
  assert.doesNotMatch(
    render(ADDR, { ...own, free2zaddr: "another-address", vanity: "other" }),
    /first-party-embed-resolved/,
  );
  assert.doesNotMatch(
    render(ADDR, { ...aliceCard }),
    /first-party-embed-resolved/,
    "a card that does not say which page it is cannot claim an /article/ id",
  );
});

test("the renderer enforces the cap itself, whatever map it is handed", () => {
  const keys = Array.from({ length: 6 }, (_, i) => `post-${i}`);
  const map = Object.fromEntries(
    keys.map((key) => [
      `zpage:free2z.cash/alice/${key}`,
      { ...aliceCard, href: `/alice/${key}`, title: key },
    ]),
  );
  const html = md.processMarkdown(
    doc(...keys.map((key) => embed(`https://free2z.cash/alice/${key}`))),
    { firstPartyCards: map },
  );
  assert.equal(
    html.match(/first-party-embed-resolved/g)?.length,
    cards.MAX_FIRST_PARTY_CARDS,
  );
  // And a duplicate costs nothing against the cap.
  const dup = md.processMarkdown(
    doc(
      ...Array.from({ length: 5 }, () =>
        embed("https://free2z.cash/alice/post-0"),
      ),
      embed("https://free2z.cash/alice/post-1"),
    ),
    { firstPartyCards: map },
  );
  assert.equal(dup.match(/first-party-embed-resolved/g)?.length, 6);
  // Options never leak into the next render.
  assert.doesNotMatch(
    md.processMarkdown(embed("https://free2z.cash/alice/post-0")),
    /first-party-embed-resolved/,
  );
});

// ---------------------------------------------------------------------------
// The server loader.
// ---------------------------------------------------------------------------

const load = (content, api, extra = {}) =>
  loader.loadFirstPartyCards({
    content,
    gated: false,
    fetch: api.fetch,
    cookie: null,
    locale: "en",
    ...extra,
  });

test("the loader forwards exactly the reader's cookie — and none for an anonymous reader", async () => {
  const content = doc(
    embed("https://free2z.cash/alice/post"),
    embed(`https://free2z.cash/converse/${UUID_A}`),
  );
  const routes = {
    "/api/zpage/post/": zpageBody(),
    [`/api/comments/${UUID_A}/`]: commentBody(),
  };

  const anon = fakeApi(routes);
  await load(content, anon);
  assert.equal(anon.calls.length, 2);
  assert.ok(anon.calls.every((call) => call.cookie === null));

  const reader = fakeApi(routes);
  const cookie = "sessionid=reader-session; csrftoken=abc";
  await load(content, reader, { cookie });
  assert.ok(reader.calls.every((call) => call.cookie === cookie));
});

test("the loader asks the API by identifier, never the embedded route", async () => {
  const api = fakeApi({});
  await load(
    doc(
      embed("https://free2z.cash/accounts/logout/?next=//evil.example"),
      embed(`https://free2z.cash/converse/${UUID_A}#comment-1`),
      embed("https://free2z.cash/article/5d1f8a8e"),
      embed("https://free2z.cash/bob/tr?lang=zh-Hans&next=/x"),
    ),
    api,
  );
  assert.deepEqual(
    api.calls.map((call) => `${call.path}${call.search}`),
    [
      "/api/zpage/logout/?lang=en",
      `/api/comments/${UUID_A}/`,
      "/api/zpage/5d1f8a8e/?lang=en",
      "/api/zpage/tr/?lang=zh-Hans",
    ],
  );
  assert.ok(api.calls.every((call) => call.url.startsWith(`${API}/api/`)));
  assert.ok(api.calls.every((call) => !/next=|evil|comment-1/.test(call.url)));
});

test("a redirect is never followed, and only a 200 can become a card", async () => {
  const api = fakeApi({
    "/api/zpage/post/": () =>
      new Response(JSON.stringify(zpageBody()), {
        status: 302,
        headers: { location: "https://evil.example/" },
      }),
    "/api/zpage/other/": () =>
      new Response(JSON.stringify(zpageBody({ vanity: "other" })), {
        status: 203,
      }),
  });
  const result = await load(
    doc(
      embed("https://free2z.cash/alice/post"),
      embed("https://free2z.cash/alice/other"),
    ),
    api,
  );
  assert.deepEqual(result, {});
  assert.ok(api.calls.every((call) => call.redirect === "manual"));
});

test("gated, missing, mismatched or malformed answers leave nothing in the page data", async () => {
  const api = fakeApi({
    "/api/zpage/sub/": { show_modal: true, page: zpageBody({ vanity: "sub" }) },
    "/api/zpage/theirs/": zpageBody({
      vanity: "theirs",
      creator: { username: "mallory" },
    }),
    "/api/zpage/bad/": () => new Response("{not json", { status: 200 }),
  });
  const result = await load(
    doc(
      embed("https://free2z.cash/alice/sub"),
      embed("https://free2z.cash/alice/draft"), // 404
      embed("https://free2z.cash/alice/theirs"),
      embed("https://free2z.cash/alice/bad"),
    ),
    api,
  );
  assert.deepEqual(result, {});
  assert.equal(api.calls.length, 4);
});

test("a gated host article resolves nothing, and an article with no embeds calls nothing", async () => {
  const api = fakeApi({ "/api/zpage/post/": zpageBody() });
  assert.deepEqual(
    await load(embed("https://free2z.cash/alice/post"), api, { gated: true }),
    {},
  );
  assert.deepEqual(await load("Just prose.", api), {});
  assert.deepEqual(await load(null, api), {});
  assert.equal(api.calls.length, 0);
});

test("spellings of one page share ONE call and one cap slot; per-key checks still run", async () => {
  const routes = {
    "/api/zpage/post/": zpageBody(),
    "/api/zpage/p1/": zpageBody({ vanity: "p1", title: "P1" }),
    "/api/zpage/p2/": zpageBody({ vanity: "p2", title: "P2" }),
    "/api/zpage/p3/": zpageBody({ vanity: "p3", title: "P3" }),
  };
  const api = fakeApi(routes);
  const content = doc(
    embed("https://free2z.cash/alice/post"),
    embed("https://free2z.cash/ALICE/post?next=/x"), // same key
    embed("https://free2z.cash/article/post"), // new key, same call
    embed("https://free2z.cash/bob/post"), // new key, same call, wrong owner
    embed("https://free2z.cash/alice/p1"),
    embed("https://free2z.cash/alice/p2"),
    embed("https://free2z.cash/alice/p3"),
  );
  const map = await load(content, api);
  // Four distinct calls: `post` once, then p1..p3 — the spellings did not
  // burn the slots p1..p3 need.
  assert.deepEqual(api.calls.map((call) => call.path).sort(), [
    "/api/zpage/p1/",
    "/api/zpage/p2/",
    "/api/zpage/p3/",
    "/api/zpage/post/",
  ]);
  assert.deepEqual(Object.keys(map).sort(), [
    "zpage:free2z.cash//post",
    "zpage:free2z.cash/alice/p1",
    "zpage:free2z.cash/alice/p2",
    "zpage:free2z.cash/alice/p3",
    "zpage:free2z.cash/alice/post",
  ]);
  // bob/post shared the call but not the card: the page is alice's.
  assert.equal(map["zpage:free2z.cash/bob/post"], undefined);
  // And every one of them renders (the renderer counts calls the same way).
  const html = md.processMarkdown(content, { firstPartyCards: map });
  assert.equal(html.match(/first-party-embed-resolved/g)?.length, 6);
});

test("the cap bounds fetches: nine embeds, four calls", async () => {
  const routes = {};
  for (let i = 0; i < 9; i += 1) {
    routes[`/api/zpage/post-${i}/`] = zpageBody({ vanity: `post-${i}` });
  }
  const api = fakeApi(routes);
  const result = await load(
    doc(
      ...Array.from({ length: 9 }, (_, i) =>
        embed(`https://free2z.cash/alice/post-${i}`),
      ),
    ),
    api,
  );
  assert.equal(api.calls.length, cards.MAX_FIRST_PARTY_CARDS);
  assert.equal(Object.keys(result).length, cards.MAX_FIRST_PARTY_CARDS);
});

test("self-embed terminates at one level: one call, and the card holds text only", async () => {
  const self = zpageBody({
    content: doc("Intro.", embed("https://free2z.cash/alice/post"), "Outro."),
  });
  const api = fakeApi({ "/api/zpage/post/": self });
  const map = await load(self.content, api);
  assert.equal(api.calls.length, 1);
  const html = md.processMarkdown(self.content, { firstPartyCards: map });
  assert.equal(html.match(/first-party-embed-resolved/g)?.length, 1);
  // The embedded page's own embed survives only as its link text.
  assert.equal(map[KEY].excerpt, "Intro. free2z.cash/alice/post Outro.");
});

test("mutual embed A↔B: rendering A resolves B once and never follows B's embed of A", async () => {
  const a = zpageBody({
    vanity: "a",
    content: embed("https://free2z.cash/alice/b"),
  });
  const b = zpageBody({
    vanity: "b",
    title: "B",
    content: doc("B body", embed("https://free2z.cash/alice/a")),
  });
  const api = fakeApi({ "/api/zpage/a/": a, "/api/zpage/b/": b });
  const map = await load(a.content, api);
  assert.deepEqual(
    api.calls.map((call) => call.path),
    ["/api/zpage/b/"],
  );
  const html = md.processMarkdown(a.content, { firstPartyCards: map });
  assert.equal(html.match(/first-party-embed-resolved/g)?.length, 1);
  assert.equal(html.match(/<a /g)?.length, 1, "no nested link inside the card");
});

test("a stalled API cannot hold the article past the card deadline", async () => {
  const api = fakeApi({
    "/api/zpage/post/": ({ init }) =>
      new Promise((_, reject) => {
        // Honour abort like a real fetch — and a second route below ignores
        // it entirely, which the deadline must bound too.
        init.signal?.addEventListener("abort", () =>
          reject(init.signal.reason),
        );
      }),
    "/api/zpage/deaf/": () => new Promise(() => {}),
  });
  const content = doc(
    embed("https://free2z.cash/alice/post"),
    embed("https://free2z.cash/alice/deaf"),
  );
  // Warm the lexer/module paths first, so what is timed is the deadline and
  // not a cold start on a loaded runner.
  md.collectFirstPartyContentEmbeds(content, "free2z.cash");
  const started = Date.now();
  const result = await load(content, api);
  const elapsed = Date.now() - started;
  assert.deepEqual(result, {});
  assert.ok(
    elapsed < deadlines.FIRST_PARTY_EMBED_TIMEOUT_MS + 2000,
    `took ${elapsed}ms`,
  );
});

test("an oversized body is refused rather than parsed", async () => {
  const huge = JSON.stringify(
    zpageBody({
      content: "x".repeat(loader.MAX_FIRST_PARTY_CARD_RESPONSE_BYTES),
    }),
  );
  const api = fakeApi({
    "/api/zpage/post/": () => new Response(huge, { status: 200 }),
  });
  assert.deepEqual(
    await load(embed("https://free2z.cash/alice/post"), api),
    {},
  );
});

// ---------------------------------------------------------------------------
// The SSR routes: reader's cookie in, private response out.
// ---------------------------------------------------------------------------

function routeEvent({ cookie, host, routes, params, url }) {
  const api = fakeApi({ ...routes });
  const headersSet = {};
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  return {
    api,
    headersSet,
    event: {
      params,
      url: new URL(url),
      request: { headers, signal: new AbortController().signal },
      locals: { locale: "en" },
      setHeaders: (values) => Object.assign(headersSet, values),
      fetch: api.fetch,
      host,
    },
  };
}

const HOST_CONTENT = doc(
  "Intro",
  embed("https://free2z.cash/alice/post"),
  embed("https://free2z.cash/alice/subonly"),
);

// The backend's gating, as seen over the wire for three readers. The real
// rule is pinned against Postgres in the pytest matrix; here it only has to
// depend on the cookie the route forwards.
function gatingApi(hostBody) {
  return {
    "/api/zpage/host/": hostBody,
    "/api/zpage/post/": zpageBody(),
    "/api/zpage/subonly/": ({ headers }) =>
      /sessionid=(subscriber|owner)\b/.test(headers.get("cookie") || "")
        ? Response.json(zpageBody({ vanity: "subonly", title: "Members only" }))
        : Response.json({
            show_modal: true,
            page: zpageBody({ vanity: "subonly", content: "Subscribe" }),
          }),
  };
}

test("the SSR route and its first-party card preserve the first exact alias selector", async () => {
  const hostBody = zpageBody({
    vanity: "host",
    content: embed("https://free2z.cash/alice/post?lang=cmn&lang=zh"),
    source_language: "en",
    actual_language: "cmn",
    available_languages: ["en", "cmn"],
  });
  const aliasBody = zpageBody({
    source_language: "en",
    actual_language: "cmn",
    available_languages: ["en", "cmn"],
  });
  const { api, event } = routeEvent({
    cookie: null,
    params: { username: "alice", vanity: "host" },
    url: "https://free2z.cash/alice/host?lang=cmn&lang=zh",
    routes: {
      "/api/zpage/host/": hostBody,
      "/api/zpage/post/": aliasBody,
    },
  });
  const data = await vanityLoad(event);
  await data.relatedArticles;
  await data.seriesContext;

  assert.equal(
    api.calls.find((call) => call.path === "/api/zpage/host/")?.search,
    "?lang=cmn",
    "the vanity SSR loader must pass the raw first validated alias to the API",
  );
  assert.equal(
    api.calls.find((call) => call.path === "/api/zpage/post/")?.search,
    "?lang=cmn",
    "the embedded card loader must use the same alias selector",
  );
  assert.equal(data.articleLanguage, "cmn");
  assert.equal(
    data.firstPartyCards["zpage:free2z.cash/alice/post?lang=cmn"]?.title,
    "Alice's post",
  );
});

test("the immutable-address SSR loader keeps aliases and malformed selectors fall back", async () => {
  const aliasBody = zpageBody({
    source_language: "en",
    actual_language: "cmn",
    available_languages: ["en", "cmn"],
  });
  const originalFetch = globalThis.fetch;
  const { api, event } = routeEvent({
    cookie: null,
    params: { id: "host" },
    url: "https://free2z.cash/article/host?lang=cmn&lang=zh",
    routes: { "/api/zpage/host/": aliasBody },
  });
  globalThis.fetch = api.fetch;
  try {
    await articleLoad(event);
    assert.equal(api.calls[0]?.search, "?lang=cmn");
  } finally {
    globalThis.fetch = originalFetch;
  }

  const malformed = routeEvent({
    cookie: null,
    params: { username: "alice", vanity: "host" },
    url: "https://free2z.cash/alice/host?lang=%3Cscript%3E&lang=cmn",
    routes: { "/api/zpage/host/": zpageBody({ vanity: "host" }) },
  });
  const data = await vanityLoad(malformed.event);
  await data.relatedArticles;
  await data.seriesContext;
  assert.equal(malformed.api.calls[0]?.search, "?lang=en");
});

for (const [reader, cookie, expectedKeys] of [
  ["anonymous", null, ["zpage:free2z.cash/alice/post"]],
  ["stranger", "sessionid=stranger", ["zpage:free2z.cash/alice/post"]],
  [
    "subscriber",
    "sessionid=subscriber",
    ["zpage:free2z.cash/alice/post", "zpage:free2z.cash/alice/subonly"],
  ],
  [
    "owner",
    "sessionid=owner",
    ["zpage:free2z.cash/alice/post", "zpage:free2z.cash/alice/subonly"],
  ],
]) {
  test(`the zPage route resolves cards as the ${reader} reader, and answers privately`, async () => {
    const { api, headersSet, event } = routeEvent({
      cookie,
      params: { username: "alice", vanity: "host" },
      url: "https://free2z.cash/alice/host",
      routes: gatingApi(zpageBody({ vanity: "host", content: HOST_CONTENT })),
    });
    const data = await vanityLoad(event);
    await data.relatedArticles;
    await data.seriesContext;
    assert.deepEqual(Object.keys(data.firstPartyCards).sort(), expectedKeys);
    for (const call of api.calls.filter((c) => /post|subonly/.test(c.path))) {
      assert.equal(call.cookie, cookie);
    }
    assert.equal(headersSet["cache-control"], "private, no-cache");
    assert.match(headersSet.vary, /Cookie/);
    if (!expectedKeys.includes("zpage:free2z.cash/alice/subonly")) {
      assert.doesNotMatch(
        JSON.stringify(data.firstPartyCards),
        /Members only|Subscribe/,
      );
    }
  });
}

test("the zPage route resolves nothing when the host article is itself gated", async () => {
  const { api, event } = routeEvent({
    cookie: null,
    params: { username: "alice", vanity: "host" },
    url: "https://free2z.cash/alice/host",
    routes: gatingApi({
      show_modal: true,
      page: zpageBody({ vanity: "host", content: HOST_CONTENT }),
    }),
  });
  const data = await vanityLoad(event);
  assert.equal(data.gated, true);
  assert.deepEqual(data.firstPartyCards, {});
  assert.ok(
    !api.calls.some((c) => /\/api\/zpage\/(post|subonly)\//.test(c.path)),
  );
});

test("/article/<id> resolves cards as the reader too", async () => {
  const originalFetch = globalThis.fetch;
  // zpageRetrieve goes through the generated client's global fetch; the cards
  // go through the event's fetch. Serve both from the same fake.
  const { api, headersSet, event } = routeEvent({
    cookie: "sessionid=subscriber",
    params: { id: "host" },
    url: "https://free2z.cash/article/host",
    routes: gatingApi(zpageBody({ vanity: "host", content: HOST_CONTENT })),
  });
  globalThis.fetch = api.fetch;
  try {
    const data = await articleLoad(event);
    assert.deepEqual(Object.keys(data.firstPartyCards).sort(), [
      "zpage:free2z.cash/alice/post",
      "zpage:free2z.cash/alice/subonly",
    ]);
    assert.equal(headersSet["cache-control"], "private, no-cache");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
