// The client half of `GET /api/languages/` .
//
// What these are trying to catch:
//
// * An **empty picker**. Every failure shape — a rejected request, a 200 with
//   the wrong body, a 200 with no languages — has to land on the seed, because
//   a picker with nothing in it reads as "we removed your language".
// * A **cached failure**, which outlives the outage that caused it and leaves a
//   tab stuck on the seed until it is reloaded.
// * The `ja` regression from: a language the article already has must
//   stay listed even when the catalog does not sell it.
// * An RTL script table that has drifted from the server's.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CATALOG_TTL_MS,
  RTL_SCRIPTS,
  catalogTranslatableTags,
  describeLanguage,
  fetchLanguageCatalog,
  languageDirection,
  languageEntryMatchesQuery,
  resetLanguageCatalogCache,
  seedLanguageCatalog,
} from "../src/lib/language-catalog.js";
import {
  TRANSLATABLE_LANGUAGES,
  untranslatedLanguages,
} from "../src/lib/zpage-language.js";

const UI_ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(UI_ROOT, "..", "..", "..", "..");

/** A fetcher that records its calls and answers with `payload`. */
function stubFetcher(payload) {
  /** @type {any[]} */
  const calls = [];
  const fetcher = async (params) => {
    calls.push(params);
    return typeof payload === "function" ? payload(calls.length) : payload;
  };
  fetcher.calls = calls;
  return fetcher;
}

const apiPayload = {
  locale: "en",
  languages: [
    {
      tag: "en",
      name: "English",
      autonym: "English",
      script: "Latn",
      direction: "ltr",
      translatable: true,
    },
    {
      tag: "ar",
      name: "Arabic",
      autonym: "العربية",
      script: "Arab",
      direction: "rtl",
      translatable: true,
    },
    {
      // A language served for naming but not sold —  item 9. It is the
      // only thing in these fixtures that proves `translatable` is read, and
      // it is deliberately one that NEITHER the compiled seed NOR this
      // engine's CLDR tables know: `Intl.DisplayNames` cannot name `szy`, so
      // it also proves the served name is what reaches the screen.
      tag: "szy",
      name: "Sakizaya",
      autonym: "Sakizaya",
      script: "Latn",
      direction: "ltr",
      translatable: false,
    },
  ],
};

test.beforeEach(() => resetLanguageCatalogCache());

// --- direction --------------------------------------------------------------

test("direction follows the script, not the language", () => {
  for (const tag of ["ar", "he", "fa", "ur", "ckb", "ps", "dv", "yi"]) {
    assert.equal(languageDirection(tag), "rtl", tag);
  }
  for (const tag of ["en", "ja", "zh-Hant", "ta", "kmr", "sr-Cyrl"]) {
    assert.equal(languageDirection(tag), "ltr", tag);
  }
  // Same language, opposite answers, decided by the script subtag.
  assert.equal(languageDirection("pa-Arab"), "rtl");
  assert.equal(languageDirection("pa-Guru"), "ltr");
});

test("an unanswerable tag is ltr, not a throw", () => {
  assert.equal(languageDirection("not a language"), "ltr");
  assert.equal(languageDirection(null), "ltr");
  assert.equal(languageDirection(undefined), "ltr");
  assert.equal(languageDirection(42), "ltr");
});

test("the RTL script table matches the server's", () => {
  // The seed renders direction with no server involved, so a drift here is an
  // offline picker laying Arabic out left-to-right.
  const source = fs.readFileSync(
    path.join(REPO_ROOT, "py", "free2z", "f2z", "language_catalog.py"),
    "utf8",
  );
  const block = source.match(/RTL_SCRIPTS = frozenset\(\{([\s\S]*?)\}\)/);
  assert.ok(
    block,
    "RTL_SCRIPTS is gone from py/free2z/f2z/language_catalog.py",
  );
  const pythonScripts = block[1].match(/"([A-Za-z]{4})"/g) ?? [];
  assert.ok(pythonScripts.length > 20, "parsed suspiciously few scripts");
  assert.deepEqual(
    [...RTL_SCRIPTS].sort(),
    pythonScripts.map((quoted) => quoted.slice(1, -1)).sort(),
  );
});

// --- the seed ---------------------------------------------------------------

test("the seed catalog covers the seed array and says it is not from the API", () => {
  const catalog = seedLanguageCatalog("en");
  assert.equal(catalog.fromApi, false);
  assert.deepEqual(
    catalog.languages.map((entry) => entry.tag).sort(),
    [...TRANSLATABLE_LANGUAGES].sort(),
  );
  const arabic = catalog.languages.find((entry) => entry.tag === "ar");
  assert.equal(arabic.direction, "rtl");
  assert.equal(arabic.script, "Arab");
  assert.ok(arabic.autonym);
});

test("the seed is ordered by the name the viewer reads", () => {
  const names = seedLanguageCatalog("en").languages.map(
    (entry) => entry.name ?? entry.tag,
  );
  assert.deepEqual(
    names,
    [...names].sort((a, b) => a.localeCompare(b, "en")),
  );
  // And it is a different order in another locale, or "localized" is a lie.
  const spanish = seedLanguageCatalog("es").languages.map((e) => e.tag);
  assert.notDeepEqual(
    spanish,
    seedLanguageCatalog("en").languages.map((e) => e.tag),
  );
});

// --- fetching ---------------------------------------------------------------

test("a good response becomes the catalog", async () => {
  const fetcher = stubFetcher(apiPayload);
  const catalog = await fetchLanguageCatalog({ locale: "en", fetcher });
  assert.equal(catalog.fromApi, true);
  assert.equal(catalog.locale, "en");
  assert.deepEqual(
    catalog.languages.map((entry) => entry.tag),
    ["en", "ar", "szy"],
  );
  assert.deepEqual(fetcher.calls, [{ locale: "en" }]);
});

test("the catalog is cached per locale", async () => {
  const fetcher = stubFetcher(apiPayload);
  await fetchLanguageCatalog({ locale: "en", fetcher });
  await fetchLanguageCatalog({ locale: "en", fetcher });
  assert.equal(fetcher.calls.length, 1);
  await fetchLanguageCatalog({ locale: "es", fetcher });
  assert.equal(fetcher.calls.length, 2);
});

test("the cache expires so a long-lived tab picks up a new language", async () => {
  const fetcher = stubFetcher(apiPayload);
  let clock = 1_000;
  const now = () => clock;
  await fetchLanguageCatalog({ locale: "en", fetcher, now });
  clock += CATALOG_TTL_MS - 1;
  await fetchLanguageCatalog({ locale: "en", fetcher, now });
  assert.equal(fetcher.calls.length, 1, "still fresh");
  clock += 2;
  await fetchLanguageCatalog({ locale: "en", fetcher, now });
  assert.equal(fetcher.calls.length, 2, "stale, so refetched");
});

test("concurrent callers share one request", async () => {
  const fetcher = stubFetcher(apiPayload);
  const [a, b, c] = await Promise.all([
    fetchLanguageCatalog({ locale: "en", fetcher }),
    fetchLanguageCatalog({ locale: "en", fetcher }),
    fetchLanguageCatalog({ locale: "en", fetcher }),
  ]);
  assert.equal(fetcher.calls.length, 1);
  assert.equal(a, b);
  assert.equal(b, c);
});

// --- every failure lands on the seed ----------------------------------------

const SEED_SIZE = TRANSLATABLE_LANGUAGES.length;

for (const [label, payload] of [
  ["a rejected request", () => Promise.reject(new Error("offline"))],
  ["a null body", () => null],
  ["a body with no languages", () => ({ locale: "en" })],
  ["a body whose languages is not an array", () => ({ languages: "nope" })],
  [
    "a catalog of unusable tags",
    () => ({ locale: "en", languages: [{ tag: "und" }, { tag: "!!" }] }),
  ],
]) {
  test(`${label} falls back to the seed`, async () => {
    const catalog = await fetchLanguageCatalog({
      locale: "en",
      fetcher: async () => payload(),
    });
    assert.equal(catalog.fromApi, false);
    assert.equal(catalog.languages.length, SEED_SIZE);
  });
}

test("a well-formed empty catalog is an answer, not a failure", async () => {
  // The reachable shape of "we sell no translations right now": the server
  // serves `TRANSLATABLE`, so withdrawing every target answers `[]` with a
  // 200. Treating that as a failure would restore 39 compiled-in targets and
  // offer every one of them, each of which the backend then refuses to quote.
  const catalog = await fetchLanguageCatalog({
    locale: "en",
    fetcher: async () => ({ locale: "en", languages: [] }),
  });
  assert.equal(catalog.fromApi, true);
  assert.deepEqual(catalog.languages, []);
  assert.deepEqual(catalogTranslatableTags(catalog), []);
});

test("a stalled request is bounded, and does not wedge every later caller", async () => {
  // Without a deadline the never-settling promise below would be handed to
  // every subsequent caller through the in-flight de-duplication, so the
  // refetch-on-picker-open recovery would join the stall rather than recover
  // from it — for as long as the tab stayed open.
  let aborted = false;
  const stalled = async (_params, signal) => {
    signal?.addEventListener("abort", () => {
      aborted = true;
    });
    return new Promise(() => {});
  };
  const first = await fetchLanguageCatalog({
    locale: "en",
    fetcher: stalled,
    timeoutMs: 5,
  });
  assert.equal(first.fromApi, false, "the stall fell back to the seed");
  assert.equal(aborted, true, "the request was actually aborted");

  // And the in-flight entry was released, so the next attempt is a new one.
  const second = await fetchLanguageCatalog({
    locale: "en",
    fetcher: stubFetcher(apiPayload),
    timeoutMs: 5,
  });
  assert.equal(second.fromApi, true, "the stall outlived itself");
});

test("a failure is not cached, so the next caller gets to try again", async () => {
  let attempt = 0;
  const fetcher = async () => {
    attempt += 1;
    if (attempt === 1) throw new Error("blip");
    return apiPayload;
  };
  const first = await fetchLanguageCatalog({ locale: "en", fetcher });
  assert.equal(first.fromApi, false);
  const second = await fetchLanguageCatalog({ locale: "en", fetcher });
  assert.equal(second.fromApi, true, "a cached failure outlives the outage");
});

test("a row the client cannot canonicalize is dropped, not printed", async () => {
  const catalog = await fetchLanguageCatalog({
    locale: "en",
    fetcher: async () => ({
      locale: "en",
      languages: [...apiPayload.languages, { tag: "und" }, null, 7],
    }),
  });
  assert.deepEqual(
    catalog.languages.map((entry) => entry.tag),
    ["en", "ar", "szy"],
  );
});

// --- what the picker actually consumes --------------------------------------

test("only the sellable half becomes the picker's translatable list", async () => {
  const catalog = await fetchLanguageCatalog({
    locale: "en",
    fetcher: stubFetcher(apiPayload),
  });
  assert.deepEqual(catalogTranslatableTags(catalog), ["en", "ar"]);
});

test("an absent or unusable catalog falls back to the seed array", () => {
  assert.deepEqual(catalogTranslatableTags(null), [...TRANSLATABLE_LANGUAGES]);
  assert.deepEqual(catalogTranslatableTags({ locale: "en", languages: [] }), [
    ...TRANSLATABLE_LANGUAGES,
  ]);
  assert.deepEqual(catalogTranslatableTags({ locale: "en" }), [
    ...TRANSLATABLE_LANGUAGES,
  ]);
});

test("an API catalog where nothing is sellable is an answer, not a failure", async () => {
  // Restoring 39 compiled-in targets here would offer every one of them while
  // the server refuses each quote — the seed overruling the platform.
  const catalog = await fetchLanguageCatalog({
    locale: "en",
    fetcher: async () => ({
      locale: "en",
      languages: apiPayload.languages.map((entry) => ({
        ...entry,
        translatable: false,
      })),
    }),
  });
  assert.equal(catalog.fromApi, true, "the response itself is usable");
  assert.deepEqual(catalogTranslatableTags(catalog), []);
});

test("a language the article already has stays listed (the #1032 ja case)", async () => {
  // The catalog deliberately does not include `ja`. The article does.
  const catalog = await fetchLanguageCatalog({
    locale: "en",
    fetcher: stubFetcher(apiPayload),
  });
  const offered = untranslatedLanguages({
    rows: [],
    extraLanguages: ["ja"],
    translatable: catalogTranslatableTags(catalog),
  });
  assert.ok(
    offered.includes("ja"),
    "serving the catalog must not hide a variant outside the sell list",
  );
  assert.ok(offered.includes("ar"));
});

test("a served language the frontend bundle has never heard of is offered", async () => {
  // The entire point of: `szy` is in no compiled-in list here.
  assert.ok(!TRANSLATABLE_LANGUAGES.includes("szy"));
  const catalog = await fetchLanguageCatalog({
    locale: "en",
    fetcher: async () => ({
      locale: "en",
      languages: [
        ...apiPayload.languages.slice(0, 2),
        { ...apiPayload.languages[2], translatable: true },
      ],
    }),
  });
  assert.ok(
    untranslatedLanguages({
      rows: [],
      translatable: catalogTranslatableTags(catalog),
    }).includes("szy"),
    "a language added on the server must reach the picker with no release",
  );
});

// --- naming a language the browser has never heard of ------------------------

test("a language this engine can name is named by this engine", () => {
  // The served name is a fallback, not an override: the local CLDR data is in
  // the exact viewer locale, and this is what the picker has always rendered.
  assert.deepEqual(
    describeLanguage("ja", "en", { name: "WRONG", autonym: "WRONG" }),
    { name: "Japanese", autonym: "\u65e5\u672c\u8a9e" },
  );
});

test("a language this engine CANNOT name falls back to the server's name", () => {
  // `szy` (Sakizaya) is absent from Node's and Chromium's CLDR tables, so
  // today the picker drops it silently — a language added on the server would
  // still need a client that had heard of it, which is the whole promise of
  //  undone.
  assert.equal(describeLanguage("szy", "en").name, null);
  assert.deepEqual(
    describeLanguage("szy", "en", { name: "Sakizaya", autonym: "Sakizaya" }),
    { name: "Sakizaya", autonym: "Sakizaya" },
  );
});

test("a nameless language is dropped, never shown as a raw tag", () => {
  //a subtag must never reach a reader, so "no name from either source"
  // has to stay null rather than degrade to the tag.
  assert.deepEqual(describeLanguage("szy", "en", { name: "  " }), {
    name: null,
    autonym: null,
  });
  assert.deepEqual(describeLanguage("und", "en", { name: "Unknown" }), {
    name: null,
    autonym: null,
  });
  assert.deepEqual(describeLanguage(null, "en"), { name: null, autonym: null });
});

test("a row is findable by the name and autonym the SERVER supplied", () => {
  // The row is on screen showing "Sakizaya" / "Sakidaya". Typing either of
  // them used to empty the list, because the search only ever looked at the
  // names this engine could produce — and for this language it produces none.
  const entry = { language: "szy", name: "Sakizaya", autonym: "Sakidaya" };
  assert.equal(languageEntryMatchesQuery(entry, "sakiz", "en"), true);
  assert.equal(languageEntryMatchesQuery(entry, "sakid", "en"), true);
  assert.equal(languageEntryMatchesQuery(entry, "szy", "en"), true);
  assert.equal(languageEntryMatchesQuery(entry, "japanese", "en"), false);
  // An empty query still shows everything, and a language the engine CAN name
  // keeps matching on the engine's own names.
  assert.equal(languageEntryMatchesQuery(entry, "  ", "en"), true);
  assert.equal(
    languageEntryMatchesQuery({ language: "ja", name: null }, "japanese", "en"),
    true,
  );
});

test("the picker resolves its search through languageEntryMatchesQuery", () => {
  // The seam moved one module along in: the component now delegates its
  // list building — ordering, grouping, matching — to `$lib/language-picker.js`,
  // and THAT is what has to keep consulting this module's matcher. Following
  // the seam rather than deleting the assertion, because the thing being
  // pinned is unchanged: a language only the server can name must be findable
  // by the name it displays. `language-picker.test.mjs` asserts the behaviour
  // end to end; this pins the wiring that makes it hold.
  const picker = fs.readFileSync(
    path.join(
      UI_ROOT,
      "..",
      "src",
      "lib",
      "components",
      "zpageLanguage",
      "LanguagePicker.svelte",
    ),
    "utf8",
  );
  assert.match(picker, /buildLanguageSections\(/);
  assert.match(picker, /served: names/);

  const listLogic = fs.readFileSync(
    path.join(UI_ROOT, "..", "src", "lib", "language-picker.js"),
    "utf8",
  );
  assert.match(listLogic, /languageEntryMatchesQuery\(/);
});

test("the picker resolves its names through describeLanguage", () => {
  // Pinning the seam, not the implementation: if the component goes back to
  // naming languages itself, the served name stops reaching the screen and
  // every assertion above keeps passing.
  const picker = fs.readFileSync(
    path.join(
      UI_ROOT,
      "..",
      "src",
      "lib",
      "components",
      "zpageLanguage",
      "LanguagePicker.svelte",
    ),
    "utf8",
  );
  assert.match(picker, /describeLanguage\(/);
  assert.match(picker, /names\.get\(language\)/);
});

test("the editor names a language through describeLanguage everywhere", () => {
  // Naming it in the picker alone is worse than not naming it: the creator
  // picks "Sakizaya" and the chip, the switch prompt and the dialog that asks
  // them to spend 2Z all call it "Detecting…".
  const source = fs.readFileSync(
    path.join(UI_ROOT, "..", "src", "routes", "edit", "+page.svelte"),
    "utf8",
  );
  const label = source.slice(
    source.indexOf("function languageLabel("),
    source.indexOf("const chip = $derived("),
  );
  assert.ok(label.length > 0, "found the label helper");
  assert.match(label, /describeLanguage\(/);
  assert.match(label, /servedLanguageNames/);
});

test("the editor actually feeds the served catalog into its pickers", () => {
  // Without this, the module could be deleted from the editor and every other
  // test here would stay green while the endpoint went back to being unused.
  // Deliberately tolerant of formatting: a Prettier pass must not fail it.
  const source = fs.readFileSync(
    path.join(UI_ROOT, "..", "src", "routes", "edit", "+page.svelte"),
    "utf8",
  );
  assert.match(source, /fetchLanguageCatalog\s*\(/);
  const calls = source.match(/untranslatedLanguages\(\{[\s\S]*?\}\)/g) ?? [];
  assert.ok(calls.length >= 2, "the editor stopped building language lists");
  for (const call of calls) {
    assert.match(
      call,
      /translatable:/,
      "a picker list still hardcodes the compiled-in seed",
    );
  }
});

test("the seed array is still exported — it is the offline fallback", () => {
  assert.ok(Array.isArray(TRANSLATABLE_LANGUAGES));
  assert.ok(TRANSLATABLE_LANGUAGES.length >= 39);
});
