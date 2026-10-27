import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { derived, writable } from "svelte/store";

import { getRequestLocale } from "../src/lib/request-locale.js";
import { requestScopedStore } from "../src/lib/request-scoped-store.js";
import { withRequestLocale } from "../src/lib/server/request-locale.js";

const UI_ROOT = path.dirname(fileURLToPath(import.meta.url));
const source = (relativePath) =>
  fs.readFileSync(path.join(UI_ROOT, "..", relativePath), "utf8");

// --- issue  ------------------------------------------------------------
//
// `$lib/i18n` keeps the active locale in a module-scoped Svelte store. On the
// server that module is instantiated once per Node process and shared by every
// concurrent request, so the locale request A wrote is readable by request B.
//
// Honest scope note: this is NOT reproducible over HTTP against the app as it
// stands. Svelte's SSR `render()` is synchronous, so `setLocale(data.locale)`
// in `+layout.svelte` and every `$t` read inside that render happen in one
// uninterrupted turn of the event loop; 3000 mixed-locale concurrent requests
// across `/`, `/trending`, `/creators` and `/article/[id]` produced zero
// cross-contamination. The bug is latent: it arms itself the moment anything
// awaits between the write and the read. `tests/browser/locale-concurrency.spec.ts`
// guards the end-to-end behaviour; the tests below pin the mechanism, which is
// the part that can be exercised under genuine concurrency.

test("a module-global locale is contaminated by a concurrent request", () => {
  // Stand-in for the shipped shape: one variable, written per request, read
  // back after an await. This is what `$lib/i18n`'s module-scoped store did on
  // the server before the request scope existed.
  let moduleGlobalLocale = "en";

  const render = async (requested) => {
    moduleGlobalLocale = requested; // +layout.svelte: setLocale(data.locale)
    await Promise.resolve(); // any await on the render path
    return moduleGlobalLocale; // a component reading $locale / $t
  };

  return Promise.all([render("es"), render("fr")]).then((rendered) => {
    // The Spanish reader is served French. Not a hypothetical ordering — the
    // second request's write lands while the first is suspended.
    assert.deepEqual(rendered, ["fr", "fr"]);
  });
});

test("withRequestLocale isolates concurrent requests across awaits", async () => {
  const render = (requested) =>
    withRequestLocale(requested, async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 5));
      return getRequestLocale();
    });

  assert.deepEqual(await Promise.all([render("es"), render("fr")]), [
    "es",
    "fr",
  ]);
});

test("many interleaved requests each keep their own locale", async () => {
  const locales = ["en", "es", "fr", "pt-BR"];
  const requests = Array.from({ length: 200 }, (_, index) => {
    const requested = locales[index % locales.length];
    return withRequestLocale(requested, async () => {
      // Staggered suspension points so the requests genuinely interleave
      // rather than running to completion one at a time.
      await new Promise((resolve) => setTimeout(resolve, index % 7));
      const seenMidRender = getRequestLocale();
      await Promise.resolve();
      return [seenMidRender, getRequestLocale(), requested];
    });
  });

  for (const [mid, end, requested] of await Promise.all(requests)) {
    assert.equal(mid, requested);
    assert.equal(end, requested);
  }
});

test("code running outside a request scope has no request locale", () => {
  assert.equal(getRequestLocale(), null);
});

// --- the `derived` trap ----------------------------------------------------
//
// Raised by the codex adversarial review of this change, and it was a real hole
// in the first draft. A request-scoped *base* store is not enough: every `$t`
// in the app reads a store built on top of it, and `derived` caches its value
// for as long as any subscriber is alive. The two tests below are the same
// overlapping-request scenario against the broken shape and the shipped one.

/**
 * Subscribe once, keep the subscription open for `holdMs`, and report the first
 * value seen — i.e. what one SSR render would put in its HTML.
 */
async function renderWith(store, holdMs) {
  let seen;
  const stop = store.subscribe((value) => {
    seen ??= value;
  });
  if (holdMs) await new Promise((resolve) => setTimeout(resolve, holdMs));
  stop();
  return seen;
}

test("deriving from a request-scoped store still leaks the first request", async () => {
  const fallback = writable("en");
  const scopedLocale = requestScopedStore(fallback, () => getRequestLocale());
  // The shape the first draft of this fix shipped.
  const naiveTranslator = derived(scopedLocale, ($locale) => `copy:${$locale}`);

  const [spanish, french] = await Promise.all([
    // A subscribes first and stays subscribed while B renders.
    withRequestLocale("es", () => renderWith(naiveTranslator, 25)),
    withRequestLocale("fr", async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return renderWith(naiveTranslator, 0);
    }),
  ]);

  assert.equal(spanish, "copy:es");
  // The French reader is served Spanish: the derived never re-read the source.
  assert.equal(french, "copy:es");
});

test("a request-scoped translator store gives each request its own copy", async () => {
  const fallback = writable("en");
  // The shape `tStore` ships: wrap, never derive.
  const translator = requestScopedStore(
    derived(fallback, ($locale) => `copy:${$locale}`),
    () => {
      const requestLocale = getRequestLocale();
      return requestLocale ? `copy:${requestLocale}` : null;
    },
  );

  const [spanish, french, none] = await Promise.all([
    withRequestLocale("es", () => renderWith(translator, 25)),
    withRequestLocale("fr", async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return renderWith(translator, 0);
    }),
    // No request scope at all still falls through to the module-global store,
    // which is what the browser and prerendering rely on.
    renderWith(translator, 0),
  ]);

  assert.equal(spanish, "copy:es");
  assert.equal(french, "copy:fr");
  assert.equal(none, "copy:en");
});

test("the server hook binds the request locale around resolve()", () => {
  const hooks = source("src/hooks.server.ts");
  assert.match(
    hooks,
    /withRequestLocale\(\s*selected,\s*\(\)\s*=>\s*\n?\s*resolve\(event/,
  );
});

test("i18n reads the request locale before the module-global store", () => {
  const i18n = source("src/lib/i18n.ts");

  // The exported stores must consult the request scope, otherwise every `$t`
  // and `$locale` in a component goes straight back to the shared global.
  assert.match(
    i18n,
    /export const locale: Writable<SupportedLocale> = \{\s*\.\.\.requestScopedStore/,
  );
  assert.match(
    i18n,
    /export const tStore: Readable<TranslationFunction> = requestScopedStore\(/,
  );
  assert.match(
    i18n,
    /export function getCurrentLocale\(\)[\s\S]*?activeRequestLocale\(\) \?\? get\(localeStore\)/,
  );

  // Nothing may read the module-global directly as if it were the truth, and
  // nothing may derive from the request-scoped store — a derived caches its
  // value across concurrent subscribers. See the `derived` trap tests above.
  assert.doesNotMatch(i18n, /translate\(get\(locale\)/);
  assert.doesNotMatch(i18n, /derived\(locale,/);
});

test("the browser keeps the module-global store untouched", () => {
  const i18n = source("src/lib/i18n.ts");
  // `activeRequestLocale()` must be inert in the browser: there is exactly one
  // user there and the writable store is the correct owner of the locale.
  assert.match(
    i18n,
    /function activeRequestLocale\(\)[\s\S]*?if \(browser\) return null;/,
  );
  // `setLocale` must still write the global in the browser, or the language
  // switcher stops updating the live page.
  assert.match(
    i18n,
    /if \(browser \|\| !activeRequestLocale\(\)\) \{\s*localeStore\.set/,
  );
});

test("the request-locale registry stays free of node-only imports", () => {
  // `$lib/i18n` is bundled for the browser and imports this module; a `node:`
  // import here would break the client build.
  const registry = source("src/lib/request-locale.js");
  assert.doesNotMatch(registry, /from "node:/);
});
