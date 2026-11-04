// Regression gate for the Search Console error "Profile page structured data
// issues detected in free2z.cash — Missing field mainEntity" (2026-08-14).
//
// `/{username}` rendered `"@type": "ProfilePage"` with the creator's Person
// object sitting NEXT TO it as a separate `@graph` node, unlinked. Google
// requires `ProfilePage.mainEntity`; without it the rich result is suppressed
// and every creator profile is reported as a critical error.
//
// Two things are checked here, and the second is the one that keeps this from
// regressing: `createPageJsonLd()` will not EMIT a ProfilePage unless a valid
// mainEntity is present. Forgetting to pass one degrades to WebPage — no rich
// result, but no error report either.
//
// Coverage runs from the helper up through real markup: the last two tests
// SSR-render <SeoHead> and parse the `<script type="application/ld+json">` it
// emits, so an escaping or serialization bug between the object graph and the
// wire cannot pass.
//
// What this does NOT prove: that the route reaches this code with a populated
// creator (the load function is not exercised), or that Google is happy with
// the result. Route wiring is asserted by reading `[username]/+page.svelte`;
// validating with Google needs the Rich Results Test on a deployed URL.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { createServer } from "vite";

const PROFILE_ROUTE = new URL(
  "../src/routes/[username]/+page.svelte",
  import.meta.url,
);

const ORIGIN = "https://free2z.cash";

let createPageJsonLd;
let isValidProfileMainEntity;
let renderSvelte;
let SeoHead;
let server;

before(async () => {
  server = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  ({ createPageJsonLd, isValidProfileMainEntity } =
    await server.ssrLoadModule("/src/lib/seo.ts"));
  ({ render: renderSvelte } = await server.ssrLoadModule("svelte/server"));
  SeoHead = (await server.ssrLoadModule("/src/lib/components/SeoHead.svelte"))
    .default;
});

after(async () => {
  await server?.close();
});

const PERSON = {
  "@type": "Person",
  "@id": `${ORIGIN}/free2z#creator`,
  name: "Free2Z",
  alternateName: "@free2z",
  url: `${ORIGIN}/free2z`,
};

function buildProfile(overrides = {}) {
  return createPageJsonLd({
    type: "profile",
    origin: ORIGIN,
    canonicalHref: `${ORIGIN}/free2z`,
    title: "Free2Z on Free2Z",
    description: "free2z is a creator on free2z, just like you",
    imageHref: `${ORIGIN}/brand/free2z-og.png`,
    imageWidth: 1200,
    imageHeight: 630,
    mainEntity: PERSON,
    ...overrides,
  });
}

/** The `@graph` node describing the page itself. */
function pageNode(jsonLd) {
  return jsonLd["@graph"][0];
}

/**
 * SSR-render <SeoHead> and parse the JSON-LD it actually puts on the wire —
 * i.e. what a crawler receives, after `escapeJsonForHtml()`.
 */
function renderJsonLd(props) {
  const { head } = renderSvelte(SeoHead, {
    props: {
      title: "Free2Z on Free2Z",
      description: "free2z is a creator on free2z, just like you",
      path: "/free2z",
      ...props,
    },
  });

  const match = head.match(
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/,
  );
  assert.ok(match, "SeoHead must emit a ld+json script block");

  // Undo the HTML-escaping applied on the way out; the payload is otherwise
  // not parseable as JSON.
  const json = match[1]
    .replace(/\\u003C/g, "<")
    .replace(/\\u003E/g, ">")
    .replace(/\\u0026/g, "&");
  return JSON.parse(json);
}

test("a profile page carries mainEntity on the ProfilePage node", () => {
  const node = pageNode(buildProfile());

  assert.equal(node["@type"], "ProfilePage");
  assert.equal(node.mainEntity["@type"], "Person");
  assert.equal(node.mainEntity.name, "Free2Z");
});

test("mainEntity survives JSON serialization into the <script> block", () => {
  // JSON.stringify drops `undefined` values; a mainEntity lost that way would
  // be invisible in every assertion made against the object graph.
  const serialized = JSON.parse(JSON.stringify(buildProfile()));
  const node = pageNode(serialized);

  assert.equal(node["@type"], "ProfilePage");
  assert.ok(node.mainEntity, "mainEntity must exist in the serialized output");
  assert.equal(node.mainEntity.name, "Free2Z");
});

test("the profile entity is not also duplicated as a sibling graph node", () => {
  const graph = buildProfile()["@graph"];
  const people = graph.filter((node) => node["@type"] === "Person");

  assert.deepEqual(people, [], "the Person belongs under mainEntity only");
});

test("extra structured data still lands as sibling graph nodes", () => {
  const graph = buildProfile({
    extra: [{ "@type": "BreadcrumbList", itemListElement: [] }],
  })["@graph"];

  assert.equal(graph.length, 2);
  assert.equal(graph[1]["@type"], "BreadcrumbList");
});

test("a profile without a usable entity degrades to WebPage", () => {
  // Emitting ProfilePage here is what generated the Search Console error, so
  // the fallback is the actual fix — not the happy path above.
  for (const mainEntity of [
    undefined,
    null,
    {},
    { "@type": "Person" }, // no name and no handle
    { "@type": "Person", name: "   ", alternateName: "" }, // both blank
    { "@type": "WebPage", name: "Not a person" }, // wrong type
  ]) {
    const node = pageNode(buildProfile({ mainEntity }));
    assert.equal(
      node["@type"],
      "WebPage",
      `mainEntity ${JSON.stringify(mainEntity)} must not yield a ProfilePage`,
    );
    assert.equal(node.mainEntity, undefined);
  }
});

test("isValidProfileMainEntity accepts Person and Organization", () => {
  assert.equal(isValidProfileMainEntity(PERSON), true);
  assert.equal(
    isValidProfileMainEntity({ "@type": "Organization", name: "Free2Z" }),
    true,
  );
  assert.equal(isValidProfileMainEntity("Free2Z"), false);
});

test("a handle alone identifies the entity, as Google allows", () => {
  // Google requires `name` OR `alternateName`, not `name` specifically. Being
  // stricter costs rich-result eligibility silently, with nothing anywhere to
  // explain why — so the handle-only entity must still yield a ProfilePage.
  const handleOnly = { "@type": "Person", alternateName: "@alice" };

  assert.equal(isValidProfileMainEntity(handleOnly), true);
  assert.equal(
    pageNode(buildProfile({ mainEntity: handleOnly }))["@type"],
    "ProfilePage",
  );
});

test("non-profile page types are unaffected", () => {
  const article = pageNode(
    buildProfile({
      type: "article",
      mainEntity: undefined,
      modifiedTime: "2026-08-01T12:34:56Z",
    }),
  );
  assert.equal(article["@type"], "Article");
  assert.equal(article.headline, "Free2Z on Free2Z");
  assert.equal(article.dateModified, "2026-08-01T12:34:56Z");

  const website = pageNode(
    buildProfile({ type: "website", mainEntity: PERSON }),
  );
  assert.equal(website["@type"], "WebPage");
  assert.equal(website.mainEntity, undefined);
});

test("the rendered <SeoHead> markup carries mainEntity", () => {
  const node = pageNode(renderJsonLd({ type: "profile", mainEntity: PERSON }));

  assert.equal(node["@type"], "ProfilePage");
  assert.equal(node.mainEntity["@type"], "Person");
  assert.equal(node.mainEntity.name, "Free2Z");
});

test("rendered markup omits ProfilePage when the entity is unusable", () => {
  const node = pageNode(renderJsonLd({ type: "profile" }));

  assert.equal(node["@type"], "WebPage");
  assert.equal(node.mainEntity, undefined);
});

test("the /{username} route passes its Person as mainEntity", () => {
  // The builder above is only reached correctly if the route wires it up; a
  // `structuredData={profileJsonLd}` regression would restore the exact bug
  // while every assertion above stayed green.
  const source = readFileSync(PROFILE_ROUTE, "utf8");

  assert.match(source, /mainEntity=\{profileJsonLd\}/);
  assert.doesNotMatch(source, /structuredData=\{profileJsonLd\}/);
});

// --- sameAs / dateCreated  ------------------------------------
//
//  deliberately shipped WITHOUT `sameAs` or `dateCreated`: `sameAs`
// needed a safe source of truth for identity links (landed separately in
// `sameAsUrls()`, tests/bio.test.mjs), and `dateCreated` needed the backend
// to expose `date_joined` on CreatorDetailSerializer. Both are now wired
// through; these tests cover the JSON-LD shape, not the route's fetch
// (unexercised here, same limitation as the file above).
//
// The API intentionally keeps `date_joined` at day precision for privacy. The
// JSON-LD consumer expands that date to UTC midnight because Google's parser
// expects a DateTime; this must not be confused with recovering signup time.
// `date_modified` is a separate day-only public-profile timestamp. The
// JSON-LD consumer expands it to UTC midnight, just as it does `dateCreated`.
// The route must never use account-wide `updated_at`, which includes private
// security changes.

test("a ProfilePage carries a DateTime dateCreated, not datePublished", () => {
  const node = pageNode(
    buildProfile({
      dateCreated: "2024-01-15",
      modifiedTime: "2026-08-01T00:00:00Z",
    }),
  );

  assert.equal(node["@type"], "ProfilePage");
  assert.equal(node.dateCreated, "2024-01-15T00:00:00Z");
  assert.equal(node.dateModified, "2026-08-01T00:00:00Z");
  // Google's recommended property for ProfilePage is `dateCreated`, not
  // `datePublished` -- a profile is not "published" the way an article is.
  assert.equal(node.datePublished, undefined);
});

test("a ProfilePage preserves an existing DateTime dateCreated", () => {
  const node = pageNode(
    buildProfile({ dateCreated: "2024-01-15T12:34:56+00:00" }),
  );

  assert.equal(node.dateCreated, "2024-01-15T12:34:56+00:00");
});

test("ProfilePage dateModified converts the public day to UTC midnight", () => {
  const node = pageNode(buildProfile({ modifiedTime: "2026-08-01" }));

  assert.equal(node.dateModified, "2026-08-01T00:00:00Z");
});

test("a null profile dateModified is omitted from rendered JSON-LD", () => {
  const node = pageNode(
    renderJsonLd({
      type: "profile",
      mainEntity: PERSON,
      modifiedTime: undefined,
    }),
  );

  assert.equal(Object.hasOwn(node, "dateModified"), false);
});

test("dateCreated is dropped when the page does not resolve to a ProfilePage", () => {
  // Article and WebPage keep using publishedTime -> datePublished; dateCreated
  // is ProfilePage-only and must not leak onto other page types.
  const article = pageNode(
    buildProfile({
      type: "article",
      mainEntity: undefined,
      publishedTime: "2024-01-15T00:00:00Z",
      dateCreated: "2024-01-15",
    }),
  );
  assert.equal(article["@type"], "Article");
  assert.equal(article.datePublished, "2024-01-15T00:00:00Z");
  assert.equal(article.dateCreated, undefined);
});

test("a profile Person carries sameAs when passed on mainEntity", () => {
  const person = {
    ...PERSON,
    sameAs: ["https://x.com/_skyl", "https://github.com/skyl"],
  };
  const node = pageNode(buildProfile({ mainEntity: person }));

  assert.equal(node["@type"], "ProfilePage");
  assert.deepEqual(node.mainEntity.sameAs, [
    "https://x.com/_skyl",
    "https://github.com/skyl",
  ]);
});

test("dateCreated and sameAs survive rendering through <SeoHead> onto the wire", () => {
  const person = { ...PERSON, sameAs: ["https://github.com/skyl"] };
  const node = pageNode(
    renderJsonLd({
      type: "profile",
      mainEntity: person,
      dateCreated: "2024-01-15",
      modifiedTime: "2026-08-01",
    }),
  );

  assert.equal(node["@type"], "ProfilePage");
  assert.equal(node.dateCreated, "2024-01-15T00:00:00Z");
  assert.equal(node.dateModified, "2026-08-01T00:00:00Z");
  assert.deepEqual(node.mainEntity.sameAs, ["https://github.com/skyl"]);
});

test("the /{username} route wires dateCreated from the creator and sameAs from parsed socials", () => {
  const source = readFileSync(PROFILE_ROUTE, "utf8");

  assert.match(source, /dateCreated=\{creator\.date_joined\}/);
  assert.match(source, /sameAsUrls\(bioSocials\)/);
});

test("the /{username} route wires the public-profile dateModified, not updated_at", () => {
  // `updated_at` advances on private security operations (a password
  // change, for one) that have nothing to do with the public profile.
  // Publishing it as `dateModified` on an anonymous endpoint would let
  // anyone poll the exact moment of a creator's last account change of ANY
  // kind. A regression here would silently reintroduce that disclosure.
  const source = readFileSync(PROFILE_ROUTE, "utf8");

  assert.doesNotMatch(source, /modifiedTime=\{creator\.updated_at\}/);
  assert.match(
    source,
    /modifiedTime=\{creator\.date_modified \|\| undefined\}/,
  );
});
