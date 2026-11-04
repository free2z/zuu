// The language picker's logic, with no Svelte in it (part of  ws5).
//
// The picker was built for four entries.  took `TRANSLATABLE` from 39 to
// 78, at which point a flat alphabetical list of localized names is not a
// control anyone can use: the row you want is off screen, the name you know it
// by may be the autonym rather than the English one, and the four
// Chinese-looking rows do not explain themselves.
//
// Everything here is a pure function over tags and strings so it can be tested
// without a DOM. `LanguagePicker.svelte` is the rendering and the ARIA; this is
// the ordering, the grouping, the folding and the matching.
//
// Two rules from  are load-bearing and are enforced here rather than in
// the component:
//
//   1. **A raw tag never reaches a reader as prose.** Every entry this
//      module emits carries a `name` that came from CLDR. A language we cannot
//      name is dropped, not rendered with its subtag as a stand-in.
//   2. **Whatever the API says an article has is always listed**, even outside
//      the sellable set — the `ja` case in. This module never consults
//      `TRANSLATABLE_LANGUAGES`; it lists exactly the tags it is handed.
//
// Where the names, the direction and the base match rule come from: 's
// `language-catalog.js`. `describeLanguage` there is what merges this engine's
// CLDR data with the names the SERVER supplied, which is the only reason a
// language the local ICU build has never heard of is visible at all; its
// `languageDirection` mirrors `RTL_SCRIPTS` in `py/f2z/language_catalog.py`,
// and a drift test pins that mirror. This module does not reimplement any of
// it. What it adds on top is the part a 78-row list needs and a 4-row list did
// not: accent folding, the raw tag and the family name as search keys, the
// ordering, and the grouping.
//
// `entryMatchesQuery` therefore DELEGATES to `languageEntryMatchesQuery` first
// and only then tries its own folded keys, so any rule added to the catalog
// matcher keeps working here without this file being touched.

import { contentDirection, contentScript } from "./content-direction.js";
import {
  describeLanguage,
  languageEntryMatchesQuery,
} from "./language-catalog.js";
import {
  languageDisplayName,
  normalizeContentLanguage,
} from "./zpage-language.js";

/** Where a creator's recently-used content languages are remembered. */
export const RECENT_LANGUAGES_STORAGE_KEY = "free2z-recent-content-languages";

/** How many recent languages are kept, and floated to the top of the list. */
export const RECENT_LANGUAGES_LIMIT = 5;

/**
 * Case- and accent-insensitive search text.
 *
 * Someone looking for "Français" types "francais", and someone looking for
 * "Español" types "espanol". NFD splits a precomposed letter into its base and
 * its combining mark, the mark is dropped, and the result is lowercased. NFC at
 * the end keeps the output a normal string for any caller that compares it to
 * something else.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function foldSearchText(value) {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .normalize("NFC")
    .toLowerCase()
    .trim();
}

/**
 * The script a tag is written in, or null.
 *
 * `content-direction.js`, not a fourth implementation: an explicit
 * script subtag wins, `und`/`mul`/`zxx` stay unknown rather than being
 * maximized into a confident `Latn`, and there is a fallback map for tags CLDR
 * cannot place.
 *
 * @param {string} tag
 * @returns {string | null}
 */
export function languageScript(tag) {
  return contentScript(tag);
}

/**
 * Which way this language's own text runs: `"rtl"` or `"ltr"`.
 *
 * Two existing implementations, and this deliberately adds no third. The
 * endpoint's `text_direction` wins, because the server is the side that can be
 * corrected without a frontend release. Otherwise `contentDirection` from
 * 's `content-direction.js` — the richest of the local answers: explicit
 * script subtag first, `und` left unknown, a fallback map behind CLDR.
 * (`language-catalog.js` also exports a `languageDirection`; it is the one the
 * offline *seed* is built with and mirrors the server's table. Worth
 * consolidating the two into one primitive, and not in this PR.)
 *
 * Never null here, unlike `contentDirection`. A direction is an attribute
 * value on a `<bdi>`, and "I do not know" there means "inherit the surrounding
 * LTR list" — which is exactly the reordering the isolation exists to stop.
 *
 * @param {string} tag
 * @param {unknown} [served] the endpoint's `text_direction` for this tag
 * @returns {"rtl" | "ltr"}
 */
export function languageDirection(tag, served = null) {
  if (served === "rtl" || served === "ltr") return served;
  return contentDirection(tag) ?? "ltr";
}

/**
 * What distinguishes this tag from its bare primary subtag, named in the
 * viewer's locale: `"Simplified"` for `zh-Hans`, `"Brazil"` for `pt-BR`.
 *
 * Null when the tag IS its primary subtag, or when CLDR cannot name the
 * qualifier — in which case the caller falls back to the full display name
 * rather than inventing one out of the subtag.
 *
 * @param {string} tag
 * @param {string} viewerLocale
 * @returns {string | null}
 */
export function languageQualifier(tag, viewerLocale) {
  /** @type {string[]} */
  let parts;
  try {
    parts = new Intl.Locale(tag).toString().split("-");
  } catch {
    return null;
  }
  if (parts.length < 2) return null;

  const locales = [viewerLocale || "en", "en"];
  /** @type {string[]} */
  const pieces = [];
  for (const part of parts.slice(1)) {
    const type =
      part.length === 4
        ? "script"
        : /^([A-Za-z]{2}|\d{3})$/.test(part)
          ? "region"
          : null;
    if (!type) continue;
    try {
      const name = new Intl.DisplayNames(locales, {
        type,
        fallback: "none",
      }).of(part);
      // `fallback: "none"` gives undefined for a subtag CLDR cannot name; some
      // engines echo the subtag, which is the thing that must never print.
      if (name && name !== part) pieces.push(name);
    } catch {
      // An engine without this DisplayNames type contributes nothing.
    }
  }
  return pieces.length ? pieces.join(" — ") : null;
}

/**
 * The name of a bare primary subtag, for a group heading.
 *
 * NOT `languageDisplayName`: that one applies the product's regional defaults,
 * so it answers `pt` with "Brazilian Portuguese" — which is the correct name of
 * the tag we store for bare `pt`, and a wrong, actively misleading heading over
 * a group containing `pt-PT`. A heading names the language; the rows under it
 * name the variants.
 *
 * Null when CLDR cannot name it, which drops the heading rather than printing
 * the subtag.
 *
 * @param {string} primary
 * @param {string} viewerLocale
 * @returns {string | null}
 */
export function primaryLanguageName(primary, viewerLocale) {
  try {
    const name = new Intl.DisplayNames([viewerLocale || "en", "en"], {
      type: "language",
      fallback: "none",
    }).of(primary);
    return name && name !== primary ? name : null;
  } catch {
    return null;
  }
}

/**
 * Accept-Language, in preference order, as plain tags.
 *
 * Takes either the raw header (`"fr-CA,fr;q=0.9,en;q=0.8"`) or an already
 * ordered list (`navigator.languages`). `*` is dropped: it means "anything",
 * which floats nothing. Ties keep the order they were written in, because a
 * browser emits its own preference order and re-sorting equal q-values would
 * discard it.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export function parseAcceptLanguage(value) {
  /** @type {{ tag: string, q: number, index: number }[]} */
  const parsed = [];

  /** @type {string[]} */
  let items;
  if (Array.isArray(value)) {
    items = value.filter((entry) => typeof entry === "string");
  } else if (typeof value === "string") {
    items = value.split(",");
  } else {
    return [];
  }

  items.forEach((item, index) => {
    const [range, ...params] = String(item).split(";");
    const tag = range.trim();
    if (!tag || tag === "*") return;
    let q = 1;
    for (const param of params) {
      const match = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(param);
      if (!match) continue;
      const parsedQ = Number.parseFloat(match[1]);
      if (Number.isFinite(parsedQ)) q = parsedQ;
    }
    if (q <= 0) return;
    parsed.push({ tag, q, index });
  });

  return parsed
    .sort((a, b) => b.q - a.q || a.index - b.index)
    .map((entry) => entry.tag);
}

/**
 * The subset of `available` the viewer most likely reads, most likely first.
 *
 * BCP-47 range matching, widened deliberately: an `en-GB` preference matches a
 * stored `en`, and a bare `fr` preference matches every French variant on
 * offer. Unlike `resolveContentLanguageRange`, which must pick exactly one
 * variant to render and returns null when two are equally good, this may return
 * several — they are suggestions, and offering both `pt-BR` and `pt-PT` to
 * someone whose browser said `pt` is the useful answer.
 *
 * @param {unknown} accepted raw header, or an ordered list of tags
 * @param {readonly string[]} available
 * @returns {string[]}
 */
export function preferredLanguages(accepted, available) {
  const pool = (Array.isArray(available) ? available : []).filter(
    (tag) => typeof tag === "string" && tag.length > 0,
  );
  /** @type {string[]} */
  const ordered = [];
  const seen = new Set();

  for (const range of parseAcceptLanguage(accepted)) {
    const canonical = normalizeContentLanguage(range);
    if (!canonical) continue;
    const primary = canonical.split("-", 1)[0].toLowerCase();

    const exact = pool.filter(
      (tag) => (normalizeContentLanguage(tag) ?? tag) === canonical,
    );
    const related = pool.filter(
      (tag) =>
        (normalizeContentLanguage(tag) ?? tag)
          .split("-", 1)[0]
          .toLowerCase() === primary,
    );
    for (const tag of [...exact, ...related]) {
      if (seen.has(tag)) continue;
      seen.add(tag);
      ordered.push(tag);
    }
  }
  return ordered;
}

/**
 * Everything a creator might type to find this language, pre-folded.
 *
 * The raw tag is in here on purpose: someone who knows `pt-PT` should be able
 * to type `pt-PT`. That is the one place a tag is legitimately part of the UI —
 * as an *input*, matched against, never rendered back as prose.
 *
 * @param {string} tag
 * @param {string} viewerLocale
 * @param {{ name?: string | null, autonym?: string | null } | null} [described]
 * @returns {string[]}
 */
export function languageSearchKeys(tag, viewerLocale, described = null) {
  // Falling back rather than dropping the keys: a caller that does not have a
  // described entry to hand must still get the engine's own name and autonym,
  // or the row silently stops being findable by the text it displays.
  const names = described ?? describeLanguage(tag, viewerLocale);
  const canonical = normalizeContentLanguage(tag) ?? tag;
  const primary = canonical.split("-", 1)[0].toLowerCase();
  return [
    tag,
    canonical,
    canonical.replace(/-/g, " "),
    // The RENDERED name and autonym, which may have come from the server —
    // a language only the catalog can name must be findable by the text the
    // creator can see.
    names?.name ?? null,
    names?.autonym ?? null,
    languageDisplayName(tag, "en"),
    languageQualifier(tag, viewerLocale),
    // The group heading, so "Portuguese" finds `pt-BR` even in a viewer locale
    // whose name for it does not contain the family name as a substring.
    primaryLanguageName(primary, viewerLocale),
    primaryLanguageName(primary, "en"),
  ]
    .filter(
      /** @returns {value is string} */ (value) =>
        typeof value === "string" && value.length > 0,
    )
    .map(foldSearchText)
    .filter((value, index, all) => value && all.indexOf(value) === index);
}

/**
 * Does this entry match what was typed?
 *
 * The catalog's rule first — it is the one that knows about server-supplied
 * names, and delegating means a change there reaches the picker without this
 * file being edited. Then this module's folded keys, which is what adds
 * accent-insensitivity, the raw tag and the family name.
 *
 * **Be clear about what that first call buys today: nothing a test can see.**
 * The folded keys already include the served name and autonym, so the catalog
 * matcher's current behaviour is a strict subset of theirs — stubbing the
 * delegation out turns no test red, and that was checked rather than assumed.
 * It stays because it is the seam  pinned on purpose: the next rule added
 * there (a synonym table, a transliteration) reaches the picker without this
 * file being touched, and the alternative is a colleague's assertion quietly
 * ceasing to describe the code.
 *
 * @param {{ language?: string, name?: string | null, autonym?: string | null,
 *           keys: readonly string[] }} entry
 * @param {string} query
 * @param {string} [viewerLocale]
 * @returns {boolean}
 */
export function entryMatchesQuery(entry, query, viewerLocale = "en") {
  const needle = foldSearchText(query);
  if (!needle) return true;
  if (
    entry.language &&
    languageEntryMatchesQuery(
      /** @type {{ language: string, name?: string | null, autonym?: string | null }} */ (
        entry
      ),
      query,
      viewerLocale,
    )
  ) {
    return true;
  }
  return entry.keys.some((key) => key.includes(needle));
}

/**
 * One nameable language, with everything a row needs to render.
 *
 * @typedef {object} LanguageEntry
 * @property {string} language the tag, exactly as it is stored
 * @property {string} name the localized name — never a tag, never empty
 * @property {string | null} autonym the name in its own language
 * @property {string | null} qualifier what distinguishes it inside its group
 * @property {"rtl" | "ltr"} direction the direction the autonym runs
 * @property {string | null} script the likely script subtag
 * @property {string} primary the primary subtag, which is the group key
 * @property {string[]} keys folded search keys
 */

/**
 * What the SERVER said about a tag, as the catalog endpoint returns it.
 *
 * @typedef {object} ServedLanguage
 * @property {string | null} [name]
 * @property {string | null} [autonym]
 * @property {"ltr" | "rtl"} [direction] the endpoint's `text_direction`
 */

/**
 * Describe one tag for a row, or null when nobody can name it.
 *
 * Naming is `language-catalog.js`'s `describeLanguage`: this engine's CLDR data
 * first, the served name as the fallback. That fallback is the whole point of
 *  without it a language is visible only if the browser has heard of it,
 * so serving 78 languages would still need a client that knows all 78, and on
 * an engine with a trimmed ICU build most of the list disappears.
 *
 * @param {string} language
 * @param {string} viewerLocale
 * @param {ServedLanguage | null} [served]
 * @returns {LanguageEntry | null}
 */
export function describeLanguageEntry(language, viewerLocale, served = null) {
  if (typeof language !== "string" || !language) return null;
  const described = describeLanguage(language, viewerLocale, served);
  // The  gate, and the reason this returns null rather than a placeholder:
  // a language with no name does not render at all.
  if (typeof described.name !== "string" || !described.name) return null;
  const canonical = normalizeContentLanguage(language) ?? language;
  return {
    language,
    name: described.name,
    autonym: described.autonym,
    qualifier: languageQualifier(language, viewerLocale),
    direction: languageDirection(canonical, served?.direction),
    script: languageScript(canonical),
    primary: canonical.split("-", 1)[0].toLowerCase(),
    keys: languageSearchKeys(language, viewerLocale, described),
  };
}

/**
 * A rendered section of the list.
 *
 * @typedef {object} LanguageSection
 * @property {string} id stable, and unique across sections
 * @property {"suggested" | "recent" | "language" | "typed"} kind
 * @property {string | null} label the group heading, or null for no heading
 * @property {LanguageEntry[]} entries
 */

/**
 * Build the list: suggestions first, then one group per language.
 *
 * ### Why grouping is by primary subtag, and why that is the teaching
 *
 * `zh-Hans` and `zh-Hant` are ONE language written two ways — a script choice.
 * `yue-Hant` is a DIFFERENT language that happens to use the same script as one
 * of them. Grouping on the primary subtag says exactly that and nothing else:
 * Simplified and Traditional sit under one "Chinese" heading as two ways to
 * write it, and Cantonese stands on its own line as its own language. A
 * grouping keyed on script would have put `zh-Hant` and `yue-Hant` together and
 * taught the opposite.
 *
 * A group heading only appears where the group has more than one entry, because
 * a heading over a single row is noise. `shared` is computed BEFORE the query
 * filter, so filtering a group down to one row does not strip the heading and
 * leave a row reading "Simplified" with nothing saying what of.
 *
 * @param {object} input
 * @param {readonly string[]} input.languages every tag to offer
 * @param {string} [input.viewerLocale]
 * @param {unknown} [input.accepted] Accept-Language header or ordered list
 * @param {readonly string[]} [input.recent] the creator's recent languages
 * @param {string} [input.query]
 * @param {ReadonlyMap<string, ServedLanguage> | null} [input.served] what the
 *   catalog endpoint said about these tags
 * @returns {LanguageSection[]}
 */
export function buildLanguageSections({
  languages,
  viewerLocale = "en",
  accepted = null,
  recent = [],
  query = "",
  served = null,
}) {
  /** @type {LanguageEntry[]} */
  const entries = [];
  const seen = new Set();
  for (const language of Array.isArray(languages) ? languages : []) {
    if (seen.has(language)) continue;
    const entry = describeLanguageEntry(
      language,
      viewerLocale,
      served?.get(language) ?? null,
    );
    if (!entry) continue;
    seen.add(language);
    entries.push(entry);
  }

  /** @type {Map<string, LanguageEntry>} */
  const byTag = new Map(entries.map((entry) => [entry.language, entry]));
  const offered = entries.map((entry) => entry.language);

  // The viewer's own languages first, then the ones this creator keeps
  // reaching for. Both are suggestions about the SAME list, so a language may
  // legitimately appear twice on screen; the section id keeps the two rows
  // distinct for `aria-activedescendant`.
  /** @type {LanguageEntry[]} */
  const suggested = [];
  const suggestedSeen = new Set();
  for (const tag of [
    ...preferredLanguages(accepted, offered),
    ...(Array.isArray(recent) ? recent : []),
  ]) {
    const entry = byTag.get(tag);
    if (!entry || suggestedSeen.has(tag)) continue;
    suggestedSeen.add(tag);
    suggested.push(entry);
  }

  /** @type {Map<string, LanguageEntry[]>} */
  const groups = new Map();
  for (const entry of entries) {
    const bucket = groups.get(entry.primary);
    if (bucket) bucket.push(entry);
    else groups.set(entry.primary, [entry]);
  }

  const collator = new Intl.Collator(viewerLocale || "en", {
    sensitivity: "base",
  });

  /** @type {LanguageSection[]} */
  const sections = [];

  const matching = suggested.filter((entry) =>
    entryMatchesQuery(entry, query, viewerLocale),
  );
  if (matching.length) {
    sections.push({
      id: "suggested",
      kind: "suggested",
      label: null,
      entries: matching,
    });
  }

  /** @type {{ key: string, label: string | null, entries: LanguageEntry[], sortOn: string }[]} */
  const built = [];
  for (const [primary, bucket] of groups) {
    const shared = bucket.length > 1;
    const heading = shared ? primaryLanguageName(primary, viewerLocale) : null;
    const visible = bucket
      .filter((entry) => entryMatchesQuery(entry, query, viewerLocale))
      .sort((a, b) => collator.compare(a.name, b.name));
    if (!visible.length) continue;
    built.push({
      key: primary,
      // A group whose own heading CLDR cannot name renders its rows with their
      // full names instead of a qualifier under an unnamed heading.
      label: heading,
      entries: visible,
      sortOn: heading || visible[0].name,
    });
  }
  built.sort((a, b) => collator.compare(a.sortOn, b.sortOn));

  for (const group of built) {
    sections.push({
      id: `language:${group.key}`,
      kind: "language",
      label: group.label,
      entries: group.entries,
    });
  }

  return sections;
}

/**
 * Flatten sections into the navigable option list, with an id per row.
 *
 * The id has to include the section because the suggestions repeat rows that
 * also appear in their language group, and `aria-activedescendant` points at
 * exactly one element.
 *
 * @param {readonly LanguageSection[]} sections
 * @returns {{ id: string, section: LanguageSection, entry: LanguageEntry }[]}
 */
export function flattenSections(sections) {
  /** @type {{ id: string, section: LanguageSection, entry: LanguageEntry }[]} */
  const flat = [];
  for (const section of sections) {
    for (const entry of section.entries) {
      flat.push({
        id: optionDomId(section.id, entry.language),
        section,
        entry,
      });
    }
  }
  return flat;
}

/**
 * A DOM id for one row. Tags and section keys are `[A-Za-z0-9-]`, so the only
 * character needing a substitution is the `:` in a section id.
 *
 * @param {string} sectionId
 * @param {string} language
 * @returns {string}
 */
export function optionDomId(sectionId, language) {
  return `lp-${sectionId.replace(/[^A-Za-z0-9-]/g, "_")}-${language.replace(
    /[^A-Za-z0-9-]/g,
    "_",
  )}`;
}

/**
 * The row an exactly-typed tag names, or null.
 *
 * Typing a code is a documented way to use this picker, and substring search
 * does not respect it: "Af-**fr**-ikaans" contains `fr`, sorts first, and so a
 * creator who types `fr` and presses Enter relabels their article Afrikaans.
 * `es` lands on Burmese the same way. An exactly-typed tag therefore takes the
 * cursor, whatever else the substring matched. Found by the codex review on
 *.
 *
 * Comparison is on the CANONICAL form on both sides, so `PT_pt` finds the row
 * stored as `pt-PT`.
 *
 * @param {readonly { id: string, language: string }[]} options
 * @param {string} query
 * @returns {string | null} the option id
 */
export function exactTagOptionId(options, query) {
  const tag = normalizeContentLanguage(query);
  if (!tag) return null;
  const hit = (Array.isArray(options) ? options : []).find(
    (option) =>
      (normalizeContentLanguage(option.language) ?? option.language) === tag,
  );
  return hit ? hit.id : null;
}

/**
 * Where the arrow keys move next, wrapping at both ends.
 *
 * Wrapping is what the combobox pattern specifies, and it is also what makes
 * `End` reachable on a 50-row list without a second key.
 *
 * @param {number} current index, or -1 for "nothing active"
 * @param {number} delta
 * @param {number} length
 * @returns {number} the new index, or -1 when there is nothing to move to
 */
export function nextActiveIndex(current, delta, length) {
  if (length <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : length - 1;
  return (((current + delta) % length) + length) % length;
}

/**
 * Read the creator's recent content languages out of storage.
 *
 * Tolerant by construction: this is a convenience ordering, and a corrupt or
 * unavailable `localStorage` must degrade to "no suggestions", never to a
 * picker that throws on open. Every value is re-validated on read, because what
 * is in storage was written by an older build of this code.
 *
 * @param {Storage | null} [storage]
 * @returns {string[]}
 */
export function readRecentLanguages(storage) {
  const store = storage ?? safeLocalStorage();
  if (!store) return [];
  try {
    const raw = store.getItem(RECENT_LANGUAGES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    /** @type {string[]} */
    const out = [];
    for (const value of parsed) {
      if (typeof value !== "string") continue;
      if (!normalizeContentLanguage(value)) continue;
      if (out.includes(value)) continue;
      out.push(value);
      if (out.length >= RECENT_LANGUAGES_LIMIT) break;
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Remember one language as most-recently-used, and return the new list.
 *
 * @param {string} language
 * @param {Storage | null} [storage]
 * @returns {string[]}
 */
export function rememberRecentLanguage(language, storage) {
  if (!normalizeContentLanguage(language)) return readRecentLanguages(storage);
  const store = storage ?? safeLocalStorage();
  const next = [
    language,
    ...readRecentLanguages(store).filter((tag) => tag !== language),
  ].slice(0, RECENT_LANGUAGES_LIMIT);
  if (store) {
    try {
      store.setItem(RECENT_LANGUAGES_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Private mode, a full quota, or a blocked third-party context. The
      // ordering is a nicety; losing it is not worth an exception on the way
      // out of a picker the creator just used successfully.
    }
  }
  return next;
}

/**
 * `localStorage`, or null where there isn't one. Accessing the property itself
 * throws in a blocked context, so the guard has to be a try/catch.
 *
 * @returns {Storage | null}
 */
function safeLocalStorage() {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * The viewer's languages as the browser states them, or null on the server.
 *
 * @returns {readonly string[] | null}
 */
export function browserAcceptLanguages() {
  try {
    if (typeof navigator === "undefined") return null;
    if (Array.isArray(navigator.languages) && navigator.languages.length) {
      return navigator.languages;
    }
    return navigator.language ? [navigator.language] : null;
  } catch {
    return null;
  }
}
