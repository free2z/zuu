// free2z/zuu#1022 Contract B: the /bridge/* fallback pages.
//
// Runs the REAL static scripts, unmodified, inside a vm context whose DOM is
// built from the element ids the REAL generated HTML declares. What it
// protects:
//   * the landing page shows "@peer" only for a fragment that is exactly
//     `#peer=<handle>` with handle in ^[a-z0-9_]{1,30}$, via textContent;
//   * a bad handle is refused and nothing from it reaches the page or the
//     "open it" link;
//   * neither script sends anything anywhere (no fetch/XHR/beacon/socket/
//     image/storage/cookie), so a bridge fragment cannot leave the device;
//   * the pages load no inline script and nothing from another origin, which
//     is what lets nginx serve them with `script-src 'self'`.
//
// Run: node --test k8s/free2z/bridge-pages/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const BASE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p) => readFileSync(path.join(BASE, ...p), "utf8");

const CHAT_JS = read("static", "e2e2z-chat.js");
const SCRUB_JS = read("static", "scrub-fragment.js");
const CHAT_HTML = read("site", "e2e2z-chat.html");
const FALLBACK_PAGES = ["e2e2z.html", "free2z.html", "zuuli.html"];

// Minimal element: records every write that could inject markup.
function fakeElement(id, { hidden = false, href = null } = {}) {
  const el = {
    id,
    hidden,
    textContent: "",
    attributes: href === null ? {} : { href },
    htmlWrites: [],
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    getAttribute(name) {
      return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null;
    },
  };
  for (const prop of ["innerHTML", "outerHTML"]) {
    Object.defineProperty(el, prop, {
      set(v) {
        el.htmlWrites.push([prop, v]);
      },
      get() {
        return "";
      },
    });
  }
  el.insertAdjacentHTML = (...args) => el.htmlWrites.push(["insertAdjacentHTML", args]);
  return el;
}

// Build the fake DOM from what the generated HTML actually says, so a renamed
// id or a dropped `hidden` in the template fails here instead of passing
// against a hand-written stub.
function domFromHtml(source) {
  const elements = {};
  const tag = /<([a-z]+)\b([^>]*)\bid="([^"]+)"([^>]*)>/g;
  for (const m of source.matchAll(tag)) {
    const attrs = m[2] + " " + m[4];
    const href = /\bhref="([^"]*)"/.exec(attrs);
    elements[m[3]] = fakeElement(m[3], {
      hidden: /\shidden(\s|$|=)/.test(" " + attrs + " "),
      href: href ? href[1] : null,
    });
  }
  return elements;
}

// Every channel a script could use to move data off the device. Touching any
// of them records a violation; none of them is a real implementation.
function sandbox({ hash = "", search = "", pathname = "/bridge/e2e2z/chat/" } = {}) {
  const violations = [];
  const trap = (name) =>
    function () {
      violations.push(name);
      throw new Error(`${name} must not be used`);
    };
  const elements = domFromHtml(CHAT_HTML);
  const listeners = {};
  const replaced = [];
  const location = { hash, search, pathname, href: `https://free2z.com${pathname}${search}${hash}` };
  const storage = new Proxy(
    {},
    {
      get(_t, prop) {
        violations.push(`storage.${String(prop)}`);
        return trap(`storage.${String(prop)}`);
      },
    },
  );
  const document = {
    getElementById: (id) => elements[id] || null,
    write: trap("document.write"),
    createElement: trap("document.createElement"),
  };
  Object.defineProperty(document, "cookie", {
    get() {
      violations.push("document.cookie");
      return "";
    },
    set() {
      violations.push("document.cookie=");
    },
  });
  const window = {
    location,
    history: {
      replaceState: (...args) => replaced.push(args),
      pushState: trap("history.pushState"),
    },
    addEventListener: (type, fn) => {
      (listeners[type] ||= []).push(fn);
    },
    navigator: { sendBeacon: trap("navigator.sendBeacon") },
    fetch: trap("fetch"),
    XMLHttpRequest: trap("XMLHttpRequest"),
    WebSocket: trap("WebSocket"),
    EventSource: trap("EventSource"),
    Image: trap("Image"),
    open: trap("window.open"),
    postMessage: trap("postMessage"),
    localStorage: storage,
    sessionStorage: storage,
    indexedDB: storage,
  };
  window.window = window;
  window.self = window;
  window.document = document;
  const context = vm.createContext({ ...window, window, document });
  return { context, elements, listeners, violations, replaced, location };
}

function runChat(hash) {
  const box = sandbox({ hash });
  vm.runInContext(CHAT_JS, box.context, { filename: "e2e2z-chat.js" });
  return box;
}

function assertNoLeak(box) {
  assert.deepEqual(box.violations, [], "a script touched a network/storage API");
  for (const el of Object.values(box.elements)) {
    assert.deepEqual(el.htmlWrites, [], `markup was written into #${el.id}`);
  }
}

test("the generated landing page declares what the script drives", () => {
  const els = domFromHtml(CHAT_HTML);
  for (const id of ["peer-generic", "peer-line", "peer-name", "peer-invalid", "open-app"]) {
    assert.ok(els[id], `#${id} missing from site/e2e2z-chat.html`);
  }
  assert.equal(els["peer-generic"].hidden, false, "no-JS visitors must see the generic line");
  assert.equal(els["peer-line"].hidden, true);
  assert.equal(els["peer-invalid"].hidden, true);
  assert.equal(els["open-app"].getAttribute("href"), "/bridge/e2e2z/chat/");
});

test("a valid #peer= renders @peer and carries it into the open-app link", () => {
  for (const handle of ["alice", "a", "bob_99", "x".repeat(30), "0_0"]) {
    const box = runChat(`#peer=${handle}`);
    const { elements: e } = box;
    assert.equal(e["peer-name"].textContent, `@${handle}`);
    assert.equal(e["peer-line"].hidden, false);
    assert.equal(e["peer-generic"].hidden, true);
    assert.equal(e["peer-invalid"].hidden, true);
    assert.equal(e["open-app"].getAttribute("href"), `/bridge/e2e2z/chat/#peer=${handle}`);
    assertNoLeak(box);
  }
});

test("a bad handle or any other fragment is refused and shown nowhere", () => {
  const bad = [
    "#peer=<img src=x onerror=alert(1)>",
    "#peer=%3Cscript%3E",
    '#peer=a"onmouseover="x',
    "#peer=Alice",
    "#peer=",
    `#peer=${"x".repeat(31)}`,
    "#peer=alice&extra=1",
    "#peer=alice#x",
    "#peer=%61lice",
    "#peer=alice%0A",
    "#peer=alice\n",
    "#peer=al ice",
    "#peer=alice.bob",
    "#peer=ālice",
    "#Peer=alice",
    "#peer%3Dalice",
    "#x=1&peer=alice",
    "#res=AAAA&rid=BBBB",
    "#alice",
    "peer=alice",
  ];
  for (const hash of bad) {
    const box = runChat(hash);
    const { elements: e } = box;
    assert.equal(e["peer-name"].textContent, "", `rendered something for ${JSON.stringify(hash)}`);
    assert.equal(e["peer-line"].hidden, true, hash);
    assert.equal(e["peer-generic"].hidden, false, hash);
    assert.equal(e["peer-invalid"].hidden, false, `no refusal notice for ${JSON.stringify(hash)}`);
    assert.equal(e["open-app"].getAttribute("href"), "/bridge/e2e2z/chat/", hash);
    assertNoLeak(box);
  }
});

test("no fragment shows the generic request without a refusal notice", () => {
  for (const hash of ["", "#"]) {
    const box = runChat(hash);
    const { elements: e } = box;
    assert.equal(e["peer-line"].hidden, true);
    assert.equal(e["peer-generic"].hidden, false);
    assert.equal(e["peer-invalid"].hidden, true);
    assertNoLeak(box);
  }
});

test("editing the fragment re-renders, and a later bad value clears the name", () => {
  const box = runChat("#peer=alice");
  assert.equal(box.elements["peer-name"].textContent, "@alice");
  box.location.hash = "#peer=<b>";
  for (const fn of box.listeners.hashchange || []) fn();
  assert.equal(box.elements["peer-name"].textContent, "");
  assert.equal(box.elements["peer-line"].hidden, true);
  assert.equal(box.elements["open-app"].getAttribute("href"), "/bridge/e2e2z/chat/");
  assertNoLeak(box);
});

test("the generic fallback script drops the fragment and reads nothing else", () => {
  const box = sandbox({ hash: "#res=SECRET&rid=ID", pathname: "/bridge/free2z/v1/response" });
  vm.runInContext(SCRUB_JS, box.context, { filename: "scrub-fragment.js" });
  assert.deepEqual(box.replaced, [[null, "", "/bridge/free2z/v1/response"]]);
  assert.deepEqual(box.violations, []);

  const clean = sandbox({ hash: "", pathname: "/bridge/zuuli/" });
  vm.runInContext(SCRUB_JS, clean.context, { filename: "scrub-fragment.js" });
  assert.deepEqual(clean.replaced, [], "a URL with nothing to drop must not be rewritten");
});

test("pages load only same-origin assets and no inline script", () => {
  const pages = { "e2e2z-chat.html": CHAT_HTML };
  for (const name of FALLBACK_PAGES) pages[name] = read("site", name);
  for (const [name, source] of Object.entries(pages)) {
    const scripts = [...source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    assert.equal(scripts.length, 1, `${name}: exactly one script`);
    assert.equal(scripts[0][2].trim(), "", `${name}: inline script would need 'unsafe-inline'`);
    const want = name === "e2e2z-chat.html" ? "e2e2z-chat.js" : "scrub-fragment.js";
    assert.match(scripts[0][1], new RegExp(`src="/bridge/_static/${want.replace(".", "\\.")}"`), name);
    assert.doesNotMatch(source, /\son[a-z]+\s*=/i, `${name}: inline event handler`);
    assert.doesNotMatch(source, /<(iframe|img|form|object|embed)\b/i, `${name}: unexpected element`);
    // The GCLB OVERWRITES same-named response headers (backend-config.yaml
    // sets a permissive CSP and a weaker Referrer-Policy), so the page itself
    // must carry both policies. A meta CSP is enforced in addition to any
    // header CSP, so this is the one that is certain in production.
    assert.match(source, /<meta name="referrer" content="no-referrer">/, `${name}: referrer meta`);
    assert.match(
      source,
      /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'">/,
      `${name}: CSP meta`,
    );
    // Any in-page `href="#..."` would REPLACE the #peer= fragment and drop
    // the recipient (a skip link did exactly that).
    assert.doesNotMatch(source, /href="#/, `${name}: in-page fragment link`);
    for (const m of source.matchAll(/<link\b[^>]*href="([^"]+)"/g)) {
      assert.ok(m[1].startsWith("/bridge/_static/"), `${name}: stylesheet ${m[1]}`);
    }
    // Every outbound link is free2z or a store host, and never passes a Referer.
    for (const m of source.matchAll(/<a\b([^>]*)>/g)) {
      const href = /href="([^"]*)"/.exec(m[1])[1];
      if (/^https?:/.test(href)) {
        const host = new URL(href).hostname;
        assert.ok(
          ["free2z.cash", "testflight.apple.com", "apps.apple.com", "play.google.com"].includes(host),
          `${name}: link to ${host}`,
        );
        assert.match(m[1], /rel="noreferrer"/, `${name}: ${href} without rel=noreferrer`);
      } else {
        assert.match(href, /^(#|\/bridge\/|mailto:)/, `${name}: unexpected href ${href}`);
      }
    }
  }
});

test("the scripts contain no network, storage or markup-writing call at all", () => {
  // Belt and braces for the runtime traps above: a call on a branch the tests
  // do not reach would not trip a trap, but it is still in the file.
  const forbidden =
    /\b(fetch|XMLHttpRequest|sendBeacon|WebSocket|EventSource|localStorage|sessionStorage|indexedDB|cookie|innerHTML|outerHTML|insertAdjacentHTML|createElement|postMessage|Image|decodeURI(Component)?|unescape|eval|Function)\b|document\.write/;
  for (const [name, source] of [
    ["e2e2z-chat.js", CHAT_JS],
    ["scrub-fragment.js", SCRUB_JS],
  ]) {
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(code, forbidden, name);
  }
});
