// Which embeds are Free2Z's own pages, and which need the reader's consent.
//
// A page on free2z.cash (or the legacy free2z.com) embedded in another zpage
// is not third-party content, so it must render without the "External
// Content" consent prompt. Everything else keeps the prompt — and the match
// is on the parsed hostname, so a lookalike never inherits the exemption.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";

let server;
let isFirstPartyUrl;
let isExternalEmbed;
let privacyStore;

before(async () => {
  server = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  ({ isFirstPartyUrl } = await server.ssrLoadModule(
    "/src/lib/utils/embed-domains.ts",
  ));
  ({ isExternalEmbed, privacyStore } = await server.ssrLoadModule(
    "/src/lib/stores/privacy.ts",
  ));
});

after(async () => {
  await server?.close();
});

const FIRST_PARTY = [
  "https://free2z.cash/someone/zpage/a-post",
  "https://www.free2z.cash/someone/zpage/a-post",
  "https://FREE2Z.CASH/someone",
  "https://free2z.com/someone/zpage/a-post",
  "https://www.free2z.com/someone",
];

const NOT_FIRST_PARTY = [
  // Lookalikes: the trusted name appears, but it is not the hostname.
  "https://free2z.cash.example.com/page",
  "https://evilfree2z.cash/page",
  "https://free2z.cash@evil.example/page",
  "https://evil.example/https://free2z.cash/page",
  "https://evil.example/?next=free2z.cash",
  // Plain http can be substituted in transit.
  "http://free2z.cash/someone",
  "http://free2z.com/someone",
  // Not a web page at all.
  "javascript://free2z.cash/%0aalert(1)",
  "ftp://free2z.cash/file",
  "not a url",
  "",
];

test("Free2Z's own https pages are first-party", () => {
  for (const url of FIRST_PARTY) {
    assert.equal(isFirstPartyUrl(url), true, url);
  }
});

test("lookalikes, plain http and non-web URLs are not first-party", () => {
  for (const url of NOT_FIRST_PARTY) {
    assert.equal(isFirstPartyUrl(url), false, url);
  }
});

test("a first-party embed is not external and loads without consent", () => {
  for (const url of FIRST_PARTY) {
    assert.equal(isExternalEmbed(url), false, url);
    assert.equal(privacyStore.canLoadUrl(url), true, url);
  }
});

test("third-party and lookalike embeds still need consent", () => {
  for (const url of [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://example.com/article",
    "https://free2z.cash.example.com/page",
    "http://free2z.cash/someone",
  ]) {
    assert.equal(isExternalEmbed(url), true, url);
    assert.equal(privacyStore.canLoadUrl(url), false, url);
  }
});
