// The language picker at 50+ languages —, part of  ws5.
//
// The control under test used to be a flat, alphabetical, mouse-only list of
// four rows. Every test here is one way that stops being usable when the list
// is fifty rows long, or one rule from  that must survive the rewrite.
//
// Where an assertion depends on what CLDR happens to know, the test asserts the
// PRECONDITION first. A test that says "an unnameable language is dropped" is
// worth nothing the day ICU learns to name the language it picked as its
// example — it would pass without testing anything, which is this repo's
// dominant defect class. The precondition assert makes that failure loud.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  RECENT_LANGUAGES_LIMIT,
  RECENT_LANGUAGES_STORAGE_KEY,
  buildLanguageSections,
  describeLanguageEntry,
  entryMatchesQuery,
  exactTagOptionId,
  flattenSections,
  foldSearchText,
  languageDirection,
  languageQualifier,
  languageScript,
  languageSearchKeys,
  nextActiveIndex,
  optionDomId,
  parseAcceptLanguage,
  preferredLanguages,
  primaryLanguageName,
  readRecentLanguages,
  rememberRecentLanguage,
} from "../src/lib/language-picker.js";
import {
  TRANSLATABLE_LANGUAGES,
  languageDisplayName,
} from "../src/lib/zpage-language.js";

const UI_ROOT = path.dirname(fileURLToPath(import.meta.url));
const source = (relativePath) =>
  fs.readFileSync(path.join(UI_ROOT, "..", relativePath), "utf8");

const PICKER = "src/lib/components/zpageLanguage/LanguagePicker.svelte";

/** A representative slice of what the list looks like once  lands. */
const SAMPLE = Object.freeze([
  "zh-Hans",
  "zh-Hant",
  "yue-Hant",
  "pt-BR",
  "pt-PT",
  "ar",
  "he",
  "en",
  "es",
  "fr",
  "ja",
]);

/** Every tag the picker would render, in render order. */
const tagsOf = (sections) =>
  sections.flatMap((section) => section.entries.map((entry) => entry.language));

/** One row, found anywhere in the list. */
const rowFor = (sections, tag) =>
  sections
    .flatMap((section) => section.entries)
    .find((entry) => entry.language === tag);

/** A `Storage`-shaped object, because there is no DOM here. */
function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => void data.set(key, String(value)),
    removeItem: (key) => void data.delete(key),
    clear: () => data.clear(),
    key: (index) => [...data.keys()][index] ?? null,
    get length() {
      return data.size;
    },
  };
}

// --- searching --------------------------------------------------------------

test("search folds case and diacritics", () => {
  assert.equal(foldSearchText("Français"), "francais");
  assert.equal(foldSearchText("ESPAÑOL"), "espanol");
  assert.equal(foldSearchText("  Português (Brasil) "), "portugues (brasil)");
  // A decomposed sequence — what a dead-key keyboard actually emits — folds
  // to the same thing as the precomposed one, which is the entire point.
  // Built from code points on purpose: a formatter or an editor that
  // normalized a literal would quietly delete the only case being tested.
  const DECOMPOSED = "Fran" + "c\u0327" + "ais";
  assert.notEqual(DECOMPOSED, "Fran\u00e7ais");
  assert.equal(foldSearchText(DECOMPOSED), "francais");
  assert.equal(foldSearchText(null), "");
  assert.equal(foldSearchText(42), "");
});

test("a creator who cannot type an accent still finds the language", () => {
  const typed = [
    "francais",
    "FRANCAIS",
    "Fran\u00e7ais",
    "Fran" + "c\u0327ais",
  ];
  for (const value of typed) {
    assert.deepEqual(
      tagsOf(buildLanguageSections({ languages: SAMPLE, query: value })),
      ["fr"],
      `typing ${JSON.stringify(value)} finds French`,
    );
  }
});

test("someone who knows the tag can type the tag", () => {
  // The precise reason the raw tag is a search key: `pt-PT` is how a European
  // Portuguese creator names their language, and "European Portuguese" is not.
  assert.deepEqual(
    tagsOf(buildLanguageSections({ languages: SAMPLE, query: "pt-PT" })),
    ["pt-PT"],
  );
  // A bare primary subtag finds the whole family, not nothing.
  assert.deepEqual(
    tagsOf(buildLanguageSections({ languages: SAMPLE, query: "pt" })).sort(),
    ["pt-BR", "pt-PT"],
  );
  // Case-insensitively, because nobody types `pt-PT` with the shift key.
  assert.deepEqual(
    tagsOf(buildLanguageSections({ languages: SAMPLE, query: "PT-pt" })),
    ["pt-PT"],
  );
});

test("search matches the autonym, in its own script", () => {
  assert.deepEqual(
    tagsOf(buildLanguageSections({ languages: SAMPLE, query: "日本語" })),
    ["ja"],
  );
  assert.deepEqual(
    tagsOf(buildLanguageSections({ languages: SAMPLE, query: "العربية" })),
    ["ar"],
  );
  assert.deepEqual(
    tagsOf(buildLanguageSections({ languages: SAMPLE, query: "繁體" })),
    ["yue-Hant", "zh-Hant"],
  );
});

test("search matches the family name, so 'Chinese' finds both scripts", () => {
  const found = tagsOf(
    buildLanguageSections({ languages: SAMPLE, query: "chinese" }),
  );
  assert.deepEqual(found.sort(), ["zh-Hans", "zh-Hant"]);
  // And does NOT sweep Cantonese in with them: it is a different language, and
  // a search that conflated them would be teaching the thing  is about.
  assert.ok(!found.includes("yue-Hant"));
});

test("the search keys are the localized name, the autonym and the tag", () => {
  const keys = languageSearchKeys("zh-Hant", "en");
  assert.ok(keys.includes("zh-hant"), "the raw tag");
  assert.ok(keys.includes("traditional chinese"), "the localized name");
  assert.ok(keys.includes("繁體中文"), "the autonym");
  assert.ok(keys.includes("chinese"), "the family name");
  // Every key is folded, so the matcher never has to fold a haystack at match
  // time — 50 languages times 8 keys per keystroke is the reason.
  for (const key of keys) assert.equal(key, foldSearchText(key));
});

test("an empty query matches everything, and matching is substring", () => {
  const entry = { keys: ["traditional chinese", "zh-hant"] };
  assert.equal(entryMatchesQuery(entry, ""), true);
  assert.equal(entryMatchesQuery(entry, "   "), true);
  assert.equal(entryMatchesQuery(entry, "tradition"), true);
  assert.equal(entryMatchesQuery(entry, "chinese trad"), false);
});

// --- Accept-Language --------------------------------------------------------

test("Accept-Language is parsed in q order, and ties keep their order", () => {
  assert.deepEqual(parseAcceptLanguage("fr-CA,fr;q=0.9,en;q=0.8"), [
    "fr-CA",
    "fr",
    "en",
  ]);
  // q sorts above written order...
  assert.deepEqual(parseAcceptLanguage("en;q=0.5,de;q=0.9"), ["de", "en"]);
  //...but equal q keeps it, because a browser's own order IS the preference.
  assert.deepEqual(parseAcceptLanguage("de,en,fr"), ["de", "en", "fr"]);
  // `*` floats nothing, and `q=0` is an explicit refusal.
  assert.deepEqual(parseAcceptLanguage("en,*;q=0.1,de;q=0"), ["en"]);
  assert.deepEqual(parseAcceptLanguage(["pt-BR", "pt", "en"]), [
    "pt-BR",
    "pt",
    "en",
  ]);
  assert.deepEqual(parseAcceptLanguage(null), []);
  assert.deepEqual(parseAcceptLanguage(undefined), []);
});

test("the viewer's likely languages float to the top", () => {
  const sections = buildLanguageSections({
    languages: SAMPLE,
    accepted: "es-MX,es;q=0.9,en;q=0.5",
  });
  assert.equal(sections[0].kind, "suggested");
  assert.deepEqual(
    sections[0].entries.map((entry) => entry.language),
    ["es", "en"],
  );
});

test("a preference matches by range, and offers every variant it reaches", () => {
  // `en-GB` is not on offer; `en` is, and that is what the viewer reads.
  assert.deepEqual(preferredLanguages("en-GB", SAMPLE), ["en"]);
  // A bare `pt` reaches both Portuguese variants. `resolveContentLanguageRange`
  // returns null here, on purpose — it must choose exactly one variant to
  // RENDER. A suggestion list may honestly offer both.
  assert.deepEqual(preferredLanguages("pt", SAMPLE), ["pt-BR", "pt-PT"]);
  // A language this ARTICLE does not offer contributes nothing rather than a
  // phantom row. Nothing here depends on `is` being unsellable: SAMPLE is a
  // fixed list of eleven tags, and `is` is not one of them.
  assert.deepEqual(preferredLanguages("is", SAMPLE), []);
  // And a non-language is not a preference ('s other half).
  assert.deepEqual(preferredLanguages("und,zxx,mul", SAMPLE), []);
});

test("the creator's recent languages come after the viewer's own", () => {
  const sections = buildLanguageSections({
    languages: SAMPLE,
    accepted: "en",
    recent: ["ja", "ar"],
  });
  assert.deepEqual(
    sections[0].entries.map((entry) => entry.language),
    ["en", "ja", "ar"],
  );
});

test("a suggestion is never a row the list does not actually offer", () => {
  const sections = buildLanguageSections({
    languages: ["en", "fr"],
    accepted: "de,ja",
    recent: ["is", "ko"],
  });
  assert.equal(sections[0].kind, "language");
  assert.deepEqual(tagsOf(sections), ["en", "fr"]);
});

test("suggestions are filtered by the query like everything else", () => {
  const sections = buildLanguageSections({
    languages: SAMPLE,
    accepted: "en,ja",
    query: "japan",
  });
  assert.equal(sections[0].kind, "suggested");
  assert.deepEqual(
    sections[0].entries.map((entry) => entry.language),
    ["ja"],
  );
  const empty = buildLanguageSections({
    languages: SAMPLE,
    accepted: "en,ja",
    query: "arabic",
  });
  assert.ok(!empty.some((section) => section.kind === "suggested"));
});

// --- direction and script ---------------------------------------------------

test("each entry carries the direction its OWN text runs in", () => {
  for (const tag of ["ar", "he", "fa", "ur", "ps", "sd"]) {
    assert.equal(languageDirection(tag), "rtl", tag);
  }
  for (const tag of ["en", "ja", "zh-Hant", "yue-Hant", "ru", "hi", "am"]) {
    assert.equal(languageDirection(tag), "ltr", tag);
  }
  // Never null: the value is a `dir` attribute, and "unknown" there means
  // "inherit the LTR list", which is the bug it exists to prevent.
  assert.equal(languageDirection("not a tag at all"), "ltr");
});

test("an RTL autonym in an LTR list is an RTL row", () => {
  const sections = buildLanguageSections({ languages: SAMPLE });
  assert.equal(rowFor(sections, "ar").direction, "rtl");
  assert.equal(rowFor(sections, "he").direction, "rtl");
  assert.equal(rowFor(sections, "en").direction, "ltr");
});

test("the script comes from content-direction.js, not a fourth copy", () => {
  assert.equal(languageScript("zh-Hant"), "Hant");
  assert.equal(languageScript("yue-Hant"), "Hant");
  assert.equal(languageScript("sr"), "Cyrl");
  assert.equal(languageScript("pt-BR"), "Latn");
  assert.equal(languageScript("!!"), null);
  // The two behaviours that make 's version the right one to reuse: an
  // explicit script subtag wins, and `und` stays unknown instead of being
  // maximized into `Latn`.
  assert.equal(languageScript("az-Arab"), "Arab");
  assert.equal(languageScript("und"), null);
});

// --- grouping: script is not language  -------------------------------

test("Simplified and Traditional are one language written two ways", () => {
  const sections = buildLanguageSections({ languages: SAMPLE });
  const chinese = sections.find((section) => section.id === "language:zh");
  assert.ok(chinese, "there is a Chinese group");
  assert.equal(chinese.label, "Chinese");
  assert.deepEqual(
    chinese.entries.map((entry) => entry.language),
    ["zh-Hans", "zh-Hant"],
  );
  // The rows under the heading say what distinguishes them, and nothing else
  // has to be inferred from a tag.
  assert.deepEqual(
    chinese.entries.map((entry) => entry.qualifier),
    ["Simplified", "Traditional"],
  );
});

test("Cantonese is its own language, not a third Chinese row", () => {
  const sections = buildLanguageSections({ languages: SAMPLE });
  const cantonese = sections.find((section) => section.id === "language:yue");
  assert.ok(cantonese, "Cantonese is its own group");
  // Its own group, and not inside the Chinese one — the whole point of.
  const chinese = sections.find((section) => section.id === "language:zh");
  assert.ok(
    !chinese.entries.some((entry) => entry.language.startsWith("yue")),
    "yue is not filed under zh",
  );
  // Standing alone it carries its full name, not a bare "Traditional" under
  // someone else's heading.
  assert.equal(cantonese.label, null);
  assert.equal(cantonese.entries[0].name, "Cantonese (Traditional)");
  // And it is genuinely the same script as zh-Hant — "related but distinct" is
  // the claim, and the script is where the relation is real.
  assert.equal(cantonese.entries[0].script, rowFor(sections, "zh-Hant").script);
});

test("a group heading names the LANGUAGE, not the product's default variant", () => {
  // `languageDisplayName('pt')` is "Brazilian Portuguese", because bare `pt` is
  // stored as `pt-BR` (`_REGIONAL_DEFAULTS`). Using it as the heading over a
  // group that contains `pt-PT` would tell a European Portuguese creator their
  // language is Brazilian.
  assert.equal(languageDisplayName("pt", "en"), "Brazilian Portuguese");
  assert.equal(primaryLanguageName("pt", "en"), "Portuguese");
  const sections = buildLanguageSections({ languages: SAMPLE });
  const portuguese = sections.find((section) => section.id === "language:pt");
  assert.equal(portuguese.label, "Portuguese");
  assert.deepEqual(
    portuguese.entries.map((entry) => entry.qualifier),
    ["Brazil", "Portugal"],
  );
});

test("a single-variant language gets no heading, because a heading of one is noise", () => {
  const sections = buildLanguageSections({ languages: SAMPLE });
  for (const id of ["language:en", "language:ja", "language:ar"]) {
    const section = sections.find((entry) => entry.id === id);
    assert.equal(section.label, null, id);
  }
});

test("filtering a group down to one row keeps its heading", () => {
  // Otherwise the surviving row reads "Traditional" with nothing on screen
  // saying traditional WHAT.
  const sections = buildLanguageSections({
    languages: SAMPLE,
    query: "zh-Hant",
  });
  const chinese = sections.find((section) => section.id === "language:zh");
  assert.equal(chinese.entries.length, 1);
  assert.equal(chinese.label, "Chinese");
});

test("groups are ordered by their heading in the viewer's locale", () => {
  const en = buildLanguageSections({ languages: SAMPLE, viewerLocale: "en" })
    .filter((section) => section.kind === "language")
    .map((section) => section.label ?? section.entries[0].name);
  assert.deepEqual(
    en,
    [...en].sort((a, b) => a.localeCompare(b, "en")),
  );

  const es = buildLanguageSections({ languages: SAMPLE, viewerLocale: "es" })
    .filter((section) => section.kind === "language")
    .map((section) => section.label ?? section.entries[0].name);
  assert.deepEqual(
    es,
    [...es].sort((a, b) => a.localeCompare(b, "es")),
  );
  // And the Spanish list is genuinely a different order, not the English one
  // relabelled — which is what proves the collator is doing anything.
  assert.notDeepEqual(es, en);
});

// --- the rules that outrank the design  ------------------------

test("a language only the SERVER can name is still on the list, and findable", () => {
  // 's whole point: the catalog can add a language this browser's CLDR
  // data has never heard of. Naming goes through `language-catalog.js`, so the
  // served name is the fallback — and the picker must also be able to FIND it,
  // or the row is on screen and vanishes the moment anyone types its name.
  assert.equal(languageDisplayName("abe", "en"), null, "precondition");
  const served = new Map([
    ["abe", { name: "Abenaki", autonym: "Wôbanakiôdwawôgan" }],
  ]);
  const sections = buildLanguageSections({
    languages: ["en", "abe", "fr"],
    served,
  });
  assert.deepEqual(tagsOf(sections), ["abe", "en", "fr"]);
  assert.equal(rowFor(sections, "abe").name, "Abenaki");

  for (const query of ["abenaki", "ABENAKI", "Wôbanakiôdwawôgan", "abe"]) {
    assert.deepEqual(
      tagsOf(
        buildLanguageSections({
          languages: ["en", "abe", "fr"],
          served,
          query,
        }),
      ),
      ["abe"],
      query,
    );
  }
});

test("the server's text_direction wins over the local script table", () => {
  // The endpoint is the side that can be corrected without a frontend release.
  const served = new Map([["en", { direction: "rtl" }]]);
  const sections = buildLanguageSections({ languages: ["en"], served });
  assert.equal(rowFor(sections, "en").direction, "rtl");
  // And with nothing served it is 's `contentDirection`, so `ckb` is rtl
  // and `kmr` is not, an explicit script subtag wins over the language, and
  // the `und` sentinel is not maximized into a confident answer.
  assert.equal(languageDirection("ckb"), "rtl");
  assert.equal(languageDirection("kmr"), "ltr");
  assert.equal(languageDirection("az-Arab"), "rtl");
  assert.equal(languageDirection("az"), "ltr");
  assert.equal(languageDirection("und"), "ltr");
});

test("a language we cannot name does not render", () => {
  // Precondition: if a future ICU learns to name Abenaki this assert fails
  // loudly instead of the test below passing for no reason.
  assert.equal(languageDisplayName("abe", "en"), null);
  assert.equal(describeLanguageEntry("abe", "en"), null);
  // Not even with a served entry that names nothing.
  assert.equal(describeLanguageEntry("abe", "en", { name: "  " }), null);
  const sections = buildLanguageSections({ languages: ["en", "abe", "fr"] });
  assert.deepEqual(tagsOf(sections), ["en", "fr"]);
  // And not as a heading either.
  assert.equal(primaryLanguageName("abe", "en"), null);
});

test("no entry anywhere renders its own tag as its name", () => {
  const sections = buildLanguageSections({
    languages: [...TRANSLATABLE_LANGUAGES, "yue-Hant", "abe", "und", "zxx"],
    viewerLocale: "en",
  });
  const rows = flattenSections(sections);
  assert.ok(rows.length >= TRANSLATABLE_LANGUAGES.length);
  for (const { entry } of rows) {
    assert.equal(typeof entry.name, "string");
    assert.notEqual(entry.name, entry.language);
    assert.ok(entry.name.length > 0, entry.language);
  }
  for (const section of sections) {
    assert.notEqual(section.label, section.id.replace("language:", ""));
  }
  // The sentinels never became rows.
  assert.ok(!tagsOf(sections).includes("und"));
  assert.ok(!tagsOf(sections).includes("zxx"));
});

test("whatever the API reports for an article is listed, sellable or not", () => {
  // The `ja` case in, generalized: this module never consults
  // TRANSLATABLE_LANGUAGES, so a variant created outside the sell list is
  // still a row the creator can reach.
  // `yue-Hant` became sellable in, and Icelandic is queued to follow.
  // So the outsider is CHOSEN at run time out of candidates rather than
  // hardcoded: the sell list is something the platform tunes, and a test that
  // owns a tag stops it being tuned. If every candidate becomes sellable this
  // fails loudly instead of quietly testing nothing.
  const outsider = ["yue-Hans", "cy", "ga", "mt", "be", "bs", "is"].find(
    (tag) =>
      !TRANSLATABLE_LANGUAGES.includes(tag) && languageDisplayName(tag, "en"),
  );
  assert.ok(outsider, "a nameable language outside the sell list exists");
  const sections = buildLanguageSections({
    languages: [...TRANSLATABLE_LANGUAGES, outsider],
  });
  const tags = tagsOf(sections);
  assert.ok(tags.includes(outsider));
  // And the two Cantonese scripts file under Cantonese together, rather than
  // becoming two more unexplained Chinese rows.
  const both = buildLanguageSections({
    languages: [...TRANSLATABLE_LANGUAGES, "yue-Hans"],
  });
  const cantonese = both.find((section) => section.id === "language:yue");
  assert.deepEqual(cantonese.entries.map((entry) => entry.language).sort(), [
    "yue-Hans",
    "yue-Hant",
  ]);
  assert.equal(cantonese.label, "Cantonese");
  for (const tag of TRANSLATABLE_LANGUAGES) assert.ok(tags.includes(tag), tag);
});

test("every sellable language survives the list at full size", () => {
  const sections = buildLanguageSections({
    languages: TRANSLATABLE_LANGUAGES,
    viewerLocale: "en",
  });
  const tags = flattenSections(sections).map((row) => row.entry.language);
  assert.equal(new Set(tags).size, TRANSLATABLE_LANGUAGES.length);
});

test("a duplicate tag in the input is one row, not two", () => {
  const sections = buildLanguageSections({ languages: ["en", "en", "fr"] });
  assert.deepEqual(tagsOf(sections), ["en", "fr"]);
});

// --- keyboard navigation ----------------------------------------------------

test("an exactly-typed tag outranks the first substring match", () => {
  // "A-fr-ikaans" contains `fr` and sorts first, so a creator who types `fr`
  // and presses Enter relabelled their article Afrikaans; `es` landed on
  // Burmese the same way. Found by the codex review on.
  const sections = buildLanguageSections({
    languages: TRANSLATABLE_LANGUAGES,
    query: "fr",
  });
  const rows = flattenSections(sections).map((row) => ({
    id: row.id,
    language: row.entry.language,
  }));
  // The collision is real: the substring match does put Afrikaans first.
  assert.equal(rows[0].language, "af");
  assert.equal(exactTagOptionId(rows, "fr"), optionDomId("language:fr", "fr"));

  const spanish = flattenSections(
    buildLanguageSections({ languages: TRANSLATABLE_LANGUAGES, query: "es" }),
  ).map((row) => ({ id: row.id, language: row.entry.language }));
  assert.notEqual(spanish[0].language, "es", "the collision is real for `es`");
  assert.equal(
    exactTagOptionId(spanish, "es"),
    optionDomId("language:es", "es"),
  );

  // Canonicalized on both sides, so `PT_pt` finds the row stored as `pt-PT`.
  const pt = [
    { id: "a", language: "pt-BR" },
    { id: "b", language: "pt-PT" },
  ];
  assert.equal(exactTagOptionId(pt, "PT_pt"), "b");
  // Nothing typed, or nothing matching, leaves the cursor where it was.
  assert.equal(exactTagOptionId(pt, ""), null);
  assert.equal(exactTagOptionId(pt, "portuguese"), null);
  assert.equal(exactTagOptionId(pt, "und"), null);
  assert.equal(exactTagOptionId(null, "pt-PT"), null);
});

test("arrow keys wrap at both ends", () => {
  assert.equal(nextActiveIndex(0, 1, 5), 1);
  assert.equal(nextActiveIndex(4, 1, 5), 0);
  assert.equal(nextActiveIndex(0, -1, 5), 4);
  assert.equal(nextActiveIndex(-1, 1, 5), 0);
  assert.equal(nextActiveIndex(-1, -1, 5), 4);
  // An empty list has nowhere to go, and must not report row 0.
  assert.equal(nextActiveIndex(0, 1, 0), -1);
  assert.equal(nextActiveIndex(-1, 1, 0), -1);
});

test("every navigable row has its own id, even when it is listed twice", () => {
  const sections = buildLanguageSections({
    languages: SAMPLE,
    accepted: "ja",
    recent: ["ar"],
  });
  const rows = flattenSections(sections);
  const ids = rows.map((row) => row.id);
  // `ja` and `ar` each appear as a suggestion AND in their own group...
  assert.equal(rows.filter((row) => row.entry.language === "ja").length, 2);
  //...and `aria-activedescendant` points at exactly one element, so the ids
  // must still be unique.
  assert.equal(new Set(ids).size, ids.length);
  // A DOM id cannot contain the `:` a section id uses.
  for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]+$/);
});

test("the row id is stable for a given section and tag", () => {
  assert.equal(optionDomId("language:zh", "zh-Hant"), "lp-language_zh-zh-Hant");
  assert.equal(optionDomId("suggested", "pt-BR"), "lp-suggested-pt-BR");
});

// --- the creator's recent languages -----------------------------------------

test("recent languages round-trip, most recent first", () => {
  const storage = fakeStorage();
  assert.deepEqual(readRecentLanguages(storage), []);
  rememberRecentLanguage("ja", storage);
  rememberRecentLanguage("fr", storage);
  rememberRecentLanguage("ja", storage);
  assert.deepEqual(readRecentLanguages(storage), ["ja", "fr"]);
});

test("the recent list is capped, so it cannot eat the picker", () => {
  const storage = fakeStorage();
  for (const tag of ["af", "ar", "bn", "cs", "da", "de", "el"]) {
    rememberRecentLanguage(tag, storage);
  }
  const recent = readRecentLanguages(storage);
  assert.equal(recent.length, RECENT_LANGUAGES_LIMIT);
  assert.equal(recent[0], "el");
});

test("storage holding junk degrades to no suggestions, never to a throw", () => {
  // What is in storage was written by an older build of this code, or by
  // nothing at all. Opening the picker must not depend on it.
  for (const raw of ["not json", "{}", '"en"', "[1,2,3]", '["und","zxx"]']) {
    const storage = fakeStorage({ [RECENT_LANGUAGES_STORAGE_KEY]: raw });
    assert.deepEqual(readRecentLanguages(storage), [], raw);
  }
  const mixed = fakeStorage({
    [RECENT_LANGUAGES_STORAGE_KEY]: '["en",null,"und","fr","en"]',
  });
  assert.deepEqual(readRecentLanguages(mixed), ["en", "fr"]);
});

test("a storage that throws is survived on both read and write", () => {
  const hostile = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("quota");
    },
    removeItem() {},
    clear() {},
    key: () => null,
    length: 0,
  };
  assert.deepEqual(readRecentLanguages(hostile), []);
  assert.deepEqual(rememberRecentLanguage("en", hostile), ["en"]);
});

test("a non-language is never remembered", () => {
  const storage = fakeStorage();
  rememberRecentLanguage("und", storage);
  rememberRecentLanguage("", storage);
  rememberRecentLanguage("not a tag", storage);
  assert.deepEqual(readRecentLanguages(storage), []);
});

// --- the qualifier ----------------------------------------------------------

test("a qualifier is the script or the region, never the subtag", () => {
  assert.equal(languageQualifier("zh-Hans", "en"), "Simplified");
  assert.equal(languageQualifier("pt-BR", "en"), "Brazil");
  assert.equal(languageQualifier("en", "en"), null);
  // A subtag CLDR cannot name contributes nothing rather than printing itself.
  assert.equal(languageQualifier("en-x-nope", "en"), null);
});

// --- the component: it is a combobox, not a styled select -------------------
//
// These read the source. They are pinned with the formatting factored out — a
// prettier pass must not turn any of them red.

/**
 * Just the markup.
 *
 * The doc comment at the top of the component explains the ARIA it uses, in
 * prose, quoting the attribute names. An assertion run over the whole file is
 * therefore satisfied by the COMMENT and would stay green with every attribute
 * deleted — a test that passes without testing anything. Slicing at `{#if open}`
 * is what makes these assertions about the element.
 */
const template = () => {
  const picker = source(PICKER);
  const start = picker.indexOf("{#if open}");
  assert.ok(start > 0, "found the start of the template");
  return picker.slice(start);
};

test("the picker is an ARIA combobox over a listbox", () => {
  const picker = template();
  assert.match(picker, /role=["']combobox["']/);
  assert.match(picker, /aria-expanded=/);
  assert.match(picker, /aria-controls=\{listboxId\}/);
  assert.match(picker, /aria-autocomplete=["']list["']/);
  assert.match(picker, /aria-activedescendant=\{activeId/);
  assert.match(picker, /role=["']listbox["']/);
  // Scoped to the rows themselves. The typed-tag escape hatch further down
  // also carries `role="option"`, so an unscoped match stays green with every
  // language row stripped of its role — which is most of the list.
  const start = picker.indexOf("{#each section.entries as entry");
  assert.ok(start > 0, "found the language rows");
  const rows = picker.slice(start, picker.indexOf("{/each}", start));
  assert.match(rows, /role=["']option["']/);
  assert.match(rows, /aria-selected=/);
  // Shorthand — prettier writes `{id}`, not `id={id}`.
  assert.match(rows, /\s\{id\}/);
  // The thing it replaced.
  assert.doesNotMatch(picker, /<\/select>/);
});

test("the list is navigable from the keyboard alone", () => {
  const picker = source(PICKER);
  const handler = picker.slice(
    picker.indexOf("function onSearchKeydown("),
    picker.indexOf("function rowLabel("),
  );
  assert.ok(handler.length > 0, "found the key handler");
  for (const key of [
    "ArrowDown",
    "ArrowUp",
    "Home",
    "End",
    "Enter",
    "Escape",
  ]) {
    assert.match(handler, new RegExp(`["']${key}["']`), key);
  }
  assert.match(handler, /nextActiveIndex\(/);
  assert.match(handler, /choose\(/);
  assert.match(handler, /close\(\)/);
});

test("closing hands focus back to whatever opened the picker", () => {
  const picker = source(PICKER);
  assert.match(picker, /returnFocusTo\s*=/);
  assert.match(picker, /document\.activeElement/);
  assert.match(picker, /function restoreFocus\(\)/);
  assert.match(picker, /\.focus\(\)/);
  // Both exits restore it: cancelling and choosing.
  const choose = picker.slice(
    picker.indexOf("function choose("),
    picker.indexOf("function restoreFocus("),
  );
  assert.match(choose, /restoreFocus\(\)/);
  assert.match(choose, /rememberRecentLanguage\(/);
});

test("each autonym is isolated and tagged with its own language", () => {
  const picker = template();
  // `<bdi>` is the isolation. Without it an RTL autonym reorders the row it
  // sits in — the row's own punctuation moves, not just the autonym.
  assert.match(picker, /<bdi[\s\S]{0,200}dir=\{entry\.direction\}/);
  assert.match(picker, /<bdi[\s\S]{0,200}lang=\{entry\.language\}/);
  assert.doesNotMatch(
    picker,
    /<span[^>]*>\{entry\.autonym\}/,
    "the autonym is never an unisolated span",
  );
});

test("the picker does not hardcode a language table", () => {
  const picker = source(PICKER);
  assert.doesNotMatch(picker, /TRANSLATABLE_LANGUAGES/);
  assert.match(picker, /buildLanguageSections\(/);
});

test("narrowing the list is announced, not silent", () => {
  const picker = template();
  assert.match(picker, /aria-live=["']polite["']/);
  assert.match(picker, /languagePickerResultCount/);
  for (const locale of ["en", "es", "fr", "pt-BR"]) {
    const catalog = JSON.parse(source(`src/lib/locales/${locale}.json`));
    assert.ok(catalog.editor.languagePickerResultCount.includes("{count}"));
    assert.ok(catalog.editor.languagePickerSuggested.length > 0);
  }
});
