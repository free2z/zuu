import assert from "node:assert/strict";
import test from "node:test";

import {
  afterDeferredLinkNavigation,
  clientRoutedLinkUrl,
  canReleaseFullPageNavigationFallback,
} from "../src/lib/client-link-navigation.ts";

//the zPage enters its loading state inside the link click, on a
// prediction that SvelteKit is about to client-route it. Every link SvelteKit
// leaves to the browser must predict nothing — otherwise a page that is about
// to open a tab or a download would cover itself with a skeleton.

const PAGE = "https://free2z.test/alice/first";

function element(
  nodeName,
  attributes = {},
  { parent = null, href, target } = {},
) {
  const node = {
    nodeType: 1,
    nodeName,
    parentNode: parent,
    href: href ?? attributes.href ?? "",
    target: target ?? attributes.target ?? "",
    hasAttribute: (name) => Object.hasOwn(attributes, name),
    getAttribute: (name) =>
      Object.hasOwn(attributes, name) ? attributes[name] : null,
    closest(selector) {
      const name = /^\[(.+)\]$/.exec(selector)?.[1];
      assert.ok(name, `unsupported selector ${selector}`);
      for (let at = node; at; at = at.parentNode) {
        if (at.nodeType === 1 && at.hasAttribute(name)) return at;
      }
      return null;
    },
  };
  return node;
}

function click(target, init = {}) {
  return {
    defaultPrevented: true,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    composedPath: () => [target],
    ...init,
  };
}

const zPageLink = (attributes = {}, options = {}) =>
  element("A", { href: "/alice/second", ...attributes }, options);

test("a claimed same-origin link predicts its URL, from a nested target too", () => {
  const link = zPageLink();
  const span = element("SPAN", {}, { parent: link });
  assert.equal(
    clientRoutedLinkUrl(click(link), PAGE)?.href,
    "https://free2z.test/alice/second",
  );
  assert.equal(
    clientRoutedLinkUrl(click(span), PAGE)?.href,
    "https://free2z.test/alice/second",
  );
});

test("a click SvelteKit did not claim predicts nothing", () => {
  assert.equal(
    clientRoutedLinkUrl(click(zPageLink(), { defaultPrevented: false }), PAGE),
    null,
  );
});

test("a modified or non-primary click predicts nothing", () => {
  for (const init of [
    { button: 1 },
    { metaKey: true },
    { ctrlKey: true },
    { shiftKey: true },
    { altKey: true },
  ]) {
    assert.equal(
      clientRoutedLinkUrl(click(zPageLink(), init), PAGE),
      null,
      JSON.stringify(init),
    );
  }
});

test("links the browser handles predict nothing", () => {
  const cases = {
    "new tab": zPageLink({ target: "_blank" }),
    "named frame": zPageLink({ target: "reader" }),
    "parent frame": zPageLink({ target: "_parent" }),
    "top frame": zPageLink({ target: "_top" }),
    // SvelteKit's get_link_info: `external =... || !!target`.
    "target=_self": zPageLink({ target: "_self" }),
    download: zPageLink({ download: "" }),
    "rel=external": zPageLink({ rel: "noopener external" }),
    reload: zPageLink({ "data-sveltekit-reload": "" }),
    "reload=true": zPageLink({ "data-sveltekit-reload": "true" }),
    "reload from an ancestor": zPageLink(
      {},
      { parent: element("DIV", { "data-sveltekit-reload": "true" }) },
    ),
    "other origin": zPageLink({ href: "https://elsewhere.test/alice/second" }),
    "no anchor": element("SPAN"),
    "anchor without href": element("A"),
  };
  for (const [name, target] of Object.entries(cases)) {
    assert.equal(clientRoutedLinkUrl(click(target), PAGE), null, name);
  }
});

test("data-sveltekit-reload=off|false keeps the link client-routed", () => {
  for (const value of ["off", "false"]) {
    const nested = zPageLink(
      {},
      { parent: element("DIV", { "data-sveltekit-reload": value }) },
    );
    assert.ok(clientRoutedLinkUrl(click(nested), PAGE), `ancestor ${value}`);
    const own = zPageLink({ "data-sveltekit-reload": value });
    assert.ok(clientRoutedLinkUrl(click(own), PAGE), value);
  }
  // The nearest value wins, as in SvelteKit.
  const overridden = zPageLink(
    { "data-sveltekit-reload": "false" },
    { parent: element("DIV", { "data-sveltekit-reload": "" }) },
  );
  assert.ok(clientRoutedLinkUrl(click(overridden), PAGE));
});

test("an SVG link is read through baseVal", () => {
  const link = zPageLink(
    {},
    { href: { baseVal: "/alice/third" }, target: { baseVal: "" } },
  );
  assert.equal(
    clientRoutedLinkUrl(click(link), PAGE)?.href,
    "https://free2z.test/alice/third",
  );
});

function fakeScheduler() {
  const frames = [];
  const timers = [];
  let now = 0;
  let seq = 0;
  return {
    requestAnimationFrame: (callback) => frames.push(callback),
    setTimeout: (callback, ms) => {
      timers.push({ at: now + ms, callback, seq: seq++ });
    },
    frame() {
      frames.splice(0).forEach((callback) => callback());
    },
    // Run the earliest due timer, as a browser task would.
    async runNextTimer() {
      timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = timers.shift();
      assert.ok(next, "a timer is queued");
      now = next.at;
      next.callback();
      await new Promise((resolve) => setImmediate(resolve));
    },
    async runTimersUntil(time) {
      for (;;) {
        timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
        const next = timers[0];
        if (!next || next.at > time) break;
        timers.shift();
        now = next.at;
        next.callback();
        await new Promise((resolve) => setImmediate(resolve));
      }
      now = time;
    },
  };
}

test("the prediction outlives SvelteKit's rAF + setTimeout(0), by one more task", async () => {
  const schedule = fakeScheduler();
  let settled = false;
  afterDeferredLinkNavigation(schedule).then(() => {
    settled = true;
  });
  await schedule.runTimersUntil(0);
  assert.equal(settled, false, "not before the frame");
  schedule.frame();
  // The rAF callback queued setTimeout(0) — the same task SvelteKit waits for
  // before it calls navigate(). Not settled at the end of that task: the
  // microtasks of navigate() (route, beforeNavigate, $navigating) come first.
  await schedule.runNextTimer();
  assert.equal(settled, false, "not in SvelteKit's own task");
  await schedule.runNextTimer();
  assert.equal(settled, true, "in the task after it");
});

test("without a frame, the prediction ends after SvelteKit's 100ms fallback", async () => {
  const schedule = fakeScheduler();
  let settled = false;
  afterDeferredLinkNavigation(schedule).then(() => {
    settled = true;
  });
  await schedule.runTimersUntil(99);
  assert.equal(settled, false);
  await schedule.runTimersUntil(100);
  assert.equal(settled, true);
  // A late frame does not settle it twice (or throw).
  schedule.frame();
  await schedule.runTimersUntil(200);
});

test("a retained document can release only the same pending full-page navigation", () => {
  const navigation = {};
  assert.equal(
    canReleaseFullPageNavigationFallback(
      navigation,
      navigation,
      PAGE,
      PAGE,
      false,
    ),
    true,
  );
  assert.equal(
    canReleaseFullPageNavigationFallback(navigation, {}, PAGE, PAGE, false),
    false,
    "a newer navigation owns the store",
  );
  assert.equal(
    canReleaseFullPageNavigationFallback(
      navigation,
      navigation,
      PAGE,
      `${PAGE}/next`,
      false,
    ),
    false,
    "the document navigated to a different URL",
  );
  assert.equal(
    canReleaseFullPageNavigationFallback(
      navigation,
      navigation,
      PAGE,
      PAGE,
      true,
    ),
    false,
    "a real unload is in progress",
  );
});
