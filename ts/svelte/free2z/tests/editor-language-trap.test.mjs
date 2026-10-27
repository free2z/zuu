// Regression cover for the editor language trap reported in.
//
// The owner-observed repro, verbatim:
//   1. A zPage whose `source_language` is `und` shows "Original (language
//      unknown)" in the Article language dropdown.
//   2. The creator selects "English" — the obvious, correct-seeming answer.
//   3. The editor goes blank. Title, description and body all empty.
//   4. Switching back snaps the dropdown and toasts "Save this translation
//      before switching languages."
//   5. There is no way out through the UI.
//
// Two things had to change. The picker must not be able to land a creator in
// a blank variant at all (step 3 is now an explicitly labelled action), and
// when work *is* unsaved the switch must offer save / discard / cancel like
// every other navigation in the editor (step 5 is now impossible).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  LANGUAGE_SWITCH_CHOICES,
  canDeleteTranslationLanguage,
  editorLanguageMenu,
  planLanguageSwitch,
  translationVariantUrl,
} from "../src/lib/zpage-language.js";

const UI_ROOT = path.dirname(fileURLToPath(import.meta.url));
const source = (relativePath) =>
  fs.readFileSync(path.join(UI_ROOT, "..", relativePath), "utf8");

const SUPPORTED = ["en", "es", "fr", "pt-BR"];

/**
 * A minimal model of the editor's language surface, driven by the very
 * helpers `src/routes/edit/+page.svelte` uses. It reproduces the parts that
 * mattered: a variant with no content blanks the composer, autosave refuses
 * an empty body, and every field handler marks the editor dirty.
 */
function createEditor({ sourceLanguage, variants = {}, openLanguage }) {
  const stored = {
    [sourceLanguage]: variants[sourceLanguage] ?? "",
    ...variants,
  };
  const editor = {
    sourceLanguage,
    selectedLanguage: openLanguage ?? sourceLanguage,
    content: stored[openLanguage ?? sourceLanguage] ?? "",
    changeVersion: 0,
    savedVersion: 0,
    blockedReason: null,
    writes: [],
  };

  const availableLanguages = () =>
    Object.keys(stored).filter((code) => code !== sourceLanguage);

  const isDirty = () => editor.changeVersion !== editor.savedVersion;

  const menu = () =>
    editorLanguageMenu({
      sourceLanguage,
      availableLanguages: availableLanguages(),
      selectedLanguage: editor.selectedLanguage,
      supportedLanguages: SUPPORTED,
    });

  /** Any field handler — title, description, cover, body, tags, vanity. */
  const touch = (value) => {
    if (value !== undefined) editor.content = value;
    editor.changeVersion += 1;
    editor.blockedReason = null;
  };

  /** `handleSave({ isAuto: true })`. Refuses an empty body, and says why. */
  const autoSave = () => {
    editor.blockedReason = null;
    if (!editor.content.trim()) {
      editor.blockedReason = "content-required";
      return false;
    }
    stored[editor.selectedLanguage] = editor.content;
    editor.writes.push({
      language: editor.selectedLanguage,
      content: editor.content,
    });
    editor.savedVersion = editor.changeVersion;
    return true;
  };

  const discardPendingChanges = () => {
    editor.changeVersion = 0;
    editor.savedVersion = 0;
    editor.blockedReason = null;
  };

  const open = (language) => {
    editor.selectedLanguage = language;
    // Blanking only ever happens for a variant that does not exist yet.
    editor.content = stored[language] ?? "";
    editor.isNewTranslationDraft = !(language in stored);
  };

  /** `requestLanguage()` — the whole point of the fix. */
  const requestLanguage = (nextLanguage, choose = () => "cancel") => {
    const plan = planLanguageSwitch({
      currentLanguage: editor.selectedLanguage,
      nextLanguage,
      isDirty: isDirty(),
      isSaving: false,
    });

    if (plan.action === "none") return { switched: false, prompted: false };

    if (plan.action === "prompt") {
      const choice = choose(LANGUAGE_SWITCH_CHOICES);
      assert.ok(
        LANGUAGE_SWITCH_CHOICES.includes(choice),
        "the prompt offers save, discard and cancel — nothing else",
      );

      if (choice === "cancel") {
        return { switched: false, prompted: true };
      }

      if (choice === "discard") {
        discardPendingChanges();
      } else if (!autoSave() || isDirty()) {
        return {
          switched: false,
          prompted: true,
          blockedReason: editor.blockedReason,
        };
      }
    }

    open(nextLanguage);
    return { switched: true, prompted: plan.action === "prompt" };
  };

  return {
    state: editor,
    stored,
    isDirty,
    menu,
    touch,
    autoSave,
    requestLanguage,
    availableLanguages,
  };
}

test("the language picker never offers a variant that does not exist yet", () => {
  // Step 1-3 of the repro. An `und` original with no translations offers
  // exactly one thing to switch to: itself. "English" is not in the picker at
  // all, so selecting it — and being blanked — is not reachable from here.
  const menu = editorLanguageMenu({
    sourceLanguage: "und",
    availableLanguages: [],
    selectedLanguage: "und",
    supportedLanguages: SUPPORTED,
  });

  assert.deepEqual(menu.existing, ["und"]);
  assert.deepEqual(menu.missing, SUPPORTED);

  // Once a Spanish translation exists it joins the picker, and drops out of
  // the "start a new translation" list.
  const withSpanish = editorLanguageMenu({
    sourceLanguage: "und",
    availableLanguages: ["es"],
    selectedLanguage: "und",
    supportedLanguages: SUPPORTED,
  });
  assert.deepEqual(withSpanish.existing, ["und", "es"]);
  assert.deepEqual(withSpanish.missing, ["en", "fr", "pt-BR"]);
});

test("a blank variant that is open stays in the picker so the control never lies", () => {
  const menu = editorLanguageMenu({
    sourceLanguage: "und",
    availableLanguages: [],
    selectedLanguage: "fr",
    supportedLanguages: SUPPORTED,
  });

  assert.deepEqual(menu.existing, ["und", "fr"]);
  assert.ok(!menu.missing.includes("fr"));
});

test("#980 repro: an empty new translation is always escapable by discarding", () => {
  const editor = createEditor({
    sourceLanguage: "und",
    variants: { und: "The real English article." },
  });

  // The creator explicitly starts an English version. Nothing is dirty yet,
  // so no prompt: the editor opens blank on purpose.
  const started = editor.requestLanguage("en");
  assert.deepEqual(started, { switched: true, prompted: false });
  assert.equal(editor.state.content, "");
  assert.equal(editor.state.isNewTranslationDraft, true);

  // They touch something — a tag, the vanity, the cover, anything. Before the
  // fix this armed the trap: dirty + empty body = a save that always failed.
  editor.touch();
  assert.equal(editor.isDirty(), true);
  assert.equal(editor.autoSave(), false);
  assert.equal(editor.state.blockedReason, "content-required");

  // Step 5: getting back out. Discarding always works.
  const back = editor.requestLanguage("und", () => "discard");
  assert.deepEqual(back, { switched: true, prompted: true });
  assert.equal(editor.state.selectedLanguage, "und");
  assert.equal(editor.state.content, "The real English article.");
  assert.equal(editor.isDirty(), false);

  // Nothing was written. No junk "English translation" was created to buy the
  // creator's way out, and the original is untouched.
  assert.deepEqual(editor.state.writes, []);
  assert.deepEqual(editor.availableLanguages(), []);
  assert.equal(editor.stored.und, "The real English article.");
});

test("cancelling leaves the creator exactly where they were, with their edits", () => {
  const editor = createEditor({
    sourceLanguage: "und",
    variants: { und: "The real English article." },
  });

  editor.requestLanguage("es");
  editor.touch("Un borrador a medias.");

  const cancelled = editor.requestLanguage("und", () => "cancel");
  assert.deepEqual(cancelled, { switched: false, prompted: true });
  assert.equal(editor.state.selectedLanguage, "es");
  assert.equal(editor.state.content, "Un borrador a medias.");
  assert.equal(editor.isDirty(), true);
});

test("saving before a switch still works, and a refused save names its reason", () => {
  const editor = createEditor({
    sourceLanguage: "en",
    variants: { en: "Original." },
  });

  editor.requestLanguage("fr");
  editor.touch("Une vraie traduction.");

  const saved = editor.requestLanguage("en", () => "save");
  assert.deepEqual(saved, { switched: true, prompted: true });
  assert.deepEqual(editor.state.writes, [
    { language: "fr", content: "Une vraie traduction." },
  ]);
  assert.deepEqual(editor.availableLanguages(), ["fr"]);

  // The old dead end: dirty with an empty body. It now reports *why* instead
  // of a generic "save this translation first", and discard is still open.
  editor.requestLanguage("es");
  editor.touch();
  const refused = editor.requestLanguage("en", () => "save");
  assert.deepEqual(refused, {
    switched: false,
    prompted: true,
    blockedReason: "content-required",
  });
  const rescued = editor.requestLanguage("en", () => "discard");
  assert.equal(rescued.switched, true);
  assert.equal(editor.state.selectedLanguage, "en");
});

test("a clean switch never prompts", () => {
  assert.deepEqual(
    planLanguageSwitch({
      currentLanguage: "en",
      nextLanguage: "fr",
      isDirty: false,
      isSaving: false,
    }),
    { action: "switch" },
  );
  assert.deepEqual(
    planLanguageSwitch({ currentLanguage: "en", nextLanguage: "en" }),
    { action: "none" },
  );
  // An in-flight save is unsaved work too — it used to be its own dead end.
  assert.deepEqual(
    planLanguageSwitch({
      currentLanguage: "en",
      nextLanguage: "fr",
      isDirty: false,
      isSaving: true,
    }),
    { action: "prompt" },
  );
});

test("an unsaved new page relabels in place — it is never reloaded or discarded", () => {
  // A draft that exists only in this tab has nothing on the server to reload
  // and nothing saved to discard. Reloading would destroy it; prompting to
  // "discard" would mark never-saved text clean and drop the leave-guard.
  for (const isDirty of [false, true]) {
    assert.deepEqual(
      planLanguageSwitch({
        currentLanguage: "en",
        nextLanguage: "es",
        isDirty,
        isNewPage: true,
      }),
      { action: "relabel" },
    );
  }

  // Same language is still a no-op, even for a new page.
  assert.deepEqual(
    planLanguageSwitch({
      currentLanguage: "en",
      nextLanguage: "en",
      isNewPage: true,
    }),
    { action: "none" },
  );

  const editor = source("src/routes/edit/+page.svelte");
  assert.match(
    editor,
    /plan\.action === "relabel"[\s\S]{0,400}selectedLanguage = nextLanguage;[\s\S]{0,80}updateEditorUrl\("new"\)/,
  );
  // The relabel path must not touch the dirty counters.
  assert.doesNotMatch(
    editor,
    /plan\.action === "relabel"[\s\S]{0,400}discardPendingChanges/,
  );
});

test("an open prompt suspends autosave so discard cannot lose the race", () => {
  const editor = source("src/routes/edit/+page.svelte");

  // A prompt waits on a human, potentially for minutes. A live 2.5s autosave
  // timer would persist the very edits the creator is about to discard — and
  // a late PUT during a delete would resurrect the deleted row.
  assert.match(
    editor,
    /function askEditorPrompt\([\s\S]{0,600}clearAutoSaveTimer\(\);/,
  );
  // Clearing once is not enough: markDirty() from a late image upload or a
  // stray keystroke must not re-arm the clock behind the dialog...
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
  //...and a timer armed before the prompt opened must not fire behind it.
  assert.match(
    autosaveGuard,
    /if\(editorPrompt\|\|isDeletingTranslation\|\|isDeletingPage\|\|isRelabelling\)\{[\s\S]*return;/,
  );
  // The clock restarts the moment the decision is made, unless the caller
  // makes the editor clean.
  assert.match(
    editor,
    /function settleEditorPrompt\([\s\S]{0,600}if \(isDirty\) \{\s*\n\s*scheduleAutoSave\(\);/,
  );
  // Hiding the tab is another autosave trigger; it defers to the prompt too.
  assert.match(editor, /!editorPrompt &&\s*\n\s*isDirty &&/);
});

test("deleting a translation is serialized against an in-flight save", () => {
  const editor = source("src/routes/edit/+page.svelte");
  const deleteFn = editor.slice(
    editor.indexOf("async function deleteTranslation("),
  );

  // A translation PUT that lands after the DELETE would be re-applied by the
  // backend's update_or_create, resurrecting the row and making the success
  // toast a lie.
  assert.match(
    deleteFn,
    /while \(currentSavePromise\) \{\s*\n\s*await currentSavePromise;\s*\n\s*\}/,
  );
  // And the affordance itself is unavailable while a save is running. The
  // per-row Delete now lives in the Translations panel, which disables every
  // action from one `busy` prop — `isSaving` included.
  // Every one of these makes a per-row action unsafe, `isTranslating`
  // included since P8: a purchase is writing a variant server-side and the
  // panel refresh at the end of it must not race a click.
  const busyProp = editor.slice(editor.indexOf("<TranslationsPanel"));
  for (const flag of [
    "isSaving",
    "isRelabelling",
    "isDeletingTranslation",
    "isSwitchingLanguage",
    "isTranslating",
  ]) {
    assert.match(
      busyProp.slice(0, 600),
      new RegExp(`busy=\\{[\\s\\S]*?${flag}`),
    );
  }
  assert.match(
    editor,
    /onDelete=\{\(language\) => void deleteTranslation\(language\)\}/,
  );
});

test("every delete refusal maps to something the creator can act on", () => {
  const editor = source("src/routes/edit/+page.svelte");
  const deleteFn = editor.slice(
    editor.indexOf("async function deleteTranslation("),
  );

  // the delete addresses the variant by its own language
  // (`DELETE /api/zpage/{id}/variants/{lang}/`), so there is nothing for the
  // client to assert about the source: the API refuses `origin: "source"` with
  // a 400 on its own. That is what retired the X-Free2Z-Source-Language
  // precondition the deprecated `/translations/` route needed for the `und`
  // cohort — the route itself is now unambiguous.
  //
  // The one precondition it DOES carry now is `If-Match`, and it is a
  // freshness check rather than a capability one: it refuses a delete built on
  // a version of the translation somebody else has already replaced.
  assert.match(
    deleteFn,
    /await zpageVariantsDestroy\(identifier, language, \{\s*\n\s*headers: preconditionHeaders\(/,
  );
  assert.match(deleteFn, /status === 400[\s\S]{0,200}deleteTranslationRefused/);
  assert.match(
    deleteFn,
    /status === PRECONDITION_FAILED[\s\S]{0,900}deleteTranslationConflict/,
  );
  // A refused delete must never mark the editor clean: nothing was deleted, so
  // pending edits still have somewhere to go.
  assert.doesNotMatch(
    deleteFn,
    /status === PRECONDITION_FAILED[\s\S]{0,900}discardPendingChanges/,
  );
  // 404 is ambiguous — the queryset is owner-scoped, so it means either
  // "already gone" or "this session no longer owns the page". Guessing
  // "success" would discard edits for a translation that may still exist.
  assert.match(deleteFn, /status === 404[\s\S]{0,400}deleteTranslationMissing/);
  assert.doesNotMatch(
    deleteFn,
    /status === 404[\s\S]{0,400}discardPendingChanges/,
  );
  assert.match(
    deleteFn,
    /status === 401 \|\| status === 403[\s\S]{0,200}deleteTranslationForbidden/,
  );
});

test("a delete in flight blocks autosave, and a deleted variant is never returned to", () => {
  const editor = source("src/routes/edit/+page.svelte");

  // The composer stays editable once the confirmation closes. A PUT started
  // during a slow DELETE would be re-applied by update_or_create, resurrecting
  // the row while the UI reports a successful deletion.
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
    autosaveGuard,
    /if\(editorPrompt\|\|isDeletingTranslation\|\|isDeletingPage\|\|isRelabelling\)\{/,
  );

  // If the post-delete navigation fails, falling back to the deleted language
  // would let the next save recreate it. Force a real page load instead.
  assert.match(
    editor,
    /commitLanguageSwitch\(sourceLanguage \?\? "", \{ canReturn: false \}\)/,
  );
  assert.match(
    editor,
    /if \(canReturn\) \{[\s\S]{0,400}return(?: false)?;\s*\n\s*\}[\s\S]{0,400}window\.location\.assign\(nextHref\)/,
  );
});

test("selectedLanguage follows the loaded route, it never leads it", () => {
  const editor = source("src/routes/edit/+page.svelte");
  const commit = editor.slice(
    editor.indexOf("async function commitLanguageSwitch("),
    editor.indexOf("async function requestLanguage("),
  );

  // `selectedLanguage` picks the endpoint a save writes to. Assigning it
  // before `goto()` resolves let a Cmd-S during a slow navigation PUT the body
  // still on screen over the *other* language's translation.
  assert.doesNotMatch(commit, /selectedLanguage = nextLanguage/);
  assert.match(
    commit,
    /isSwitchingLanguage = true;[\s\S]{0,700}await goto\(nextHref/,
  );
  assert.match(commit, /finally \{\s*\n\s*isSwitchingLanguage = false;/);
  // The rehydration effect is what sets it, from the route data.
  assert.match(editor, /selectedLanguage = routeData\.requestedLanguage/);

  // Saves are suspended across that awaited navigation, so the composer must
  // not accept input it would silently replace on hydration.
  assert.match(
    commit,
    /document\.activeElement as HTMLElement \| null\)\?\.blur\?\.\(\)/,
  );
  const busyOverlay = editor
    .slice(
      editor.indexOf("{#if isSwitchingLanguage"),
      editor.indexOf("{/if}", editor.indexOf("{#if isSwitchingLanguage")) +
        "{/if}".length,
    )
    .replace(/\s+/g, "");
  assert.match(
    busyOverlay,
    /\{#ifisSwitchingLanguage\|\|isDeletingTranslation\|\|isDeletingPage\}/,
  );
  assert.match(busyOverlay, /isDeletingPage\}[\s\S]*editor\.deletingPage/);
  assert.match(busyOverlay, /editor\.switchingLanguage/);

  const requestGuard = editor
    .slice(
      editor.indexOf("async function requestLanguage("),
      editor.indexOf("const plan = planLanguageSwitch"),
    )
    .replace(/\s+/g, "");
  assert.match(
    requestGuard,
    /if\(isSwitchingLanguage\|\|isDeletingTranslation\|\|isDeletingPage\)return;/,
  );
});

test("deleting discloses that it discards unsaved shared article settings", () => {
  const editor = source("src/routes/edit/+page.svelte");
  // A PUT after the DELETE would recreate the variant, so the delete has to
  // abandon everything unsaved — including tags, payout address and canonical
  // URL, which belong to the article, not to the translation.
  // Only when the variant being deleted is the one on screen — deleting some
  // other language never touches this editor's unsaved work, so claiming it
  // would be a lie in the other direction.
  assert.match(
    editor,
    /isDirty && isOpenVariant\s*\n\s*\?[\s\S]{0,200}editor\.deleteTranslationBodyUnsaved/,
  );

  for (const locale of ["en", "es", "fr", "pt-BR"]) {
    const catalog = JSON.parse(
      fs.readFileSync(
        path.join(UI_ROOT, "..", "src", "lib", "locales", `${locale}.json`),
        "utf8",
      ),
    );
    assert.ok(
      catalog.editor.deleteTranslationBodyUnsaved.includes("{language}"),
      `${locale} keeps the language placeholder`,
    );
  }
});

test("a failed delete never marks the creator's unsaved edits clean", () => {
  const editor = source("src/routes/edit/+page.svelte");
  const deleteFn = editor.slice(
    editor.indexOf("async function deleteTranslation("),
  );

  // Until the sibling backend PR lands, DELETE returns 405 here. Discarding
  // before the response would mark still-unsaved edits clean, dropping the
  // leave guard and autosave, and the work would vanish on reload.
  const request = deleteFn.indexOf("await zpageVariantsDestroy(");
  const discard = deleteFn.indexOf("discardPendingChanges()");
  assert.ok(
    request > 0 && discard > request,
    "discard happens after a successful response",
  );

  // The success branch is the only one that discards — and only when the
  // variant that was deleted is the one this editor has open.
  assert.match(
    deleteFn,
    /deleteTranslationSuccess[\s\S]{0,900}discardPendingChanges\(\);[\s\S]{0,400}commitLanguageSwitch\(sourceLanguage \?\? "", \{ canReturn: false \}\)/,
  );
  assert.match(
    deleteFn,
    /if \(!isOpenVariant\) \{[\s\S]{0,300}return;\s*\n\s*\}[\s\S]{0,400}discardPendingChanges\(\);/,
  );
  // A delete that did not happen puts the autosave clock back.
  assert.match(
    deleteFn,
    /finally \{\s*\n\s*isDeletingTranslation = false;[\s\S]{0,300}if \(isDirty\) \{\s*\n\s*scheduleAutoSave\(\);/,
  );
});

test("nothing starts a save behind an open prompt", () => {
  const editor = source("src/routes/edit/+page.svelte");
  // The navigation guard's silent flush is the third autosave trigger. With a
  // decision pending it defers to the explicit "leave anyway?" confirm, which
  // is itself not a dead end.
  assert.match(
    editor,
    /!isSaving && canFlushSave && !editorPrompt && navigation\.to\?\.url/,
  );
  // And "discard" waits out a PUT that a navigation guard already started —
  // an outstanding request cannot be recalled, so the switch must not pretend
  // it was discarded.
  assert.match(
    editor,
    /choice === "discard"\) \{[\s\S]{0,400}while \(currentSavePromise\) \{\s*\n\s*await currentSavePromise;/,
  );
});

test("discard does not clear anything until the switch actually lands", () => {
  const editor = source("src/routes/edit/+page.svelte");
  const commit = editor.slice(
    editor.indexOf("async function commitLanguageSwitch("),
    editor.indexOf("async function requestLanguage("),
  );

  // Clearing the dirty flags up front and then failing the goto would leave
  // the abandoned text on screen and marked clean: one later keystroke would
  // autosave — and, on a published variant, republish — the discarded body.
  // Instead, suppress the navigation guard and let the rehydration on the
  // other side replace the fields.
  assert.match(commit, /bypassNextNavigationGuard = discardUnsaved;/);
  assert.match(
    commit,
    /finally \{[\s\S]{0,400}bypassNextNavigationGuard = false;/,
  );
  assert.doesNotMatch(commit, /discardPendingChanges/);
  // A switch that did not happen leaves unsaved work: restart the clock.
  assert.match(
    commit,
    /finally \{[\s\S]{0,500}if \(isDirty\) \{\s*\n\s*scheduleAutoSave\(\);/,
  );
});

test("only real translations can be deleted, never the source language", () => {
  const base = {
    sourceLanguage: "en",
    availableLanguages: ["es"],
  };
  assert.equal(
    canDeleteTranslationLanguage({ ...base, selectedLanguage: "es" }),
    true,
  );
  // The article's own language: the backend refuses it, so we never offer it.
  assert.equal(
    canDeleteTranslationLanguage({ ...base, selectedLanguage: "en" }),
    false,
  );
  // A legacy `und` original is the source too.
  assert.equal(
    canDeleteTranslationLanguage({
      sourceLanguage: "und",
      availableLanguages: [],
      selectedLanguage: "und",
    }),
    false,
  );
  // A blank variant that was never written has nothing to delete.
  assert.equal(
    canDeleteTranslationLanguage({ ...base, selectedLanguage: "fr" }),
    false,
  );
  // A page that does not exist yet has no translations at all.
  assert.equal(
    canDeleteTranslationLanguage({
      ...base,
      selectedLanguage: "es",
      isNewPage: true,
    }),
    false,
  );

  assert.equal(
    translationVariantUrl("abc123", "pt-BR"),
    "/api/zpage/abc123/translations/pt-BR/",
  );
});

test("the editor wires the discard path, the delete call and the reassurance", () => {
  const editor = source("src/routes/edit/+page.svelte");

  // Save / Discard / Cancel, from one prompt.
  assert.match(editor, /editor\.languageSwitchSave/);
  assert.match(editor, /editor\.languageSwitchDiscard/);
  assert.match(editor, /choice === "discard"[\s\S]{0,600}discarding = true;/);
  assert.match(
    editor,
    /commitLanguageSwitch\(nextLanguage, \{\s*\n\s*discardUnsaved: discarding,/,
  );

  // Discard clears every dirty flag — including the canonical-URL one, which
  // otherwise pins `isDirty` true forever and was a dead end of its own.
  assert.match(
    editor,
    /function discardPendingChanges\(\) \{[\s\S]*?canonicalUrlNeedsSave = false;[\s\S]*?\n  \}/,
  );

  // Entering a blank variant is a labelled action, not a side effect. Since
  //  P7 that action is the Translations panel's "Add a translation", which
  // opens a picker whose own copy says it creates an empty version.
  assert.match(
    editor,
    /onAddTranslation=\{\(\) => \(languagePicker = "add"\)\}/,
  );
  assert.match(editor, /editor\.languagePickerAddTitle/);
  assert.match(
    editor,
    /onselect=\{\(language\) => void startNewTranslation\(language\)\}/,
  );
  assert.match(editor, /editor\.newTranslationNotice/);
  assert.match(editor, /isNewTranslationDraft/);

  // Delete, confirmed, against the documented contract — and conditional on
  // this variant's `ETag` when the editor holds one, so a translation saved
  // from another tab while the confirmation dialog was open is not thrown away
  //.
  assert.match(
    editor,
    /await zpageVariantsDestroy\(identifier, language, \{\s*\n\s*headers: preconditionHeaders\(/,
  );
  assert.match(editor, /editor\.deleteTranslationTitle/);
  assert.match(editor, /choice !== "confirm"/);
});

test("no save path returns false without naming a reason", () => {
  const editor = source("src/routes/edit/+page.svelte");
  const saveSection = editor.slice(
    editor.indexOf("async function handleSave("),
    editor.indexOf("async function handlePublish("),
  );

  assert.ok(saveSection.length > 0, "found the save implementation");
  // Ownership refusal records its reason in the shared check before returning
  // or throwing through the autosave fallback. Exempt only those proven paths;
  // every other bare false still loses the diagnostic this guard protects.
  const ownerCheck = editor.match(
    /function confirmSaveOwner\(options: SaveOptions\): boolean \{([\s\S]*?)\n  \}/,
  );
  assert.ok(ownerCheck, "the shared ownership check exists");
  assert.match(ownerCheck[1], /return failSave\(reason\)/);
  assert.match(
    saveSection,
    /if\s*\(!confirmSaveOwner\(options\)\)\s*throw new SaveOwnerChangedError\(\)/,
  );
  // An intentionally paused automatic flush is not a failed user save. It
  // retains edits and must not surface a false error while a job is running.
  const automaticPause =
    /if\s*\(\s*options\.isAuto &&\s*\(editorPrompt \|\|[\s\S]*?translationReviewNeeded \|\|\s*unresolvedTranslationLanguage !== null\)\s*\)\s*return false;/;
  assert.match(saveSection, automaticPause);
  const otherSavePaths = saveSection
    .replace(automaticPause, "")
    .replace(/if\s*\(!confirmSaveOwner\(options\)\)\s*return false;/g, "")
    .replace(
      /if\s*\(error instanceof SaveOwnerChangedError\)\s*return false;/g,
      "",
    );
  assert.deepEqual(
    otherSavePaths.match(/return false;/g),
    null,
    "every refused save must go through failSave() so the creator can be " +
      "told what is wrong — a bare `return false` is the #980 silent failure.",
  );
  assert.ok(
    saveSection.match(/return failSave\("/g).length >= 9,
    "each distinct blocking condition names itself",
  );
});

test("the switch-failure copy no longer demands the impossible", () => {
  const catalogs = ["en", "es", "fr", "pt-BR"].map((locale) =>
    JSON.parse(
      fs.readFileSync(
        path.join(UI_ROOT, "..", "src", "lib", "locales", `${locale}.json`),
        "utf8",
      ),
    ),
  );

  for (const catalog of catalogs) {
    const editor = catalog.editor;
    // The old string told the creator to do the one thing the editor refused
    // to let them do, and never mentioned the discard they actually wanted.
    assert.ok(
      editor.translationSwitchSaveFailed.includes("{reason}"),
      "the failure message states the real blocking reason",
    );
    for (const key of [
      "languageSwitchDiscard",
      "startWriting",
      "newTranslationNotice",
      "deleteTranslation",
      "saveBlockedEmptyContent",
    ]) {
      assert.equal(
        typeof editor[key] === "string" && editor[key].trim().length > 0,
        true,
        `missing editor.${key}`,
      );
    }
  }

  assert.equal(
    catalogs[0].editor.translationSwitchSaveFailed.startsWith(
      "Save this translation before switching languages",
    ),
    false,
  );
});
