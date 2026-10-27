import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  TRANSLATION_SOURCE_LANGUAGE_HEADER,
  articleCanonicalHref,
  articleTranslationHref,
  editorArticleHref,
  editorLanguageMenu,
  editorTranslationHref,
  editorVariantHref,
  isCurrentTranslationResponse,
  isRequestedVariantMissing,
  translationVariantUrl,
} from "../src/lib/zpage-language.js";

const UI_ROOT = path.dirname(fileURLToPath(import.meta.url));
const source = (relativePath) =>
  fs.readFileSync(path.join(UI_ROOT, "..", relativePath), "utf8");

test("editor routes identify the exact language variant", () => {
  assert.equal(
    editorTranslationHref("my page", "es"),
    "/edit?lang=es&id=my+page",
  );
  assert.equal(editorTranslationHref(null, "pt"), "/edit?lang=pt-BR");
});

test("article edit actions preserve translations but keep sources canonical", () => {
  assert.equal(
    editorArticleHref("story", "es", "en"),
    "/edit?lang=es&id=story",
  );
  assert.equal(editorArticleHref("story", "en", "en"), "/edit?id=story");
  assert.equal(editorArticleHref("legacy", "und", "und"), "/edit?id=legacy");

  const actions = source("src/lib/components/zpageActions/PageActions.svelte");
  assert.match(
    actions,
    /editorArticleHref\([\s\S]*?article\?\.actual_language,[\s\S]*?article\?\.source_language/,
  );
});

test("search request identity includes locale and rejects stale-language responses", () => {
  const searchPage = source("src/routes/search/+page.svelte");
  // `tagFilter` joined the identity in; the locale is what this test
  // guards, so the assertion pins the locale's presence rather than the exact
  // number of components.
  assert.match(
    searchPage,
    /requestKey = `\$\{searchQuery\}:\$\{tagFilter\}:\$\{currentPage\}:\$\{requestLanguage\}`/,
  );
  assert.match(
    searchPage,
    /performSearch\(searchQuery, currentPage, requestLanguage, tagFilter\)/,
  );
  assert.match(searchPage, /\$locale === language/);

  const command = source("src/lib/components/layout/SearchCommand.svelte");
  assert.match(
    command,
    /\$effect\(\(\) => \{[\s\S]*?const language = \$locale/,
  );
  assert.match(command, /runSearch\(q, generation, language\)/);
  assert.match(command, /\$locale === language/);
});

test("reader language links preserve the logical article path", () => {
  assert.equal(
    articleTranslationHref("/ana/story", "fr"),
    "/ana/story?lang=fr",
  );
  assert.equal(
    articleTranslationHref("https://free2z.com/ana/story?lang=es", "fr"),
    "https://free2z.com/ana/story?lang=fr",
  );
});

test("translated variants use their own canonical while source stays clean", () => {
  assert.equal(
    articleCanonicalHref("https://free2z.com/ana/story", "es", "en"),
    "https://free2z.com/ana/story?lang=es",
  );
  assert.equal(
    articleCanonicalHref("https://free2z.com/ana/story?lang=en", "en", "en"),
    "https://free2z.com/ana/story",
  );
});

test("a late autosave response cannot hydrate another language", () => {
  assert.equal(isCurrentTranslationResponse("es", "fr"), false);
  assert.equal(isCurrentTranslationResponse("fr", "fr"), true);
});

test("unsupported regional Portuguese is never relabelled Brazilian", () => {
  assert.throws(() => editorTranslationHref("story", "pt-PT"));
});

test("the global language selector cannot invalidate a dirty editor", () => {
  const layout = source("src/routes/+layout.svelte");
  assert.match(layout, /route\.id === "\/edit"[\s\S]*?<Footer/);
});

test("the language control always shows the variant that is actually open", () => {
  const editor = source("src/routes/edit/+page.svelte");
  //  P7 removed the `<select>` entirely, which removes the whole class of
  // "the control says one language, the editor shows another": there is no
  // longer a control carrying its own value. The panel marks the open row from
  // `openLanguage`, derived from `selectedLanguage`, which is assigned only
  // from loaded route data — never optimistically ahead of the navigation.
  assert.doesNotMatch(editor, /id="editor-article-language"/);
  assert.match(
    editor,
    // `\s*` around the argument: where Prettier breaks this call is its
    // business, not the contract being pinned.
    /const openLanguage = \$derived\(\s*normalizeContentLanguage\(selectedLanguage\)/,
  );
  assert.match(editor, /selectedLanguage=\{openLanguage\}/);
  // A failed switch leaves `selectedLanguage` untouched: it is assigned from
  // the loaded route data, never optimistically ahead of the navigation.
  assert.match(
    editor,
    /catch \{\s*\n?\s*if \(canReturn\) \{[\s\S]*?editor\.translationSwitchFailed/,
  );
  assert.match(editor, /selectedLanguage = routeData\.requestedLanguage/);
});

test("new pages use canonical create and variants use nested writes", () => {
  const editor = source("src/routes/edit/+page.svelte");
  assert.equal(
    translationVariantUrl("my page", "pt-BR"),
    "/api/zpage/my%20page/translations/pt-BR/",
  );
  assert.match(
    editor,
    /translationVariantUrl\(currentIdentifier, languageAtSaveStart\)/,
  );
  assert.match(editor, /: "\/api\/zpage\/"/);
  assert.doesNotMatch(editor, /\/api\/zpage\/multilingual\//);
  assert.doesNotMatch(editor, /saveUrl[\s\S]{0,300}\?lang=/);
});

test("new editor honors and normalizes an explicit source language", () => {
  const loader = source("src/routes/edit/+page.ts");
  // Content language, not product-UI locale: `resolveSupportedLocale` would
  // silently drop `ja` and load the source variant instead.
  assert.match(
    loader,
    /normalizeContentLanguage\([\s\S]*?url\.searchParams\.get\("lang"\)/,
  );
  assert.doesNotMatch(loader, /resolveSupportedLocale/);
  assert.match(
    loader,
    /requestedLanguage: explicitLanguage \|\| layout\.locale \|\| "en"/,
  );
});

test("legacy originals remain selectable without sending invalid und locale", () => {
  const reader = source("src/routes/[username]/[vanity]/+page.svelte");
  assert.match(
    reader,
    /language === "und"[\s\S]*?next\.searchParams\.delete\("lang"\)/,
  );
  assert.match(reader, /Original \(language unknown\)/);
  assert.match(reader, /availableArticleLanguages\.length > 1/);
});

test("legacy original content remains editable through canonical no-lang routes", () => {
  const loader = source("src/routes/edit/+page.ts");
  const editor = source("src/routes/edit/+page.svelte");
  assert.match(
    loader,
    /const params = new URLSearchParams\(\{\s*mine: "true"\s*\}\)/,
  );
  assert.match(loader, /if \(language\) params\.set\("lang", language\)/);
  // A legacy `und` source is a real variant of the article, so it is always
  // in the picker — and it is never offered as a translation to write.
  const legacy = editorLanguageMenu({
    sourceLanguage: "und",
    availableLanguages: [],
    selectedLanguage: "und",
    supportedLanguages: ["en", "es", "fr", "pt-BR"],
  });
  assert.deepEqual(legacy.existing, ["und"]);
  assert.deepEqual(legacy.missing, ["en", "es", "fr", "pt-BR"]);
  // The editor no longer prints the sentinel as prose anywhere: `und` has no
  // display name, so the chip and the panel say "Detecting…" instead.
  assert.doesNotMatch(editor, /Original \(language unknown\)/);
  assert.match(editor, /editor\.languageChipDetecting/);
  // And the legacy source keeps its query-free editor URL, because
  // `editorVariantHref` drops a language it cannot name rather than put `und`
  // in a URL.
  assert.equal(editorVariantHref("legacy", "und"), "/edit?id=legacy");
  assert.equal(editorVariantHref("legacy", "ja"), "/edit?lang=ja&id=legacy");
});

test("missing translations are detected independently of fallback disclosure", () => {
  assert.equal(isRequestedVariantMissing("und", "es"), true);
  assert.equal(isRequestedVariantMissing("en", "fr"), true);
  assert.equal(isRequestedVariantMissing("und", "und"), false);
  assert.equal(isRequestedVariantMissing("es", "es"), false);

  const editor = source("src/routes/edit/+page.svelte");
  assert.match(
    editor,
    /routeData\.zpage &&[\s\S]*?isRequestedVariantMissing\([\s\S]*?routeData\.zpage\.actual_language,[\s\S]*?routeData\.requestedLanguage/,
  );
  assert.doesNotMatch(editor, /routeData\.zpage\?\.fallback_used/);
});

test("translation saves carry the source-language compatibility precondition", () => {
  assert.equal(TRANSLATION_SOURCE_LANGUAGE_HEADER, "X-Free2Z-Source-Language");

  const editor = source("src/routes/edit/+page.svelte");
  assert.match(
    editor,
    /const translationSourceLanguage =[\s\S]*?currentIdentifier && !isCanonicalSave[\s\S]*?currentZPage\?\.source_language/,
  );
  //canonical updates send it too (the label this editor saw), so a
  // background detector relabel does not 412 the creator's autosave.
  assert.match(
    editor,
    /const claimedSourceLanguage =\s*translationSourceLanguage \|\|\s*\(currentIdentifier && isCanonicalSave \? sourceAtSaveStart : null\)/,
  );
  assert.match(
    editor,
    /\[TRANSLATION_SOURCE_LANGUAGE_HEADER\]:\s*claimedSourceLanguage/,
  );
});

test("SSR sets the request locale before rendering child components", () => {
  const layout = source("src/routes/+layout.svelte");
  assert.match(
    layout,
    /if \(data\.locale && \(!browser \|\| data\.localePersisted\)\)[\s\S]*?setLocale\(data\.locale\)/,
  );
});

test("URL language drives SSR html language before the locale cookie", () => {
  const hooks = source("src/hooks.server.ts");
  // The precedence itself now lives in `resolveRequestLocale`, which
  // tests/article-language.test.mjs exercises directly. What must stay true
  // here is that the hook feeds it the URL, the cookie AND the route id — the
  // route id is what keeps `?lang=` off the product UI on article pages.
  assert.match(hooks, /resolveRequestLocale\(\{/);
  assert.match(hooks, /routeId: event\.route\.id/);
  assert.match(hooks, /queryLocale: event\.url\.searchParams\.get\("lang"\)/);
  assert.match(
    hooks,
    /cookieLocale: event\.cookies\.get\(LOCALE_STORAGE_KEY\)/,
  );
});
