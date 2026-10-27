import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { createServer } from "vite";

let server;
let RECAPTCHA_FRAME_SELECTOR;
let RECAPTCHA_HOSTS;
let isRecaptchaFrame;
let restoreRecaptchaOverlayPointerEvents;
let watchRecaptchaOverlay;

before(async () => {
  server = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  ({
    RECAPTCHA_FRAME_SELECTOR,
    RECAPTCHA_HOSTS,
    isRecaptchaFrame,
    restoreRecaptchaOverlayPointerEvents,
    watchRecaptchaOverlay,
  } = await server.ssrLoadModule("/src/lib/utils/recaptcha-overlay.ts"));
});

after(async () => {
  await server?.close();
});

// The real URLs Google loads, captured from stage.free2z.cash while the
// sign-in modal was open. `bframe` is the challenge ("select all images…");
// `anchor` is the widget the badge points at.
const BFRAME_SRC =
  "https://www.google.com/recaptcha/api2/bframe?hl=en&v=abc&k=sitekey";
const ANCHOR_SRC =
  "https://www.google.com/recaptcha/api2/anchor?ar=1&k=sitekey&size=invisible";

function el(tagName, props = {}) {
  const node = {
    tagName: tagName.toUpperCase(),
    childNodes: [],
    parentElement: null,
    style: { pointerEvents: "" },
    styleObservers: [],
    ...props,
    append(child) {
      child.parentElement = this;
      this.childNodes.push(child);
      return child;
    },
    contains(other) {
      let cursor = other;
      while (cursor) {
        if (cursor === this) return true;
        cursor = cursor.parentElement;
      }
      return false;
    },
  };
  return node;
}

/**
 * Minimal stand-in for `document`. `querySelectorAll` really parses the
 * `iframe[src*="…"]` selector the module ships, so the test fails if that
 * selector stops matching Google's URLs.
 */
function makeDocument() {
  const body = el("body");
  const listeners = [];
  const doc = {
    body,
    detached: [],
    defaultView: {
      addEventListener: (type, handler, capture) =>
        listeners.push({ type, handler, capture }),
      removeEventListener: (type, handler, capture) => {
        const index = listeners.findIndex(
          (l) =>
            l.type === type && l.handler === handler && l.capture === capture,
        );
        if (index !== -1) listeners.splice(index, 1);
      },
    },
    listeners,
    querySelectorAll(selector) {
      const match = /^iframe\[src\*="(.+)"\]$/.exec(selector);
      assert.ok(match, `unsupported selector in fake DOM: ${selector}`);
      const needle = match[1];
      const found = [];
      const walk = (node) => {
        for (const child of node.childNodes) {
          if (
            child.tagName === "IFRAME" &&
            String(child.src ?? "").includes(needle)
          ) {
            found.push(child);
          }
          walk(child);
        }
      };
      walk(body);
      for (const detached of doc.detached) walk(detached);
      return found;
    },
  };
  return doc;
}

/**
 * The shape Google actually produces: a body-level wrapper, an inner
 * `position: fixed; z-index: 2000000000` bubble, and the challenge iframe.
 * Neither wrapper has a class or id — only an inline style — which is why the
 * overlay is located via the iframe inside it.
 */
function addChallengeOverlay(doc, src = BFRAME_SRC) {
  const overlayRoot = doc.body.append(el("div"));
  const bubble = overlayRoot.append(el("div"));
  const frame = bubble.append(el("iframe", { src }));
  return { overlayRoot, bubble, frame };
}

function fireFocusIn(doc, target) {
  let stopped = false;
  const event = {
    type: "focusin",
    target,
    stopPropagation: () => {
      stopped = true;
    },
  };
  for (const listener of doc.listeners) {
    if (listener.type === "focusin") listener.handler(event);
  }
  return stopped;
}

let doc;
beforeEach(() => {
  doc = makeDocument();
});

test("selector matches both reCAPTCHA frames Google injects", () => {
  assert.equal(RECAPTCHA_FRAME_SELECTOR, 'iframe[src*="/recaptcha/"]');
  for (const src of [BFRAME_SRC, ANCHOR_SRC]) {
    assert.ok(src.includes("/recaptcha/"), src);
    assert.ok(isRecaptchaFrame({ src }), src);
  }
});

test("only Google's own hosts count as a reCAPTCHA frame", () => {
  assert.ok(RECAPTCHA_HOSTS.has("www.google.com"));
  assert.ok(RECAPTCHA_HOSTS.has("www.recaptcha.net"));

  for (const src of [
    // An embed a creator controls whose path merely *looks* like reCAPTCHA
    // must never let this code unlock part of the page.
    "https://evil.example/recaptcha/api2/bframe",
    "https://www.google.com.evil.example/recaptcha/api2/bframe",
    "https://www.google.com/maps/recaptcha/",
    "javascript:alert('/recaptcha/')",
    "not a url /recaptcha/",
    "",
    null,
    undefined,
  ]) {
    assert.equal(isRecaptchaFrame({ src }), false, String(src));
  }
});

test("re-enables pointer events on the challenge bubble (#1088)", () => {
  const { overlayRoot, bubble, frame } = addChallengeOverlay(doc);

  assert.equal(restoreRecaptchaOverlayPointerEvents(doc), 1);

  // <body> is `pointer-events: none` while a modal is open and the property is
  // inherited, so the bubble has to opt back in explicitly. Its descendants
  // (the iframe) inherit `auto` from it; the outer wrapper is a zero-height
  // positioning anchor and is deliberately left alone.
  assert.equal(bubble.style.pointerEvents, "auto");
  assert.equal(overlayRoot.style.pointerEvents, "");
  assert.equal(frame.style.pointerEvents, "");
});

test("is idempotent — a second pass changes nothing", () => {
  addChallengeOverlay(doc);
  assert.equal(restoreRecaptchaOverlayPointerEvents(doc), 1);
  assert.equal(restoreRecaptchaOverlayPointerEvents(doc), 0);
});

test("patches the anchor container as well as the challenge", () => {
  addChallengeOverlay(doc, BFRAME_SRC);
  addChallengeOverlay(doc, ANCHOR_SRC);
  assert.equal(restoreRecaptchaOverlayPointerEvents(doc), 2);
});

test("an iframe that is a direct child of <body> patches itself", () => {
  const frame = doc.body.append(el("iframe", { src: BFRAME_SRC }));
  assert.equal(restoreRecaptchaOverlayPointerEvents(doc), 1);
  assert.equal(frame.style.pointerEvents, "auto");
  // Never <body> itself: that would undo the modal's interaction lock.
  assert.equal(doc.body.style.pointerEvents, "");
});

test("never walks up to the application root", () => {
  // A page-supplied embed whose URL contains the magic substring. Walking to
  // the <body>-level ancestor would set `pointer-events: auto` on the whole
  // SvelteKit app and defeat the modal's background lock.
  const appRoot = doc.body.append(el("div"));
  const article = appRoot.append(el("div"));
  const frame = article.append(
    el("iframe", { src: "https://evil.example/recaptcha/api2/bframe" }),
  );

  assert.equal(restoreRecaptchaOverlayPointerEvents(doc), 0);
  assert.equal(appRoot.style.pointerEvents, "");
  assert.equal(article.style.pointerEvents, "");
  assert.equal(frame.style.pointerEvents, "");
});

test("leaves unrelated iframes alone", () => {
  const wrapper = doc.body.append(el("div"));
  const frame = wrapper.append(
    el("iframe", { src: "https://player.vimeo.com/video/1" }),
  );
  assert.equal(restoreRecaptchaOverlayPointerEvents(doc), 0);
  assert.equal(wrapper.style.pointerEvents, "");
  assert.equal(frame.style.pointerEvents, "");
});

test("ignores a detached frame instead of throwing", () => {
  const orphanRoot = el("div");
  orphanRoot.append(el("div")).append(el("iframe", { src: BFRAME_SRC }));
  doc.detached.push(orphanRoot);

  // Detached nodes still have a parent element, so they are patched harmlessly
  // rather than crashing the sign-in flow.
  assert.doesNotThrow(() => restoreRecaptchaOverlayPointerEvents(doc));
});

test("tolerates a document with no body", () => {
  assert.equal(restoreRecaptchaOverlayPointerEvents({ body: null }), 0);
});

test("watch applies once and tears down when MutationObserver is absent", () => {
  const { bubble } = addChallengeOverlay(doc);
  const stop = watchRecaptchaOverlay(doc);
  assert.equal(bubble.style.pointerEvents, "auto");
  assert.doesNotThrow(stop);
});

test("watch shields the challenge from the modal's focus trap", () => {
  const { frame } = addChallengeOverlay(doc);
  const stop = watchRecaptchaOverlay(doc);

  // bits-ui listens for `focusin` on `document` in the capture phase; a
  // capture listener on `window` runs first, so stopping propagation there
  // keeps the focus scope from yanking focus back out of the challenge and
  // keeps the dismissible layer from reporting a focus-outside.
  const focusListener = doc.listeners.find((l) => l.type === "focusin");
  assert.ok(focusListener, "expected a focusin listener on the window");
  assert.equal(focusListener.capture, true);

  assert.equal(fireFocusIn(doc, frame), true);

  // Focus moving anywhere else must still reach bits-ui untouched.
  const input = doc.body.append(el("input"));
  assert.equal(fireFocusIn(doc, input), false);

  stop();
  assert.equal(
    doc.listeners.filter((l) => l.type === "focusin").length,
    0,
    "teardown must remove the focus listener",
  );
});

test("watch re-applies when Google rewrites the overlay style", () => {
  const observers = [];
  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.disconnected = false;
      observers.push(this);
    }
    observe(target, options) {
      this.target = target;
      this.options = options;
      if (options?.attributes) target.styleObservers.push(this);
    }
    disconnect() {
      this.disconnected = true;
    }
  }

  const previous = globalThis.MutationObserver;
  globalThis.MutationObserver = FakeMutationObserver;
  try {
    const { bubble } = addChallengeOverlay(doc);
    const stop = watchRecaptchaOverlay(doc);
    assert.equal(bubble.style.pointerEvents, "auto");
    assert.equal(bubble.styleObservers.length, 1);

    // Google resets inline styles when it shows/hides the challenge.
    bubble.style.pointerEvents = "";
    bubble.styleObservers[0].callback();
    assert.equal(bubble.style.pointerEvents, "auto");

    const bodyObserver = observers.find((o) => o.options?.childList);
    assert.ok(bodyObserver, "expected a childList observer on <body>");
    // Nested insertions have to be visible: Google may append an empty wrapper
    // and fill it in afterwards.
    assert.equal(bodyObserver.options.subtree, true);

    const late = addChallengeOverlay(doc, ANCHOR_SRC);
    bodyObserver.callback();
    assert.equal(late.bubble.style.pointerEvents, "auto");

    stop();
    assert.ok(observers.every((o) => o.disconnected));
  } finally {
    globalThis.MutationObserver = previous;
  }
});

test("UnifiedAuthModal still installs the overlay fix", async () => {
  const source = await readFile(
    new URL(
      "../src/lib/components/auth/UnifiedAuthModal.svelte",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(source, /\$lib\/utils\/recaptcha-overlay/);
  assert.match(source, /watchRecaptchaOverlay\(document\)/);
  assert.match(source, /restoreRecaptchaOverlayPointerEvents\(document\)/);
  assert.match(source, /stopRecaptchaOverlayWatch\?\.\(\)/);
});
