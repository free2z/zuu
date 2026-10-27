import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { createServer } from "vite";

/**
 *  a same-origin `::embed[…]` skips the consent gate and Iframely. The
 * classifier deciding "same origin" is therefore a security boundary: every
 * mistake in the permissive direction is a third-party embed rendered with no
 * consent. These tables are the boundary's contract. Each hostile case asserts
 * the NEGATIVE, and the whole file is proven load-bearing by a negative
 * control recorded in the PR (loosen the host check / drop the canonical
 * spelling check / drop the decoded-segment check -> this file goes red).
 */

let server;
let firstParty;
let markdown;
let privacy;

before(async () => {
  server = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  firstParty = await server.ssrLoadModule(
    "/src/lib/utils/first-party-embed.ts",
  );
  markdown = await server.ssrLoadModule("/src/lib/utils/markdown.ts");
  privacy = await server.ssrLoadModule("/src/lib/stores/privacy.ts");
});

after(async () => {
  await server?.close();
});

const classify = (value) => firstParty.classifyFirstPartyEmbed(value);

// ---------------------------------------------------------------------------
// Accepted: what an author (or the  editor insert) actually writes.
// ---------------------------------------------------------------------------
const ACCEPTED = [
  [
    "https://free2z.cash/uploadz/public/alice/talk.mp4",
    { kind: "video", path: "/uploadz/public/alice/talk.mp4", name: "talk.mp4" },
  ],
  [
    "https://free2z.cash/uploadz/public/alice/episode.mp3",
    {
      kind: "audio",
      path: "/uploadz/public/alice/episode.mp3",
      name: "episode.mp3",
    },
  ],
  [
    // The legacy / members-tier alias (tuzi#1463): no `public/` segment.
    "https://free2z.cash/uploadz/alice/photo.png",
    { kind: "image", path: "/uploadz/alice/photo.png", name: "photo.png" },
  ],
  [
    // `http:` renders exactly like `https:` (only the path is ever used) —
    // the behaviour this renderer had before  (security review).
    "http://free2z.cash/uploadz/public/alice/talk.mp4",
    { kind: "video", path: "/uploadz/public/alice/talk.mp4", name: "talk.mp4" },
  ],
  [
    // Legacy alias host: an upload is served by PATH from our own origin, as
    // the pre- renderer always rewrote it (codex review round 6).
    "https://www.free2z.cash/uploadz/public/alice/talk.mp4",
    { kind: "video", path: "/uploadz/public/alice/talk.mp4", name: "talk.mp4" },
  ],
  [
    "https://www.free2z.com/uploadz/alice/song.mp3",
    { kind: "audio", path: "/uploadz/alice/song.mp3", name: "song.mp3" },
  ],
  [
    "https://free2z.cash/uploadz/public/alice/w-9.pdf",
    { kind: "pdf", path: "/uploadz/public/alice/w-9.pdf", name: "w-9.pdf" },
  ],
  [
    "https://free2z.cash/uploadz/public/alice/archive.zip",
    {
      kind: "file",
      path: "/uploadz/public/alice/archive.zip",
      name: "archive.zip",
    },
  ],
  [
    "https://stage.free2z.cash/uploadz/public/alice/clip.webm",
    {
      kind: "video",
      path: "/uploadz/public/alice/clip.webm",
      name: "clip.webm",
    },
  ],
  [
    "https://free2z.com/uploadz/public/free2z/fw9.pdf",
    { kind: "pdf", path: "/uploadz/public/free2z/fw9.pdf", name: "fw9.pdf" },
  ],
  [
    "/uploadz/public/alice/doc.pdf",
    { kind: "pdf", path: "/uploadz/public/alice/doc.pdf", name: "doc.pdf" },
  ],
  [
    "/uploadz/alice/song.ogg",
    { kind: "audio", path: "/uploadz/alice/song.ogg", name: "song.ogg" },
  ],
  [
    // Percent-encoded names are ordinary; the display name is decoded TEXT.
    "https://free2z.cash/uploadz/public/alice/My%20Doc.PDF",
    {
      kind: "pdf",
      path: "/uploadz/public/alice/My%20Doc.PDF",
      name: "My Doc.PDF",
    },
  ],
  [
    // Query and fragment are dropped from what is rendered.
    "https://free2z.cash/uploadz/public/alice/w-9.pdf?next=https://evil.example/#x",
    { kind: "pdf", path: "/uploadz/public/alice/w-9.pdf", name: "w-9.pdf" },
  ],
  [
    // A media time range survives on video/audio (codex review): it never
    // reaches the server and it is what makes an excerpt embed an excerpt.
    "/uploadz/public/alice/talk.mp4#t=120,150",
    {
      kind: "video",
      path: "/uploadz/public/alice/talk.mp4#t=120,150",
      name: "talk.mp4",
    },
  ],
  [
    "https://free2z.cash/uploadz/public/alice/episode.mp3#t=30",
    {
      kind: "audio",
      path: "/uploadz/public/alice/episode.mp3#t=30",
      name: "episode.mp3",
    },
  ],
  [
    //...and anything else in a fragment is dropped.
    "https://free2z.cash/uploadz/public/alice/talk.mp4#t=1&x=javascript:1",
    { kind: "video", path: "/uploadz/public/alice/talk.mp4", name: "talk.mp4" },
  ],
  [
    // A legacy filename with a literal `%` (codex review): still a player.
    "https://free2z.cash/uploadz/public/legacy/100%25.mp4",
    {
      kind: "video",
      path: "/uploadz/public/legacy/100%25.mp4",
      name: "100%.mp4",
    },
  ],
  [
    // A legacy spelling with a plain interior space (codex review).
    "/uploadz/public/legacy/My Video.mp4",
    {
      kind: "video",
      path: "/uploadz/public/legacy/My%20Video.mp4",
      name: "My Video.mp4",
    },
  ],
  [
    "https://free2z.cash/uploadz/public/legacy/My Talk.mp3",
    {
      kind: "audio",
      path: "/uploadz/public/legacy/My%20Talk.mp3",
      name: "My Talk.mp3",
    },
  ],
  [
    "/uploadz/public/alice/burst.avifs",
    {
      kind: "image",
      path: "/uploadz/public/alice/burst.avifs",
      name: "burst.avifs",
    },
  ],
  [
    "https://free2z.cash/alice/my-article",
    {
      kind: "zpage",
      href: "https://free2z.cash/alice/my-article",
      username: "alice",
      identifier: "my-article",
    },
  ],
  [
    "https://free2z.cash/alice/my-article/",
    {
      kind: "zpage",
      href: "https://free2z.cash/alice/my-article/",
      username: "alice",
      identifier: "my-article",
    },
  ],
  [
    "https://free2z.cash/article/zAbC123",
    {
      kind: "zpage",
      href: "https://free2z.cash/article/zAbC123",
      username: null,
      identifier: "zAbC123",
    },
  ],
  [
    "https://free2z.cash/converse/0F8FAD5B-D9CB-469F-A165-70867728950E",
    {
      kind: "converse",
      href: "https://free2z.cash/converse/0F8FAD5B-D9CB-469F-A165-70867728950E",
      uuid: "0f8fad5b-d9cb-469f-a165-70867728950e",
    },
  ],
  [
    "https://free2z.cash/converse/0f8fad5b-d9cb-469f-a165-70867728950e#reply",
    {
      kind: "converse",
      href: "https://free2z.cash/converse/0f8fad5b-d9cb-469f-a165-70867728950e#reply",
      uuid: "0f8fad5b-d9cb-469f-a165-70867728950e",
    },
  ],
  ["https://free2z.cash", { kind: "page", href: "https://free2z.cash/" }],
];

test("first-party uploads and pages are classified exactly (#2021)", () => {
  for (const [value, expected] of ACCEPTED) {
    assert.deepEqual(classify(value), expected, value);
  }
});

// ---------------------------------------------------------------------------
// Off-site, or not provably on-site: MUST be null, i.e. keep the consent gate.
// ---------------------------------------------------------------------------
const UPLOAD = "/uploadz/public/alice/w-9.pdf";
const NOT_FIRST_PARTY = [
  // Host is a prefix / substring / path / query of something else.
  `https://free2z.cash.evil.com${UPLOAD}`,
  `https://evil-free2z.cash${UPLOAD}`,
  `https://evilfree2z.cash${UPLOAD}`,
  "https://evil.com/?u=free2z.cash",
  `https://evil.com/?u=https://free2z.cash${UPLOAD}`,
  `https://evil.com/free2z.cash${UPLOAD}`,
  `https://evil.com${UPLOAD}`,
  `https://evil.com#https://free2z.cash${UPLOAD}`,
  // Protocol-relative and slash/backslash authority tricks.
  `//free2z.cash${UPLOAD}`,
  `///free2z.cash${UPLOAD}`,
  `/\\free2z.cash${UPLOAD}`,
  `/\\evil.com${UPLOAD}`,
  `https:\\\\free2z.cash${UPLOAD}`,
  `https:\\\\free2z.cash\\uploadz\\public\\alice\\w-9.pdf`,
  `https:/free2z.cash${UPLOAD}`,
  `https:free2z.cash${UPLOAD}`,
  `https:///free2z.cash${UPLOAD}`,
  // Userinfo, both directions, and the empty-credential spelling.
  `https://free2z.cash@evil.com${UPLOAD}`,
  `https://evil.com@free2z.cash${UPLOAD}`,
  `https://user:pass@free2z.cash${UPLOAD}`,
  `https://:@free2z.cash${UPLOAD}`,
  `https://free2z.cash%2F@evil.com${UPLOAD}`,
  `https://free2z.cash\\@evil.com${UPLOAD}`,
  // Lookalikes: trailing dot, IDN homoglyph (Cyrillic е), punycode, case,
  // percent-encoded host, subdomains that are not in the exact set.
  `https://free2z.cash.${UPLOAD}`,
  `https://frеe2z.cash${UPLOAD}`,
  `https://xn--fre2z-3ve.cash${UPLOAD}`,
  `https://FREE2Z.CASH${UPLOAD}`,
  `https://Free2z.cash${UPLOAD}`,
  `HTTPS://free2z.cash${UPLOAD}`,
  `https://free2z%2Ecash${UPLOAD}`,
  `https://free2z%2ecash${UPLOAD}`,
  // Subdomains outside the exact set may name an upload only (legacy alias,
  // served by path from our origin) — never a route.
  "https://www.free2z.cash/alice/my-article",
  "https://relay.free2z.cash/",
  "https://evil.free2z.cash/logout?next=https://evil.com",
  "https://www.free2z.cash/converse/0f8fad5b-d9cb-469f-a165-70867728950e",
  `https://www.free2z.cash/uploadz/private/7d1e/passport.png`,
  // Ports: only the default, and only when not spelled out.
  `https://free2z.cash:8443${UPLOAD}`,
  `https://free2z.cash:443${UPLOAD}`,
  `https://free2z.cash:${UPLOAD}`,
  // A space may never sit in or next to the authority.
  `https://free2z.cash ${UPLOAD}`,
  `https:// free2z.cash${UPLOAD}`,
  `https://free2z.cash @evil.com${UPLOAD}`,
  `https://evil.com /@free2z.cash${UPLOAD}`,
  // Whitespace / control characters the URL parser would silently strip.
  ` https://free2z.cash${UPLOAD}`,
  `https://free2z.cash${UPLOAD} `,
  `\thttps://free2z.cash${UPLOAD}`,
  `ht\ttps://free2z.cash${UPLOAD}`,
  `https://free2z.cash/upl\toadz/public/alice/w-9.pdf`,
  `https://free2z.cash/uploadz/public/alice/w-9.pdf\n`,
  `https://free\n2z.cash${UPLOAD}`,
  `https://free2z.cash${UPLOAD}\r`,
  `https://free2z.cash${UPLOAD} `,
  `\u0000https://free2z.cash${UPLOAD}`,
  // IP literals, in every spelling the parser normalizes.
  `https://127.0.0.1${UPLOAD}`,
  `https://[::1]${UPLOAD}`,
  `https://0x7f000001${UPLOAD}`,
  `https://2130706432${UPLOAD}`,
  // Schemes.
  `HTTP://free2z.cash${UPLOAD}`,
  `http://free2z.cash:80${UPLOAD}`,
  `http:free2z.cash${UPLOAD}`,
  `http://evil.com@free2z.cash${UPLOAD}`,
  `javascript://free2z.cash${UPLOAD}`,
  "javascript:alert(document.domain)//free2z.cash/uploadz/public/a/x.pdf",
  "JaVaScRiPt:alert(1)",
  "data:application/pdf;base64,JVBERi0=",
  "data:text/html,<script>alert(1)</script>",
  "blob:https://free2z.cash/2f1c5b3e-7a1d-4f5e-9a41-000000000000",
  `ftp://free2z.cash${UPLOAD}`,
  `file:///uploadz/public/alice/w-9.pdf`,
  `ws://free2z.cash${UPLOAD}`,
  // Root-relative values that are not an allow-listed upload.
  "/uploadz/../logout",
  "/uploadz/%2e%2e/logout",
  "/uploadz/%2E%2E/logout?next=https://evil.com",
  "/uploadz/a%2F..%2F..%2Flogout",
  "/uploadz/a%2f..%2f..%2flogout.mp4",
  "/uploadz/a%5c..%5clogout.png",
  "/uploadz/private/7d1e/passport.png",
  "/uploadz/public/hls/alice/talk.mp4/master.m3u8",
  "/uploadz/public",
  "/uploadz/",
  "/uploadz",
  "/uploadz//evil.com/x.png",
  "/alice/my-article",
  "/logout?next=https://evil.com",
  "/",
  // Non-strings and empties.
  "",
  undefined,
  null,
  42,
  { href: `https://free2z.cash${UPLOAD}` },
];

test("off-site and non-canonical values are never first party (#2021)", () => {
  for (const value of NOT_FIRST_PARTY) {
    assert.equal(classify(value), null, JSON.stringify(value));
  }
});

// ---------------------------------------------------------------------------
// On our host but not an allow-listed upload shape: never NATIVE media. The
// only thing these may become is a plain link to the URL the author wrote —
// which they could already have written as a markdown link.
// ---------------------------------------------------------------------------
const OUR_HOST_HOSTILE_PATH = [
  "https://free2z.cash/logout?next=https://evil.com",
  "https://free2z.cash/accounts/logout/?next=//evil.com",
  "https://free2z.cash/uploadz/../logout",
  "https://free2z.cash/uploadz/%2e%2e/logout",
  "https://free2z.cash/uploadz/a%2F..%2F..%2Flogout.mp4",
  "https://free2z.cash/uploadz/%2e%2e%2flogout.pdf",
  "https://free2z.cash/uploadz/a%5c..%5clogout.png",
  "https://free2z.cash/uploadz/%252e%252e/x.png",
  "https://free2z.cash/uploadz/a%252f..%252f..%252flogout.png",
  "https://free2z.cash/uploadz/a%255c..%255clogout.png",
  "https://free2z.cash/uploadz/public/alice/%2500.png",
  "https://free2z.cash/uploadz/public/alice/%00.png",
  "https://free2z.cash/uploadz/public/alice/%0a.mp4",
  "https://free2z.cash/uploadz/public/alice/%E0%A4%A.png",
  "https://free2z.cash/uploadz/private/7d1e/passport.png",
  "https://free2z.cash/uploadz/public/hls/alice/talk.mp4/master.m3u8",
  "https://free2z.cash/uploadz//evil.com/x.png",
  "https://free2z.cash/uploadz/public/alice/",
  "https://free2z.cash/uploadz/",
  "https://free2z.cash/uploadzz/x.png",
  "https://free2z.cash/UPLOADZ/x.png",
  "https://free2z.cash/api/uploadz/x.png",
];

test("our host with a hostile path is a plain link, never native media (#2021)", () => {
  for (const value of OUR_HOST_HOSTILE_PATH) {
    const result = classify(value);
    assert.ok(result, `expected a first-party link for ${value}`);
    assert.equal("path" in result, false, value);
  }
});

// The scope amendment's allow-list: route shapes that LOOK like a zPage or a
// converse thread but are not one must be a plain link ("page"), never a
// content embed.
const NOT_CONTENT_SHAPES = [
  "https://free2z.cash/converse/../logout",
  "https://free2z.cash/converse/%2e%2e/logout",
  "https://free2z.cash/converse/not-a-uuid",
  "https://free2z.cash/converse/0f8fad5b-d9cb-469f-a165-70867728950e/extra",
  "https://free2z.cash/converse/0f8fad5b%2Fd9cb-469f-a165-70867728950e",
  "https://free2z.cash/converse",
  "https://free2z.cash/alice/my-article/edit",
  "https://free2z.cash/alice%2Fmy-article",
  "https://free2z.cash/alice/my%2Farticle",
  "https://free2z.cash/alice/%2e%2e",
  "https://free2z.cash/alice/.hidden",
  "https://free2z.cash/alice/my%00article",
  "https://free2z.cash/alice/dashboard",
  "https://free2z.cash/alice/broadcast",
  "https://free2z.cash/alice/ppv",
  "https://free2z.cash/alice/subscribers-only",
  "https://free2z.cash/alice/private",
  "https://free2z.cash/alice/private/s3cr3t-share-token",
  "https://free2z.cash/alice/zpage/legacy-slug",
  "https://free2z.cash/og/zpage",
  "https://free2z.cash/og/zpage/alice",
  "https://free2z.cash/edit/123",
  "https://free2z.cash/tag/zcash",
  "https://free2z.cash/api/zpage",
  "https://free2z.cash/uploadz/private",
  "https://free2z.cash/adminzzz/login",
  "https://free2z.cash/live/alice",
  "https://free2z.cash/storytime/alice",
  "https://free2z.cash/profile/kyc",
  "https://free2z.cash/logout",
  "https://free2z.cash/alice",
  "https://free2z.cash/",
  "https://free2z.cash/article/..%2Flogout",
  "https://free2z.cash/article/a/b",
];

test("lookalike zPage / converse shapes are plain links (#2021 amendment)", () => {
  for (const value of NOT_CONTENT_SHAPES) {
    const result = classify(value);
    assert.ok(result, value);
    assert.equal(result.kind, "page", value);
  }
});

test("every static top-level route is excluded from the zPage shape", async () => {
  // A new top-level route (`/foo/<x>`) must not be misread as a zPage by a
  // user called `foo`; this reads the routes directory rather than trusting
  // the list to be maintained by hand.
  const { readdir } = await import("node:fs/promises");
  const routes = new URL("../src/routes/", import.meta.url);
  const names = [];
  for (const entry of await readdir(routes, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("[")) continue;
    if (entry.name.startsWith("(")) {
      for (const inner of await readdir(new URL(`${entry.name}/`, routes), {
        withFileTypes: true,
      })) {
        if (inner.isDirectory() && !inner.name.startsWith("[")) {
          names.push(inner.name);
        }
      }
      continue;
    }
    names.push(entry.name);
  }
  assert.ok(names.length > 10, "read too few routes");
  for (const name of names) {
    // The two allow-listed content roots are their own shapes, tested above.
    if (name === "article" || name === "converse") continue;
    const result = classify(`https://free2z.cash/${name}/some-identifier`);
    assert.notEqual(result?.kind, "zpage", `/${name}/<x> read as a zPage`);
  }
});

test("every accepted upload path is a canonical /uploadz/ path with no traversal", () => {
  for (const [value] of ACCEPTED) {
    const result = classify(value);
    if (!("path" in result)) continue;
    assert.match(result.path, /^\/uploadz\/[^?#]+(?:#t=[\d.,]+)?$/, value);
    assert.doesNotMatch(
      result.path,
      /(?:^|\/)\.\.?(?:\/|$)|%2f|%5c|\\/i,
      value,
    );
  }
});

test("the host set is exact and comes from configuration, not a suffix", () => {
  const custom = new Set(["media.example.org"]);
  assert.deepEqual(
    firstParty.classifyFirstPartyEmbed(
      "https://media.example.org/uploadz/public/a/x.png",
      custom,
    ),
    { kind: "image", path: "/uploadz/public/a/x.png", name: "x.png" },
  );
  for (const value of [
    "https://free2z.cash/uploadz/public/a/x.png",
    "https://cdn.media.example.org/uploadz/public/a/x.png",
    "https://media.example.org.evil.com/uploadz/public/a/x.png",
  ]) {
    assert.equal(
      firstParty.classifyFirstPartyEmbed(value, custom),
      null,
      value,
    );
  }
  assert.equal(firstParty.isFirstPartyHost("free2z.cash"), true);
  assert.equal(firstParty.isFirstPartyHost("sub.free2z.cash"), false);
  assert.equal(firstParty.isFirstPartyHost("free2z.cash."), false);
});

test("every upload type the backend accepts is classified by its MIME family", async () => {
  // A backend-accepted image that classified as "file" would silently turn an
  // article image into a download link (codex review on this PR).
  const source = await readFile(
    new URL(
      "../../../../py/free2z/dj/apps/uploads/validation.py",
      import.meta.url,
    ),
    "utf8",
  );
  const block = /ALLOWED_TYPE_EXTENSIONS[^=]*=\s*\{([\s\S]*?)\n\}/.exec(source);
  assert.ok(block, "ALLOWED_TYPE_EXTENSIONS not found");
  const entries = [...block[1].matchAll(/'([a-z]+)\/[^']+':\s*\(([^)]*)\)/g)];
  assert.ok(entries.length >= 10, "parsed too few upload types");
  for (const [, family, list] of entries) {
    const expected = family === "application" ? "pdf" : family;
    for (const [, extension] of list.matchAll(/'\.([a-z0-9]+)'/g)) {
      const result = classify(`/uploadz/public/alice/x.${extension}`);
      assert.equal(result?.kind, expected, `.${extension} (${family})`);
    }
  }
});

test("isExternalEmbed: our own content is not external; lookalikes still are", () => {
  for (const [value] of ACCEPTED) {
    if (!value.startsWith("https://")) continue;
    assert.equal(privacy.isExternalEmbed(value), false, value);
  }
  for (const value of [
    `https://free2z.cash.evil.com${UPLOAD}`,
    `https://evil.com@free2z.cash${UPLOAD}`,
    `https://FREE2Z.CASH${UPLOAD}`,
    `http://free2z.cash:8080${UPLOAD}`,
    "https://relay.free2z.cash/alice/my-article",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://example.com/article",
  ]) {
    assert.equal(privacy.isExternalEmbed(value), true, value);
  }
});

// ---------------------------------------------------------------------------
// The renderer: what actually reaches the page.
// ---------------------------------------------------------------------------

test("a first-party ::embed renders natively: no consent placeholder, no iframe (#2021)", () => {
  const html = markdown.processMarkdown(
    [
      "::embed[https://free2z.cash/uploadz/public/alice/talk.mp4]",
      "",
      "::embed[https://free2z.cash/uploadz/public/alice/episode.mp3]",
      "",
      "::embed[https://free2z.cash/uploadz/public/alice/photo.png]",
      "",
      "::embed[https://free2z.cash/uploadz/public/alice/w-9.pdf]",
      "",
      "::embed[/uploadz/public/alice/notes.pdf]",
      "",
      "::iframe[https://free2z.cash/uploadz/public/alice/other.pdf]",
      "",
      "::embed[https://free2z.cash/alice/my-article]",
      "",
    ].join("\n"),
  );

  // Nothing here may be handed to ExternalEmbed (consent + Iframely), and no
  // frame of any first-party route may exist.
  assert.doesNotMatch(html, /data-embed-url/);
  assert.doesNotMatch(html, /external-embed-placeholder/);
  assert.doesNotMatch(html, /<iframe/i);
  assert.doesNotMatch(html, /iframe\.ly/);

  // Video: a server-rendered first-party player on the ROOT-RELATIVE path.
  assert.match(
    html,
    /<video[^>]*class="markdown-video"[\s\S]*?<source src="\/uploadz\/public\/alice\/talk\.mp4"/,
  );
  // Audio: the inert placeholder MarkdownContent mounts as MarkdownAudio.
  assert.match(
    html,
    /class="audio-embed-placeholder" data-audio-url="\/uploadz\/public\/alice\/episode\.mp3"/,
  );
  // Image: the article image sink.
  assert.match(
    html,
    /<img src="\/uploadz\/public\/alice\/photo\.png"[^>]*class="markdown-embed-image"/,
  );
  // PDF: a link card to our own upload, never a frame.
  for (const name of ["w-9.pdf", "notes.pdf", "other.pdf"]) {
    assert.match(
      html,
      new RegExp(
        `<div class="first-party-embed first-party-embed-pdf"><a class="first-party-embed-card" href="/uploadz/public/alice/${name.replace(".", "\\.")}" rel="external">`,
      ),
      name,
    );
  }
  assert.match(html, /first-party-embed-kind[^>]*>PDF</);
  // A first-party zPage: a plain internal link until its content card lands.
  assert.match(
    html,
    /<div class="first-party-embed first-party-embed-zpage"><a class="first-party-embed-card" href="https:\/\/free2z\.cash\/alice\/my-article">/,
  );
});

test("third-party and hostile ::embed values keep the existing gated path (#2021)", () => {
  const html = markdown.processMarkdown(
    [
      "::embed[https://www.youtube.com/watch?v=dQw4w9WgXcQ]",
      "",
      `::embed[https://free2z.cash.evil.com${UPLOAD}]`,
      "",
      `::embed[https://evil.com@free2z.cash${UPLOAD}]`,
      "",
      "::embed[https://FREE2Z.CASH/uploadz/public/alice/talk.mp4]",
      "",
    ].join("\n"),
  );

  assert.match(
    html,
    /data-embed-url="https:\/\/www\.youtube\.com\/watch\?v=dQw4w9WgXcQ"/,
  );
  assert.match(
    html,
    /data-embed-url="https:\/\/free2z\.cash\.evil\.com\/uploadz\/public\/alice\/w-9\.pdf"/,
  );
  assert.match(
    html,
    /data-embed-url="https:\/\/evil\.com@free2z\.cash\/uploadz\/public\/alice\/w-9\.pdf"/,
  );
  // A non-canonical spelling of our own video is third-party media: it waits
  // for consent in an inert placeholder rather than rendering natively.
  assert.match(
    html,
    /class="video-embed-placeholder" data-video-url="https:\/\/free2z\.cash\/uploadz\/public\/alice\/talk\.mp4"/,
  );
  assert.doesNotMatch(html, /first-party-embed/);
});

test("a video excerpt keeps its time range through the renderer", () => {
  const html = markdown.processMarkdown(
    "::embed[https://free2z.cash/uploadz/public/alice/talk.mp4#t=120,150]",
  );
  assert.match(
    html,
    /<source src="\/uploadz\/public\/alice\/talk\.mp4#t=120,150" type="video\/mp4">/,
  );
});

test("a root-relative embed that is not an allow-listed upload renders as text", () => {
  for (const value of [
    "/uploadz/../logout",
    "/uploadz/%2e%2e/logout",
    "/uploadz/a%2F..%2F..%2Flogout.png",
    "/uploadz/private/7d1e/passport.png",
  ]) {
    const html = markdown.processMarkdown(`::embed[${value}]`);
    assert.doesNotMatch(html, /<img|<video|<audio|<a |data-[a-z]+-url/, value);
    assert.match(html, /::embed\[/, value);
  }
});

test("a hostile first-party path never reaches a media sink (#2021)", () => {
  for (const value of OUR_HOST_HOSTILE_PATH) {
    const html = markdown.processMarkdown(`::embed[${value}]`);
    assert.doesNotMatch(html, /<img|<video|<audio|<iframe/i, value);
    assert.doesNotMatch(html, /data-(?:audio|video|embed)-url/, value);
  }
});

test("a first-party file card's name is text, never markup", () => {
  const html = markdown.processMarkdown(
    "::embed[https://free2z.cash/uploadz/public/alice/%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E.pdf]",
  );
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;\.pdf/);
});

test("bidi controls cannot spoof a file card's name (security review)", () => {
  for (const control of [
    "%E2%80%AE", // RLO
    "%E2%80%AD", // LRO
    "%E2%80%AA", // LRE
    "%E2%80%AB", // RLE
    "%E2%80%AC", // PDF
    "%E2%81%A6", // LRI
    "%E2%81%A7", // RLI
    "%E2%81%A8", // FSI
    "%E2%81%A9", // PDI
    "%E2%80%8E", // LRM
    "%E2%80%8F", // RLM
    "%D8%9C", // ALM
  ]) {
    const value = `https://free2z.cash/uploadz/public/alice/${control}gnp.exe`;
    const result = classify(value);
    assert.equal(result.kind, "file", control);
    assert.equal(result.name, "gnp.exe", control);
    assert.doesNotMatch(
      result.name,
      /[\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]/,
      control,
    );
    const html = markdown.processMarkdown(`::embed[${value}]`);
    assert.match(html, />EXE<\/span><span[^>]*>gnp\.exe<\/span>/, control);
    assert.doesNotMatch(
      html,
      /[\u200e\u200f\u061c\u202a-\u202e\u2066-\u2069]/,
      control,
    );
  }
});

test("QuickTime video gets a QuickTime MIME type (security review nit)", () => {
  for (const [name, mime] of [
    ["clip.qt", "video/quicktime"],
    ["clip.mov", "video/quicktime"],
    ["clip.m4v", "video/mp4"],
    ["clip.webm", "video/webm"],
  ]) {
    const html = markdown.processMarkdown(
      `::embed[/uploadz/public/alice/${name}]`,
    );
    assert.match(
      html,
      new RegExp(
        `<source src="/uploadz/public/alice/${name.replace(".", "\\.")}" type="${mime}">`,
      ),
      name,
    );
  }
});

test("http: first-party embeds render natively, like https: (security review)", () => {
  const html = markdown.processMarkdown(
    "::embed[http://free2z.cash/uploadz/public/alice/talk.mp4]",
  );
  assert.match(html, /<source src="\/uploadz\/public\/alice\/talk\.mp4"/);
  assert.doesNotMatch(html, /data-(?:embed|video)-url/);
});

test("legacy alias hosts are normalized for uploads (images and embeds) but never for routes", () => {
  // A normalization onto our own origin, never a trust decision: an image
  // that worked through the old `(^|\.)free2z\.(cash|com|net)$` rewrite
  // must keep working (www.free2z.cash has no DNS).
  for (const src of [
    "https://www.free2z.cash/uploadz/public/u/p.png",
    "http://free2z.com/uploadz/public/u/p.png",
    "https://free2z.net/uploadz/public/u/p.png",
    "https://media.free2z.cash/uploadz/public/u/p.png",
  ]) {
    const html = markdown.processMarkdown(`![x](${src})`);
    assert.match(html, /<img src="\/uploadz\/public\/u\/p\.png"/, src);
  }
  for (const src of [
    "https://free2z.cash.evil.com/uploadz/public/u/p.png",
    "https://evilfree2z.cash/uploadz/public/u/p.png",
    "https://evil.com/uploadz/public/u/p.png",
  ]) {
    const html = markdown.processMarkdown(`![x](${src})`);
    assert.doesNotMatch(html, /<img src="\/uploadz\//, src);
  }
  assert.equal(firstParty.isFirstPartyUploadDomain("www.free2z.cash"), true);
  assert.equal(
    firstParty.isFirstPartyUploadDomain("free2z.cash.evil.com"),
    false,
  );
  // The embed classifier applies the same normalization to UPLOADS only; a
  // route on an alias host is not first party.
  assert.deepEqual(classify("https://www.free2z.cash/uploadz/public/u/p.png"), {
    kind: "image",
    path: "/uploadz/public/u/p.png",
    name: "p.png",
  });
  assert.equal(classify("https://www.free2z.cash/alice/my-article"), null);
});

test("a legacy-alias video/audio embed plays from our own origin (codex review)", () => {
  const html = markdown.processMarkdown(
    [
      "::embed[https://www.free2z.cash/uploadz/public/u/p.mp4]",
      "",
      "::embed[https://www.free2z.cash/uploadz/public/u/p.mp3]",
    ].join("\n"),
  );
  assert.match(html, /<source src="\/uploadz\/public\/u\/p\.mp4"/);
  assert.match(html, /data-audio-url="\/uploadz\/public\/u\/p\.mp3"/);
  assert.doesNotMatch(html, /www\.free2z\.cash/);
});
