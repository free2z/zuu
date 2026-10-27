import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";

let server;
let markdown;
let outbound;
let outboundStore;

before(async () => {
  server = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  markdown = await server.ssrLoadModule("/src/lib/utils/markdown.ts");
  outbound = await server.ssrLoadModule("/src/lib/utils/outbound-link.ts");
  outboundStore = await server.ssrLoadModule(
    "/src/lib/stores/outbound-links.ts",
  );
});

after(async () => {
  await server?.close();
});

function memoryStorage(entries = {}) {
  const values = new Map(Object.entries(entries));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

function getAuthorLinks(html) {
  return html.match(/<a\b[^>]*data-markdown-author-link="true"[^>]*>/g) || [];
}

test("SSR marks every user-authored author link; only OFF-SITE ones open a new tab", () => {
  const html = markdown.processMarkdown(
    "# Heading\n\n[same](/article) [jump](#heading) [query](?page=2) " +
      "[external](https://Example.test/path)[^1].\n\n[^1]: Footnote",
  );

  // Every user-authored HTTP(S) destination carries the marker and class, so
  // the hydrated handler classifies all of them ( required behaviour 1's
  // durable half: the SSR anchor decides, before hydration and without
  // JavaScript). Only anchors the renderer generates itself stay unmarked.
  //
  // `target="_blank"` is OFF-SITE ONLY. The same-origin half of
  // requirement 1 made an in-page table of contents open a second tab of the
  // page you were already reading and pushed internal cross-links out of the
  // SvelteKit router. See the comment on `renderer.link` for why departing
  // from the requirement text is the right reading of it: the safety boundary
  // is the off-site warning, and requirement 6 already puts same-origin links
  // on the non-warned side of it.
  const authorLinks = getAuthorLinks(html);
  assert.equal(authorLinks.length, 4);
  for (const link of authorLinks) {
    assert.match(link, /data-markdown-author-link="true"/);
    assert.match(link, /class="markdown-author-link"/);
  }

  const external = authorLinks.find((link) =>
    /href="https:\/\/Example\.test\/path"/.test(link),
  );
  assert.match(external, /target="_blank"/);
  assert.match(external, /rel="noopener noreferrer"/);

  for (const pattern of [
    /href="\/article"/,
    /href="#heading"/,
    /href="\?page=2"/,
  ]) {
    const internal = authorLinks.find((link) => pattern.test(link));
    assert.ok(internal, `no author link matched ${pattern}`);
    assert.doesNotMatch(internal, /\btarget=/);
    assert.doesNotMatch(internal, /\brel=/);
  }

  // Non-HTTP schemes fail outbound parsing and render as plain anchors the
  // browser handles natively.
  const mailtoHtml = markdown.processMarkdown("[mail](mailto:a@b.test)");
  assert.doesNotMatch(mailtoHtml, /data-markdown-author-link/);
  assert.match(mailtoHtml, /<a href="mailto:a@b\.test">/);

  const generatedLinks = html.match(/<a\b[^>]*>/g) || [];
  for (const link of generatedLinks.filter((value) =>
    /data-footnote-(?:ref|backref)/.test(value),
  )) {
    assert.doesNotMatch(link, /\btarget=/);
    assert.doesNotMatch(link, /\brel=/);
    assert.doesNotMatch(link, /markdown-author-link/);
  }
});

test("an external URL containing footnote-marker text is still treated as external", () => {
  // Regression: the removed string-pass normalizer matched
  // `data-footnote-ref` ANYWHERE inside the <a> tag, including inside the
  // author-controlled href, so this destination stripped its own marker,
  // target, rel and class — disarming the outbound warning.
  const html = markdown.processMarkdown(
    "[click here](https://e.example/pwn#data-footnote-ref)",
  );

  const authorLinks = getAuthorLinks(html);
  assert.equal(authorLinks.length, 1);
  assert.match(authorLinks[0], /data-markdown-author-link="true"/);
  assert.match(authorLinks[0], /target="_blank"/);
  assert.match(authorLinks[0], /rel="noopener noreferrer"/);
});

test("a same-origin absolute URL is internal, and a lookalike host is not", () => {
  // The classification comes from the parsed origin, so it cannot be spoofed
  // by a host that merely CONTAINS the canonical one.
  const internal = markdown.processMarkdown(
    "[canonical](https://free2z.cash/alice/other-article)",
  );
  const internalLinks = getAuthorLinks(internal);
  assert.equal(internalLinks.length, 1);
  assert.doesNotMatch(internalLinks[0], /\btarget=/);

  for (const lookalike of [
    "https://free2z.cash.evil.example/x",
    "https://notfree2z.cash/x",
    "https://free2z.cash@evil.example/x",
  ]) {
    const html = markdown.processMarkdown(`[l](${lookalike})`);
    const links = getAuthorLinks(html);
    assert.equal(links.length, 1, lookalike);
    assert.match(links[0], /target="_blank"/, lookalike);
    assert.match(links[0], /rel="noopener noreferrer"/, lookalike);
  }
});

test("external links keep the blank-tab treatment and marker attributes", () => {
  const html = markdown.processMarkdown("[x](https://external.example/page)");

  const authorLinks = getAuthorLinks(html);
  assert.equal(authorLinks.length, 1);
  assert.match(authorLinks[0], /href="https:\/\/external\.example\/page"/);
  assert.match(authorLinks[0], /data-markdown-author-link="true"/);
  assert.match(authorLinks[0], /target="_blank"/);
  assert.match(authorLinks[0], /rel="noopener noreferrer"/);
});

test("HTTP destinations and hostname keys use normalized parsed values", () => {
  assert.equal(
    outbound.normalizeOutboundHostname("EXAMPLE.test."),
    "example.test",
  );
  assert.equal(
    outbound.normalizeOutboundHostname("münich.example"),
    "xn--mnich-kva.example",
  );
  assert.equal(outbound.normalizeOutboundHostname("example.test:8443"), null);
  assert.equal(outbound.normalizeOutboundHostname("user@example.test"), null);
  assert.equal(outbound.normalizeOutboundHostname("example.test/path"), null);

  const external = outbound.parseOutboundHttpUrl(
    "HTTPS://User:pass@Example.test.:8443/path?q=1",
    "https://free2z.cash/article",
  );
  assert.equal(external.hostname, "example.test");
  assert.equal(external.protocol, "https:");
  assert.equal(external.isExternal, true);
  assert.match(external.href, /^https:\/\/User:pass@example\.test\.:8443/);

  const sameOrigin = outbound.parseOutboundHttpUrl(
    "https://FREE2Z.CASH.:443/other",
    "https://free2z.cash/article",
  );
  assert.equal(sameOrigin.isExternal, false);
  assert.equal(
    outbound.parseOutboundHttpUrl(
      "javascript:alert(1)",
      "https://free2z.cash/",
    ),
    null,
  );
  assert.equal(
    outbound.parseOutboundHttpUrl(
      "data:text/html,evil",
      "https://free2z.cash/",
    ),
    null,
  );
  assert.equal(
    outbound.parseOutboundHttpUrl("https://external.example/", "not a URL"),
    null,
  );
  assert.equal(
    outbound.isDisallowedAuthorLink(
      "vbscript:msgbox(1)",
      "https://free2z.cash/",
    ),
    true,
  );
  assert.equal(
    outbound.isDisallowedAuthorLink(
      "blob:https://external.example/id",
      "https://free2z.cash/",
    ),
    true,
  );
  assert.equal(
    outbound.isDisallowedAuthorLink(
      "mailto:author@example.test",
      "https://free2z.cash/",
    ),
    false,
  );
});

test("malformed storage fails closed and trust is exact-host only", () => {
  const malformed = memoryStorage({
    trustedExternalDomains: '["trusted.example", "trusted.example:8443"]',
    dontShowExternalLinkWarning: "true",
  });
  const malformedStore = outboundStore.createOutboundLinkStore(
    undefined,
    malformed,
  );
  assert.deepEqual(malformedStore.getTrustedDomains(), []);
  assert.equal(malformedStore.hasGlobalWarningDisabled(), true);

  const storage = memoryStorage();
  const first = outboundStore.createOutboundLinkStore(undefined, storage);
  first.trustDomain("TRUSTED.Example.");
  assert.deepEqual(first.getTrustedDomains(), ["trusted.example"]);

  const reloaded = outboundStore.createOutboundLinkStore(undefined, storage);
  assert.equal(reloaded.isDomainTrusted("trusted.example"), true);
  assert.equal(reloaded.isDomainTrusted("trusted.example.evil"), false);
  assert.equal(reloaded.isDomainTrusted("user@trusted.example"), false);
  assert.equal(reloaded.isDomainTrusted("trusted.example:8443"), false);

  reloaded.revokeDomain("trusted.example.");
  const afterRevoke = outboundStore.createOutboundLinkStore(undefined, storage);
  assert.deepEqual(afterRevoke.getTrustedDomains(), []);
});

test("global warning preference persists independently of embed consent", () => {
  const storage = memoryStorage();
  const store = outboundStore.createOutboundLinkStore(undefined, storage);
  store.disableWarnings();
  assert.equal(storage.getItem("dontShowExternalLinkWarning"), "true");
  assert.equal(storage.getItem("globalEmbedConsent"), null);
  assert.equal(
    outboundStore
      .createOutboundLinkStore(undefined, storage)
      .hasGlobalWarningDisabled(),
    true,
  );
  store.enableWarnings();
  assert.equal(store.hasGlobalWarningDisabled(), false);
});

test("malformed global preference does not disable warnings", () => {
  const storage = memoryStorage({ dontShowExternalLinkWarning: "yes" });
  const store = outboundStore.createOutboundLinkStore(undefined, storage);
  assert.equal(store.hasGlobalWarningDisabled(), false);
  assert.equal(store.shouldWarn("external.example"), true);
});
