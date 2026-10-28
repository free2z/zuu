// Regression gate for Google Search Console's "No thumbnail URL provided —
// Video isn't on a watch page" on every zPage video (report of 2026-08-31).
//
// Before this, a `<video>` in a zPage body was a bare media element: no
// `poster`, no `VideoObject`, no `thumbnailUrl`, no `uploadDate`. A crawler
// fetching https://free2z.cash/example_creator/howto-compile-the-latest-ywallet-on-linux
// received exactly:
//
//     <video controls="" preload="metadata" class="markdown-video">
//     <source src="/uploadz/public/example_creator/ywalletcompile_h.mp4" type="video/mp4">
//
// and one `application/ld+json` block containing a lone `Article`.
//
// The assertions here are deliberately about BEHAVIOUR, not source text:
// every JSON-LD check goes through `JSON.parse` of the exact escaped string
// the route interpolates into `<script type="application/ld+json">`, and every
// markup check goes through the real DOMPurify sanitizer that `processMarkdown`
// ends with — which is the only way to know whether `poster=` actually
// survives to the wire rather than being silently dropped.
//
// What this does NOT prove: that a poster was ever generated for a real
// upload (that is py/free2z/dj/apps/uploads/test_video_posters.py), that the route's
// load function populates `article.media`, or that Google accepts the result.
// The last one needs the Rich Results Test against a deployed URL.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";

let server;
let markdown;
let buildZPageMeta;
let embeddedMedia;

before(async () => {
  server = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  markdown = await server.ssrLoadModule("/src/lib/utils/markdown.ts");
  ({ buildZPageMeta } = await server.ssrLoadModule("/src/lib/meta.ts"));
  embeddedMedia = await server.ssrLoadModule(
    "/src/lib/utils/embedded-media.ts",
  );
});

after(async () => {
  await server?.close();
});

const VIDEO_URL = "/uploadz/public/example_creator/ywalletcompile_h.mp4";
const POSTER_URL =
  "/uploadz/public/example_creator/ywalletcompile_h_poster_ab12.webp";

/** One `media` entry shaped exactly like the API's `EmbeddedMedia`. */
function mediaItem(overrides = {}) {
  return {
    embed_url: VIDEO_URL,
    url: VIDEO_URL,
    kind: "video",
    mime_type: "video/mp4",
    access: "public",
    is_public: true,
    poster: POSTER_URL,
    title: "Compiling YWallet",
    description: "Every step, start to finish.",
    uploaded_at: "2024-06-20T21:45:05Z",
    ...overrides,
  };
}

function article(overrides = {}) {
  return {
    free2zaddr: "0f7e1a2b-3c4d-5e6f-7a8b-9c0d1e2f3a4b",
    vanity: "howto-compile-the-latest-ywallet-on-linux",
    title: "How to compile the latest YWallet on Linux",
    description: "A walkthrough.",
    content: `Intro\n\n::embed[${VIDEO_URL}]\n`,
    creator: { username: "example_creator" },
    created_at: "2024-06-20T00:00:00Z",
    updated_at: "2024-06-21T00:00:00Z",
    tags: ["ywallet"],
    media: [mediaItem()],
    ...overrides,
  };
}

/**
 * Parse the JSON-LD exactly as a crawler receives it: the route interpolates
 * `pageMeta.jsonLdString` verbatim into the script block, so undoing
 * `escapeJsonForHtml` and parsing that string is the wire payload, escaping
 * bugs included.
 */
function jsonLd(overrides = {}) {
  const { jsonLdString } = buildZPageMeta(article(overrides));
  assert.ok(jsonLdString, "a published zPage must emit JSON-LD");
  assert.doesNotMatch(
    jsonLdString,
    /<\/script/i,
    "a raw closing script tag would break out of the block",
  );
  const json = jsonLdString
    .replace(/\\u003C/g, "<")
    .replace(/\\u003E/g, ">")
    .replace(/\\u0026/g, "&");
  return JSON.parse(json);
}

function videoNodes(parsed) {
  const graph = parsed["@graph"] || [parsed];
  return graph.filter((node) => node["@type"] === "VideoObject");
}

function articleNode(parsed) {
  const graph = parsed["@graph"] || [parsed];
  return graph.find((node) => node["@type"] === "Article");
}

// ---------------------------------------------------------------------------
// the JSON-LD
// ---------------------------------------------------------------------------

test("a public video with a poster emits a complete VideoObject", () => {
  const parsed = jsonLd();
  const videos = videoNodes(parsed);

  assert.equal(videos.length, 1);
  const video = videos[0];
  // Google's REQUIRED properties for a VideoObject, one assertion each so a
  // failure names the missing field.
  assert.equal(video.name, "Compiling YWallet");
  assert.deepEqual(video.thumbnailUrl, [`https://free2z.cash${POSTER_URL}`]);
  assert.equal(video.uploadDate, "2024-06-20T21:45:05Z");
  assert.equal(video.contentUrl, `https://free2z.cash${VIDEO_URL}`);
  assert.equal(video.description, "Every step, start to finish.");
  // Absolute URLs: a crawler resolving `/uploadz/...` against its own origin
  // is not a thing we get to rely on.
  for (const url of [video.contentUrl, ...video.thumbnailUrl]) {
    assert.match(url, /^https:\/\/free2z\.cash\//);
  }
});

test("the Article node links the video and keeps every field it had", () => {
  const parsed = jsonLd();
  const node = articleNode(parsed);
  const video = videoNodes(parsed)[0];

  assert.equal(parsed["@context"], "https://schema.org");
  assert.deepEqual(node.video, [{ "@id": video["@id"] }]);
  // A spot-check that turning the block into a @graph did not drop the
  // Article's own contract.
  assert.equal(node.headline, "How to compile the latest YWallet on Linux");
  assert.equal(node.author.name, "example_creator");
  assert.equal(node.publisher["@id"], "https://free2z.cash/#organization");
  assert.equal(node.datePublished, "2024-06-20T00:00:00Z");
  assert.equal(node.isAccessibleForFree, true);
});

test("a page with no video is byte-identical to what it emitted before", () => {
  const withMedia = buildZPageMeta(article({ media: [] })).jsonLdString;
  const withoutMediaField = buildZPageMeta(
    article({ media: undefined }),
  ).jsonLdString;

  assert.equal(withMedia, withoutMediaField);
  const parsed = JSON.parse(withMedia);
  // The historical flat shape: no @graph, @context first, no `video` key.
  assert.equal(parsed["@type"], "Article");
  assert.equal(parsed["@graph"], undefined);
  assert.equal(parsed.video, undefined);
  assert.equal(Object.keys(parsed)[0], "@context");
});

test("a gated video is never advertised", () => {
  for (const gated of [
    mediaItem({ is_public: false, access: "members" }),
    mediaItem({ is_public: false, access: "private" }),
    // `access: public` but a deactivated owner —. `is_public` is the
    // only field that answers "will nginx serve this to an anonymous
    // request", and it is the one that must be believed.
    mediaItem({ is_public: false, access: "public" }),
  ]) {
    const parsed = jsonLd({ media: [gated] });
    assert.deepEqual(
      videoNodes(parsed),
      [],
      `${gated.access} video must not be declared`,
    );
    assert.equal(articleNode(parsed).video, undefined);
  }
});

test("a video with no poster emits nothing rather than a fabricated thumbnail", () => {
  // The whole point of: a `thumbnailUrl` we cannot back with a real
  // frame is worse than the "no thumbnail URL provided" report, because the
  // crawler fetches it. The page's OG card is NOT a frame of the video.
  const parsed = jsonLd({ media: [mediaItem({ poster: null })] });

  assert.deepEqual(videoNodes(parsed), []);
  const serialized = JSON.stringify(parsed);
  assert.doesNotMatch(serialized, /VideoObject/);
  assert.doesNotMatch(serialized, /thumbnailUrl/);
});

test("an incomplete media row emits nothing", () => {
  for (const broken of [
    mediaItem({ uploaded_at: "" }),
    mediaItem({ title: "", url: "" }),
    mediaItem({ kind: "audio" }),
  ]) {
    assert.deepEqual(videoNodes(jsonLd({ media: [broken] })), []);
  }
});

test("a video with no title of its own falls back to the page title", () => {
  const parsed = jsonLd({ media: [mediaItem({ title: "", description: "" })] });
  const video = videoNodes(parsed)[0];

  assert.equal(video.name, "How to compile the latest YWallet on Linux");
  assert.ok(
    video.description,
    "the page description is the documented fallback",
  );
});

test("multiple videos become multiple nodes with distinct ids", () => {
  const second = "/uploadz/public/example_creator/second.mp4";
  const parsed = jsonLd({
    media: [
      mediaItem(),
      mediaItem({
        embed_url: second,
        url: second,
        poster: "/uploadz/public/example_creator/second_poster.webp",
        title: "Part two",
      }),
    ],
  });
  const videos = videoNodes(parsed);

  assert.equal(videos.length, 2);
  assert.notEqual(videos[0]["@id"], videos[1]["@id"]);
  assert.deepEqual(
    articleNode(parsed).video,
    videos.map((node) => ({ "@id": node["@id"] })),
  );
});

// ---------------------------------------------------------------------------
// the rendered player
// ---------------------------------------------------------------------------

test("poster survives the sanitizer onto a server-rendered <video>", () => {
  // `poster` is not in markdownSanitizeOptions.ADD_ATTR's ancestors by
  // accident — DOMPurify's own defaults also allow it, which is exactly why
  // this has to be checked empirically rather than reasoned about.
  const posters = embeddedMedia.buildVideoPosterMap([mediaItem()]);
  const html = markdown.processMarkdown(`::embed[${VIDEO_URL}]`, {
    videoPosters: posters,
  });

  assert.match(html, /<video\b/);
  assert.match(html, new RegExp(`poster="${POSTER_URL}"`));
  assert.match(html, new RegExp(`<source src="${VIDEO_URL}"`));
});

test("a video with no poster renders no poster attribute at all", () => {
  const html = markdown.processMarkdown(`::embed[${VIDEO_URL}]`, {
    videoPosters: embeddedMedia.buildVideoPosterMap([
      mediaItem({ poster: null }),
    ]),
  });

  assert.match(html, /<video\b/);
  assert.doesNotMatch(html, /\bposter=/);
});

test("options do not leak between renders", () => {
  markdown.processMarkdown(`::embed[${VIDEO_URL}]`, {
    videoPosters: embeddedMedia.buildVideoPosterMap([mediaItem()]),
  });
  const second = markdown.processMarkdown(`::embed[${VIDEO_URL}]`);

  assert.doesNotMatch(second, /\bposter=/);
});

test("a third-party video carries the poster as an inert data attribute", () => {
  const remote = "https://tracker.example/probe.mp4";
  const html = markdown.processMarkdown(`::embed[${remote}]`, {
    videoPosters: { "/uploadz/whatever.mp4": POSTER_URL },
  });

  // Unchanged behaviour: no live player, no live src, before consent.
  assert.match(html, /class="video-embed-placeholder"/);
  assert.doesNotMatch(html, /<video\b|<source\b[^>]*\bsrc=/);
  // And no poster either — the map is keyed by upload path, and a tracker
  // URL is not one of ours.
  assert.doesNotMatch(html, /data-video-poster=/);
});

test("an absolute free2z upload URL is rewritten and gets a real poster", () => {
  // `rewriteFree2zUploadUrl` turns an absolute free2z upload URL into the
  // root-relative form BEFORE the third-party check, so this is a
  // server-rendered player, not a placeholder — and the poster lookup has to
  // survive that rewrite.
  const absolute = `https://free2z.cash${VIDEO_URL}`;
  const html = markdown.processMarkdown(`::embed[${absolute}]`, {
    videoPosters: embeddedMedia.buildVideoPosterMap([mediaItem()]),
  });

  assert.match(html, /<video\b/);
  assert.match(html, new RegExp(`poster="${POSTER_URL}"`));
});

test("a placeholder-rendered upload carries its poster as data-video-poster", () => {
  // Reachable whenever PUBLIC_API_BASE_URL points uploads at another host
  // (dev/staging): `getApiUploadUrl` then produces an absolute URL that SSR
  // cannot classify as same-origin, so MarkdownVideo mounts it client-side
  // and the poster must travel with it.
  const hosted = `https://uploads.example${VIDEO_URL}`;
  const html = markdown.processMarkdown(`::embed[${hosted}]`, {
    videoPosters: embeddedMedia.buildVideoPosterMap([mediaItem()]),
  });

  assert.match(html, /class="video-embed-placeholder"/);
  assert.match(html, new RegExp(`data-video-poster="${POSTER_URL}"`));
});

test("a poster with a hostile scheme is refused at the sink", () => {
  const html = markdown.processMarkdown(`::embed[${VIDEO_URL}]`, {
    videoPosters: { [VIDEO_URL]: "javascript:alert(1)" },
  });

  assert.match(html, /<video\b/);
  assert.doesNotMatch(html, /javascript:/i);
});

// ---------------------------------------------------------------------------
// the join key
// ---------------------------------------------------------------------------

test("every spelling of an upload URL reduces to the same key", () => {
  const { uploadPathKey } = embeddedMedia;
  const expected = "/uploadz/example_creator/clip.mp4";

  assert.equal(
    uploadPathKey("/uploadz/public/example_creator/clip.mp4"),
    expected,
  );
  assert.equal(uploadPathKey("/uploadz/example_creator/clip.mp4"), expected);
  assert.equal(
    uploadPathKey(
      "https://free2z.cash/uploadz/public/example_creator/clip.mp4",
    ),
    expected,
  );
  assert.equal(
    uploadPathKey("/uploadz/public/example_creator/clip.mp4?v=2"),
    expected,
  );
  assert.equal(
    uploadPathKey("/uploadz/public/example_cre%61tor/clip.mp4"),
    expected,
    "percent-encoding must not split one asset into two keys",
  );

  assert.equal(uploadPathKey("//free2z.cash/uploadz/public/x.mp4"), null);
  assert.equal(uploadPathKey("javascript:alert(1)"), null);
  assert.equal(uploadPathKey("/media/x.mp4"), null);
  assert.equal(uploadPathKey(undefined), null);
});
