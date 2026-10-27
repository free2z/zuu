import { DEFAULT_LOCALE, LANGUAGE_OPTIONS, normalizeLocale } from "./locale.js";
import { contentDirection, contentScript } from "./content-direction.js";

export const TRANSLATION_SOURCE_LANGUAGE_HEADER = "X-Free2Z-Source-Language";

// ---------------------------------------------------------------------------
// Content languages
//
// `normalizeLocale` answers a different question: "which of the four PRODUCT-UI
// locales is this?" A zPage's *content* language is not that ( §2 principle
// 8, §3.3). an article can be written in `ja`, and the four-locale
// assumption is exactly why an API-created Japanese variant is invisible in the
// editor today.
//
// These helpers follow the language rules in `py/f2z/languages.py`, the
// canonical registry. The API catalog is authoritative when it is available;
// the seed below is only an offline fallback and may lag behind it.
// ---------------------------------------------------------------------------

/**
 * Primary subtags that are not a language.
 *
 * `und` is the sentinel this whole issue exists to delete, and CLDR *does*
 * have a display name for it ("Unknown language"), so `Intl.DisplayNames` will
 * happily dress it up as prose unless it is rejected first. `mul`, `zxx` and
 * `mis` are the same class of non-answer. Mirrors `_REJECTED_SCOPES`.
 */
const NON_LANGUAGE_PRIMARY_SUBTAGS = new Set(["und", "mul", "zxx", "mis"]);

/**
 * Product overrides applied to bare subtags. Mirrors `_REGIONAL_DEFAULTS` in
 * `py/f2z/languages.py`, and it has to stay an exact mirror: the two runtimes
 * both turn a `?lang=` value into a variant lookup, so a tag that normalizes
 * differently here serves one URL as two languages.
 *
 * `pt` -> `pt-BR` because every stored Portuguese row is `pt-BR`; `pt-PT` is
 * deliberately left alone. `yue` -> `yue-Hant`  is the same mechanism
 * applied to a script: written Cantonese is overwhelmingly traditional, and
 * `yue-Hant` is the sellable tag. Bare `zh` is deliberately NOT defaulted —
 * the Python module docstring has the reasoning.
 *
 * @type {Readonly<Record<string, string>>}
 */
const REGIONAL_DEFAULTS = Object.freeze({ pt: "pt-BR", yue: "yue-Hant" });

/** IANA well-formedness, same shape check the Python registry applies. */
const TAG_SHAPE = /^[A-Za-z0-9]{1,8}(-[A-Za-z0-9]{1,8})*$/;

/**
 * Canonicalize a **content** language tag, or null when the value is not a
 * language anyone can write an article in.
 *
 * Null is the load-bearing return: every caller must render a name or render
 * nothing. Printing a raw subtag at a human is the  defect.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function normalizeContentLanguage(value) {
  if (typeof value !== "string") return null;

  const trimmed = value.trim().replace(/_/g, "-");
  if (!trimmed || !TAG_SHAPE.test(trimmed)) return null;

  /** @type {string | undefined} */
  let canonical;
  try {
    [canonical] = Intl.getCanonicalLocales(trimmed);
  } catch {
    return null;
  }
  if (!canonical) return null;

  const primary = canonical.split("-", 1)[0].toLowerCase();
  if (NON_LANGUAGE_PRIMARY_SUBTAGS.has(primary)) return null;
  // Private use (`qaa`..`qtz`) means whatever the sender decided.
  if (/^q[a-t][a-z]$/.test(primary)) return null;
  if (primary === "x" || primary === "i") return null;
  // A singleton subtag opens an extension or private-use section: `-x-draft`,
  // `-u-ca-buddhist`, `-t-…`. None of them names a different language, the
  // Python registry rejects them, and accepting one here would let a `?lang=`
  // value through that every subsequent save then 400s on.
  if (/(^|-)[0-9A-Za-z](-|$)/.test(canonical)) return null;

  // Only a BARE subtag takes the product default. `pt-PT` already names its
  // region, and relabelling a Portuguese creator's article as Brazilian would
  // be the mislabel this issue exists to stop.
  return canonical === primary
    ? (REGIONAL_DEFAULTS[canonical] ?? canonical)
    : canonical;
}

/**
 * The name of a language, written in the viewer's UI locale — or null.
 *
 * CLDR (via `Intl.DisplayNames`) names ~every language, which is what makes a
 * ~50-language picker possible without shipping a translation table. The
 * four-entry `LANGUAGE_OPTIONS` autonyms remain the last resort so the UI
 * locales still read correctly on an engine with a trimmed ICU build.
 *
 * @param {unknown} code
 * @param {string} [viewerLocale]
 * @returns {string | null}
 */
export function languageDisplayName(code, viewerLocale = DEFAULT_LOCALE) {
  const tag = normalizeContentLanguage(code);
  if (!tag) return null;

  try {
    const name = new Intl.DisplayNames(
      [viewerLocale || DEFAULT_LOCALE, DEFAULT_LOCALE],
      { type: "language", fallback: "none" },
    ).of(tag);
    // `fallback: "none"` returns undefined for a tag CLDR cannot name; some
    // engines echo the tag instead, which is the thing we must never print.
    if (name && name !== tag) return name;
  } catch {
    // A malformed viewer locale, or an engine without DisplayNames.
  }

  const option = LANGUAGE_OPTIONS.find((entry) => entry.code === tag);
  return option ? option.label : null;
}

/**
 * The name of a language written in that language ("Español"), or null.
 * Used only as a secondary search key and a subtitle in the picker.
 *
 * @param {unknown} code
 * @returns {string | null}
 */
export function languageAutonym(code) {
  const tag = normalizeContentLanguage(code);
  if (!tag) return null;
  return languageDisplayName(tag, tag);
}

/**
 * Languages we will seed the AI-translation picker with when the catalog is
 * unavailable. The API's catalog is authoritative, so this offline fallback
 * may lag behind `TRANSLATABLE` in `py/f2z/languages.py`.
 *
 * Ordered because this one drives a picker.
 *
 * This is a *fallback and superset seed*, never the whole truth: whatever
 * languages the API reports for an article are always listed too, so a variant
 * created outside this set (the `ja` case in ) is still visible.
 */
export const TRANSLATABLE_LANGUAGES = Object.freeze([
  "af",
  "am",
  "ar",
  "az",
  "bg",
  "bn",
  "ca",
  "cs",
  "da",
  "de",
  "el",
  "en",
  "es",
  "et",
  "eu",
  "fa",
  "fi",
  "fil",
  "fr",
  "gl",
  "gu",
  "ha",
  "he",
  "hi",
  "hr",
  "ht",
  "hu",
  "hy",
  "id",
  "ig",
  "is",
  "it",
  "ja",
  "ka",
  "kk",
  "km",
  "kn",
  "ko",
  "lo",
  "lt",
  "lv",
  "mk",
  "ml",
  "mn",
  "mr",
  "ms",
  "my",
  "nb",
  "ne",
  "nl",
  "nn",
  "pa",
  "pl",
  "ps",
  "pt-BR",
  "pt-PT",
  "ro",
  "ru",
  "si",
  "sk",
  "sl",
  "so",
  "sq",
  "sr",
  "sv",
  "sw",
  "ta",
  "te",
  "th",
  "tr",
  "uk",
  "ur",
  "uz",
  "vi",
  "yo",
  "yue-Hant",
  "zh-Hans",
  "zh-Hant",
  "zu",
]);

/**
 * The editor URL for one of the four PRODUCT-UI locales, and a throw for
 * anything else.
 *
 * **Legacy.** `editorVariantHref` is the content-language form and is what new
 * code wants: the editor route itself has accepted any content language since
 *. This one is kept because its throw is still the right answer for a
 * caller that genuinely means "one of the four", and a test pins that.
 *
 * @param {string | null | undefined} identifier @param {string} language
 */
export function editorTranslationHref(identifier, language) {
  const locale = normalizeLocale(language);
  if (!locale) throw new Error("Unsupported zpage language");
  const query = new URLSearchParams({ lang: locale });
  if (identifier) query.set("id", identifier);
  return `/edit?${query.toString()}`;
}

/**
 * Link to the exact variant being read. Canonical source content, including
 * legacy `und`, deliberately has no language query.
 *
 * Built with `editorVariantHref`, which accepts any CONTENT language and never
 * throws. It used to build with `editorTranslationHref`, which throws for
 * anything outside the four UI locales — and this is a link rendered on the
 * reader page, so with 's fix in place and nothing else, opening a
 * published `zh-Hans` article **500ed the whole page** from inside
 * `PageActions`. A link is not worth an error page: a language the editor
 * cannot address degrades to the canonical `/edit?id=` instead.
 *
 * @param {string | null | undefined} identifier
 * @param {string | null | undefined} actualLanguage
 * @param {string | null | undefined} sourceLanguage
 */
export function editorArticleHref(identifier, actualLanguage, sourceLanguage) {
  if (
    actualLanguage &&
    actualLanguage !== "und" &&
    actualLanguage !== sourceLanguage
  ) {
    return editorVariantHref(identifier, actualLanguage);
  }
  const query = new URLSearchParams();
  if (identifier) query.set("id", identifier);
  return query.size ? `/edit?${query.toString()}` : "/edit";
}

/**
 * The public URL of one *content* variant of an article.
 *
 * `normalizeContentLanguage`, never `normalizeLocale`: the tag names the
 * language the article is written in, which has nothing to do with the four
 * locales the product UI is translated into. Routing it through the UI-locale
 * normalizer is  — `zh-Hans` came back `null`, the link was never built,
 * and a published translation was unreachable from anywhere in the product.
 *
 * Still throws for a value that is not a language at all (`und`, `x-private`,
 * a typo): a `?lang=` the API will reject is worse than no link.
 *
 * @param {string} pathname
 * @param {string} language
 * @param {readonly string[] | null | undefined} [availableLanguages]
 */
export function articleTranslationHref(pathname, language, availableLanguages) {
  const tag = normalizeContentLanguage(language);
  if (!tag) throw new Error("Unsupported zpage language");
  const base = pathname.split(/[?#]/, 1)[0];
  // Keep an exact stored tag when it identifies an API row. The API matches
  // `?lang=` exactly, while normalization may fold aliases such as `cmn` to
  // `zh`; emitting the folded form would point at a different variant.
  const stored = (availableLanguages || []).find(
    (candidate) =>
      candidate === language && normalizeContentLanguage(candidate),
  );
  return `${base}?${new URLSearchParams({ lang: stored ?? tag })}`;
}

/**
 * The article's variants as canonical, linkable content-language tags, in the
 * order the API listed them.
 *
 * This used to be membership of `SUPPORTED_LOCALES` — the four locales the
 * *product UI* is translated into — which meant a published `zh-Hans`
 * translation was never advertised in `hreflang`, never listed in the
 * sitemap's cluster, and had no `rel=alternate` anywhere a crawler could find
 * it. An `hreflang` needs a valid BCP-47 tag, not a tag we happen to
 * ship a navbar in.
 *
 * Normalization is used to VALIDATE and to de-duplicate exact stored tags,
 * never to rewrite them. Distinct stored aliases remain distinct because the
 * API serves exact tags: ICU rewrites `cmn` to `zh`, and advertising
 * `?lang=zh` for a row stored as `cmn` targets a different variant. Values that
 * name no language at all (`und`, `mul`, private use) are dropped, exactly as
 * before, and script and region are never collapsed (`pt-PT` stays European,
 * `zh-Hans` stays distinct from `zh-Hant`).
 *
 * @param {readonly string[] | null | undefined} availableLanguages
 * @returns {string[]}
 */
function linkableLanguages(availableLanguages) {
  /** @type {string[]} */
  const named = [];
  /** @type {Set<string>} */
  const seen = new Set();
  for (const language of availableLanguages || []) {
    const tag = normalizeContentLanguage(language);
    if (!tag || seen.has(language)) continue;
    seen.add(language);
    // The stored spelling, not `tag`.
    named.push(typeof language === "string" ? language : tag);
  }
  return named;
}

/**
 * Resolve a requested language *range* against the variants an article
 * actually has — RFC 4647 "lookup", plus one deliberate extension.
 *
 * The API requires an EXACT tag: `GET /api/zpage/<id>/?lang=zh` on an article
 * whose only Chinese variant is `zh-Hans` serves the *source* language and
 * says so in `actual_language`. A reader who types, shares, or is sent
 * `?lang=zh` is asking for Chinese, and there is exactly one Chinese text to
 * give them, so answering in English is a defect, not a policy.
 *
 * The rules, in order:
 *
 * 1. **Exact tag wins.** `zh-Hans` asked for, `zh-Hans` served.
 * 2. **Progressive truncation of the RANGE** (RFC 4647 lookup): `zh-Hans-CN`
 *    falls back to `zh-Hans`, never sideways to `zh-Hant`. A truncated match
 *    is still subject to rule 3's script constraint — plain lookup would match
 *    the range `sr-Latn` to a variant tagged `sr`, which CLDR says is
 *    Cyrillic, and hand a Latin-script reader Cyrillic text with nothing said
 *    about it. The standard's algorithm does not know about scripts;
 *    is about exactly that gap.
 * 3. **One, and only one, variant sharing the primary subtag — and never
 *    across a script.** This is the extension: strict lookup never
 *    *lengthens* a range, so `zh` would match nothing at all. `zh` on an
 *    article whose only Chinese variant is `zh-Hans` resolves to it, and `pt`
 *    with only a `pt-PT` variant resolves to that. But a range that implies a
 *    script is never answered with a different script: `zh-Hant`, and equally
 *    `zh-TW`, resolve to nothing on a Simplified-only article, because
 *    Simplified and Traditional are not substitutes. A differing
 *    *region* within one script is tolerated — `pt-BR` and `pt-PT` are both
 *    Latin.
 *
 *    **The script is the LIKELY script, not the written one.** `zh-TW` and
 *    `zh-CN` are the most common hand-written Chinese tags and neither spells
 *    a script out, so a guard that reads only an explicit subtag does not fire
 *    for exactly the tags range resolution exists to serve: a `zh-TW` reader
 *    was handed Simplified, silently, with `<html lang="zh-Hans">` and no
 *    disclosure. CLDR's likely-subtags answers what the tag means, and ICU and
 *    the Python registry agree on it tag for tag — the golden table pins that.
 * 4. **Ambiguity is never guessed.** An article carrying both `zh-Hans` and
 *    `zh-Hant` resolves `zh` to `null`: the caller keeps whatever the API
 *    served, the disclosure says so, and the switcher offers both. Serving
 *    Simplified to a reader who may have meant Traditional is the failure
 *    mode of, and a silent wrong answer is worse than a visible choice.
 *
 * Returns null — never throws, never a 4xx — for anything it cannot resolve,
 * so a junk `?lang=` degrades to the canonical view instead of breaking a page.
 *
 * @param {unknown} requestedLanguage
 * @param {readonly unknown[] | null | undefined} availableLanguages
 * @returns {string | null}
 */
export function resolveContentLanguageRange(
  requestedLanguage,
  availableLanguages,
) {
  const tag = normalizeContentLanguage(requestedLanguage);
  if (!tag) return null;

  const variants = linkableLanguages(
    /** @type {readonly string[] | null | undefined} */ (availableLanguages),
  );
  if (variants.length === 0) return null;

  const script = requestedScript(tag);
  // Only a CONFLICT excludes: a bare `zh` request constrains nothing and still
  // matches `zh-Hans` or `zh-Hant`, whichever the article has.
  /** @param {string} variant */
  const agrees = (variant) => {
    const variantScript = contentScript(canonicalOf(variant));
    return !(script && variantScript && script !== variantScript);
  };

  // Comparison is on the CANONICAL form, the answer is the stored spelling.
  const subtags = tag.split("-");
  while (subtags.length) {
    const candidate = subtags.join("-");
    const exact = variants.find(
      (variant) => canonicalOf(variant) === candidate && agrees(variant),
    );
    if (exact) return exact;
    subtags.pop();
    // No singleton handling is needed: `normalizeContentLanguage` rejects a
    // tag with an extension or private-use section outright, so neither the
    // range nor a variant can contain one here.
  }

  const primary = tag.split("-", 1)[0];
  const matches = variants.filter(
    (variant) =>
      canonicalOf(variant).split("-", 1)[0] === primary && agrees(variant),
  );
  return matches.length === 1 ? matches[0] : null;
}

/**
 * The canonical form of a stored tag, or the tag itself if it has none.
 * @param {string} value
 * @returns {string}
 */
function canonicalOf(value) {
  return normalizeContentLanguage(value) ?? value;
}

/**
 * Which way the text of one *content* variant runs, or null when the article's
 * language is not known (legacy `und`, an unsaved draft, a value that names no
 * language at all).
 *
 * Null is the whole point, and a caller must not collapse it to `"ltr"`:
 * "unknown" and "left-to-right" produce different `dir` attributes. See
 * `contentDirectionAttribute`.
 *
 * @param {unknown} value a stored or requested content-language tag
 * @returns {"ltr" | "rtl" | null}
 */
export function contentLanguageDirection(value) {
  // Normalize FIRST, and treat the stored `und` sentinel as the non-answer it
  // is. `py/f2z/languages.text_direction` normalizes first for the same reason,
  // which is what makes the two runtimes one rule.
  const tag = value === "und" ? null : normalizeContentLanguage(value);
  return tag ? contentDirection(tag) : null;
}

/**
 * The `dir` attribute for an element whose text is one content variant.
 *
 * Three values, and each says something different:
 *
 * - `"rtl"` / `"ltr"` — we know the language, so we state the base direction
 *   outright. This is the answer `dir="auto"` gets WRONG in the case that
 *   matters here: "Zcash" and `2Z` open Arabic paragraphs all the time, and
 *   first-strong-character detection reads such a paragraph as left-to-right,
 *   left-aligns it, and misplaces its trailing punctuation. The language tag is
 *   metadata; a heuristic over the text is a guess, and W3C's own guidance is
 *   to prefer the metadata whenever it exists.
 * - `"auto"` — we do not know, so the browser reads the first strong character
 *   of the element's own text. Better than defaulting to the chrome's
 *   direction, and on a `<textarea>` it re-resolves live as the writer types,
 *   which is exactly right for a draft with no language label yet.
 *
 * Never null, never absent — and this is the ONE place  deliberately departs
 * from `contentDirection`, whose null means "omit the attribute and leave the
 * inherited direction alone". Do not simplify this away. `auto` is load-bearing
 * twice, and the second case has no other answer:
 *
 * - an unlabelled legacy article (`und`, or a null `source_language`) whose text
 *   is Hebrew inherits the chrome's left-to-right under omission, and renders
 *   correctly under `auto`;
 * - a brand-new editor draft has NO language label BY CONSTRUCTION, so `auto` is
 *   the only reason a creator typing Arabic gets a right-to-left writing surface
 *   before any label exists. See `writingLanguage` in `/edit`.
 *
 * So: `contentDirection` answers "what direction is this language", and this
 * answers "what goes in the attribute". Two questions, one implementation each.
 *
 * @param {unknown} value
 * @returns {"ltr" | "rtl" | "auto"}
 */
export function contentDirectionAttribute(value) {
  return contentLanguageDirection(value) ?? "auto";
}

/**
 * The script the REQUEST constrains the answer to, or null for "no preference".
 *
 * A bare primary subtag is the one case that constrains nothing: `?lang=zh`
 * means "Chinese", and it must still reach the single Chinese variant an
 * article has, whichever script that is — which is the case 's brief asked
 * for by name. Maximizing it instead would read `zh` as `zh-Hans` and refuse a
 * Traditional-only article. Anything more specific does constrain: `zh-Hant`
 * says so outright, and `zh-TW` says so through its region.
 *
 * A VARIANT is always maximized, including a bare one: a variant stored as `zh`
 * is concrete text, and CLDR's likely script is the best available statement of
 * what it is — so an explicit `zh-Hant` request is not silently handed it.
 *
 * The script itself comes from `./content-direction.js` (`contentScript`), which
 *  introduced for direction and which  then adopted rather than
 * shipping a second copy. ONE implementation, so a tag cannot be `Hant` for the
 * purpose of picking a variant and something else for the purpose of laying it
 * out — two implementations of one language question, disagreeing, is exactly
 *.
 *
 * Verified against the `Intl.Locale#maximize()` call this used to make. Over 161
 * tags they differ on FOUR, not on `und` alone as an earlier version of this
 * comment claimed (outside review): `und`, `zh_Hans`, `pt_br` and `en-Arab-x`.
 * Every one is provably unreachable here — `normalizeContentLanguage` runs first
 * and rejects the non-language, the underscore forms and the private-use
 * singleton — so the swap is inert rather than merely tested. Saying "the only
 * difference is `und`" was accurate about the golden tables and wrong about the
 * function, and the distinction matters if anyone ever moves these call sites
 * upstream of normalization. Null still means "no constraint known", never a
 * conflict.
 *
 * @param {string} tag
 * @returns {string | null}
 */
function requestedScript(tag) {
  return tag.includes("-") ? contentScript(tag) : null;
}

/**
 * Which language variant of an article to render.
 *
 * Lives here, next to `normalizeContentLanguage`, and NOT in `locale.js`: the
 * version that used to live there normalized both inputs with
 * `normalizeLocale`, so `?lang=zh-Hans` was `null` before the fetch was even
 * built and every reader of a Chinese translation silently got English
 *. An article's content language and the reader's UI language are
 * independent concepts, and the two normalizers are not interchangeable.
 *
 * An explicit `?lang=` always wins — that is the link readers share. With no
 * explicit choice the reader's own UI locale is the sensible default, so a
 * Spanish-reading visitor lands on the Spanish variant when one exists. The
 * answer is a tag, never null: it goes straight into the API query.
 *
 * @param {{ requestedLanguage?: unknown, uiLocale?: unknown }} choice
 * @returns {string}
 */
export function resolveArticleLanguage({ requestedLanguage, uiLocale }) {
  return (
    explicitArticleLanguage(requestedLanguage) ??
    normalizeContentLanguage(uiLocale) ??
    DEFAULT_LOCALE
  );
}

/**
 * Validate an explicit content-language selector and retain its stored alias
 * primary when ICU rewrites that primary (`cmn` -> `zh`, including suffixes).
 * Case, script and region formatting still come from ICU; invalid selectors
 * return null so callers keep their existing fallback behavior.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function explicitArticleLanguage(value) {
  const normalized = normalizeContentLanguage(value);
  if (!normalized || typeof value !== "string") return null;

  const raw = value.trim().replace(/_/g, "-");
  try {
    const canonical = Intl.getCanonicalLocales(raw)[0];
    if (!canonical) return normalized;
    const rawPrimary = raw.split("-", 1)[0].toLowerCase();
    const canonicalPrimary = canonical.split("-", 1)[0].toLowerCase();
    const rawSuffix = raw.slice(rawPrimary.length);
    // Only a PURE primary-subtag substitution is an alias the API may have
    // stored (`cmn-Hans` -> `zh-Hans`). A whole-tag mapping consumes or adds
    // subtags — `sgn-BR` -> `bzs`, `art-lojban` -> `jbo`, `zh-hakka` -> `hak`,
    // `prs` -> `fa-AF`, `sh` -> `sr-Latn` — and splicing the raw primary back
    // onto it names a different language (`sgn`, `art`, `zh`) or an invalid
    // one. Those keep the normalized answer, exactly as the crawler tier's
    // `_explicit_content_language` does. Known residual: a deprecated primary
    // (`iw`, `eng`, `tl`) keeps its raw spelling here where Python answers
    // `he`; the API's own `languages.normalize` folds it to the same row.
    if (
      rawPrimary !== canonicalPrimary &&
      raw.split("-").length === canonical.split("-").length &&
      Intl.getCanonicalLocales(`${canonicalPrimary}${rawSuffix}`)[0] ===
        canonical
    ) {
      const suffix = canonical.slice(canonicalPrimary.length);
      return `${rawPrimary}${suffix}`;
    }
  } catch {
    // Validation above already rejected malformed values.
  }
  return normalized;
}

/**
 * The variant to ask the API for on a SECOND pass, or null when the first
 * answer stands.
 *
 * `available_languages` is the only place the variant list exists, and it
 * arrives *with* the response — so a range like `zh` can only be resolved
 * after one fetch has come back. This is what turns that into at most one
 * extra request, and only when the first answer was not what was asked for.
 *
 * @param {{
 *   askedLanguage?: unknown,
 *   actualLanguage?: unknown,
 *   availableLanguages?: readonly unknown[] | null,
 * }} response
 * @returns {string | null}
 */
export function variantLanguageRetry({
  askedLanguage,
  actualLanguage,
  availableLanguages,
}) {
  const asked = normalizeContentLanguage(askedLanguage);
  if (!asked) return null;
  const actual = normalizeContentLanguage(actualLanguage);
  // The API served exactly what was asked for: nothing to improve on.
  if (actual && actual === asked) return null;

  const resolved = resolveContentLanguageRange(asked, availableLanguages);
  // Unresolvable or ambiguous: keep the API's own fallback, which the
  // disclosure explains, and let the switcher offer the choice. "Already
  // asked" means the selector actually SENT: an alias (`cmn`) that found no
  // row must still retry the canonical spelling it folds to (`zh`), exactly
  // as it was served before aliases were preserved.
  const sent = typeof askedLanguage === "string" ? askedLanguage : asked;
  if (!resolved || resolved === sent) return null;
  // Already serving it (the API's fallback happened to land on the range's one
  // match), so a second fetch would return the same bytes.
  if (actual && resolved === actual) return null;
  return resolved;
}

/**
 * Whether — and how — to tell a reader that they are looking at a fallback
 * variant rather than the language they asked for.
 *
 * Moved here from `locale.js` with. It used to name both languages with
 * `languageLabel(normalizeLocale(...))`, a lookup in the four-entry product-UI
 * table, so the one reader this note exists for — someone who asked for a
 * language the article does not have — was told nothing whenever either side
 * fell outside those four. A reader who asks for Chinese and is served English
 * must be told, in Chinese's name, not left to wonder.
 *
 * Returns localized language *names*, never tags, and null far more often than
 * not. The rules, from:
 *
 * - the backend must say it fell back (`fallback_used`, trustworthy  *   stopped an unknown source language counting as a fallback);
 * - both sides must be genuine languages we can NAME — if CLDR has no name for
 *   one of them, say nothing rather than print a subtag;
 * - and the mismatch must be one the reader can make sense of: they asked for
 *   a language explicitly, or this article visibly offers a choice. Otherwise
 *   the note fires on every English-only article for every reader whose UI is
 *   not English, which is the noise that got the  banner removed.
 *
 * @param {{
 *   fallbackUsed?: unknown,
 *   requestedLanguage?: unknown,
 *   actualLanguage?: unknown,
 *   reflectsReaderChoice?: unknown,
 *   viewerLocale?: string,
 * }} response
 * @returns {{ requested: string, shown: string } | null}
 */
export function resolveFallbackDisclosure({
  fallbackUsed,
  requestedLanguage,
  actualLanguage,
  reflectsReaderChoice,
  viewerLocale = DEFAULT_LOCALE,
}) {
  if (!fallbackUsed || !reflectsReaderChoice) return null;

  const requested = languageDisplayName(requestedLanguage, viewerLocale);
  const shown = languageDisplayName(actualLanguage, viewerLocale);
  if (!requested || !shown || requested === shown) return null;

  return { requested, shown };
}

/**
 * Which language, if any, the query-free article URL *is*.
 *
 * The clean URL has no language in it: the server negotiates one from the
 * visitor's locale cookie, falling back to the source variant when that
 * language has no published variant (`resolve_zpage_variant`). So it is a
 * language-neutral URL, and the only safe answer once an article has more than
 * one variant is "none" — two visitors get two different bodies from it. That
 * is precisely what `x-default` is for, and why no named `hreflang` may point
 * at it in that case.
 *
 * When exactly one variant exists there is nothing to negotiate: every visitor
 * gets that one, so the clean URL genuinely *is* that language's URL. This is
 * the overwhelmingly common case, and it is why an untranslated article keeps
 * the clean canonical it has today rather than sprouting `?lang=en`.
 *
 * The one answer drives both `rel=canonical` and `rel=alternate`. When they
 * disagree — an `hreflang="es"` pointing at a URL whose own canonical says
 * English — search engines discard the whole language cluster, and it takes a
 * recrawl to get back.
 *
 * With no variant list at all (legacy callers) the source keeps the clean URL,
 * which is the historical behavior.
 *
 * @param {readonly string[] | null | undefined} availableLanguages
 * @param {string | null | undefined} sourceLanguage
 * @returns {string | null}
 */
export function cleanUrlLanguage(availableLanguages, sourceLanguage) {
  // Count EVERY variant, not just the ones we can name: an unnamed `und`
  // source is still something the clean URL can negotiate down to.
  const variants = new Set(
    (availableLanguages || []).filter((value) => typeof value === "string"),
  );
  if (variants.size > 1) return null;
  // A cookieless visitor asks for the default locale; the API serves that
  // variant when it exists and the source otherwise.
  if (variants.has(DEFAULT_LOCALE)) return DEFAULT_LOCALE;
  // The source may be any content language — `zh-Hans`, `pt-PT`, `ja` — and a
  // single-variant article in one of them still owns its clean URL. The old
  // `normalizeLocale` here answered "no language at all" for every tag outside
  // the four UI locales, which is how a Chinese-only article ended up
  // advertising nothing.
  const normalized = normalizeContentLanguage(sourceLanguage);
  if (!normalized) return null;
  return typeof sourceLanguage === "string" && variants.has(sourceLanguage)
    ? sourceLanguage
    : normalized;
}

/**
 * @param {string} canonical
 * @param {string | null | undefined} actualLanguage
 * @param {string | null | undefined} sourceLanguage
 * @param {readonly string[] | null | undefined} [availableLanguages]
 */
export function articleCanonicalHref(
  canonical,
  actualLanguage,
  sourceLanguage,
  availableLanguages,
) {
  const actual = normalizeContentLanguage(actualLanguage || "");
  if (!actual) return canonical.split(/[?#]/, 1)[0];
  // The clean URL is this variant's canonical only when the clean URL serves
  // this variant. Otherwise the variant canonicalizes to its own `?lang=` URL.
  const actualStored =
    typeof actualLanguage === "string" &&
    availableLanguages?.includes(actualLanguage)
      ? actualLanguage
      : actual;
  if (actualStored === cleanUrlLanguage(availableLanguages, sourceLanguage)) {
    return canonical.split(/[?#]/, 1)[0];
  }
  return articleTranslationHref(
    canonical,
    typeof actualLanguage === "string" ? actualLanguage : actual,
    availableLanguages,
  );
}

/**
 * `rel="alternate"` targets for every language variant of an article, ending
 * with the `x-default` entry.
 *
 * `x-default` is the query-free article URL. That URL does not name a
 * language: it negotiates one from the visitor's locale, which is exactly what
 * `x-default` is defined to point at — the entry a search engine uses when
 * none of the listed languages matches the searcher. Without it a
 * Japanese-speaking searcher gets whichever alternate the engine guesses at.
 *
 * Every *named* language must resolve to that language for every visitor and
 * be that URL's own canonical, or the hreflang set contradicts the content and
 * the whole cluster gets thrown away. `?lang=` URLs satisfy that by
 * construction — an explicit request beats the locale cookie — so once an
 * article has two variants every language gets one. Only a single-variant
 * article, where nothing can be negotiated, keeps the clean URL as its named
 * alternate; `cleanUrlLanguage` is the shared answer, and `articleCanonicalHref`
 * uses the same one. Languages we cannot name (`und`, anything outside the
 * supported set) are skipped rather than emitted as a bogus `hreflang`.
 *
 * @param {string | null | undefined} canonical
 * @param {readonly string[] | null | undefined} availableLanguages
 * @param {string | null | undefined} sourceLanguage
 * @returns {{ hreflang: string, href: string }[]}
 */
export function articleLanguageAlternates(
  canonical,
  availableLanguages,
  sourceLanguage,
) {
  if (!canonical) return [];

  const base = canonical.split(/[?#]/, 1)[0];
  const named = linkableLanguages(availableLanguages);
  if (named.length === 0) return [];

  const cleanUrlOwner = cleanUrlLanguage(availableLanguages, sourceLanguage);
  const alternates = named.map((language) => ({
    hreflang: language,
    href:
      language === cleanUrlOwner
        ? base
        : articleTranslationHref(base, language, availableLanguages),
  }));

  alternates.push({ hreflang: "x-default", href: base });
  return alternates;
}

/** @param {string} responseLanguage @param {string} selectedLanguage */
export function isCurrentTranslationResponse(
  responseLanguage,
  selectedLanguage,
) {
  return responseLanguage === selectedLanguage;
}

/**
 * @param {string | null | undefined} actualLanguage
 * @param {string | null | undefined} requestedLanguage
 */
export function isRequestedVariantMissing(actualLanguage, requestedLanguage) {
  return Boolean(
    actualLanguage && requestedLanguage && actualLanguage !== requestedLanguage,
  );
}

/**
 * The nested variant resource used for both writes and deletes.
 * @param {string} identifier @param {string} language
 */
export function translationVariantUrl(identifier, language) {
  return `/api/zpage/${encodeURIComponent(identifier)}/translations/${encodeURIComponent(language)}/`;
}

/**
 * The only three outcomes a language switch may offer when work is unsaved —
 * the same three every other navigation in the editor offers. "discard" is the
 * one that used to be missing, which is what turned the article-language
 * `<select>` into a soft lock: the editor refused to move until a save
 * succeeded, and refused to save an empty body.
 */
export const LANGUAGE_SWITCH_CHOICES = Object.freeze([
  "save",
  "discard",
  "cancel",
]);

/**
 * What switching to `nextLanguage` should do right now.
 *
 * - `"none"` — already there.
 * - `"relabel"` — nothing is persisted yet, so the language is only the label
 *   this draft will be created with. Change it in place.
 * - `"prompt"` — unsaved work exists; ask save / discard / cancel.
 * - `"switch"` — nothing is at stake, just go.
 *
 * @param {{ currentLanguage?: string | null, nextLanguage?: string | null,
 *           isDirty?: boolean, isSaving?: boolean, isNewPage?: boolean }} state
 * @returns {{ action: "none" | "relabel" | "prompt" | "switch" }}
 */
export function planLanguageSwitch({
  currentLanguage,
  nextLanguage,
  isDirty = false,
  isSaving = false,
  isNewPage = false,
} = {}) {
  if (!nextLanguage || nextLanguage === currentLanguage) {
    return { action: "none" };
  }

  if (isNewPage) {
    // An unsaved draft exists only in this tab. Reloading it would blank text
    // stored nowhere else, and offering to "discard" would mark never-saved
    // text clean. Neither is right: just change the label.
    return { action: "relabel" };
  }

  if (isDirty || isSaving) {
    return { action: "prompt" };
  }

  return { action: "switch" };
}

/**
 * Split the language surface into what the article already has and what it
 * does not. The picker navigates only between languages that exist (plus the
 * blank variant currently open, so the control never shows a stale value);
 * everything else has to be started through an explicitly labelled action, so
 * a `<select>` change can never blank the editor by surprise.
 *
 * @param {{ sourceLanguage?: string | null,
 *           availableLanguages?: readonly string[],
 *           selectedLanguage?: string | null,
 *           supportedLanguages?: readonly string[],
 *           isNewPage?: boolean }} state
 */
export function editorLanguageMenu({
  sourceLanguage,
  availableLanguages = [],
  selectedLanguage,
  supportedLanguages = [],
  isNewPage = false,
} = {}) {
  if (isNewPage) {
    // Nothing is persisted yet, so every supported language is simply the
    // label this draft would be created with.
    return { existing: [...supportedLanguages], missing: [] };
  }

  /** @type {string[]} */
  const existing = [];
  for (const code of [
    sourceLanguage,
    ...availableLanguages,
    selectedLanguage,
  ]) {
    if (code && !existing.includes(code)) existing.push(code);
  }

  return {
    existing,
    missing: supportedLanguages.filter((code) => !existing.includes(code)),
  };
}

// ---------------------------------------------------------------------------
// The translation manager ( Part 7)
// ---------------------------------------------------------------------------

// Variant URLs are NOT built here. `/variants/` landed in the OpenAPI schema
// with, so orval generates `zpageVariantsList` / `zpageVariantsRetrieve`
// / `zpageVariantsUpdate` / `zpageVariantsDestroy` in `$lib/api/zpage/zpage`,
// and those are what the editor calls. A hand-rolled path is how a client
// drifts away from a contract without CI ever noticing.

/**
 * The editor URL for one variant. Unlike `editorTranslationHref` this accepts
 * any *content* language, so a `ja` variant is reachable.
 *
 * @param {string | null | undefined} identifier @param {string} language
 */
export function editorVariantHref(identifier, language) {
  const tag = normalizeContentLanguage(language);
  const query = new URLSearchParams();
  if (tag) query.set("lang", tag);
  if (identifier) query.set("id", identifier);
  return query.size ? `/edit?${query.toString()}` : "/edit";
}

/**
 * The public article URL for one variant, for any content language.
 *
 * @param {string} pathname @param {string | null | undefined} language
 */
export function articleVariantHref(pathname, language) {
  const base = pathname.split(/[?#]/, 1)[0];
  const tag = normalizeContentLanguage(language);
  return tag ? `${base}?${new URLSearchParams({ lang: tag })}` : base;
}

/**
 * Below this, the chip offers its soft "is this right?".
 *
 * Mirrors `CONFIDENCE_DISPLAY_THRESHOLD` in `py/f2z/ai/language.py`, which the
 * detector documents as the caller policy — and it matters that the two agree
 * exactly: the detector emits precisely `0.75` for a 40-199 character sample,
 * so a threshold of `0.75` with a `<` comparison would silently exclude the
 * entire short-document bucket, which is the bucket most likely to be wrong.
 * A test asserts the two constants match.
 */
export const CONFIDENCE_DISPLAY_THRESHOLD = 0.8;

/**
 * What the language chip should say.
 *
 * Three states and no fourth: a named language, "detecting", or — for a
 * brand-new draft with nothing to detect from — the label the draft will be
 * created with. There is deliberately no branch that renders a tag.
 *
 * `lowConfidence` is a soft "is this right?" affordance, never a blocker
 * ( Part 5). It is only ever true for a value the *detector* chose: a
 * creator's own answer is never second-guessed.
 *
 * @param {{
 *   sourceLanguage?: unknown,
 *   detectedLanguage?: unknown,
 *   detectionConfidence?: unknown,
 *   languageSource?: unknown,
 *   confidenceThreshold?: number,
 * }} state
 * @returns {{ language: string | null, state: "known" | "detecting",
 *             lowConfidence: boolean, isDetected: boolean }}
 */
export function languageChipState({
  sourceLanguage,
  detectedLanguage,
  detectionConfidence,
  languageSource,
  confidenceThreshold = CONFIDENCE_DISPLAY_THRESHOLD,
} = {}) {
  const language =
    normalizeContentLanguage(sourceLanguage) ??
    normalizeContentLanguage(detectedLanguage);

  // `language_source` is only present once the backend ships it. Absent, an
  // article that has a language at all is treated as the creator's own answer
  // the conservative reading, because it is the one that stays quiet.
  const isDetected = languageSource === "detected";

  return {
    language,
    state: language ? "known" : "detecting",
    isDetected,
    lowConfidence: Boolean(
      language &&
      isDetected &&
      typeof detectionConfidence === "number" &&
      Number.isFinite(detectionConfidence) &&
      detectionConfidence < confidenceThreshold,
    ),
  };
}

/**
 * `language` is the tag we can NAME; `navigateAs` is the tag the editor
 * navigates and writes with. They differ in exactly one case: a legacy `und`
 * source, which has no display name but is still a real, openable variant. Any
 * row action must use `navigateAs`, or the Edit button on that row is a no-op.
 *
 * @typedef {{
 *   language: string,
 *   navigateAs: string,
 *   status: "source" | "published" | "draft" | "written" | "not-started",
 *   isStale: boolean,
 *   origin: "source" | "human" | "ai" | null,
 *   isSource: boolean,
 *   exists: boolean,
 *   canDelete: boolean,
 * }} VariantRow
 */

/**
 * The rows of the Translations panel.
 *
 * Two inputs, in priority order:
 *
 * 1. `variants` — `GET /api/zpage/{id}/variants/`, the real answer, with
 *    per-variant `is_published`, `origin` and `is_stale`.
 * 2. `sourceLanguage` + `availableLanguages` — everything the zPage read
 *    serializer has always exposed. Used when the variants endpoint is not
 *    deployed yet, and it genuinely cannot know whether a translation is
 *    published, so those rows say "written" rather than guessing.
 *
 * **`is_stale` is never computed here.** Every backfilled translation carries a
 * NULL `source_digest`, so anything derived locally would flag ~100% of them —
 * the false-positive rate that got 's fallback banner deleted. Only an
 * explicit `true` from the API is stale.
 *
 * @param {{
 *   variants?: readonly any[] | null,
 *   sourceLanguage?: unknown,
 *   availableLanguages?: readonly unknown[],
 *   selectedLanguage?: unknown,
 *   isPublished?: boolean,
 *   hasSource?: boolean,
 * }} state
 * @returns {VariantRow[]}
 */
export function buildVariantRows({
  variants = null,
  sourceLanguage,
  availableLanguages = [],
  selectedLanguage,
  isPublished = false,
  hasSource = false,
} = {}) {
  const source = normalizeContentLanguage(sourceLanguage);
  /** @type {Map<string, VariantRow>} */
  const rows = new Map();

  /**
   * @param {unknown} rawLanguage
   * @param {{ origin?: "source" | "human" | "ai" | null,
   *           isStale?: unknown, isPublished?: boolean | undefined }} fields
   */
  const add = (rawLanguage, fields) => {
    const language = normalizeContentLanguage(rawLanguage);
    // A language we cannot name has no row: it would render as a subtag.
    if (!language || rows.has(language)) return;
    const isSource = Boolean(source) && language === source;
    rows.set(language, {
      language,
      navigateAs: language,
      isSource,
      exists: true,
      origin: isSource ? "source" : (fields.origin ?? null),
      // Only an explicit `true` is stale, and the source is never stale.
      isStale: !isSource && fields.isStale === true,
      status: isSource
        ? "source"
        : fields.isPublished === true
          ? "published"
          : fields.isPublished === false
            ? "draft"
            : "written",
      canDelete: !isSource,
    });
  };

  if (Array.isArray(variants)) {
    for (const variant of variants) {
      if (!variant || typeof variant !== "object") continue;
      add(variant.language, {
        origin: variant.origin ?? null,
        isStale: variant.is_stale,
        isPublished:
          typeof variant.is_published === "boolean"
            ? variant.is_published
            : undefined,
      });
    }
  }

  // The source always has a row, even when the endpoint has not answered yet.
  if (source) {
    add(source, { isPublished: isPublished });
  } else if (hasSource) {
    // A legacy `und` article, or one whose detection has not run yet. The
    // creator's own text is still the first thing this panel must account for
    // omitting it would make the article look like it had no original. The
    // empty tag is the "we cannot name this yet" marker; the panel renders it
    // as "Detecting…", never as a subtag.
    rows.set("", {
      language: "",
      // The raw stored tag, so "Edit" on this row really reopens the source.
      navigateAs: typeof sourceLanguage === "string" ? sourceLanguage : "",
      isSource: true,
      exists: true,
      origin: "source",
      isStale: false,
      status: "source",
      canDelete: false,
    });
  }

  for (const language of availableLanguages) {
    add(language, {});
  }

  // The variant currently open in the editor may not be written yet — the
  // explicit "write this language" path. Show it so the panel never disagrees
  // with what is on screen.
  const selected = normalizeContentLanguage(selectedLanguage);
  if (selected && !rows.has(selected)) {
    rows.set(selected, {
      language: selected,
      navigateAs: selected,
      isSource: false,
      exists: false,
      origin: null,
      isStale: false,
      status: "not-started",
      canDelete: false,
    });
  }

  return [...rows.values()].sort((a, b) => {
    if (a.isSource !== b.isSource) return a.isSource ? -1 : 1;
    return a.language.localeCompare(b.language);
  });
}

/**
 * Languages an article does not have yet, for the "add a translation" picker.
 *
 * The union of the curated `TRANSLATABLE_LANGUAGES` and anything extra the API
 * reported, minus what already exists — so a language outside the curated set
 * never disappears from the UI just because we do not sell it.
 *
 * @param {{ rows?: readonly VariantRow[], extraLanguages?: readonly unknown[],
 *           translatable?: readonly string[] }} state
 * @returns {string[]}
 */
export function untranslatedLanguages({
  rows = [],
  extraLanguages = [],
  translatable = TRANSLATABLE_LANGUAGES,
} = {}) {
  const taken = new Set(rows.map((row) => row.language));
  /** @type {string[]} */
  const available = [];
  for (const code of [...translatable, ...extraLanguages]) {
    const language = normalizeContentLanguage(code);
    if (!language || taken.has(language) || available.includes(language)) {
      continue;
    }
    available.push(language);
  }
  return available;
}

/**
 * Does this language match what the creator typed into the picker's search
 * box? Matched against the tag and every name we can produce for it, so
 * "Japanese", "日本語" and "ja" all find the same row.
 *
 * @param {string} language @param {string} query @param {string} viewerLocale
 */
export function languageMatchesQuery(language, query, viewerLocale) {
  const needle = String(query || "")
    .trim()
    .toLowerCase();
  if (!needle) return true;
  const haystacks = [
    language,
    languageDisplayName(language, viewerLocale),
    languageDisplayName(language, DEFAULT_LOCALE),
    languageAutonym(language),
  ];
  return haystacks.some(
    (value) =>
      typeof value === "string" && value.toLowerCase().includes(needle),
  );
}

/**
 * A translation may be deleted only when it exists and is not the article's
 * own source language — the same rule the backend enforces.
 *
 * @param {{ sourceLanguage?: string | null, selectedLanguage?: string | null,
 *           availableLanguages?: readonly string[], isNewPage?: boolean }} state
 */
export function canDeleteTranslationLanguage({
  sourceLanguage,
  selectedLanguage,
  availableLanguages = [],
  isNewPage = false,
} = {}) {
  return Boolean(
    !isNewPage &&
    selectedLanguage &&
    selectedLanguage !== "und" &&
    selectedLanguage !== sourceLanguage &&
    availableLanguages.includes(selectedLanguage),
  );
}
