// The editor's translation manager —  Part 7.
//
// The concrete case this file defends, from the owner's production screenshot
// (2026-08-08): an obviously-English draft, created through the API, whose
// `source_language` is the `und` sentinel. The editor showed
//
//     Article language: [ Original (language unknown) ▾ ]
//     Add a translation: [ Choose a language… ▾ ]
//
// Two dropdowns, one of them printing an internal sentinel as prose, asking a
// creator a question the platform can answer itself — and where answering it
// truthfully ("English") blanked the editor. Every test below is a piece of
// that experience being made impossible.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CONFIDENCE_DISPLAY_THRESHOLD,
  TRANSLATABLE_LANGUAGES,
  buildVariantRows,
  editorVariantHref,
  languageAutonym,
  languageChipState,
  languageDisplayName,
  languageMatchesQuery,
  normalizeContentLanguage,
  untranslatedLanguages,
} from "../src/lib/zpage-language.js";
import {
  SETTLEMENT_POLICY_VERSION,
  TERMINAL_TRANSLATION_STATUSES,
  isAmbiguousOutcome,
  isTerminalTranslationJob,
  newIdempotencyKey,
  translationJobState,
  translationPurchaseError,
} from "../src/lib/zpage-translation-purchase.js";

const UI_ROOT = path.dirname(fileURLToPath(import.meta.url));
const source = (relativePath) =>
  fs.readFileSync(path.join(UI_ROOT, "..", relativePath), "utf8");
const repoFile = (relativePath) =>
  fs.readFileSync(
    path.join(UI_ROOT, "..", "..", "..", "..", relativePath),
    "utf8",
  );

// --- the chip ---------------------------------------------------------------

test("a language is named, or nothing is said — never a subtag", () => {
  assert.equal(languageDisplayName("en", "en"), "English");
  assert.equal(languageDisplayName("ja", "en"), "Japanese");
  assert.equal(languageDisplayName("pt-BR", "en"), "Brazilian Portuguese");
  assert.equal(languageDisplayName("en", "es"), "inglés");

  // `und` HAS a CLDR display name ("Unknown language"), so it has to be
  // rejected before the lookup, not after. This is the exact defect from:
  // an internal sentinel wearing prose.
  assert.equal(languageDisplayName("und", "en"), null);
  assert.equal(languageDisplayName("mul", "en"), null);
  assert.equal(languageDisplayName("zxx", "en"), null);
  assert.equal(languageDisplayName("qaa", "en"), null);
  assert.equal(languageDisplayName("", "en"), null);
  assert.equal(languageDisplayName(null, "en"), null);
  assert.equal(languageDisplayName("not a tag!", "en"), null);
  assert.equal(languageDisplayName(123, "en"), null);

  // A well-formed tag CLDR cannot name is dropped too, rather than echoed.
  assert.equal(languageDisplayName("qqq", "en"), null);

  // Autonyms exist for the picker's second column.
  assert.equal(languageAutonym("es"), "español");
  assert.equal(languageAutonym("und"), null);
});

test("content languages are not the four product-UI locales", () => {
  assert.equal(normalizeContentLanguage("ja"), "ja");
  assert.equal(normalizeContentLanguage("de-DE"), "de-DE");
  assert.equal(normalizeContentLanguage("zh-hans"), "zh-Hans");
  // The one product override, mirroring `_REGIONAL_DEFAULTS` in Python.
  assert.equal(normalizeContentLanguage("pt"), "pt-BR");
  assert.equal(normalizeContentLanguage("pt_BR"), "pt-BR");
  // …and it is NOT applied to a real regional Portuguese.
  assert.equal(normalizeContentLanguage("pt-PT"), "pt-PT");
  assert.equal(normalizeContentLanguage("und"), null);
});

test("the unset chip reads Detecting…, never the und sentinel", () => {
  const legacy = languageChipState({ sourceLanguage: "und" });
  assert.equal(legacy.state, "detecting");
  assert.equal(legacy.language, null);

  const missing = languageChipState({});
  assert.equal(missing.state, "detecting");
  assert.equal(missing.language, null);

  // The catalogs render that state as prose, in every locale.
  for (const locale of ["en", "es", "fr", "pt-BR"]) {
    const catalog = JSON.parse(source(`src/lib/locales/${locale}.json`));
    assert.equal(typeof catalog.editor.languageChipDetecting, "string");
    assert.ok(catalog.editor.languageChipDetecting.trim().length > 0);
    assert.doesNotMatch(catalog.editor.languageChipDetecting, /\bund\b/);
  }
});

test("the chip prefers the stored label and falls back to the detection", () => {
  assert.equal(
    languageChipState({ sourceLanguage: "en", detectedLanguage: "fr" })
      .language,
    "en",
  );
  assert.equal(
    languageChipState({ sourceLanguage: "und", detectedLanguage: "ja" })
      .language,
    "ja",
  );
});

test("low confidence is a soft prompt, and only ever for a detected value", () => {
  const unsure = languageChipState({
    sourceLanguage: "en",
    detectionConfidence: 0.4,
    languageSource: "detected",
  });
  assert.equal(unsure.lowConfidence, true);
  assert.equal(unsure.state, "known", "it still shows the language");

  // A creator's own answer is never second-guessed, whatever the detector
  // scored.
  assert.equal(
    languageChipState({
      sourceLanguage: "en",
      detectionConfidence: 0.1,
      languageSource: "creator",
    }).lowConfidence,
    false,
  );

  // A confident detection, and a response from a backend that does not send
  // confidence at all, are both quiet.
  assert.equal(
    languageChipState({
      sourceLanguage: "en",
      detectionConfidence: 0.99,
      languageSource: "detected",
    }).lowConfidence,
    false,
  );
  assert.equal(
    languageChipState({ sourceLanguage: "en", languageSource: "detected" })
      .lowConfidence,
    false,
  );
});

// --- the panel --------------------------------------------------------------

test("the panel lists every variant the API reports, with real status", () => {
  const rows = buildVariantRows({
    sourceLanguage: "en",
    variants: [
      { language: "en", origin: "source", is_published: true },
      { language: "es", origin: "human", is_published: true, is_stale: true },
      { language: "fr", origin: "ai", is_published: false, is_stale: false },
      //a language outside the old four-locale assumption.
      { language: "ja", origin: "human", is_published: false },
    ],
  });

  const byLanguage = Object.fromEntries(rows.map((row) => [row.language, row]));
  assert.deepEqual(Object.keys(byLanguage).sort(), ["en", "es", "fr", "ja"]);
  assert.equal(rows[0].language, "en", "the source sorts first");

  assert.equal(byLanguage.en.status, "source");
  assert.equal(byLanguage.en.canDelete, false);
  assert.equal(byLanguage.es.status, "published");
  assert.equal(byLanguage.es.isStale, true);
  assert.equal(byLanguage.fr.status, "draft");
  assert.equal(byLanguage.fr.origin, "ai");
  assert.equal(byLanguage.ja.status, "draft");
  assert.equal(byLanguage.ja.canDelete, true);
});

test("a NULL digest is not Stale — the #805 false-positive trap", () => {
  // Every backfilled translation has a NULL `source_digest`, so the API cannot
  // say whether it is stale. Treating that as stale would badge ~100% of the
  // corpus, which is exactly the noise that got 's banner deleted.
  const rows = buildVariantRows({
    sourceLanguage: "en",
    variants: [
      { language: "es", origin: "human", is_published: true, is_stale: null },
      { language: "fr", origin: "human", is_published: true },
      { language: "ja", origin: "human", is_published: true, is_stale: false },
      { language: "de", origin: "human", is_published: true, is_stale: true },
    ],
  });
  const stale = rows.filter((row) => row.isStale).map((row) => row.language);
  assert.deepEqual(stale, ["de"], "only an explicit true is stale");

  // Nor is the source itself ever stale, whatever the API says about it.
  const [sourceRow] = buildVariantRows({
    sourceLanguage: "en",
    variants: [{ language: "en", origin: "source", is_stale: true }],
  });
  assert.equal(sourceRow.isStale, false);
});

test("a null origin is unknown provenance, never assumed human", () => {
  // The schema is explicit: "`null` means the variant row has not been
  // mirrored yet — unknown provenance, not `human`." Only `ai` earns a badge,
  // so an unmirrored row is never labelled, in either direction.
  const rows = buildVariantRows({
    sourceLanguage: "en",
    variants: [
      { language: "es", origin: null, is_published: true },
      { language: "fr", origin: "ai", is_published: false },
    ],
  });
  const byLanguage = Object.fromEntries(rows.map((row) => [row.language, row]));
  assert.equal(byLanguage.es.origin, null);
  assert.equal(byLanguage.es.canDelete, true, "still a translation");
  assert.equal(byLanguage.fr.origin, "ai");

  const panel = source(
    "src/lib/components/zpageLanguage/TranslationsPanel.svelte",
  );
  assert.match(panel, /if \(row\.origin === "ai"\) return/);
  assert.doesNotMatch(panel, /origin === "human"/);
});

test("without the variants endpoint the panel degrades, it does not guess", () => {
  // `GET /variants/` is  P6 and may not be deployed in front of this
  // editor. `available_languages` has always been there.
  const rows = buildVariantRows({
    variants: null,
    sourceLanguage: "en",
    availableLanguages: ["es", "ja"],
    isPublished: true,
    hasSource: true,
  });
  const byLanguage = Object.fromEntries(rows.map((row) => [row.language, row]));

  assert.equal(byLanguage.en.status, "source");
  // "Written" — not "Published", which we do not know, and not "Draft".
  assert.equal(byLanguage.es.status, "written");
  assert.equal(byLanguage.ja.status, "written");
  assert.equal(byLanguage.es.isStale, false);
  assert.equal(byLanguage.ja.isStale, false);
});

test("a legacy und article still shows its own text as the source row", () => {
  // The owner's screenshot case. `und` cannot be named, but the creator's
  // article is still the first thing the panel must account for — omitting it
  // would make the article look as though it had no original at all.
  const rows = buildVariantRows({
    sourceLanguage: "und",
    availableLanguages: ["es"],
    hasSource: true,
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].isSource, true);
  assert.equal(rows[0].status, "source");
  assert.equal(rows[0].language, "", "no tag, because none can be shown");
  assert.equal(rows[0].canDelete, false);
  assert.equal(rows[1].language, "es");
  assert.equal(rows[1].canDelete, true);
});

test("the open variant always has a row, even before it is written", () => {
  const rows = buildVariantRows({
    sourceLanguage: "en",
    availableLanguages: [],
    selectedLanguage: "ja",
    hasSource: true,
  });
  const japanese = rows.find((row) => row.language === "ja");
  assert.equal(japanese.status, "not-started");
  assert.equal(japanese.exists, false);
  assert.equal(japanese.canDelete, false, "nothing to delete yet");
});

// --- the pickers ------------------------------------------------------------

test("the add-translation list is ~50 languages, not four", () => {
  const rows = buildVariantRows({ sourceLanguage: "en", hasSource: true });
  const addable = untranslatedLanguages({ rows });

  assert.ok(addable.length > 30, `expected a large set, got ${addable.length}`);
  assert.ok(addable.includes("ja"));
  assert.ok(addable.includes("de"));
  assert.ok(addable.includes("zh-Hans"));
  assert.ok(!addable.includes("en"), "the source is not offered again");
});

test("a language the article has is never offered as a new translation", () => {
  const rows = buildVariantRows({
    sourceLanguage: "en",
    variants: [{ language: "ja", origin: "human", is_published: true }],
  });
  const addable = untranslatedLanguages({ rows });
  assert.ok(!addable.includes("ja"));
  assert.ok(!addable.includes("en"));
});

test("a language outside the curated set is still listed when it exists", () => {
  // `TRANSLATABLE` is what we sell. It is not what the API may return.
  // `is` (Icelandic) was this fixture until  sold it; `cy` (Welsh) is
  // not curated as of this writing.
  assert.ok(!TRANSLATABLE_LANGUAGES.includes("cy"));
  const rows = buildVariantRows({
    sourceLanguage: "en",
    variants: [{ language: "cy", origin: "human", is_published: true }],
  });
  assert.ok(rows.some((row) => row.language === "cy"));
  assert.ok(
    untranslatedLanguages({ rows, extraLanguages: ["cy"] }).includes("cy") ===
      false,
    "it already exists, so it is not addable",
  );
  // But it IS a label the article can be given.
  assert.ok(
    untranslatedLanguages({ rows: [], extraLanguages: ["cy"] }).includes("cy"),
  );
});

test("the picker is searchable by name, autonym and tag", () => {
  assert.equal(languageMatchesQuery("ja", "japan", "en"), true);
  assert.equal(languageMatchesQuery("ja", "日本", "en"), true);
  assert.equal(languageMatchesQuery("ja", "ja", "en"), true);
  assert.equal(languageMatchesQuery("ja", "german", "en"), false);
  // A Spanish-speaking creator searching in their own UI language.
  assert.equal(languageMatchesQuery("de", "alem", "es"), true);
  assert.equal(languageMatchesQuery("de", "", "en"), true);
});

test("the translatable seed is a usable offline list, not a pinned mirror", () => {
  // It WAS pinned to `py/free2z/f2z/languages.py` tag for tag, and that was right for
  // as long as this array was the only list the picker had. the
  // catalog is served from `GET /api/languages/`, and the whole point of
  // serving it is that adding a language — or demoting one whose quality went
  // bad, which  item 9 wants to be cheap — is a backend-only change. An
  // equality assertion here makes either of those red until someone also edits
  // a JavaScript file, which is exactly the coupling the endpoint removes.
  //
  // What still has to hold is what makes the seed usable as the OFFLINE
  // fallback: it is not empty, and every tag is a real language in canonical
  // form. `zh-hans` or `pt-br` here is a picker entry that every write path
  // then rejects, and no amount of intentional divergence excuses it.
  // `py/free2z/dj/apps/g12f/test_language_catalog.py` asserts the same property from
  // the other side, where `normalize()` is the registry's real one and can
  // therefore also reject a well-formed tag that names no language.
  assert.ok(
    TRANSLATABLE_LANGUAGES.length >= 39,
    "the offline fallback list has been gutted",
  );
  for (const tag of TRANSLATABLE_LANGUAGES) {
    assert.equal(
      normalizeContentLanguage(tag),
      tag,
      `${tag} in TRANSLATABLE_LANGUAGES is not a canonical language tag`,
    );
  }
});

// --- URLs and endpoints -----------------------------------------------------

test("variant resources come from the generated client, not hand-rolled URLs", () => {
  //  put `/variants/` in the schema, so orval owns URL construction and
  // the editor must not re-derive it. Hand-rolled paths are how a client drifts
  // from a contract without CI noticing.
  const editor = source("src/routes/edit/+page.svelte");
  assert.match(editor, /from "\$lib\/api\/zpage\/zpage"/);
  assert.match(editor, /zpageVariantsList,/);
  assert.match(editor, /zpageVariantsDestroy,/);
  assert.match(editor, /zpagePartialUpdate,/);
  // No hand-rolled request to a variants path anywhere.
  assert.doesNotMatch(editor, /apiFetch\([^)]*variants/);
  assert.doesNotMatch(editor, /zpageVariantsUrl|zpageVariantUrl/);
});

test("the editor URL carries any content language, and never a sentinel", () => {
  assert.equal(editorVariantHref("abc", "ja"), "/edit?lang=ja&id=abc");
  assert.equal(editorVariantHref("abc", "pt"), "/edit?lang=pt-BR&id=abc");
  assert.equal(editorVariantHref("abc", "und"), "/edit?id=abc");
  assert.equal(editorVariantHref(null, "ja"), "/edit?lang=ja");
  assert.equal(editorVariantHref(null, "und"), "/edit");
});

// --- the wiring -------------------------------------------------------------

test("the two dropdowns from the screenshot are gone", () => {
  const editor = source("src/routes/edit/+page.svelte");

  // "Article language: Original (language unknown)".
  assert.doesNotMatch(editor, /id="editor-article-language"/);
  assert.doesNotMatch(editor, /editor\.articleLanguage/);
  assert.doesNotMatch(editor, /editor\.originalLanguageUnknown/);
  // "Add a translation: Choose a language…".
  assert.doesNotMatch(editor, /id="editor-add-translation"/);
  assert.doesNotMatch(editor, /editor\.addTranslationPlaceholder/);
  // No `<select>` of any kind is left on the language surface. (The closing
  // tag, so the prose in the comments explaining what was removed does not
  // count as the thing still being there.)
  assert.doesNotMatch(editor, /<\/select>/);

  assert.match(editor, /<LanguageChip/);
  assert.match(editor, /<TranslationsPanel/);
  assert.match(editor, /<LanguagePicker/);
});

test("changing the label is a PATCH that touches nothing else", () => {
  const editor = source("src/routes/edit/+page.svelte");
  const fn = editor.slice(
    editor.indexOf("async function changeArticleLanguage("),
    editor.indexOf("async function startNewTranslation("),
  );
  assert.ok(fn.length > 0, "found the relabel implementation");

  // One field in the body — plus the `If-Match` precondition in the request
  // options, which decides only WHETHER the write happens and never what it
  // stores.
  assert.match(
    fn,
    /await zpagePartialUpdate\(\s*\n\s*identifier,\s*\n\s*\{ source_language: language \},/,
  );
  assert.match(fn, /headers: preconditionHeaders\(/);
  // The body is the ONLY thing that goes to the server, and the composer's
  // state is never re-hydrated: relabelling must not cost a keystroke.
  assert.doesNotMatch(fn, /\b(?:content|title|description) =[^=]/);
  assert.doesNotMatch(fn, /applyHydratedState|hydrateEditorState/);
  assert.doesNotMatch(fn, /goto\(|invalidateAll/);
  // One field on the wire, and nothing else.
  assert.doesNotMatch(fn, /zpageVariantsUpdate|zpageUpdate\(|apiFetch\(/);
});

test("the 409 collision gets its own actionable message", () => {
  const editor = source("src/routes/edit/+page.svelte");
  const fn = editor.slice(
    editor.indexOf("async function changeArticleLanguage("),
    editor.indexOf("async function startNewTranslation("),
  );

  // A 409 carries `detail` written to be shown to the creator. Show it
  // VERBATIM: substituting a generic failure withholds the one fact that would
  // let them fix it, which is the defect that started.
  assert.match(
    fn,
    /const conflictDetail =\s*\n\s*typeof data\?\.detail === "string" && data\.detail\.trim\(\)/,
  );
  assert.match(
    fn,
    /if \(status === 409 \|\|[\s\S]{0,120}operationNotice\.error\(\s*\n\s*conflictDetail \?\?/,
  );
  // …and the localized string is only the fallback for a response with no
  // detail at all, never a replacement for one that has it.
  assert.match(fn, /conflictDetail \?\?[\s\S]{0,300}languageChangeCollision/);
  // Distinct from the generic failure, and from the other refusals.
  assert.match(
    fn,
    /status === 401 \|\| status === 403[\s\S]{0,200}languageChangeForbidden/,
  );
  assert.match(fn, /status === 400[\s\S]{0,200}languageChangeRejected/);
  assert.match(fn, /languageChangeFailed/);

  for (const locale of ["en", "es", "fr", "pt-BR"]) {
    const catalog = JSON.parse(source(`src/lib/locales/${locale}.json`));
    const message = catalog.editor.languageChangeCollision;
    assert.ok(
      message.includes("{language}"),
      `${locale} names the colliding language`,
    );
    assert.notEqual(
      message,
      catalog.editor.languageChangeFailed,
      `${locale} does not reuse the generic failure`,
    );
  }
});

test("the panel's delete goes through the confirmed delete path", () => {
  const editor = source("src/routes/edit/+page.svelte");
  assert.match(
    editor,
    /onDelete=\{\(language\) => void deleteTranslation\(language\)\}/,
  );

  const fn = editor.slice(editor.indexOf("async function deleteTranslation("));
  // Confirmed, and refused for the source — the same rule the backend applies.
  assert.match(fn, /askEditorPrompt\(\{[\s\S]{0,200}deleteTranslationTitle/);
  assert.match(fn, /if \(choice !== "confirm"\) \{\s*\n\s*return;/);
  // Guarded on the row the creator clicked — the variants index is
  // authoritative and lists rows `available_languages` does not (a mirror-only
  // variant; from P8, an AI draft). Rechecking against the legacy list made
  // Delete render and then silently do nothing.
  assert.match(
    fn,
    /const row = variantRows\.find\([\s\S]{0,300}\);\s*\n\s*if \(!row\?\.canDelete \|\| !row\.exists\) \{\s*\n\s*return;/,
  );
  assert.doesNotMatch(fn, /canDeleteTranslationLanguage/);
});

test("a creator can publish without touching the language surface", () => {
  const editor = source("src/routes/edit/+page.svelte");
  // The panel is collapsed by default, and nothing in the publish path reads
  // from it. Principle 1 of: language is inferred, never demanded.
  assert.match(editor, /let showTranslations = \$state\(false\)/);
  const publish = editor.slice(
    editor.indexOf("async function handlePublish("),
    editor.indexOf("async function handleManualSave("),
  );
  assert.doesNotMatch(publish, /languagePicker|showTranslations|variantRows/);
});

test("translation publish reviews the saved revision it will write", () => {
  const editor = source("src/routes/edit/+page.svelte");
  const publish = editor.slice(
    editor.indexOf("async function handlePublish("),
    editor.indexOf("async function checkTranslationBeforePublish("),
  );
  assert.match(
    publish,
    /checkedRevision = await checkTranslationBeforePublish\(\)/,
  );
  assert.match(
    publish,
    /approvedRevision =\s*typeof checkedRevision === "string"/,
  );
  assert.match(publish, /writePublish\(\{\s*approvedRevision,/);

  const review = editor.slice(
    editor.indexOf("async function checkTranslationBeforePublish("),
    editor.indexOf("async function writePublish("),
  );
  assert.ok(
    review.indexOf("while (currentSavePromise)") <
      review.indexOf("confirmDespiteWarnings"),
  );
  assert.ok(
    review.indexOf("if (isDirty) {") > -1 &&
      review.indexOf("if (isDirty) {") <
        review.indexOf("confirmDespiteWarnings"),
  );
  // A clean editor without a validator must never save to obtain one: that
  // PUT has no If-Match and would overwrite another device's newer draft and
  // shared article fields before any review. Only a dirty draft is saved.
  const beforeReview = review.slice(
    0,
    review.indexOf("confirmDespiteWarnings"),
  );
  assert.doesNotMatch(beforeReview, /!\s*etag\b/);
  assert.equal(beforeReview.match(/handleSave\(/g)?.length, 1);
  assert.match(
    beforeReview,
    /if \(isDirty\) \{\s*if \(!\(await handleSave\(\)\)\)/,
  );
  assert.match(
    review,
    /changeVersion !== reviewedChangeVersion \|\|\s*isDirty/,
  );
});

test("#1009's discard path survives the rebuild", () => {
  const editor = source("src/routes/edit/+page.svelte");
  // Save / Discard / Cancel on a variant switch, and no implicit blanking.
  assert.match(editor, /planLanguageSwitch\(\{/);
  assert.match(editor, /editor\.languageSwitchDiscard/);
  assert.match(editor, /choice === "discard"[\s\S]{0,600}discarding = true;/);
  assert.match(
    editor,
    /commitLanguageSwitch\(nextLanguage, \{\s*\n\s*discardUnsaved: discarding,/,
  );
  // A refused save still says why.
  assert.match(editor, /function failSave\(reason: SaveBlockReason\)/);
  assert.match(editor, /saveBlockMessage\(saveBlockReason\)/);
  // Both panel navigations run through the same guarded switch — neither one
  // can reach a blank editor without the prompt.
  assert.match(
    editor,
    /onOpen=\{\(language\) => void requestLanguage\(language\)\}/,
  );
  assert.match(
    editor,
    /onWrite=\{\(language\) => void requestLanguage\(language\)\}/,
  );
});

// --- findings from the codex adversarial review -----------------------------

test("a relabel PATCH can never race an autosave PUT", () => {
  // `PATCH /api/zpage/{id}/` sends one field, but DRF loads the whole row, sets
  // it and calls `.save()`. A PUT committing between that load and that save is
  // written straight back out of a stale instance — the creator's body, tags or
  // payout address silently reverting, discovered only on reload. The two
  // writes are serialized in both directions.
  const editor = source("src/routes/edit/+page.svelte");

  assert.match(
    editor,
    /if \(isRelabelling\) \{\s*\n\s*return failSave\("relabelling"\);/,
  );

  const fn = editor.slice(
    editor.indexOf("async function changeArticleLanguage("),
    editor.indexOf("async function startNewTranslation("),
  );
  // Flag first, then drain: nothing new can start behind the drain.
  const flag = fn.indexOf("isRelabelling = true;");
  const drain = fn.indexOf("while (currentSavePromise)");
  const request = fn.indexOf("await zpagePartialUpdate(");
  assert.ok(
    flag > 0 && drain > flag && request > drain,
    "flag → drain → PATCH",
  );

  // And the autosave clock stays stopped for the whole round trip, then
  // restarts if the creator still has unsaved work.
  const autosaveGuard = editor
    .slice(
      editor.indexOf("function scheduleAutoSave("),
      editor.indexOf("function markDirty("),
    )
    .replace(/\s+/g, "");
  assert.match(
    autosaveGuard,
    /editorPrompt\|\|isDeletingTranslation\|\|isDeletingPage\|\|isSwitchingLanguage\|\|isRelabelling/,
  );
  assert.match(
    fn,
    /finally \{\s*\n\s*isRelabelling = false;[\s\S]{0,300}if \(isDirty\) \{\s*\n\s*scheduleAutoSave\(\);/,
  );
  // The chip itself is unavailable while a save is running.
  assert.match(editor, /disabled=\{!canRelabel \|\|\s*\n\s*isSaving \|\|/);
});

test("relabelling cannot turn an unsaved translation into the article", () => {
  // The nastiest path codex found. `selectedLanguage === source_language` is
  // what routes the next save to `/api/zpage/{id}/` instead of the translation
  // endpoint. Relabel the article to Spanish while an unsaved Spanish
  // translation draft is open and that equality flips underneath the draft —
  // the next autosave writes the translation's text over the canonical
  // article, and the original is unrecoverable through the UI.
  const editor = source("src/routes/edit/+page.svelte");

  assert.match(
    editor,
    /const canRelabel = \$derived\(\s*\n\s*!currentZPage \|\|\s*\n\s*\(Boolean\(currentZPage\.free2zaddr\) &&\s*\n\s*isCanonicalLanguage\(selectedLanguage\)\),/,
  );

  const fn = editor.slice(
    editor.indexOf("async function changeArticleLanguage("),
    editor.indexOf("async function startNewTranslation("),
  );
  // Guarded in the action too, not only in the disabled state of a button.
  assert.match(fn, /if \(!isCanonicalLanguage\(selectedLanguage\)\) return;/);
  // The guard sits before the request, not after it.
  assert.ok(
    fn.indexOf("!isCanonicalLanguage(selectedLanguage)") <
      fn.indexOf("await zpagePartialUpdate("),
  );

  // And the creator is told why, instead of being handed a dead grey link.
  assert.match(editor, /disabledReason=\{canRelabel\s*\n?\s*\? undefined/);
  assert.match(editor, /editor\.languageChangeNeedsSource/);
});

test("the collision message survives the backend returning 400, not 409", () => {
  // The serializer raises a *field* error today and only becomes a 409 in P6.
  // Sniffing its message text would break the moment the copy changes, so the
  // collision is recognised from what the editor already knows locally.
  const editor = source("src/routes/edit/+page.svelte");
  const fn = editor.slice(
    editor.indexOf("async function changeArticleLanguage("),
    editor.indexOf("async function startNewTranslation("),
  );
  assert.match(
    fn,
    /const collides = variantRows\.some\(\s*\n\s*\(row\) => row\.language === language && !row\.isSource,/,
  );
  assert.match(fn, /status === 409 \|\| \(status === 400 && collides\)/);
});

test("an unnameable source row is still openable", () => {
  // A legacy `und` source has no display name, so its row carries no tag to
  // render — but "Edit" on that row must still reopen the original. That is
  // what `navigateAs` is for; without it the button is a silent no-op and the
  // creator cannot get back to their own article.
  const [row] = buildVariantRows({ sourceLanguage: "und", hasSource: true });
  assert.equal(row.language, "");
  assert.equal(row.navigateAs, "und");

  const named = buildVariantRows({
    sourceLanguage: "en",
    variants: [{ language: "ja", origin: "human" }],
  });
  for (const each of named) {
    assert.equal(each.navigateAs, each.language);
  }

  const panel = source(
    "src/lib/components/zpageLanguage/TranslationsPanel.svelte",
  );
  assert.doesNotMatch(panel, /on(?:Open|Write|Delete)\(row\.language\)/);
  assert.match(panel, /onOpen\(row\.navigateAs\)/);
  assert.match(panel, /onWrite\(row\.navigateAs\)/);
  assert.match(panel, /onDelete\(row\.navigateAs\)/);
});

test("a missing variants endpoint is asked about once, not on every save", () => {
  const editor = source("src/routes/edit/+page.svelte");
  assert.match(
    editor,
    /<script lang="ts" module>[\s\S]{0,700}let variantsEndpointSupported = true;/,
  );
  assert.match(
    editor,
    /const rows = await zpageVariantsList\(identifier,\s*\{\s*mine:\s*true\s*\}\)/,
  );
  assert.match(
    editor,
    /error instanceof ApiError &&\s*\n\s*\(error\.status === 404 \|\| error\.status === 405\)\s*\n\s*\) \{\s*\n\s*variantsEndpointSupported = false;/,
  );
  assert.match(editor, /if \(!identifier \|\| !variantsEndpointSupported\)/);
});

test("extension and private-use sections are not content languages", () => {
  // The Python registry rejects them. Accepting one here would let a `?lang=`
  // value through that every subsequent save then 400s on, with nothing but
  // the generic save error to explain it.
  assert.equal(normalizeContentLanguage("en-u-ca-buddhist"), null);
  assert.equal(normalizeContentLanguage("en-x-draft"), null);
  assert.equal(normalizeContentLanguage("x-private"), null);
  // …while real tags with script and region subtags still pass.
  assert.equal(normalizeContentLanguage("zh-Hant-HK"), "zh-Hant-HK");
  assert.equal(normalizeContentLanguage("sr-Latn"), "sr-Latn");
});

test("a null source_language does not file canonical edits as a translation", () => {
  // `source_language` is nullable: NULL means detection has not run (
  // §3.2). Comparing a tag against null is false, so a naive equality
  // classifies edits to an *unlabelled* article as a translation in whatever
  // the reader's UI locale happens to be — and PUTs the canonical body to
  // `/variants/en/`, reporting success while the article never changes.
  const editor = source("src/routes/edit/+page.svelte");

  assert.match(
    editor,
    /function isCanonicalLanguage\(language: string \| null \| undefined\): boolean \{[\s\S]{0,400}if \(!source\) return !getRouteData\(\)\.explicitLanguage;/,
  );
  // Every routing decision goes through the one predicate — none of them is
  // left comparing against a nullable field directly.
  assert.match(
    editor,
    /const canSchedule = \$derived\(isCanonicalLanguage\(selectedLanguage\)\)/,
  );
  assert.match(
    editor,
    /const isCanonicalSave =\s*\n\s*Boolean\(currentZPage\) && isCanonicalLanguage\(languageAtSaveStart\)/,
  );
  assert.match(
    editor,
    /const isSourceVariant = isCanonicalLanguage\(selectedLanguage\)/,
  );
  assert.doesNotMatch(
    editor,
    /(?:selectedLanguage|languageAtSaveStart) === (?:currentZPage|zpage)\.source_language/,
  );

  // …and the loader supplies the one extra fact the predicate needs.
  const loader = source("src/routes/edit/+page.ts");
  assert.match(loader, /explicitLanguage,/);

  // The type says so too, so the next reader cannot assume otherwise.
  assert.match(
    source("src/lib/types/zpage.ts"),
    /source_language: string \| null;/,
  );
});

test("the low-confidence threshold matches the detector's contract", () => {
  // The detector emits exactly 0.75 for a 40-199 character sample, and
  // documents CONFIDENCE_DISPLAY_THRESHOLD as the caller policy. A UI
  // threshold of 0.75 with `<` would silently exclude that whole bucket —
  // the shortest documents, which are the likeliest to be misdetected.
  const python = repoFile("py/free2z/f2z/ai/language.py");
  const match = python.match(/^CONFIDENCE_DISPLAY_THRESHOLD = ([0-9.]+)$/m);
  assert.ok(match, "found the Python constant");
  assert.equal(CONFIDENCE_DISPLAY_THRESHOLD, Number(match[1]));

  assert.equal(
    languageChipState({
      sourceLanguage: "en",
      detectionConfidence: 0.75,
      languageSource: "detected",
    }).lowConfidence,
    true,
    "the short-document bucket gets the prompt",
  );
});

test("a language this browser cannot name is still manageable", () => {
  // Dropping the row would make a real variant invisible — and so impossible
  // to open or delete. In a management table the tag IS the variant's
  // identity; the  rule is about prose, not about an identifier that is
  // labelled as one.
  const panel = source(
    "src/lib/components/zpageLanguage/TranslationsPanel.svelte",
  );
  assert.match(panel, /editor\.variantUnnamedLanguage/);
  assert.match(panel, /tag: row\.language/);

  for (const locale of ["en", "es", "fr", "pt-BR"]) {
    const catalog = JSON.parse(source(`src/lib/locales/${locale}.json`));
    assert.ok(catalog.editor.variantUnnamedLanguage.includes("{tag}"));
  }
});

test("a language outside the curated set can still be chosen", () => {
  // The picker is seeded from the languages we SELL translations into. The
  // backend accepts far more, so without an escape hatch a Welsh creator
  // cannot say their article is Welsh and it stays mislabelled with their
  // UI locale. (Icelandic was this example until  sold it.)
  assert.ok(!TRANSLATABLE_LANGUAGES.includes("cy"));
  const picker = source(
    "src/lib/components/zpageLanguage/LanguagePicker.svelte",
  );
  assert.match(picker, /const typedLanguage = \$derived\.by\(\(\) => \{/);
  assert.match(picker, /const tag = normalizeContentLanguage\(query\)/);
  // Offered only when the typed tag is a language we can actually name, and
  // only when it is not already in the list.
  assert.match(
    picker,
    /if \(entries\.some\(\(entry\) => entry\.language === tag\)\) return null;/,
  );
  assert.match(picker, /return name \? \{ language: tag, name/);
  assert.match(picker, /\{#if typedLanguage\}/);
});

// --- buying an AI translation ( P8 / §6.1) ------------------------------
//
// The seam these replace was a disabled button reading "AI translation — soon".
// The endpoints it was waiting for landed in `be1a9a49`; the only thing missing
// was the editor passing `onTranslateWithAi`. What matters now is not that the
// button exists but that the money rules hold on the way to it.

test("the soon copy is gone from every catalog, in favour of the real action", () => {
  for (const locale of ["en", "es", "fr", "pt-BR"]) {
    const catalog = JSON.parse(
      repoFile(`ts/svelte/free2z/src/lib/locales/${locale}.json`),
    );
    const editor = catalog.editor;
    // A promise the product no longer needs to make.
    assert.equal(editor.variantTranslateAiSoon, undefined);
    assert.equal(editor.variantTranslateAiSoonHint, undefined);
    // And the real flow is fully translated — a half-localized money screen
    // would fall back to English exactly where the number is.
    for (const key of [
      "variantTranslateAi",
      "translateAiTitle",
      "translateAiPrice",
      "translateAiBalance",
      "translateAiConfirm",
      "translateAiStarted",
      "translateAiDeliveredHere",
      "translateAiRefunded",
      "translateAiErrorPublishedLimit",
      "translateAiErrorDraftLimit",
      "translateAiErrorTooLong",
      "translateAiErrorVariantPublished",
      "translateAiErrorInsufficient",
    ]) {
      assert.equal(
        typeof editor[key],
        "string",
        `${locale} is missing editor.${key}`,
      );
    }
  }
});

test("2Z are credits — no catalog string calls them money or crypto", () => {
  // Standing constraint, not a style note: 2Z are platform credits, and copy
  // that implies otherwise is a compliance problem, not a typo.
  const forbidden =
    /\b(dollars?|USD|euros?|money|dinero|argent|dinheiro|crypto|cryptocurrency|criptomoneda|cripto|Zcash|ZEC)\b/i;
  for (const locale of ["en", "es", "fr", "pt-BR"]) {
    const editor = JSON.parse(
      repoFile(`ts/svelte/free2z/src/lib/locales/${locale}.json`),
    ).editor;
    for (const [key, value] of Object.entries(editor)) {
      if (!key.startsWith("translateAi")) continue;
      assert.doesNotMatch(value, forbidden, `${locale}.editor.${key}`);
    }
  }
});

test("the panel offers the purchase, and never invents a price in a row", () => {
  const panel = source(
    "src/lib/components/zpageLanguage/TranslationsPanel.svelte",
  );
  assert.match(
    panel,
    /\$t\("editor\.variantTranslateAi", "Translate with AI"\)/,
  );
  assert.doesNotMatch(panel, /variantTranslateAiSoon\b/);
  // Pricing is cost-plus and metered: the number exists only once the quote
  // endpoint has been asked about this exact article. A row that rendered one
  // would be rendering an invention. Checked against the MARKUP — the prose
  // above it explains exactly this, and is allowed to say so.
  const markup = panel
    .slice(panel.lastIndexOf("</script>"))
    .replace(/<!--[\s\S]*?-->/g, "");
  assert.doesNotMatch(markup, /2Z|price|quote/i);
});

test("nothing is charged from a screen that has not shown the price", () => {
  const dialog = source(
    "src/lib/components/zpageLanguage/TranslateWithAiDialog.svelte",
  );
  // The confirm button is not merely disabled without a quote — it does not
  // exist. A button that is about to become clickable invites a click at
  // whatever price lands under the cursor.
  const confirmBlock = dialog.slice(
    dialog.indexOf("{#if quote && !error && !insufficientFunds && affordable}"),
  );
  assert.match(confirmBlock, /data-testid="translate-ai-confirm"/);
  assert.match(confirmBlock, /translateAiConfirm[\s\S]{0,120}\{price\} 2Z/);
  //...and it names the figure it is committing to, both in the body and on
  // the button itself.
  assert.match(dialog, /data-testid="translate-ai-price"/);
  // An unaffordable quote keeps its explanation and refresh action, but must
  // not invite a click with a disabled button showing the quoted price.
  assert.match(dialog, /makeInsufficientFunds\([\s\S]{0,180}quote\.price/);
  assert.match(dialog, /editor\.translateRetryQuote/);
  assert.doesNotMatch(dialog, /disabled=\{buying \|\| !affordable\}/);
});

test("the purchase carries an Idempotency-Key that orval cannot emit", () => {
  // CLAUDE.md: orval emits no code for `in: header` parameters, so a green
  // `api-client` job proves shape parity with the spec and NOT that the header
  // is on the wire. The call site is the only place it can be.
  const editor = source("src/routes/edit/+page.svelte");
  const buy = editor.slice(
    editor.indexOf("async function confirmTranslateWithAi("),
  );
  // Whitespace-insensitive: prettier decides whether the options object fits on
  // one line, and it stopped fitting when  hoisted the request payload into
  // a variable so the recovery re-send could share it. A test pinned to one
  // layout goes red on a reformat instead of on the bug (CLAUDE.md).
  assert.match(
    buy,
    /zpageTranslationPurchase\([\s\S]{0,400}?\{\s*headers:\s*\{\s*"Idempotency-Key":\s*key\s*,?\s*\}\s*,?\s*\}/,
  );
});

test("a retry after a lost response reuses the key, so it cannot charge twice", () => {
  // The case the whole mechanism exists for: the debit commits, the response
  // is lost, and at the fetch layer that is indistinguishable from a failure.
  // A fresh key on the retry asks for a genuinely NEW purchase and gets
  // charged for one; the same key replays the receipt or answers
  // `request_in_progress`. Neither is a second debit.
  const editor = source("src/routes/edit/+page.svelte");

  // The key belongs to the (ARTICLE, language, body digest, price) tuple —
  // the server's own fingerprint — minted at confirm and kept until a
  // purchase for it settles. Article-scoped because the server binds the key
  // to the article too: a key kept under a bare language would follow the
  // creator to the next article and wedge every purchase there on
  // `idempotency_mismatch`. The tuple itself is pinned against the server in
  // translation-purchase-identity.test.mjs.
  const buy = editor.slice(
    editor.indexOf("async function confirmTranslateWithAi("),
  );
  assert.match(
    buy,
    /intentIdentity = translationPurchaseIdentity\(\{[\s\S]{0,220}?quote,/,
  );
  assert.match(buy, /intentIdempotencyKey\(intentIdentity, \{/);
  assert.match(buy, /pending\?\.key/);
  // A failed purchase leaves the dialog — and therefore the key — in place.
  const catchStart = buy.indexOf("} catch (error: unknown) {");
  const failure = buy.slice(catchStart, buy.indexOf("} finally {", catchStart));
  assert.doesNotMatch(failure, /translateAiKeys\.delete/);
  assert.doesNotMatch(failure, /closeTranslateWithAi\(\)/);

  // Cancel must NOT drop it either. The undecided case is exactly the one
  // where a creator closes the dialog and comes back, and a key thrown away
  // there is a key that cannot replay — which makes the next attempt a second
  // charge rather than a repeat of the first.
  const close = editor.slice(editor.indexOf("function closeTranslateWithAi("));
  assert.doesNotMatch(close.slice(0, 600), /translateAiKeys\.delete/);

  // It is dropped when the purchase SETTLES, which is when the next one
  // really is a new purchase.
  assert.match(
    buy,
    /retireTranslationIntent\(\s*intentIdentity,[\s\S]{0,500}?supersedes: supersededIdentity,[\s\S]{0,500}?"success"/,
  );
});

test("a purchase charges the article whose price was on screen", () => {
  // This page component survives navigation between two /edit URLs and a
  // hydration does not close the dialog. Taking the article at confirm time
  // means a quote shown for A can be bought against B — and since prices are
  // whole 2Z, two articles can agree on a number, so `expected_price` would
  // wave it straight through. (codex adversarial review.)
  const editor = source("src/routes/edit/+page.svelte");
  const open = editor.slice(
    editor.indexOf("async function openTranslateWithAi("),
  );
  assert.match(
    open.slice(0, 800),
    /translateAiPage = currentZPage\.free2zaddr;/,
  );

  const buy = editor.slice(
    editor.indexOf("async function confirmTranslateWithAi("),
  );
  const preamble = buy.slice(0, buy.indexOf("isBuyingTranslation = true;"));
  // The identifier comes from the QUOTE's article, not from what is loaded.
  assert.match(preamble, /const identifier = translateAiPage;/);
  assert.doesNotMatch(preamble, /const identifier = currentZPage/);
  //...and if they are no longer the same article, there is nothing safe to
  // buy at all.
  assert.match(preamble, /if \(identifier !== currentZPage\?\.free2zaddr\)/);
});

test("a job that settles for another article never writes this one's state", () => {
  // This component survives navigation between two /edit URLs, so a job
  // started on article A can settle while article B is on screen. Every
  // branch of the watcher writes shared editor state — and one of them can
  // navigate. The job and its money are unaffected either way, so there is
  // nothing to say. (codex adversarial review.)
  const editor = source("src/routes/edit/+page.svelte");
  const watch = editor.slice(
    editor.indexOf("async function watchTranslationJob("),
  );
  const settled = watch.slice(
    watch.indexOf("const state = translationJobState(job);"),
  );
  const guard = settled.indexOf("currentZPage?.free2zaddr !== identifier");
  assert.ok(
    guard !== -1,
    "the watcher must check it is still the same article",
  );
  //...and it guards BEFORE any of the state writes.
  for (const write of [
    'if (state === "delivered")',
    "availableLanguages = [",
    "commitLanguageSwitch(",
  ]) {
    assert.ok(
      guard < settled.indexOf(write),
      `the article check must come before ${write}`,
    );
  }
});

test("an ambiguous failure never claims nothing was charged", () => {
  // Django can commit the debit and the 202 receipt and then have the
  // connection reset. From the browser that is indistinguishable from the
  // request never arriving — so "Nothing was charged" is the one message that
  // can be actively false, and it is the one most likely to make a creator
  // click Buy again.
  assert.equal(isAmbiguousOutcome({ status: 0, data: null }), true);
  assert.equal(isAmbiguousOutcome({ status: 502, data: "<html>" }), true);
  assert.equal(isAmbiguousOutcome({ status: 500, data: null }), true);
  // A refusal the server chose IS a decision, whatever its status.
  assert.equal(
    isAmbiguousOutcome({ status: 409, data: { code: "variant_published" } }),
    false,
  );
  assert.equal(
    isAmbiguousOutcome({ status: 503, data: { code: "translation_backlog" } }),
    false,
  );
  assert.equal(isAmbiguousOutcome({ status: 404, data: null }), false);

  const t = (_code, fallback) => fallback;
  const unknown = translationPurchaseError(
    { status: 0, data: null },
    {
      t,
      language: "Spanish",
    },
  );
  assert.doesNotMatch(unknown, /Nothing was charged/);
  assert.match(unknown, /could not tell whether/i);
  assert.match(unknown, /Do not buy it again yet/);

  // And the editor recovers by re-sending the SAME key, which is the only
  // thing that identifies THIS purchase. `GET.../translate/` answers "the
  // most recent purchase for this language" — for a creator who bought
  // Spanish last week, that is last week's job, and announcing its outcome
  // while the real request is still deciding is worse than saying nothing.
  const editor = source("src/routes/edit/+page.svelte");
  const buy = editor.slice(
    editor.indexOf("async function confirmTranslateWithAi("),
  );
  const recovery = buy.slice(buy.indexOf("if (isAmbiguousOutcome(error))"));
  assert.match(recovery.slice(0, 600), /zpageTranslationPurchase\(/);
  assert.match(recovery.slice(0, 600), /"Idempotency-Key": key/);
  assert.doesNotMatch(recovery.slice(0, 600), /zpageTranslationStatus\(/);
});

test("a translation delivered into the OPEN variant cannot be typed over", () => {
  // Buying a translation for the language you are looking at is the most
  // natural flow there is: you open the empty Spanish draft and decide to have
  // it written. But the composer still holds the text it loaded and the editor
  // considers that saved — so the next keystroke autosaves the whole stale
  // document over the translation just paid for, flipping its origin to human
  // and destroying it with no failure to refund. Refreshing the variants LIST
  // does not touch the document. (codex adversarial review.)
  const editor = source("src/routes/edit/+page.svelte");
  const watch = editor.slice(
    editor.indexOf("async function watchTranslationJob("),
  );
  const delivered = watch.slice(watch.indexOf('if (state === "delivered")'));

  assert.match(delivered, /if \(language === openLanguage\)/);
  // Clean editor: nothing of theirs to lose, so load what they bought.
  assert.match(
    delivered,
    /if \(!isDirty\) \{[\s\S]{0,300}commitLanguageSwitch\(language, \{ discardUnsaved: true \}\)/,
  );
  // Dirty editor: their work is theirs, so it is a choice — and the choice
  // spells out that keeping it overwrites the translation.
  assert.match(delivered, /askEditorPrompt\(\{/);
  assert.match(delivered, /chooseDeliveredTranslation\(identifier, language\)/);
  const choice = editor.slice(
    editor.indexOf("async function chooseDeliveredTranslation("),
    editor.indexOf("async function reconnectTranslation("),
  );
  assert.match(choice, /translationKeepRevision/);
  assert.match(choice, /translateAiArrivedKeep/);
  assert.match(choice, /apiFetch\(`\$\{resourceUrl\}\?mine=true`\)/);
  assert.match(
    choice,
    /etags\.set\(variantResourceUrl\(identifier, language\), etag\)/,
  );
});

test("a delivered translation for another variant is news, never a navigation (#2348)", () => {
  // Until  a delivery for another language switched the editor to it
  // (clean) or stopped the creator with a load-or-keep prompt (dirty). With
  // several languages landing minutes apart while the creator keeps writing,
  // either one yanked them out of what they were doing. The delivery now only
  // ANNOUNCES itself, with a Review action; the creator decides when to look.
  const editor = source("src/routes/edit/+page.svelte");
  const watch = editor.slice(
    editor.indexOf("async function followTranslationJob("),
  );
  const delivered = watch.slice(watch.indexOf('if (state === "delivered")'));
  const elsewhere = delivered.slice(
    delivered.indexOf("THE DELIVERED VARIANT IS ANOTHER LANGUAGE"),
    delivered.indexOf('if (state === "refunded")'),
  );
  assert.ok(elsewhere.length > 0, "the other-language branch exists");
  assert.match(
    elsewhere,
    /announceTranslationReady\(identifier, language, operationNotice\)/,
  );
  assert.doesNotMatch(elsewhere, /commitLanguageSwitch\(/);
  assert.doesNotMatch(elsewhere, /askEditorPrompt\(/);

  // The open-language delivery still loads in place: the creator is sitting
  // on that variant waiting for it, and nothing moves.
  const open = delivered.slice(
    0,
    delivered.indexOf("THE DELIVERED VARIANT IS ANOTHER LANGUAGE"),
  );
  assert.match(open, /language === openLanguage/);
  assert.match(open, /translateAiDeliveredHere/);

  // The announcement carries the route-safe Review action; the shared helper
  // retains the jobs-store handoff as well as navigation after leaving.
  const announce = editor.slice(
    editor.indexOf("function announceTranslationReady("),
  );
  assert.match(
    announce.slice(0, 600),
    /reviewTranslation\(identifier, language\)/,
  );
  assert.match(
    source("src/lib/editor/translation-review.ts"),
    /translationJobs\.requestReview\(identifier, language\)/,
  );

  // The retired prompt's copy is gone from every catalog with it.
  for (const locale of ["en", "es", "fr", "pt-BR"]) {
    const catalog = JSON.parse(source(`src/lib/locales/${locale}.json`));
    assert.equal(catalog.editor.translateAiArrivedElsewhereBody, undefined);
  }
});

test("the price screen is decided against fresh variants, and names what it replaces", () => {
  // The editor stops watching a job after a bounded window and the queue
  // backlog is not bounded by it, so a draft can land while the panel still
  // says "Not started". Re-reading at the decision point is what stops a
  // creator buying the same translation twice.
  const editor = source("src/routes/edit/+page.svelte");
  const open = editor.slice(
    editor.indexOf("async function openTranslateWithAi("),
  );
  const beforeQuote = open.slice(0, open.indexOf("zpageTranslationQuote("));
  assert.match(beforeQuote, /await refreshVariants\(identifier\);/);

  // And when a draft IS there, the dialog says the purchase replaces it —
  // re-translating is a legitimate choice, but it has to be a choice.
  const dialog = source(
    "src/lib/components/zpageLanguage/TranslateWithAiDialog.svelte",
  );
  assert.match(dialog, /\{#if quote\.existing_variant\}/);
  assert.match(dialog, /translateAiReplacesDraft/);
});

test("losing sight of a job never leaves the panel claiming nothing happened", () => {
  // A silent return left the pre-purchase rows on screen with Translate
  // re-enabled — which makes buying the same language again look reasonable.
  const editor = source("src/routes/edit/+page.svelte");
  const watch = editor.slice(
    editor.indexOf("async function watchTranslationJob("),
  );
  const lost = watch.slice(watch.indexOf("} catch {"));
  // Guarded on the article first: a poll failure for A must not install A's
  // rows into B's panel any more than a successful one may.
  const lostGuard = lost.indexOf("currentZPage?.free2zaddr !== identifier");
  assert.ok(lostGuard !== -1, "the poll-error branch must check the article");
  assert.ok(lostGuard < lost.indexOf("progress.interrupted = true"));
  assert.match(lost.slice(0, 900), /progress\.interrupted = true/);
  assert.match(editor, /data-testid="translation-job-status"/);
  assert.match(editor, /translationConnection/);
  //...and it says nothing about the money it cannot see.
  assert.doesNotMatch(lost.slice(0, 800), /credited back|Nothing was charged/);
});

test("the price the creator saw is the price sent back", () => {
  const editor = source("src/routes/edit/+page.svelte");
  const buy = editor.slice(
    editor.indexOf("async function confirmTranslateWithAi("),
  );
  // `expected_price` comes from the quote object that was rendered, never from
  // a re-quote: a fresh quote between the screen and the click would charge a
  // number nobody agreed to. The server 409s on a mismatch, and that refusal
  // is the point — it must be reachable.
  assert.match(buy, /expected_price: quote\.price/);
  assert.match(buy, /source_digest: quote\.source_digest/);
  assert.doesNotMatch(buy, /zpageTranslationQuote/);
  // No quote means no price was shown, so there is nothing to confirm.
  assert.match(
    buy,
    /if\s*\([\s\S]{0,180}!language[\s\S]{0,180}!quote[\s\S]{0,180}isBuyingTranslation/,
  );
});

test("a changed source refreshes the translation quote", () => {
  const editor = source("src/routes/edit/+page.svelte");
  const buy = editor.slice(
    editor.indexOf("async function confirmTranslateWithAi("),
  );
  assert.match(buy, /\["source_changed", "price_changed"\]\.includes/);
  assert.match(buy, /void openTranslateWithAi\(language\)/);
});

test("a published variant is refused on the price screen, not after the click", () => {
  // The quote is a pure read and prices a published language happily; the
  // PURCHASE is what 409s (`variant_published`). Showing the number and then
  // refusing the only button under it is 's surprise with extra steps.
  const editor = source("src/routes/edit/+page.svelte");
  const open = editor.slice(
    editor.indexOf("async function openTranslateWithAi("),
  );
  assert.match(open, /if \(quote\.existing_variant\?\.is_published\)/);
  assert.match(open, /translateAiErrorVariantPublished/);
  // And the refusal replaces the price rather than sitting beside it: the
  // dialog renders no confirm button while `error` is set.
  const dialog = source(
    "src/lib/components/zpageLanguage/TranslateWithAiDialog.svelte",
  );
  assert.match(
    dialog,
    /\{#if quote && !error && !insufficientFunds && affordable\}/,
  );
});

test("purchase URLs come from the generated client, never hand-rolled", () => {
  const editor = source("src/routes/edit/+page.svelte");
  assert.match(editor, /zpageTranslationQuote,/);
  assert.match(editor, /zpageTranslationPurchase,/);
  assert.match(editor, /zpageTranslationStatus,/);
  assert.doesNotMatch(editor, /["`']\/api\/zpage\/[^"`']*translate/);
});

test("every refusal becomes a sentence that says what to do next", () => {
  // 's silent 409 is the bug this closes: a creator re-buying an
  // already-published translation saw nothing at all.
  const t = (_code, fallback, params = {}) =>
    fallback.replace(/\{(\w+)\}/g, (_m, name) => String(params[name]));
  const say = (status, code) =>
    translationPurchaseError(
      { status, data: { code, error: "server prose" } },
      {
        t,
        language: "Spanish",
      },
    );

  assert.match(
    say(409, "variant_published"),
    /Spanish translation is published/,
  );
  assert.match(say(409, "variant_published"), /nothing was charged/i);
  assert.match(
    say(409, "published_variant_limit"),
    /Unpublish or delete one first/,
  );
  assert.match(
    say(409, "draft_variant_limit"),
    /Delete or publish an existing draft first/,
  );
  assert.match(say(409, "draft_variant_limit"), /nothing was charged/i);
  assert.match(say(402, "insufficient_funds"), /enough 2Z/);
  assert.match(say(409, "price_changed"), /new price/);
  assert.match(say(409, "source_changed"), /article changed.*new quote/i);
  assert.doesNotMatch(say(409, "source_changed"), /price changed/i);
  assert.match(
    say(409, "translation_in_progress"),
    /One translation at a time/,
  );
  assert.match(say(503, "translation_backlog"), /Try again in a few minutes/);
  assert.match(say(400, "not_translatable"), /Spanish/);

  // A retry that is undecided is NEVER reported as a failure or a charge.
  assert.match(say(409, "request_in_progress"), /never a second charge/);

  // An unknown code falls through to the server's own actionable prose rather
  // than to a generic apology that throws it away.
  assert.equal(say(409, "some_future_code"), "server prose");
  //...and with neither, to a line whose claim about the money is one we can
  // actually stand behind. A 400 with no body IS a decision — the server
  // refused before touching anything — so "nothing was charged" holds. A 500
  // or a dead connection is not, and gets the honest unknown copy instead;
  // see the ambiguity test below.
  assert.match(
    translationPurchaseError(
      { status: 400, data: null },
      { t, language: "Spanish" },
    ),
    /Nothing was charged/,
  );
});

test("a purchase settles as delivered or refunded, never as neither", () => {
  // `queued` is the only non-terminal state the contract defines. An
  // unrecognized one must stop the poll, not spin forever and not be reported
  // as an outcome we were not told about.
  assert.equal(translationJobState({ status: "queued" }), "queued");
  assert.equal(translationJobState({ status: "delivered" }), "delivered");
  assert.equal(translationJobState({ status: "refunded" }), "refunded");
  assert.equal(translationJobState({ status: "something_new" }), "unknown");
  assert.equal(translationJobState(null), "unknown");
  assert.equal(translationJobState(undefined), "unknown");

  const editor = source("src/routes/edit/+page.svelte");
  const watch = editor.slice(
    editor.indexOf("async function watchTranslationJob("),
  );
  // Only "delivered" claims a draft exists, and only "refunded" claims the 2Z
  // came back. The timeout branch claims neither — it says where to look.
  assert.match(watch, /if \(state === "delivered"\)/);
  assert.match(watch, /if \(state === "refunded"\)/);
  assert.match(watch, /translateAiStillRunning/);
});

test("the idempotency key is a UUIDv4, which is all the server accepts", () => {
  // `_idempotency_key` in `views/translate.py` rejects anything else, and a
  // rejected key means the double-charge protection is simply not there.
  const seen = new Set();
  for (let i = 0; i < 50; i += 1) {
    const key = newIdempotencyKey();
    assert.match(
      key,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    seen.add(key);
  }
  assert.equal(seen.size, 50, "keys must not repeat — one key is one purchase");
});

test("the quote prices saved text, so an unsaved editor saves first", () => {
  const editor = source("src/routes/edit/+page.svelte");
  const open = editor.slice(
    editor.indexOf("async function openTranslateWithAi("),
  );
  // The quote's `source_digest` binds the purchase to the stored body. Quoting
  // over unsaved edits shows a price for text the server has never seen, and
  // the purchase would then 409 `price_changed` — a baffling way to learn you
  // had not saved.
  assert.match(
    open,
    /if \(isDirty && canRelabel\) \{[\s\S]{0,600}handleSave\(/,
  );
  // A save that could not happen is said out loud, not quoted around.
  assert.match(open, /translateAiNeedsSave/);
});

test("the purchase-time ceiling check is on the server, not just the client", () => {
  //,. A UI that merely hid the button would still let any other client —
  // ZUULI, the MCP server, curl — buy a translation that can never be
  // published or stored. The refusal has to live where the money does.
  const view = repoFile("py/free2z/dj/apps/g12f/views/translate.py");
  assert.match(view, /published_variant_limit/);
  assert.match(view, /def published_variant_limit_error\(/);
  assert.match(view, /draft_variant_limit/);
  assert.match(view, /def draft_variant_limit_error\(/);
  // Called on BOTH routes: the quote so the price screen never shows a number
  // for something unbuyable, the purchase because a UI check is not a rule.
  assert.equal(
    (view.match(/self\.published_variant_limit_error\(/g) ?? []).length,
    2,
  );
  assert.equal(
    (view.match(/self\.draft_variant_limit_error\(/g) ?? []).length,
    2,
  );
  // And on the purchase it sits BELOW the idempotency claim, with every other
  // mutable check — above it, a retry of a purchase that already succeeded
  // would be told "the ceiling is full, nothing was charged" about 2Z that
  // are already gone.
  //
  // both purchases run their per-language checks through ONE
  // method, `item_refusal`, so the ceilings are asserted to live inside it and
  // `item_refusal` is asserted to run after each purchase's claim.
  const refusal = view.slice(
    view.indexOf("    def item_refusal("),
    view.indexOf("    def capacity_refusal("),
  );
  assert.match(refusal, /self\.published_variant_limit_error\(/);
  assert.match(refusal, /self\.draft_variant_limit_error\(/);
  const post = view.slice(view.indexOf("    def post(self, request"));
  const claimed = post.indexOf("_claim(request.user");
  const checked = post.indexOf("self.item_refusal(");
  assert.ok(claimed >= 0 && checked >= 0, "post claims, then checks");
  assert.ok(
    claimed < checked,
    "the published and draft ceiling checks must run after the idempotency claim",
  );
  const bulk = repoFile("py/free2z/dj/apps/g12f/views/translate_batch.py");
  const bulkPost = bulk.slice(bulk.indexOf("    def post(self, request"));
  const bulkClaimed = bulkPost.indexOf("_claim_batch(request.user");
  const bulkChecked = bulkPost.indexOf("self._purchase(");
  assert.ok(
    bulkClaimed >= 0 && bulkChecked >= 0,
    "bulk post claims, then buys",
  );
  assert.ok(
    bulkClaimed < bulkChecked,
    "the bulk purchase must claim its batch key before any ceiling check",
  );
  const purchase = bulk.slice(bulk.indexOf("    def _purchase("));
  assert.match(purchase, /self\.item_refusal\(/);
});

test("a published translation is seen in BOTH storage shapes", () => {
  // A published `ZPageVariant` with no legacy `ZPageTranslation` mirror is
  // live content since reads flipped, and every guard here used to ask only
  // the legacy table — reporting "this language is free" about an article
  // that is on the site, then overwriting it with machine output and
  // unpublishing it. (codex adversarial review, finding 1.)
  const variants = repoFile("py/free2z/dj/apps/g12f/variants.py");
  assert.match(
    variants,
    /def occupied_translation\(zpage_id, language, \*, lock=False\)/,
  );

  const view = repoFile("py/free2z/dj/apps/g12f/views/translate.py");
  const existing = view.slice(view.indexOf("    def existing_variant("));
  assert.match(
    existing.slice(0, 1400),
    /occupied_translation\(page\.pk, language\)/,
  );

  // The worker re-checks under the parent's lock, and that is the last thing
  // between a paid job and a creator's live article.
  const task = repoFile("py/free2z/dj/apps/g12f/translation/tasks.py");
  assert.match(task, /occupied_translation\(page\.pk, language\)/);
  assert.match(task, /occupied_translation\(page\.pk, language, lock=True\)/);
});

// --- `settled` is a fourth terminal status ------------------------
//
// The money side of  added `settled`: a failure in which part of the charge
// covers provider work that had already been done. The editor's risk is not the
// money, it is the POLLING — two call sites each carried their own inline
// `["delivered", "refunded"]`, and a terminal status missing from either one
// leaves a creator watching a job that is already over.

test("every terminal translation status is recognized as terminal", () => {
  assert.equal(translationJobState({ status: "settled" }), "settled");
  for (const status of TERMINAL_TRANSLATION_STATUSES) {
    assert.ok(
      isTerminalTranslationJob({ status }),
      `${status} must be terminal`,
    );
  }
  assert.deepEqual([...TERMINAL_TRANSLATION_STATUSES].sort(), [
    "delivered",
    "refunded",
    "settled",
  ]);
  // `queued` is the only status the contract defines as non-terminal, and an
  // unrecognized one keeps the PRIOR behaviour (shows the "check status"
  // affordance rather than declaring an outcome) —  adds a status, it
  // does not change what happens to a status nobody knows.
  assert.equal(isTerminalTranslationJob({ status: "queued" }), false);
  assert.equal(isTerminalTranslationJob({ status: "from_2027" }), false);
  assert.equal(isTerminalTranslationJob(null), false);
  assert.equal(isTerminalTranslationJob(undefined), false);
});

test("the editor keeps no inline terminal-status list to fall behind", () => {
  const editor = source("src/routes/edit/+page.svelte");
  // Formatting-insensitive on purpose: prettier decides where this array
  // breaks, and a test pinned to one layout goes red on a reformat instead of
  // on the bug (CLAUDE.md, source-scraping tests).
  assert.equal(
    /\[\s*["']delivered["']\s*,\s*["']refunded["']\s*,?\s*\]/.test(editor),
    false,
    "an inline terminal-status list is how a new status gets missed — use " +
      "isTerminalTranslationJob()",
  );
  assert.match(editor, /isTerminalTranslationJob\(/);
  // And it says something true about the money for a settled job, rather than
  // falling through to "all your 2Z came back".
  assert.match(editor, /===\s*["']settled["']/);
  assert.match(editor, /translationSettled/);
  assert.match(editor, /translateAiSettled/);
});

test("the purchase screen states the terms the settlement actually applies", () => {
  // codex adversarial review, finding 1 (its riskiest line).
  //
  // This dialog's whole job is that no 2Z is committed from a screen that has
  // not shown the number and said what happens to it.  introduced one
  // exception to "every 2Z comes back", so leaving the old unconditional
  // promise here would charge a creator against terms they were never shown —
  // and the toast went further, telling them the very thing that now costs
  // money ("rewriting the text cancels the translation and returns your 2Z")
  // was free.
  //  folded the old separate `translateAiRefundNotice` into
  // `translateAiDraftNotice`, so the promise to qualify moved. The assertion
  // follows the promise, not the key it used to live under.
  const dialog = source(
    "src/lib/components/zpageLanguage/TranslateWithAiDialog.svelte",
  );
  assert.equal(
    /your 2Z come straight back\.["\s]*[,)]/.test(dialog),
    false,
    "the dialog still promises an unconditional refund",
  );
  assert.match(dialog, /the work already done is charged for/);
  // The number is on the screen in the same sentence as the exception, so the
  // ceiling a creator is told about is the one the server enforces.
  assert.match(dialog, /never more than the \{price\} 2Z/);
  // It must name the WHOLE chargeable set, not the easiest example of it.
  // `settlement.FAULT_BY_CODE`'s REQUESTER_ACTION entries are editing the
  // article, relabelling its language, and editing or publishing the
  // translation — and an earlier draft named only the first, leaving
  // publishing the translation (the free-cancel route this issue closed)
  // unnamed on the one screen that asks for consent. (Reviewer of,
  // finding 3.)
  assert.match(dialog, /changing this article/);
  assert.match(dialog, /publishing its translation/);

  const editor = source("src/routes/edit/+page.svelte");
  assert.match(editor, /the work already done is charged for/);
  assert.equal(
    /cancels the translation and returns your 2Z\.["\s]*[,)]/.test(editor),
    false,
    "the purchase toast still says cancelling is free",
  );

  // The poll-timeout message is reachable from exactly the state in which the
  // exception can be triggered — the job is still generating and the creator's
  // next move might be to edit the article — so it must not promise an
  // unconditional refund either. (codex round 5.)
  // EVERY "if it fails" promise in this file must carry its exception in the
  // same string.
  //
  // The previous guard was a literal phrase plus nothing —
  // `/if it fails your 2Z come back/`, case-sensitive, written against round 5's
  // "...when it is done, AND IF it fails...". This round re-split the sentence
  // to "...when it is done. IF it fails...", the capital moved, and the regex
  // went inert: reverting the poll-timeout default to a fully unconditional
  // promise passed all 62 tests. Adding `/i` then made it match the CORRECT
  // text too, because the qualified sentence also starts with that phrase.
  //
  // Both failures come from pinning the wording instead of the invariant. The
  // invariant is "the promise and its exception travel together", so that is
  // what this checks — and it holds for any number of these messages, in any
  // phrasing, including ones nobody has written yet.
  for (const match of editor.matchAll(/if it fails/gi)) {
    const after = editor.slice(match.index);
    // The rest of this string literal: up to the closing quote that ends it.
    const literal = after.slice(0, after.search(/",|"\s*\n/) + 1 || 400);
    assert.match(
      literal,
      /unless/i,
      `an "if it fails" promise with no exception: ${literal.slice(0, 120)}`,
    );
  }

  // Every locale carries the corrected terms, not just English: a creator
  // reading the Spanish dialog is being shown terms too, and  can charge
  // them on the strength of it.
  //
  // The word that marks the exception, per language. A length comparison used to
  // stand in for this and it was a bad proxy — 's rewrite made every
  // message shorter, so "longer than the delivered message" would have passed a
  // catalogue whose promise was still unconditional.
  const qualifier = {
    en: /charged for/i,
    es: /se cobra/i,
    fr: /factur/i,
    "pt-BR": /cobrado/i,
  };
  // What each call site actually passes. A placeholder the call site does not
  // pass renders LITERALLY, so a catalogue promising "never more than the
  // {price} 2Z" with no `price` argument shows a creator a ceiling they cannot
  // read — the consent is then worse than the unqualified promise it replaced.
  const callSiteArgs = {
    translateAiDraftNotice: ["price"],
    translateAiStarted: ["language", "price"],
    translateAiStillRunning: ["language"],
    translateAiSettled: ["language", "price", "refunded", "billed"],
    translationSettled: ["language", "price", "refunded", "billed"],
  };

  for (const locale of ["en", "es", "fr", "pt-BR"]) {
    const strings = JSON.parse(source(`src/lib/locales/${locale}.json`)).editor;
    assert.ok(
      strings.translateAiDraftNotice.includes("{price}"),
      `${locale} draft notice must name the ceiling it can charge up to`,
    );
    // The three promises  had to qualify, in every language.
    for (const key of [
      "translateAiDraftNotice",
      "translateAiStarted",
      "translateAiStillRunning",
    ]) {
      assert.match(
        strings[key],
        qualifier[locale],
        `${locale} ${key} promises a refund with no exception`,
      );
    }
    // The dialog's terms name publishing THE TRANSLATION, in every language.
    // Matching a bare "publish" would pass on the English notice's unrelated
    // "before publishing", which is about the draft the creator receives — so
    // the phrase has to be the one in the exception clause. An English-only
    // check would also let three catalogues keep describing a narrower set
    // than the code can charge for.
    assert.match(
      strings.translateAiDraftNotice,
      {
        en: /publishing its translation/,
        es: /publicando su traducción/,
        fr: /publiez sa traduction/,
        "pt-BR": /publicando a tradução dele/,
      }[locale],
      `${locale} draft notice does not name publishing the translation, ` +
        `which is chargeable`,
    );
    // The settled messages exist everywhere and show the split — a creator who
    // cannot see which part was kept cannot tell a settlement from a bug.
    for (const key of ["translateAiSettled", "translationSettled"]) {
      for (const token of ["{refunded}", "{billed}", "{price}"]) {
        assert.ok(
          strings[key]?.includes(token),
          `${locale} ${key} is missing ${token}`,
        );
      }
    }
    for (const [key, allowed] of Object.entries(callSiteArgs)) {
      const used = [...strings[key].matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      for (const token of used) {
        assert.ok(
          allowed.includes(token),
          `${locale} ${key} uses {${token}}, which its call site does not ` +
            `pass — it would render literally`,
        );
      }
    }
  }
});

test("the purchase declares which refund terms it displayed", () => {
  // codex adversarial review, round 3, its riskiest line.
  //
  // The server bills an attributable failure only when the purchase declared
  // the terms it was bought under, because an editor tab opened before the
  // deploy still shows the old unconditional promise. Two ways to break that,
  // and both are silent: stop sending the field (every settlement quietly
  // becomes a full refund) or send a number the backend does not recognize.
  const editor = source("src/routes/edit/+page.svelte");
  const buy = editor.slice(
    editor.indexOf("async function confirmTranslateWithAi("),
    editor.indexOf("const renderedHtml = $derived("),
  );
  assert.match(
    buy,
    /settlement_policy:\s*SETTLEMENT_POLICY_VERSION/,
    "the purchase must declare the terms this build showed",
  );

  // BOTH calls must send it. The ambiguous-outcome recovery is "re-send the
  // SAME request", and it has to be the same request in fact: it once carried
  // only the price and the digest, so a purchase that reached the server on the
  // retry recorded LEGACY terms while the identical purchase that landed first
  // recorded current ones — the same screen, different terms, decided by a
  // network blip. One payload object, sent twice. (codex round 6.)
  const calls = buy.match(/zpageTranslationPurchase\(/g) ?? [];
  assert.equal(calls.length, 2, "the purchase and its one recovery re-send");
  const inlineBodies = buy.match(/expected_price:\s*quote\.price/g) ?? [];
  assert.equal(
    inlineBodies.length,
    1,
    "the recovery must reuse the purchase payload, not rebuild it — a rebuilt " +
      "one is how it silently stopped declaring the terms",
  );

  // The two halves of the contract, read off both sides rather than restated.
  const backend = repoFile("py/free2z/dj/apps/g12f/translation/settlement.py");
  const declared = backend.match(/METERED_POLICY_VERSION\s*=\s*(\d+)/);
  assert.ok(declared, "the backend must name a current policy version");
  assert.equal(
    String(SETTLEMENT_POLICY_VERSION),
    declared[1],
    "the client would declare terms the server does not honour, so every " +
      "settlement would silently become a full refund",
  );
});

test("the backend and the client agree on the terminal statuses", () => {
  // The contract's own list, read off the serializer rather than restated: a
  // status the server can emit and the client does not know is a spinner that
  // never stops.
  const serializer = repoFile(
    "py/free2z/dj/apps/g12f/serializers/translate.py",
  );
  const choices = serializer.match(
    /choices=\[\s*["']queued["'],\s*["']delivered["'],\s*["']refunded["'],\s*["']settled["'],?\s*\]/,
  );
  assert.ok(choices, "the job serializer must declare all four statuses");
  for (const status of TERMINAL_TRANSLATION_STATUSES) {
    assert.ok(
      choices[0].includes(status),
      `${status} is terminal in the client but not a server choice`,
    );
  }
});
