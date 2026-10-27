// Text direction, script and line-breaking class for a CONTENT language.
//
// We have been selling AI translations into `ar`, `he`, `fa` and `ur` while
// the zPage content container had no `dir` at all:  taught the reader
// route to render the variant and to declare it in `lang`, and stopped one
// attribute short. A reader who pays for an Arabic translation gets Arabic
// text laid out left-to-right, with the punctuation on the wrong end of every
// sentence. That is the defect this module exists for (item 5).
//
// Three things are deliberately true here.
//
// 1. **Direction comes from the SCRIPT, never from a list of languages.**
//    `az-Arab` is right-to-left and `az-Latn` is not; `pa-Arab` (Shahmukhi) is
//    and `pa-Guru` (Gurmukhi) is not; `ku`/`ckb` splits the same way. A
//    language→direction table is wrong for every one of those the first time
//    someone stores the other script, and it is wrong silently. The script is
//    read off the tag when it is spelled out, and inferred through CLDR's
//    likely-subtags otherwise — the same `Intl.Locale#maximize()` that
//    `zpage-language.js` already resolves language ranges with, so the two
//    cannot disagree about what `zh-TW` is written in.
//
// 2. **This is the CONTENT axis, and only the content axis.** The product
//    chrome's direction belongs to the UI locale and is 's to own
//    ( §2 principle 8): an English-reading visitor looking at an Arabic
//    variant must get an RTL article body inside an LTR page. So nothing here
//    ever touches `<html dir>` — the answer is applied to the article
//    container, the headline and the description, and stops there.
//
// 3. **It answers `null` rather than guessing**, because `null` is the honest
//    answer to a question about a FACT: "which way does this script run" has no
//    answer for a language nobody has identified. `"auto"` is not a direction at
//    all — it is a rendering instruction, meaningful only in HTML/CSS. The Django
//    crawler tier, an OG-image renderer, a PDF and an email have no bidi
//    heuristic to hand it to, so giving them `"auto"` forces a translation back
//    and the obvious wrong one is `ltr`.
//
//    The three live surfaces also want three different unknown-policies: the
//    reader wants `dir="auto"` so the parser reads the text, `<html>` must get
//    NOTHING (asserted in `content-bidi.spec.ts`), and an image renderer wants
//    its own. One primitive cannot serve all three, so the policy lives in
//    `contentDirectionAttribute` (`zpage-language.js`) and this stays a fact.
//
//    **An earlier version of this comment justified `null` by claiming
//    `dir="auto"` on an unlabelled article "would flip whole-page-wide". That is
//    false and worth stating plainly, because the conclusion survived the wrong
//    reason:** `dir` inherits DOWNWARD only and cannot affect an ancestor, and
//    the chrome sits outside the article container — so `auto` there would flip
//    that container and nothing else. The real argument is the one above.

/**
 * Scripts written right-to-left, by ISO 15924 code.
 *
 * Sourced from the script metadata CLDR publishes (`scriptMetadata.json`,
 * `rtl: YES`), not from the four languages we happen to sell today. The
 * historic ones cost nothing and mean this set does not have to be revisited
 * every time `TRANSLATABLE` grows: `ps`, `sd`, `ckb`, `dv`, `ug`, `yi` and
 * `nqo` are all already correct here, and none of them is named. `TRANSLATABLE`
 * then grew 39 -> 78 and gained `ps` with no edit here, which is the argument
 * made rather than asserted.
 *
 * **The invariant is not "this list is right" — it is "both tiers agree with one
 * oracle."** A hand-added entry that CLDR contradicts is how two implementations
 * drift apart, and that drift IS. So `tests/text-direction.test.mjs`
 * checks EVERY entry against `Intl.Locale.prototype.getTextInfo()`, and an
 * exception has to earn itself with stated evidence.
 *
 * That check removed `Todr` (Todhri), which was here on the assumption that a
 * historic script is a safe guess. It is not: `Intl.Locale("und-Todr")`
 * maximizes to `sq-Todr-AL` — a REAL answer, about Todhri in Albanian — and says
 * `ltr`, so `sq-Todr` content was being right-aligned. A wrong entry mis-renders
 * content exactly as surely as a missing one ( codex review, round 2).
 *
 * `Aran`, `Syre`, `Syrj` and `Syrn` are the opposite case and stay: they all
 * maximize to `en-<script>-US`, meaning CLDR has no likely language for the
 * subtag and ICU is answering about ENGLISH rather than about the script. They
 * are Nastaliq and the three Syriac variants, all right-to-left. The test
 * asserts that `^en-` maximization for each, so the exemption list cannot become
 * a place to silence the oracle — `Todr` could never have been exempted by it.
 *
 * If someone later has real evidence Todhri is right-to-left, add it back WITH
 * that evidence and an upstream CLDR note. Do not leave it silently disagreeing
 * with ICU in one of two runtimes.
 *
 * @type {ReadonlySet<string>}
 */
export const RTL_SCRIPTS = new Set([
  "Adlm",
  "Arab",
  "Aran",
  "Armi",
  "Avst",
  "Chrs",
  "Cprt",
  "Elym",
  "Gara",
  "Hatr",
  "Hebr",
  "Hung",
  "Khar",
  "Lydi",
  "Mand",
  "Mani",
  "Mend",
  "Merc",
  "Mero",
  "Narb",
  "Nbat",
  "Nkoo",
  "Orkh",
  "Ougr",
  "Palm",
  "Phli",
  "Phlp",
  "Phnx",
  "Prti",
  "Rohg",
  "Samr",
  "Sarb",
  "Sidt",
  "Sogd",
  "Sogo",
  "Syrc",
  "Syre",
  "Syrj",
  "Syrn",
  "Thaa",
  "Yezi",
]);

/**
 * Scripts that do not put a space between words.
 *
 * `th`, `lo`, `km` and `my` . CJK is deliberately absent: Han,
 * Kana and Hangul have no inter-word spaces either, but every engine breaks
 * them per-character by default and that is the correct rendering, so they
 * need no help. These four need a dictionary, and the browser only reaches for
 * one when the CSS has not already told it that breaking anywhere is fine.
 *
 * @type {ReadonlySet<string>}
 */
export const NO_SPACE_SCRIPTS = new Set(["Thai", "Laoo", "Khmr", "Mymr"]);

/**
 * Last-resort primary-subtag → script map.
 *
 * Only reachable when `Intl.Locale#maximize()` cannot answer — a runtime built
 * without CLDR's likely-subtags data, which `maximize()` then satisfies by
 * returning the tag unchanged rather than by throwing. Every entry here is a
 * language whose *unqualified* form we sell or expect to sell; a tag that
 * spells its script out never reaches this map, so `az-Latn` cannot be
 * mis-served by an `az` entry (there is none, on purpose — bare `az` is Latin
 * and needs no entry at all).
 *
 * @type {Readonly<Record<string, string>>}
 */
const FALLBACK_SCRIPTS = Object.freeze({
  ar: "Arab",
  arz: "Arab",
  ary: "Arab",
  ckb: "Arab",
  dv: "Thaa",
  fa: "Arab",
  he: "Hebr",
  ks: "Arab",
  ku: "Latn",
  nqo: "Nkoo",
  ps: "Arab",
  sd: "Arab",
  ug: "Arab",
  ur: "Arab",
  yi: "Hebr",
  // The no-space four, for the same reason.
  th: "Thai",
  lo: "Laoo",
  km: "Khmr",
  my: "Mymr",
});

/**
 * Primary subtags that name no language, so they can name no script either.
 * @type {ReadonlySet<string>}
 */
const NON_LANGUAGE_PRIMARY_SUBTAGS = new Set(["und", "mul", "zxx", "mis"]);

/** Cache: one `Intl.Locale` construction + maximize per distinct tag. */
const scriptCache = new Map();

/**
 * Title-case an ISO 15924 subtag the way BCP-47 canonicalizes it.
 *
 * @param {string} value
 * @returns {string}
 */
function titleCaseScript(value) {
  return value[0].toUpperCase() + value.slice(1).toLowerCase();
}

/**
 * The script a piece of content in `tag` is written in, or null.
 *
 * An explicit script subtag always wins; otherwise CLDR's likely script for
 * the tag; otherwise the fallback map above; otherwise null.
 *
 * @param {unknown} tag a BCP-47 language tag
 * @returns {string | null} an ISO 15924 code (`"Arab"`), or null
 */
export function contentScript(tag) {
  if (typeof tag !== "string") return null;
  const trimmed = tag.trim();
  if (!trimmed) return null;
  const cached = scriptCache.get(trimmed);
  if (cached !== undefined) return cached;

  const resolved = resolveScript(trimmed);
  scriptCache.set(trimmed, resolved);
  return resolved;
}

/**
 * @param {string} tag
 * @returns {string | null}
 */
function resolveScript(tag) {
  // `_` is what a hand-written tag and some clients use; `normalizeContentLanguage`
  // already rewrites it, but this module is also called with raw values from
  // `Accept-Language`-shaped input and must not be the thing that differs.
  const normalized = tag.replace(/_/g, "-");
  const subtags = normalized.split("-");

  // Spelled out: `az-Arab`, `pa-Guru`, `zh-Hant`. This is the case a
  // language→direction table gets wrong, so it is answered FIRST and without
  // consulting anything that could disagree — including the `und` guard below.
  //
  // The order matters in both directions. `und-Arab` is a STATEMENT that the
  // text is in Arabic script, not an inference about an unknown language, so
  // it must not be swallowed by the sentinel check. And `en-Arab-x` is a tag
  // `Intl.Locale` rejects outright (a dangling singleton), where the script
  // subtag is nonetheless unambiguous: without this branch the `catch` below
  // falls through to a map that has no `en` entry and the answer is `null`.
  // Those two are what make this branch load-bearing rather than a faster path
  // to the same answer — on a runtime that has CLDR's likely-subtags data,
  // `Intl.Locale("az-Arab").maximize().script` already says `Arab`.
  if (subtags.length > 1 && /^[A-Za-z]{4}$/.test(subtags[1])) {
    return titleCaseScript(subtags[1]);
  }

  // `und` is the "original, language unknown" sentinel this codebase still
  // stores, and `Intl.Locale("und").maximize().script` is `"Latn"` — a
  // confident answer to a question nobody asked. Same for `mul`/`zxx`/`mis`.
  // Mirrors `NON_LANGUAGE_PRIMARY_SUBTAGS` in `zpage-language.js`; unknown has
  // to stay unknown or point 3 in the header comment is not true.
  if (NON_LANGUAGE_PRIMARY_SUBTAGS.has(subtags[0].toLowerCase())) return null;

  try {
    const locale = new Intl.Locale(normalized);
    // `maximize()` is where `zh-TW` -> `Hant`, `sr` -> `Cyrl`, `ur` -> `Arab`
    // and `az` -> `Latn` come from: CLDR's likely subtags, the same data
    // `zpage-language.js` resolves a language range against.
    const script = locale.maximize().script || locale.script;
    if (script) return titleCaseScript(script);
  } catch {
    // A tag `Intl.Locale` refuses tells us nothing about its script.
  }

  const primary = subtags[0].toLowerCase();
  return FALLBACK_SCRIPTS[primary] || null;
}

/**
 * The text direction of content written in `tag`.
 *
 * Null — not `"ltr"` — when the language is unknown, so a caller can omit the
 * attribute entirely and leave today's inherited direction in place rather
 * than asserting something it cannot know.
 *
 * @param {unknown} tag a BCP-47 language tag
 * @returns {"rtl" | "ltr" | null}
 */
export function contentDirection(tag) {
  const script = contentScript(tag);
  if (!script) return null;
  return RTL_SCRIPTS.has(script) ? "rtl" : "ltr";
}

/**
 * Does content in `tag` need a dictionary to find its line breaks?
 *
 * True for Thai, Lao, Khmer and Burmese.
 *
 * **UNUSED by product code — called only from `tests/content-direction.test.mjs`
 * ( review).** The docstring used to say "see `MarkdownContent.svelte`",
 * pointing at a CSS change that was never made, and 's own browser test
 * measured that change as unnecessary: the engines break these scripts
 * acceptably without it. So this is a correct function with no caller and a
 * reference to code that does not exist, which is the shape that reads as
 * already-wired.
 *
 * Kept rather than deleted because it is someone else's landed work and removing
 * an export is a decision, not a cleanup — but it is deliberately **not mirrored
 * into `py/f2z/languages.py`**: carrying an unused table across a tier boundary
 * doubles the thing that can drift while nothing consumes either copy. Wire it up
 * or delete it; do not propagate it.
 *
 * @param {unknown} tag
 * @returns {boolean}
 */
export function usesNoSpaceScript(tag) {
  const script = contentScript(tag);
  return script !== null && NO_SPACE_SCRIPTS.has(script);
}
