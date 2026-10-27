// Reading an article in another language is a *content* choice, not a product
// preference. These guard the split ( P9) and the two reader-facing gaps
//  left open: no `x-default`, and no disclosure when the server had to
// fall back to a language the reader did not ask for.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveRequestLocale } from "../src/lib/locale.js";
import {
  articleCanonicalHref,
  articleLanguageAlternates,
  cleanUrlLanguage,
  explicitArticleLanguage,
  languageDisplayName,
  resolveArticleLanguage,
  resolveContentLanguageRange,
  resolveFallbackDisclosure,
  variantLanguageRetry,
} from "../src/lib/zpage-language.js";

const UI_ROOT = path.dirname(fileURLToPath(import.meta.url));
const source = (relativePath) =>
  fs.readFileSync(path.join(UI_ROOT, "..", relativePath), "utf8");

const ARTICLE_ROUTE = "/[username]/[vanity]";

const assertArticleEnrichmentWiring = (loader, enrichment) => {
  assert.match(
    loader,
    /loadArticleEnrichments\(\s*article,\s*fetch,\s*locale,\s*request\.signal,/,
    "the route must pass its UI locale and request signal into article enrichment",
  );
  assert.match(
    enrichment,
    /relatedArticles:\s*loadRelatedArticles\(\s*article,\s*eventFetch,\s*locale,\s*requestSignal,/,
    "related article links must use the UI locale and request signal",
  );
  assert.match(
    enrichment,
    /seriesContext:\s*loadSeriesContext\(\s*article,\s*eventFetch,\s*locale,\s*requestSignal,/,
    "series links must use the UI locale and request signal",
  );
};

// --- 1. the article language never re-skins the product UI -----------------

test("?lang= on an article route leaves the product UI locale alone", () => {
  for (const routeId of [ARTICLE_ROUTE, "/article/[id]"]) {
    assert.deepEqual(
      resolveRequestLocale({
        routeId,
        queryLocale: "es",
        cookieLocale: "en",
      }),
      { locale: "en", persisted: true },
    );
  }

  // No cookie either: the reader keeps the default UI, not the article's.
  assert.deepEqual(
    resolveRequestLocale({ routeId: ARTICLE_ROUTE, queryLocale: "fr" }),
    { locale: "en", persisted: false },
  );
});

test("?lang= still overrides the UI locale everywhere else", () => {
  assert.deepEqual(
    resolveRequestLocale({
      routeId: "/",
      queryLocale: "es",
      cookieLocale: "en",
    }),
    { locale: "es", persisted: true },
  );
  assert.deepEqual(
    resolveRequestLocale({ routeId: "/trending", queryLocale: "pt" }),
    { locale: "pt-BR", persisted: true },
  );
  // Unsupported, so it cannot select anything: fall through to the cookie.
  assert.deepEqual(
    resolveRequestLocale({
      routeId: "/creators",
      queryLocale: "de",
      cookieLocale: "fr",
    }),
    { locale: "fr", persisted: true },
  );
});

test("choosing an article language does not call setLocale", () => {
  const reader = source("src/routes/[username]/[vanity]/+page.svelte");
  assert.doesNotMatch(reader, /setLocale/);
  assert.match(
    reader,
    /function chooseArticleLanguage[\s\S]*?next\.searchParams\.set\("lang", language\)/,
  );
});

// --- 2. `?lang=` deep links still resolve ----------------------------------

test("an explicit ?lang= wins, and the UI locale is the default otherwise", () => {
  assert.equal(
    resolveArticleLanguage({ requestedLanguage: "es", uiLocale: "en" }),
    "es",
  );
  assert.equal(resolveArticleLanguage({ uiLocale: "fr" }), "fr");
  assert.equal(resolveArticleLanguage({ requestedLanguage: "pt" }), "pt-BR");
  // Nothing usable anywhere still yields a language, never undefined.
  assert.equal(
    resolveArticleLanguage({ requestedLanguage: "und", uiLocale: "und" }),
    "en",
  );
});

test("canonical lowercase ICU aliases retain their exact variant lookup", () => {
  // The API matches stored language tags exactly. Preserve canonical lowercase
  // ICU aliases so a link to a persisted `cmn` row does not become `?lang=zh`.
  for (const [alias, canonical] of [
    ["cmn", "cmn"],
    ["ajp", "ajp"],
    ["ajt", "ajt"],
    ["gom", "gom"],
  ]) {
    assert.equal(
      resolveArticleLanguage({ requestedLanguage: alias, uiLocale: "en" }),
      canonical,
    );
  }
  for (const [alias, stored] of [
    ["ajp-Latn", "ajp-Latn"],
    ["ajt-TN", "ajt-TN"],
    ["gom-IN", "gom-IN"],
  ]) {
    assert.equal(explicitArticleLanguage(alias), stored);
  }
  // Case-only canonicalization and product defaults keep their prior behavior.
  assert.equal(
    resolveArticleLanguage({ requestedLanguage: "CMN", uiLocale: "en" }),
    "cmn",
  );
  assert.equal(
    resolveArticleLanguage({ requestedLanguage: "pt", uiLocale: "en" }),
    "pt-BR",
  );
});

test("a content language survives ?lang= whatever case it was written in", () => {
  //, the whole defect in four lines: every one of these came back `null`
  // from the UI-locale normalizer, so the fetch asked for English and the
  // reader of a published Chinese translation got English.
  for (const requested of ["zh-Hans", "zh-hans", "ZH-HANS", "zh_Hans"]) {
    assert.equal(
      resolveArticleLanguage({ requestedLanguage: requested, uiLocale: "en" }),
      "zh-Hans",
      `?lang=${requested} must resolve to the Simplified Chinese variant`,
    );
  }
  // And the script subtag is never collapsed: these are two languages.
  assert.equal(
    resolveArticleLanguage({ requestedLanguage: "zh-Hant", uiLocale: "en" }),
    "zh-Hant",
  );
  // A language the product UI is not translated into is still readable.
  assert.equal(
    resolveArticleLanguage({ requestedLanguage: "ja", uiLocale: "en" }),
    "ja",
  );
  assert.equal(
    resolveArticleLanguage({ requestedLanguage: "pt-PT", uiLocale: "en" }),
    "pt-PT",
  );
});

test("a language RANGE resolves to the one variant that matches it", () => {
  // The API needs an exact tag: `?lang=zh` serves the SOURCE language, so
  // without this a reader who asks for Chinese quietly gets English.
  assert.equal(resolveContentLanguageRange("zh", ["en", "zh-Hans"]), "zh-Hans");
  assert.equal(resolveContentLanguageRange("zh", ["en", "zh-Hant"]), "zh-Hant");
  assert.equal(resolveContentLanguageRange("pt", ["en", "pt-PT"]), "pt-PT");
  // Exact always wins over the range rule.
  assert.equal(
    resolveContentLanguageRange("zh-Hant", ["zh-Hans", "zh-Hant"]),
    "zh-Hant",
  );
  assert.equal(resolveContentLanguageRange("en", ["en", "zh-Hans"]), "en");
  // RFC 4647 lookup truncates the RANGE, never sideways into another script.
  assert.equal(
    resolveContentLanguageRange("zh-Hans-CN", ["en", "zh-Hans"]),
    "zh-Hans",
  );
  //...but never sideways into another script: Traditional is not an answer
  // to a request for Simplified, in either direction.
  assert.equal(resolveContentLanguageRange("zh-Hans-CN", ["zh-Hant"]), null);
  assert.equal(resolveContentLanguageRange("zh-Hant", ["zh-Hans"]), null);
  // A differing REGION is fine — same writing system.
  assert.equal(resolveContentLanguageRange("pt-BR", ["en", "pt-PT"]), "pt-PT");
  assert.equal(resolveContentLanguageRange("en-GB", ["en-US"]), "en-US");
});

test("a region implies a script, and the guard has to see it", () => {
  // The hole the first version of this shipped with: `scriptSubtag` read only a
  // SPELLED-OUT script, and `zh-TW`/`zh-CN` — the commonest hand-written
  // Chinese tags, and exactly the ones range resolution exists to serve — name
  // none. Every row below served the wrong script silently, with `<html lang>`
  // claiming the wrong language and no disclosure (reviewer F1).
  assert.equal(resolveContentLanguageRange("zh-TW", ["en", "zh-Hans"]), null);
  assert.equal(resolveContentLanguageRange("zh-CN", ["en", "zh-Hant"]), null);
  //...in the other direction too: an explicitly Traditional request must not
  // be answered with a variant whose region makes it Simplified.
  assert.equal(resolveContentLanguageRange("zh-Hant", ["en", "zh-CN"]), null);
  assert.equal(resolveContentLanguageRange("zh-Hans", ["en", "zh-TW"]), null);

  // And the tags that DO agree still resolve, including the case a reader is
  // most likely to type by hand.
  assert.equal(
    resolveContentLanguageRange("zh-TW", ["en", "zh-Hant"]),
    "zh-Hant",
  );
  assert.equal(
    resolveContentLanguageRange("zh-CN", ["en", "zh-Hans"]),
    "zh-Hans",
  );
  // A region-bearing request now also disambiguates a two-script article,
  // where a bare `zh` cannot.
  assert.equal(
    resolveContentLanguageRange("zh-TW", ["en", "zh-Hans", "zh-Hant"]),
    "zh-Hant",
  );
  // A BARE primary subtag still constrains nothing: `?lang=zh` must reach the
  // one Chinese variant an article has, whichever script it is in. Maximizing
  // it would read `zh` as `zh-Hans` and refuse a Traditional-only article.
  assert.equal(resolveContentLanguageRange("zh", ["en", "zh-Hant"]), "zh-Hant");
  assert.equal(resolveContentLanguageRange("zh", ["en", "zh-Hans"]), "zh-Hans");
  // RFC 4647 truncation still runs first, but it is NOT exempt from the script
  // constraint. Plain lookup matches the range `sr-Latn` to a variant tagged
  // `sr` — which CLDR says is Cyrillic — and hands a Latin-script reader
  // Cyrillic text with `fallback_used: false`, so nothing explains it. The
  // standard's algorithm has no notion of scripts;  is that gap.
  assert.equal(resolveContentLanguageRange("sr-Latn", ["en", "sr"]), null);
  assert.equal(resolveContentLanguageRange("zh-Hant", ["zh"]), null);
  //...while a truncation whose scripts agree still matches, as it must.
  assert.equal(resolveContentLanguageRange("pt-BR", ["pt"]), "pt");
  assert.equal(resolveContentLanguageRange("en-GB", ["en"]), "en");

  // AMBIGUOUS: two scripts of the same language. Never guessed — serving
  // Simplified to someone who may have meant Traditional is 's defect.
  assert.equal(
    resolveContentLanguageRange("zh", ["en", "zh-Hans", "zh-Hant"]),
    null,
  );

  // Nothing to match, nothing that is a language, nothing at all: null, never
  // a throw, because a junk `?lang=` must not break a page.
  assert.equal(resolveContentLanguageRange("zh", ["en", "es"]), null);
  assert.equal(resolveContentLanguageRange("und", ["en", "und"]), null);
  assert.equal(resolveContentLanguageRange("not a tag!", ["en"]), null);
  assert.equal(resolveContentLanguageRange("zh", []), null);
  assert.equal(resolveContentLanguageRange(null, ["en"]), null);
  assert.equal(resolveContentLanguageRange("en", null), null);
});

test("a preserved alias that found no row retries the spelling it folds to", () => {
  // `?lang=cmn` on an article whose Chinese row is stored `zh`: the API
  // matches `cmn` exactly, falls back to the source, and the reader must
  // still land on `zh` — as they did before aliases were preserved.
  assert.equal(
    variantLanguageRetry({
      askedLanguage: "cmn",
      actualLanguage: "en",
      availableLanguages: ["en", "zh"],
    }),
    "zh",
  );
  // An exact alias hit stands, whatever siblings exist.
  assert.equal(
    variantLanguageRetry({
      askedLanguage: "cmn",
      actualLanguage: "cmn",
      availableLanguages: ["en", "cmn", "zh-Hans"],
    }),
    null,
  );
});

test("the second fetch happens only when the first answer was wrong", () => {
  // Asked for a range, got the source: fetch the variant that range names.
  assert.equal(
    variantLanguageRetry({
      askedLanguage: "zh",
      actualLanguage: "en",
      availableLanguages: ["en", "zh-Hans"],
    }),
    "zh-Hans",
  );

  // Exact hit: no second request, ever.
  assert.equal(
    variantLanguageRetry({
      askedLanguage: "zh-Hans",
      actualLanguage: "zh-Hans",
      availableLanguages: ["en", "zh-Hans"],
    }),
    null,
  );
  // The API's fallback already landed on the range's one match.
  assert.equal(
    variantLanguageRetry({
      askedLanguage: "zh",
      actualLanguage: "zh-Hans",
      availableLanguages: ["en", "zh-Hans"],
    }),
    null,
  );
  // Ambiguous, unresolvable, or simply absent: one request, then stop.
  assert.equal(
    variantLanguageRetry({
      askedLanguage: "zh",
      actualLanguage: "en",
      availableLanguages: ["en", "zh-Hans", "zh-Hant"],
    }),
    null,
  );
  assert.equal(
    variantLanguageRetry({
      askedLanguage: "de",
      actualLanguage: "en",
      availableLanguages: ["en", "es"],
    }),
    null,
  );
  assert.equal(
    variantLanguageRetry({
      askedLanguage: "en",
      actualLanguage: "en",
      availableLanguages: ["en"],
    }),
    null,
  );
});

test("the article loader fetches the requested variant, not the UI locale", () => {
  const loader = source("src/routes/[username]/[vanity]/+page.server.ts");
  assert.match(
    loader,
    // `\s*` at the call's punctuation: where Prettier breaks the argument
    // list is its business, not the contract.
    /requestedArticleLanguage = explicitArticleLanguage\(\s*url\.searchParams\.get\("lang"\),?\s*\)/,
  );
  // The UI-locale normalizer must not be anywhere near the `?lang=` on this
  // route: reintroducing it is  exactly.
  assert.doesNotMatch(loader, /normalizeLocale\(/);
  assert.match(
    loader,
    /articleLanguage = resolveArticleLanguage\(\{[\s\S]*?requestedLanguage: requestedArticleLanguage,[\s\S]*?uiLocale: locale,/,
  );
  assert.match(loader, /\{ lang: language \}/);
  assert.match(loader, /fetchVariant\(articleLanguage\)/);
  // The range resolution, and its bound: one retry, from the variant list the
  // first response carried.
  // The tag the LAST fetch used, which is not `articleLanguage` once an
  // unusable `?lang=` has been recovered from (codex adversarial review).
  assert.match(
    loader,
    /variantLanguageRetry\(\{[\s\S]*?askedLanguage: effectiveLanguage,[\s\S]*?availableLanguages:/,
  );
  assert.match(loader, /effectiveLanguage = DEFAULT_LOCALE;/);
  assert.match(
    loader,
    /if \(retryLanguage\) \{[\s\S]*?fetchVariant\(\s*retryLanguage,/,
  );
  //...and the retry is BOUNDED: by the time it runs we already hold a
  // renderable article, so a stall must not hold the response open
  // (codex adversarial review).
  assert.match(
    loader,
    /createAbortSignalWithTimeout\(\s*request\.signal,\s*ARTICLE_VARIANT_RETRY_TIMEOUT_MS,?\s*\)/,
  );
  // An unusable `?lang=` degrades instead of erroring — a representation
  // selector may never fail a page — and it degrades to the SAME explicit
  // language the crawler tier degrades to, so one URL cannot serve two
  // languages across tiers.
  assert.match(
    loader,
    /variantError\.status !== 400[\s\S]*?throw variantError[\s\S]*?fetchVariant\(DEFAULT_LOCALE\)/,
  );
  // Both knobs reach the page, so the component can tell them apart — and the
  // one the page is handed is the variant that was actually SERVED, which is
  // not the one that was asked for when a range resolved to a longer tag.
  assert.match(loader, /\n\s*locale,\n\s*articleLanguage: servedLanguage,/);
  assert.match(loader, /requestedArticleLanguage,/);

  // Links to OTHER articles stay in the UI locale: they point at query-free
  // URLs, so titling them in this article's language would show a Spanish
  // "Next part" that opens in English.
  assertArticleEnrichmentWiring(
    loader,
    source("src/lib/server/article-enrichment.ts"),
  );
});

test("article enrichment locale and signal guards reject incorrect wiring", () => {
  const loader = source("src/routes/[username]/[vanity]/+page.server.ts");
  const enrichment = source("src/lib/server/article-enrichment.ts");
  assertArticleEnrichmentWiring(loader, enrichment);

  const wrongLocale = enrichment.replace(
    /relatedArticles:\s*loadRelatedArticles\((\s*article,\s*eventFetch,)\s*locale,/,
    "$1 articleLanguage,",
  );
  assert.notEqual(wrongLocale, enrichment, "locale mutation must apply");
  assert.throws(
    () => assertArticleEnrichmentWiring(loader, wrongLocale),
    assert.AssertionError,
    "the guard must reject related links wired to the article language",
  );

  const wrongSignal = enrichment.replace(
    /relatedArticles:\s*loadRelatedArticles\((\s*article,\s*eventFetch,\s*locale,)\s*requestSignal,/,
    "$1 unrelatedSignal,",
  );
  assert.notEqual(wrongSignal, enrichment, "signal mutation must apply");
  assert.throws(
    () => assertArticleEnrichmentWiring(loader, wrongSignal),
    assert.AssertionError,
    "the guard must reject related links wired to the wrong request signal",
  );
});

test("the immutable-address escape hatch fetches its requested variant", () => {
  const loader = source("src/routes/article/[id]/+page.server.ts");
  assert.match(
    loader,
    /requestedArticleLanguage = explicitArticleLanguage\(\s*url\.searchParams\.get\("lang"\),?\s*\)/,
  );
  assert.doesNotMatch(loader, /normalizeLocale\(/);
  assert.match(
    loader,
    /resolveArticleLanguage\(\{[\s\S]*?requestedLanguage: requestedArticleLanguage,[\s\S]*?uiLocale: locals\.locale,/,
  );
  assert.match(loader, /\{ lang: language \}/);
  assert.match(loader, /retrieveVariant\(articleLanguage\)/);
  assert.match(
    loader,
    /variantLanguageRetry\(\{[\s\S]*?askedLanguage: effectiveLanguage,/,
  );
  assert.match(loader, /effectiveLanguage = DEFAULT_LOCALE;/);
});

test("the reader route never turns a content language into a UI locale", () => {
  // The cookie half of  P9, which is correct today and must stay correct:
  // `?lang=` on these routes selects an article variant and writes nothing.
  const locale = source("src/lib/locale.js");
  assert.match(
    locale,
    /CONTENT_LANGUAGE_ROUTE_IDS = Object\.freeze\(\[\s*"\/article\/\[id\]",\s*"\/\[username\]\/\[vanity\]",\s*"\/\[username\]\/zpage\/\[slug\]",/,
  );
  // And the UI-locale module no longer decides anything about content: the two
  // helpers that did are gone from it, because living there is what made them
  // use the wrong normalizer.
  assert.doesNotMatch(locale, /export function resolveArticleLanguage/);
  assert.doesNotMatch(locale, /export function resolveFallbackDisclosure/);
});

// --- 3. hreflang alternates and x-default ----------------------------------

test("both article routes render the cluster, not just the canonical", () => {
  // `/article/<id>` computed `pageMeta.alternates` from the same helper all
  // along and never rendered them: it emitted a `rel=canonical` with
  // no cluster around it. Its sibling head block even says "keeping the two
  // head blocks identical is what stops one from regressing" — which is
  // exactly what had happened.
  //
  // This matters more than it did before: past
  // `SITEMAP_MAX_BYTES_PER_ZPAGE` per article the sitemap deliberately stops
  // repeating the cluster inline, so the page `<head>` is the authoritative
  // carrier rather than a second copy of it.
  for (const routeId of [ARTICLE_ROUTE, "/article/[id]"]) {
    const markup = source(`src/routes${routeId}/+page.svelte`);
    assert.match(
      markup,
      /\{#each pageMeta\.alternates as alternate\}[\s\S]*?<link\s+rel="alternate"\s+hreflang=\{alternate\.hreflang\}\s+href=\{alternate\.href\}\s*\/>/,
      `${routeId} must render every hreflang alternate`,
    );
    // Inside `<svelte:head>`, so it is in the SERVER's HTML. A crawler does
    // not hydrate; a cluster added on mount is a cluster that does not exist.
    const head = /<svelte:head>([\s\S]*?)<\/svelte:head>/.exec(markup);
    assert.ok(head, `${routeId} must have a <svelte:head> block`);
    assert.match(head[1], /pageMeta\.alternates/);
  }
});

test("x-default points at the query-free, language-negotiating URL", () => {
  // Untranslated — the overwhelmingly common shape. Nothing to negotiate, so
  // the clean URL genuinely is that language's URL and keeps the canonical it
  // has today.
  assert.equal(cleanUrlLanguage(["fr"], "fr"), "fr");
  assert.deepEqual(articleLanguageAlternates("/ana/story", ["fr"], "fr"), [
    { hreflang: "fr", href: "/ana/story" },
    { hreflang: "x-default", href: "/ana/story" },
  ]);

  // A legacy `und` source alone: nothing nameable, so nothing is advertised.
  assert.deepEqual(articleLanguageAlternates("/ana/story", ["und"], "und"), []);
});

test("a named language never gets a URL whose language depends on the visitor", () => {
  // Two variants: the clean URL renders whichever the visitor's locale cookie
  // negotiates, so it belongs to no language and appears ONLY as x-default.
  // Every named alternate is an explicit `?lang=` URL, which an explicit
  // request pins regardless of any cookie.
  assert.equal(cleanUrlLanguage(["en", "es", "fr"], "en"), null);
  assert.deepEqual(
    articleLanguageAlternates(
      "https://free2z.com/ana/story",
      ["en", "es", "fr"],
      "en",
    ),
    [
      { hreflang: "en", href: "https://free2z.com/ana/story?lang=en" },
      { hreflang: "es", href: "https://free2z.com/ana/story?lang=es" },
      { hreflang: "fr", href: "https://free2z.com/ana/story?lang=fr" },
      { hreflang: "x-default", href: "https://free2z.com/ana/story" },
    ],
  );

  // Same for a non-English source with a translation.
  assert.equal(cleanUrlLanguage(["es", "en"], "es"), null);
  assert.deepEqual(
    articleLanguageAlternates("/ana/story?lang=es", ["es", "en"], "es"),
    [
      { hreflang: "es", href: "/ana/story?lang=es" },
      { hreflang: "en", href: "/ana/story?lang=en" },
      { hreflang: "x-default", href: "/ana/story" },
    ],
  );

  // An unnamed `und` source counts as a variant too: the clean URL can still
  // negotiate down to it, so the one language we CAN name must not claim it.
  assert.equal(cleanUrlLanguage(["und", "es"], "und"), null);
  assert.deepEqual(
    articleLanguageAlternates("/ana/story", ["und", "es"], "und"),
    [
      { hreflang: "es", href: "/ana/story?lang=es" },
      { hreflang: "x-default", href: "/ana/story" },
    ],
  );
  assert.equal(cleanUrlLanguage(["und", "en"], "und"), null);
  assert.deepEqual(
    articleLanguageAlternates("/ana/story", ["und", "en"], "und"),
    [
      { hreflang: "en", href: "/ana/story?lang=en" },
      { hreflang: "x-default", href: "/ana/story" },
    ],
  );
});

test("canonical and hreflang agree on who owns the query-free URL", () => {
  // The failure this guards: an `hreflang` naming a URL whose own canonical
  // serves a different language. Search engines drop the cluster, and it takes
  // a recrawl to recover. Walk the whole variant set and assert that the URL
  // advertised for a language is exactly the canonical the page renders when
  // that language is the one being served.
  for (const [available, source] of [
    [["en", "es", "fr"], "en"],
    [["es", "en"], "es"],
    [["es"], "es"],
    [["und", "es"], "und"],
    [["en"], "und"],
  ]) {
    const alternates = articleLanguageAlternates(
      "https://free2z.com/ana/story",
      available,
      source,
    );

    for (const { hreflang, href } of alternates) {
      if (hreflang === "x-default") continue;
      assert.equal(
        href,
        articleCanonicalHref(
          "https://free2z.com/ana/story",
          hreflang,
          source,
          available,
        ),
        `hreflang=${hreflang} for source=${source} must be its own canonical`,
      );
    }
  }
});

test("the canonical honors an explicit variant list without breaking callers", () => {
  // Translated article: every variant, source included, canonicalizes to its
  // own `?lang=` URL, because the clean one renders per-visitor.
  assert.equal(
    articleCanonicalHref("/ana/story", "en", "es", ["es", "en"]),
    "/ana/story?lang=en",
  );
  assert.equal(
    articleCanonicalHref("/ana/story", "es", "es", ["es", "en"]),
    "/ana/story?lang=es",
  );
  // Untranslated article: unchanged from today — the clean URL.
  assert.equal(
    articleCanonicalHref("/ana/story", "es", "es", ["es"]),
    "/ana/story",
  );
  // Without a list at all, the source keeps the clean URL as it always has.
  assert.equal(articleCanonicalHref("/ana/story", "es", "es"), "/ana/story");
  assert.equal(
    articleCanonicalHref("/ana/story", "es", "en"),
    "/ana/story?lang=es",
  );
});

test("meta passes the variant list to BOTH the canonical and the alternates", () => {
  const meta = source("src/lib/meta.ts");
  assert.match(
    meta,
    /articleCanonicalHref\([\s\S]*?source_language,\s*\n\s*availableLanguages,/,
  );
  assert.match(
    meta,
    /articleLanguageAlternates\(\s*baseCanonicalUrl,\s*\n\s*availableLanguages,/,
  );
});

test("alternates skip only the tags that name no language", () => {
  // `und` is never advertised, and it does not suppress x-default.
  assert.deepEqual(
    articleLanguageAlternates("/ana/story", ["und", "es"], "und"),
    [
      { hreflang: "es", href: "/ana/story?lang=es" },
      { hreflang: "x-default", href: "/ana/story" },
    ],
  );
  for (const nonLanguage of ["mul", "zxx", "qaa", "x-private"]) {
    assert.deepEqual(
      articleLanguageAlternates("/ana/story", [nonLanguage], nonLanguage),
      [],
      `${nonLanguage} is not a language and must never be an hreflang`,
    );
  }
  assert.deepEqual(articleLanguageAlternates(undefined, ["en"], "en"), []);
  assert.deepEqual(articleLanguageAlternates("/ana/story", [], "en"), []);
});

test("a published translation is advertised even outside the four UI locales", () => {
  //the creator's `zh-Hans` translation existed, was published, and was
  // advertised NOWHERE, because the alternate list was filtered against the
  // locales the product UI is translated into.
  assert.deepEqual(
    articleLanguageAlternates("/ana/story", ["en", "zh-Hans"], "en"),
    [
      { hreflang: "en", href: "/ana/story?lang=en" },
      { hreflang: "zh-Hans", href: "/ana/story?lang=zh-Hans" },
      { hreflang: "x-default", href: "/ana/story" },
    ],
  );
  // Two scripts are two languages, each with its own URL. Collapsing them to
  // `zh` would serve Traditional readers Simplified text.
  assert.deepEqual(
    articleLanguageAlternates("/ana/story", ["zh-Hans", "zh-Hant"], "zh-Hans"),
    [
      { hreflang: "zh-Hans", href: "/ana/story?lang=zh-Hans" },
      { hreflang: "zh-Hant", href: "/ana/story?lang=zh-Hant" },
      { hreflang: "x-default", href: "/ana/story" },
    ],
  );
  // A regional variant is advertised AS ITSELF, never relabelled Brazilian.
  assert.deepEqual(
    articleLanguageAlternates("/ana/story", ["pt-PT"], "pt-PT"),
    [
      { hreflang: "pt-PT", href: "/ana/story" },
      { hreflang: "x-default", href: "/ana/story" },
    ],
  );
  assert.equal(cleanUrlLanguage(["zh-Hans"], "zh-Hans"), "zh-Hans");
  assert.equal(
    articleCanonicalHref("/ana/story", "zh-Hans", "en", ["en", "zh-Hans"]),
    "/ana/story?lang=zh-Hans",
  );
});

test("the reader page renders every alternate, x-default included", () => {
  const reader = source("src/routes/[username]/[vanity]/+page.svelte");
  assert.match(
    reader,
    /\{#each pageMeta\.alternates as alternate\}[\s\S]*?hreflang=\{alternate\.hreflang\}[\s\S]*?href=\{alternate\.href\}/,
  );

  // hreflang belongs only on a page that is its own canonical.
  assert.match(
    source("src/lib/meta.ts"),
    /canonicalUrl === localizedCanonicalUrl/,
  );
});

// --- 4. the fallback disclosure --------------------------------------------

test("a fallback is disclosed with language names, never subtags", () => {
  // Both names are written in the READER's language, so the sentence they land
  // in is in one language throughout.
  assert.deepEqual(
    resolveFallbackDisclosure({
      fallbackUsed: true,
      requestedLanguage: "es",
      actualLanguage: "en",
      reflectsReaderChoice: true,
      viewerLocale: "en",
    }),
    { requested: "Spanish", shown: "English" },
  );
  assert.deepEqual(
    resolveFallbackDisclosure({
      fallbackUsed: true,
      requestedLanguage: "es",
      actualLanguage: "en",
      reflectsReaderChoice: true,
      viewerLocale: "es",
    }),
    { requested: "español", shown: "inglés" },
  );

  // Every value the helper can return is a name, never a tag.
  const disclosure = resolveFallbackDisclosure({
    fallbackUsed: true,
    requestedLanguage: "fr",
    actualLanguage: "pt-BR",
    reflectsReaderChoice: true,
  });
  assert.equal(disclosure.requested, languageDisplayName("fr", "en"));
  assert.equal(disclosure.shown, languageDisplayName("pt-BR", "en"));
});

test("the reader who asked for an unshipped language is told, not ignored", () => {
  // 's quietest symptom: the ONE reader this note exists for got nothing,
  // because naming the languages went through the four-entry UI table.
  assert.deepEqual(
    resolveFallbackDisclosure({
      fallbackUsed: true,
      requestedLanguage: "zh-Hans",
      actualLanguage: "en",
      reflectsReaderChoice: true,
      viewerLocale: "en",
    }),
    { requested: "Simplified Chinese", shown: "English" },
  );
  // Traditional and Simplified are a real mismatch and must read as one.
  const scripts = resolveFallbackDisclosure({
    fallbackUsed: true,
    requestedLanguage: "zh-Hant",
    actualLanguage: "zh-Hans",
    reflectsReaderChoice: true,
    viewerLocale: "en",
  });
  assert.notEqual(scripts, null);
  assert.notEqual(scripts.requested, scripts.shown);
});

test("an unnamed language is never printed at a reader", () => {
  // The  bug verbatim: `und` reaching user-facing prose. The list is now
  // exactly the tags that name NO language — a real language is disclosed.
  for (const actualLanguage of ["und", "mul", "zxx", "qaa", "", null, 7]) {
    assert.equal(
      resolveFallbackDisclosure({
        fallbackUsed: true,
        requestedLanguage: "es",
        actualLanguage,
        reflectsReaderChoice: true,
      }),
      null,
      `actual_language ${JSON.stringify(actualLanguage)} must not be disclosed`,
    );
  }

  assert.equal(
    resolveFallbackDisclosure({
      fallbackUsed: true,
      requestedLanguage: "und",
      actualLanguage: "en",
      reflectsReaderChoice: true,
    }),
    null,
  );
});

test("the note stays silent unless a genuine mismatch is worth explaining", () => {
  const genuine = {
    fallbackUsed: true,
    requestedLanguage: "es",
    actualLanguage: "en",
    reflectsReaderChoice: true,
  };
  assert.notEqual(resolveFallbackDisclosure(genuine), null);

  // The backend says it did not fall back.
  assert.equal(
    resolveFallbackDisclosure({ ...genuine, fallbackUsed: false }),
    null,
  );
  // Exact match: nothing to disclose even if the flag were set.
  assert.equal(
    resolveFallbackDisclosure({ ...genuine, actualLanguage: "es" }),
    null,
  );
  // The reader expressed no choice and the article offers none — this is the
  // ~100%-of-articles noise that got the  banner removed.
  assert.equal(
    resolveFallbackDisclosure({ ...genuine, reflectsReaderChoice: false }),
    null,
  );
});

test("the disclosure names what the READER asked for, not the retry", () => {
  // With a range-resolved request the second response's `requested_language` is
  // the RESOLVED tag and `fallback_used` is false, so reading the disclosure out
  // of the response alone makes it unreachable for every range request —
  // including the ones the range could not honour (reviewer F1).
  const reader = source("src/routes/[username]/[vanity]/+page.svelte");
  assert.match(
    reader,
    /readerRequestedLanguage =\s*data\.requestedArticleLanguage \?\?/,
  );
  assert.match(
    reader,
    /servedAnswersRequest =[\s\S]*?resolveContentLanguageRange\(readerRequestedLanguage, \[/,
  );
  assert.match(
    reader,
    /fallbackUsed: \(article as any\)\?\.fallback_used \|\| !servedAnswersRequest/,
  );
  assert.match(reader, /requestedLanguage: readerRequestedLanguage/);
});

test("the disclosure is inline and wired to the language control", () => {
  const reader = source("src/routes/[username]/[vanity]/+page.svelte");
  assert.match(
    reader,
    /fallbackDisclosure = resolveFallbackDisclosure\(\{[\s\S]*?fallbackUsed: \(article as any\)\?\.fallback_used/,
  );
  assert.match(
    reader,
    /reflectsReaderChoice:[\s\S]*?Boolean\(data\.requestedArticleLanguage\) \|\|[\s\S]*?availableArticleLanguages\.length > 1/,
  );
  assert.match(
    reader,
    /\{#if fallbackDisclosure\}[\s\S]*?id="article-language-fallback"[\s\S]*?\$t\(\s*"article\.fallbackNotice"/,
  );
  assert.match(
    reader,
    /aria-describedby=\{fallbackDisclosure[\s\S]*?"article-language-fallback"/,
  );
  // Low emphasis, in flow — not the full-width amber alert  rejected.
  assert.doesNotMatch(reader, /article-language-fallback[\s\S]{0,200}amber/);
});

test("every catalog carries the fallback notice with both placeholders", () => {
  for (const locale of ["en", "es", "fr", "pt-BR"]) {
    const catalog = JSON.parse(source(`src/lib/locales/${locale}.json`));
    const value = catalog.article?.fallbackNotice;
    assert.equal(
      typeof value,
      "string",
      `${locale}.json is missing article.fallbackNotice`,
    );
    assert.match(value, /\{requested\}/, `${locale}.json lost {requested}`);
    assert.match(value, /\{shown\}/, `${locale}.json lost {shown}`);
  }
});

// --- 5. accessibility of the language control -------------------------------

test("the language control is labelled, focusable and self-describing", () => {
  const reader = source("src/routes/[username]/[vanity]/+page.svelte");
  // Attribute ORDER is not the contract; the `for`/`id` pairing is.
  assert.match(reader, /<label[^>]*\bfor="article-language">/);
  assert.match(reader, /<select\s+id="article-language"/);
  // The visible label IS the accessible name; no aria-label overriding it.
  assert.doesNotMatch(reader, /aria-label=\{\$t\("article\.chooseLanguage"/);
  // A focus ring, rather than the old unconditional `outline-none`.
  assert.match(
    reader,
    /focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none/,
  );
  assert.doesNotMatch(
    reader,
    /class="bg-transparent font-medium outline-none"/,
  );
  // Keyboard users keep their place on the control after the variant swap.
  assert.match(reader, /reset: false/);
});

test("the switcher offers every variant, not just the four UI locales", () => {
  const reader = source("src/routes/[username]/[vanity]/+page.svelte");
  // The filter that made a bought, reviewed, published translation unreachable
  //. `languageOptions` is the product-UI table; it must not decide
  // which article variants a reader may see.
  assert.doesNotMatch(reader, /languageOptions\.some/);
  assert.doesNotMatch(reader, /languageOptions\.find/);
  assert.match(
    reader,
    /availableArticleLanguages = \([\s\S]*?available_languages[\s\S]*?normalizeContentLanguage\(value\)/,
  );
  // Labelled from CLDR, in the reader's own language, so ~every language the
  // editor sells a translation into has a name in the control.
  assert.match(reader, /languageDisplayName\(language, \$locale\)/);
  // The body's `lang` is the content tag itself, script subtag intact.
  assert.match(
    reader,
    /articleContentLanguage =\s*normalizeContentLanguage\(\(article as any\)\?\.actual_language\)/,
  );
});

test("the article body declares its own language, the chrome keeps the UI's", () => {
  const reader = source("src/routes/[username]/[vanity]/+page.svelte");
  assert.match(reader, /articleContentLanguage =/);
  assert.match(reader, /<h1\s+lang=\{articleContentLanguage\}/);
  assert.match(reader, /<article[\s\S]{0,80}lang=\{articleContentLanguage\}/);

  // `<html lang>` names the language of the DOCUMENT — the article variant
  // when a content-language route resolved one, the product-UI locale
  // everywhere else. A Chinese variant served under `<html lang="en">` is what
  // a crawler reads first and what a browser picks Han glyphs from.
  const hooks = source("src/hooks.server.ts");
  assert.match(
    hooks,
    /<html lang="\$\{event\.locals\.contentLanguage \|\| selected\}"/,
  );
  // And it can only ever be a canonical tag, never raw query input.
  for (const loader of [
    "src/routes/[username]/[vanity]/+page.server.ts",
    "src/routes/article/[id]/+page.server.ts",
  ]) {
    assert.match(
      source(loader),
      /locals\.contentLanguage = normalizeContentLanguage\(\s*\(article as \{ actual_language\?: string \}\)\.actual_language,?\s*\)/,
      `${loader} must publish the SERVED variant as the document language`,
    );
  }
  // The chrome then says which language IT is in, so an English navbar inside
  // a Chinese document is not announced as Chinese.
  for (const chrome of [
    "src/lib/components/layout/Navbar.svelte",
    "src/lib/components/layout/Footer.svelte",
  ]) {
    assert.match(source(chrome), /lang=\{\$locale\}/, `${chrome} needs lang`);
  }
  //...and so does the UI text INSIDE the page, which is interleaved with the
  // article and therefore has no single wrapper: the switcher's label, the
  // disclosure sentence, the series nav and the related-articles block. Not
  // exhaustive by construction — a lazily mounted comments component and
  // `PageActions` own their own markup — which is why this asserts the
  // regions this route renders itself.
  assert.match(reader, /<label class="shrink-0" lang=\{\$locale\}/);
  assert.match(
    reader,
    /id="article-language-fallback"\s*\n\s*lang=\{\$locale\}/,
  );
  assert.match(reader, /<nav\s*\n\s*lang=\{\$locale\}/);
  assert.ok(
    (reader.match(/lang=\{\$locale\}/g) || []).length >= 4,
    "the in-page chrome regions must declare the UI locale",
  );
});
