<script lang="ts" module>
  import {
    beginAccountBalanceRead,
    recordQuotedBalanceRead,
  } from "$lib/account-balance";
  /**
   * Whether `GET /api/zpage/{id}/variants/` exists in front of this build.
   *
   * Module scope on purpose: the answer is a property of the deployment, not
   * of one article or one editor mount, so a single 404 settles it for the
   * whole SPA session.  shipped the route; an older pod mid-rollout has
   * the Translations panel run on `available_languages` and say "Written"
   * instead of inventing a per-variant status it was never told.
   */
  let variantsEndpointSupported = true;
</script>

<script lang="ts">
  import { browser } from "$app/env";
  import { beforeNavigate, goto, replaceState } from "$app/navigation";
  import { page } from "$app/state";
  import { authStore, currentUser } from "$lib/stores/auth";
  import { requestLogin } from "$lib/stores/auth-modal";
  import { onDestroy, untrack } from "svelte";
  import type { PageData } from "./$types";
  import { toast, captureAccountToast, toastPresentation } from "$lib/toast.js";
  import { reviewTranslation } from "$lib/editor/translation-review.js";
  import { locale, tStore as t, type SupportedLocale } from "$lib/i18n";
  import { apiFetch } from "$lib/api/config";
  import { isRequestTimeout } from "$lib/api/request-timeout.js";
  import {
    ZPAGE_CREATE_IDEMPOTENCY_HEADER,
    backendHonorsCreateKey,
    noteCreateResponse,
    resolvesCreateAttempt,
    newZpageCreateKey,
  } from "$lib/zpage-create-idempotency.js";
  import EditorComposer from "$lib/components/mdEditor/EditorComposer.svelte";
  import EditorPreview from "$lib/components/mdEditor/EditorPreview.svelte";
  import { createFirstPartyPreviewResolver } from "$lib/first-party-card-resolver";
  import EditorStats from "$lib/components/mdEditor/EditorStats.svelte";
  import EditorTopbar from "$lib/components/mdEditor/EditorTopbar.svelte";
  import type {
    EditorCurrentUser,
    EditorMode,
    EditorValidationErrors,
  } from "$lib/components/mdEditor/types";
  import {
    UNTITLED_DRAFT_TITLE,
    hydrateEditorState,
    renderMarkdown,
    resolveMediaUrl,
    stripUploadPlaceholders,
    toDatetimeLocal,
  } from "$lib/components/mdEditor/utils";
  import { vanityFromTitle } from "$lib/zpage-vanity.js";
  import type { ZPage } from "$lib/types/zpage";
  import { getCanonicalUrlError } from "$lib/canonical-url.js";
  import { saveWithCanonicalAutosaveFallback } from "$lib/canonical-save.js";
  import {
    apiRequestErrorMessage,
    describeSaveFailure,
    isScheduleInThePast,
    saveNoticeReason,
  } from "$lib/save-errors.js";
  import {
    TRANSLATION_SOURCE_LANGUAGE_HEADER,
    articleVariantHref,
    buildVariantRows,
    editorVariantHref,
    isCurrentTranslationResponse,
    isRequestedVariantMissing,
    languageChipState,
    languageDisplayName,
    normalizeContentLanguage,
    planLanguageSwitch,
    translationVariantUrl,
    untranslatedLanguages,
  } from "$lib/zpage-language.js";
  import {
    catalogTranslatableTags,
    describeLanguage,
    fetchLanguageCatalog,
  } from "$lib/language-catalog.js";
  import { ApiError } from "$lib/api/mutator";
  import {
    formatDecimalText,
    insufficientFundsFromError,
    parseInsufficientFunds,
    type InsufficientFundsDetails,
  } from "$lib/insufficient-funds";
  import {
    IF_NONE_MATCH_HEADER,
    PRECONDITION_FAILED,
    createEtagRegistry,
    createOnlyHeaders,
    isPreconditionFailure,
    preconditionHeaders,
  } from "$lib/zpage-preconditions.js";
  import {
    zpagePartialUpdate,
    zpageTranslationPurchase,
    zpageTranslationQuote,
    zpageTranslationStatus,
    zpageVariantsDestroy,
    zpageVariantsList,
  } from "$lib/api/zpage/zpage";
  import type {
    TranslationJob,
    TranslationQuote,
    ZPageVariantSummary,
  } from "$lib/api/f2z.schemas";
  import {
    SETTLEMENT_POLICY_VERSION,
    TRANSLATION_POLL_INTERVAL_MS,
    TRANSLATION_POLL_TIMEOUT_MS,
    isAmbiguousOutcome,
    isNoChargeRefusal,
    isTerminalTranslationJob,
    translationErrorCode,
    translationJobState,
    translationPurchaseError,
    translationPurchaseIdentity,
    translationPurchaseLegacyIdentity,
  } from "$lib/zpage-translation-purchase.js";
  import {
    clearIntentIdempotencyKey,
    intentIdempotencyKey,
  } from "$lib/subscribe-idempotency.js";
  import { zpageCanonicalPath } from "$lib/zpage-path.js";
  import { deleteZPage, ZPageDeleteError } from "$lib/api/zpage";
  import LanguageChip from "$lib/components/zpageLanguage/LanguageChip.svelte";
  import LanguagePicker from "$lib/components/zpageLanguage/LanguagePicker.svelte";
  import TranslateWithAiDialog from "$lib/components/zpageLanguage/TranslateWithAiDialog.svelte";
  import TranslationsPanel from "$lib/components/zpageLanguage/TranslationsPanel.svelte";
  import TranslateIntoDialog from "$lib/components/zpageLanguage/TranslateIntoDialog.svelte";
  import TranslationTray from "$lib/components/zpageLanguage/TranslationTray.svelte";
  import TranslationReviewBar from "$lib/components/zpageLanguage/TranslationReviewBar.svelte";
  import TranslationReviewSource from "$lib/components/zpageLanguage/TranslationReviewSource.svelte";
  import TranslationJobsIndicator from "$lib/components/zpageLanguage/TranslationJobsIndicator.svelte";
  import { translationJobs } from "$lib/stores/translationJobs";
  import { createTranslationPublishing } from "$lib/editor/translation-publishing.svelte";
  import {
    bulkIntentStorageKey,
    purchaseBulkTranslations,
    readBulkIntentFrom,
    type BulkIntent,
  } from "$lib/editor/translation-bulk";
  import {
    isActiveJob,
    readyLanguages,
    receiptJobs,
    summarizeJobs,
    summarizeTray,
    trayRows,
    type ServerTranslationJob,
    type TranslationJobEntry,
  } from "$lib/translation-jobs";
  import {
    quoteTranslations,
    type BulkQuote,
  } from "$lib/api/zpage-translations";
  import SeriesEditor from "$lib/components/SeriesEditor.svelte";

  interface Props {
    data: PageData;
  }

  type SavePayload = {
    title: string;
    content: string;
    description: string;
    canonical_url: string;
    tags: string[];
    vanity: string;
    p2paddr: string;
    featured_image?: number | null;
    is_published: boolean;
    is_subscriber_only: boolean;
    publish_at: string | null;
    source_language?: string;
  };

  /**
   * A zPage's *content* language: any BCP-47 tag the registry accepts, not one
   * of the four product-UI locales. `und` still arrives from legacy rows, and
   * is handled by never being rendered (see `languageChipState`).
   */
  type EditorLanguage = string;

  interface SaveOptions {
    isAuto?: boolean;
    /**
     * The creator already agreed that this save may stop running translations
     *. Skips the warning — it was just shown.
     */
    stopsTranslations?: boolean;
    /** Immutable variant revision approved for this publication. */
    approvedRevision?: string;
    overrides?: Partial<SavePayload>;
    successMessage?: string;
  }

  // Why the last save attempt did not persist. Autosave used to swallow every
  // one of these (`isAuto` suppresses its own toasts), which is how a creator
  // could end up staring at a control that refused to move without ever being
  // told what was wrong. Every `return false` below names its reason.
  type SaveBlockReason =
    | "translation-unresolved"
    | "translations-running"
    | "in-flight"
    | "title-required"
    | "content-required"
    | "description-too-long"
    | "canonical-url-invalid"
    | "canonical-url-unsaved"
    | "save-unconfirmed"
    | "auth-required"
    | "wrong-account"
    | "validation"
    | "conflict"
    | "request-failed"
    | "timed-out"
    | "create-timed-out"
    | "create-page-gone"
    | "needs-2z"
    | "deleting"
    | "switching"
    | "relabelling";

  type EditorPromptChoice = "confirm" | "discard" | "cancel" | "keep";

  type EditorPrompt = {
    title: string;
    body: string;
    confirmLabel?: string;
    /** Omitted for two-way confirmations (delete). */
    discardLabel?: string;
    cancelLabel: string;
    cancelChoice?: "cancel" | "keep";
    danger?: boolean;
  };

  const AUTOSAVE_DELAY = 2500;
  const AUTOSAVE_MAX_WAIT = 15000;
  const MAX_AUTOSAVE_RETRIES = 3;
  const DESCRIPTION_MAX_LENGTH = 250;

  let { data }: Props = $props();

  type EditPageData = PageData & {
    currentUser: EditorCurrentUser;
    requestedId: string;
    zpage: ZPage | null;
    /** Strong `ETag` for the CANONICAL article, from the load's GET. */
    zpageEtag: string | null;
    /** The translation being edited, or null when the source is open. */
    variantLanguage: string | null;
    /** That translation's own `ETag`, when the load could read one. */
    variantEtag: string | null;
    requestedLanguage: EditorLanguage;
  };

  /**
   * Newest optimistic-concurrency validator per write URL.
   *
   * Keyed by URL because the editor writes two different resources — the
   * canonical article and a translation variant — and each carries its own
   * validator. One shared "current etag" would eventually send a
   * translation's validator on a canonical save and 412 a page nobody else
   * had touched.
   */
  const etags = createEtagRegistry();

  /**
   * Set once this editor has been told it is holding a superseded version.
   *
   * A 412 is not a transient failure to retry — a newer version exists and no
   * amount of retrying makes this tab's copy current again. Without a latch
   * the very next keystroke schedules an autosave, and every one of those
   * either 412s again (a toast per keystroke) or, worse, would go out
   * unconditioned and clobber the newer version the creator was just warned
   * about. So the editor stops sending saves and says why, until a reload
   * (or a hydration onto freshly read state) clears it.
   */
  let saveConflicted = $state(false);

  let currentZPage = $state<ZPage | null>(null);
  let title = $state("");
  let description = $state("");
  let canonicalUrl = $state("");
  let coverImage = $state("");
  let coverImageId = $state<number | null>(null);
  let tags = $state<string[]>([]);
  let zcashAddress = $state("");
  let content = $state("");
  let vanity = $state("");
  // Track vanity edits separately so an unrelated in-flight edit can adopt a
  // server-generated URL without overwriting a vanity the creator just typed.
  let vanityEditRevision = 0;
  // The vanity `handleTitleChange` last proposed, and the proposals the API
  // refused. A derived vanity is the editor's guess, not something
  // the creator chose, so a refusal of it (taken, reserved, a username) must
  // never block the article from saving: the guess is dropped and the save
  // retried without it. A vanity the creator TYPED is never dropped — its
  // refusal is shown to them instead.
  let derivedVanity = "";
  const rejectedDerivedVanities = new Set<string>();
  let isPublished = $state(false);
  let isSubscriberOnly = $state(false);
  let publishAt = $state("");
  let showCover = $state(false);
  let showSubtitle = $state(false);
  let mode = $state<EditorMode>("write");
  let isSaving = $state(false);
  let saveError = $state<string | null>(null);
  let lastSavedAt = $state<number | null>(null);
  let validationErrors = $state<EditorValidationErrors>({});
  let autoSaveTimeout: ReturnType<typeof setTimeout> | null = null;
  let lastHydratedKey = $state("");
  // A New post navigation carries an explicit, unique URL marker. Keep the
  // last marker after the save's shallow URL rewrite drops the query string so
  // that write canonicalization does not hydrate the old route again.
  let lastNewPostNavigation = $state<string | null>(null);
  /**
   * How many times the composer has been filled from a server read.
   *
   * Bumped by `applyHydratedState` and read by `metadataResetKey`, which is
   * where the reasoning lives. It exists so a child component can tell "the
   * document under me was replaced" apart from "the creator changed something"
   * a distinction nothing else on this page could express, and  is the
   * bill for that.
   */
  let hydrationGeneration = $state(0);
  let changeVersion = $state(0);
  let savedVersion = $state(0);
  let firstPendingChangeAt: number | null = null;
  let autoSaveRetries = 0;
  // Set when a save is abandoned at its bound  and cleared by the next
  // success: an abandoned PUT may still commit, which changes what a later
  // 412 means (see the precondition branch in `performSave`).
  let saveTimedOutSinceLastSuccess = false;
  // Set when a CREATE is abandoned at its bound: it may have committed, and
  // every POST mints a new page, so autosave must not create again unasked.
  // Only ever set for a create sent WITHOUT an Idempotency-Key: a
  // keyed one is reconciled through `pendingCreate` instead.
  let createOutcomeUnknown = $state(false);
  // Which notice that latch shows: the timed-out create, or a reconciled
  // create whose page was deleted elsewhere.
  let createLatchReason: "create-timed-out" | "create-page-gone" =
    "create-timed-out";
  //the server refused to create this NEW page because the creator
  // already has one and holds under 1 2Z (`402 insufficient_funds`). Shown as
  // a notice with the ways to get 2Z, and it stops autosave re-sending a create
  // that will be refused identically: a creator on 2026-10-07 was refused six
  // times in two minutes by a bare sentence and left.
  let createNeeds2z = $state<InsufficientFundsDetails | null>(null);
  //a keyed create whose outcome is unknown (no answer, or a 5xx). The
  // exact body is kept with its key because the server binds the key to the
  // body: re-sending THESE bytes under THIS key returns the page the first
  // attempt made — or makes it, if that attempt never committed — and never a
  // second one. Cleared only by proof of the outcome (`resolvesCreateAttempt`)
  // and by navigation.
  let pendingCreate: { key: string; body: string } | null = null;
  // The language the creator picked for the unsaved draft while its create
  // was unresolved, when the reconciled page turned out to exist in another
  // one. Applied as a real relabel once the save that adopted it succeeds.
  let relabelAfterReconcile: string | null = null;
  // How many creates have timed out: a manual save queued behind one compares
  // it to tell "clicked after the warning" from "clicked before it".
  let createTimeouts = 0;
  let destroyed = false;
  const editorActionToastIds = new Set<string | number>();
  let currentSavePromise: Promise<boolean> | null = null;
  let pendingNavigationFlush = false;
  let bypassNextNavigationGuard = false;
  let canonicalUrlNeedsSave = $state(false);
  let selectedLanguage = $state<EditorLanguage>("en");
  let availableLanguages = $state<string[]>([]);
  let saveBlockReason = $state<SaveBlockReason | null>(null);
  let isNewTranslationDraft = $state(false);
  let isDeletingTranslation = $state(false);
  let isDeletingPage = $state(false);
  let isSwitchingLanguage = $state(false);
  let editorPrompt = $state<EditorPrompt | null>(null);
  /**
   * `GET /api/zpage/{id}/variants/` — the only source of per-variant status.
   * `null` means "we have not been told", which is never treated as "stale"
   * and never as "unpublished".
   */
  let variants = $state<ZPageVariantSummary[] | null>(null);
  let variantsRequestId = 0;
  let languagePicker = $state<"relabel" | "add" | "translate" | null>(null);
  let isRelabelling = $state(false);
  // ---- Buying an AI translation ( P8 / §6.1) -------------------------
  /** The language being quoted/bought, or `null` when the dialog is closed. */
  let translateAiLanguage = $state<string | null>(null);
  /**
   * The ARTICLE the open dialog is about.
   *
   * This page component survives navigation between two `/edit` URLs, and a
   * hydration does not close the dialog. Without this, a quote shown for
   * article A could be confirmed against whatever article is loaded when the
   * button is clicked — and since prices are whole 2Z, two articles can easily
   * agree on a number, so the server's `expected_price` check would wave it
   * through and charge for the wrong article. Everything scoped to a purchase
   * is keyed on this, not on "the article currently on screen".
   * (codex adversarial review.)
   */
  let translateAiPage: string | null = null;
  let translateAiQuote = $state<TranslationQuote | null>(null);
  /**
   * Exact key bound to this dialog's consent, alongside its article/language
   * and quote. Minted on first confirmation or restored from a durable unknown
   * request. Another tab settling that request must not turn this still-open
   * recovery decision into a new charge. Closing drops only this in-memory
   * binding; unresolved requests remain durable and restore it on reopening.
   */
  let translateAiIntentKey = $state<string | null>(null);
  let translateAiError = $state<string | null>(null);
  let translateAiPurchaseError = $state<string | null>(null);
  let translateAiFailureGeneration = $state<number | null>(null);
  $effect(() => {
    if (
      translateAiFailureGeneration !== null &&
      translateAiFailureGeneration !== $toastPresentation.generation
    ) {
      translateAiPurchaseError = null;
      translateAiFailureGeneration = null;
    }
  });
  let translateAiFunds = $state<InsufficientFundsDetails | null>(null);
  let isBuyingTranslation = $state(false);
  let translationPurchaseGeneration = 0;
  /** Set while a purchase is in flight or being polled — the panel is busy. */
  let isTranslating = $state(false);
  let translationProgress = $state<{
    page: string;
    language: string;
    job: TranslationJob;
    interrupted: boolean;
    checking: boolean;
    superseded?: boolean;
    storageJobId?: string;
  } | null>(null);
  let translationReviewNeeded = $state(false);
  let translationReviewTarget = $state<{
    page: string;
    language: string;
  } | null>(null);
  let unresolvedTranslationLanguage = $state<string | null>(null);
  let unresolvedTranslationPage: string | null = null;
  let translationMonitorId = 0;
  let translationRestorePage: string | null = null;
  const visibleTranslationProgress = $derived(
    translationProgress?.page === currentZPage?.free2zaddr
      ? translationProgress
      : null,
  );
  const translationPending = $derived(
    Boolean(
      visibleTranslationProgress &&
      !isTerminalTranslationJob(visibleTranslationProgress.job),
    ),
  );

  // Bumped on every open/close so a slow quote for a language the creator has
  // already moved on from cannot land in the dialog. Same discipline as
  // `variantsRequestId`.
  let translateAiRequestId = 0;
  // Collapsed by default: a creator writing in one language never has to open
  // it, and publishing never requires touching anything in here.
  let showTranslations = $state(false);
  let settleEditorPromptChoice: ((choice: EditorPromptChoice) => void) | null =
    null;

  const isDirty = $derived(
    changeVersion !== savedVersion || canonicalUrlNeedsSave,
  );
  /**
   * Is there prose ON SCREEN — a title, a subtitle, a body?
   *
   * One job only: deciding whether the waiting screen may stand in for the
   * writing surface, which is a question about what is visible, not about what
   * is unsaved. It deliberately ignores tags, the cover and the payout address,
   * because replacing an empty-LOOKING composer with a status panel hides
   * nothing even when those are dirty.
   *
   * It is emphatically NOT the test for "may I discard this?" — `isDirty` is,
   * and an earlier draft of  that used this one there would have thrown
   * away an unsaved payout address because the prose happened to be empty.
   */
  const hasCreatorText = $derived(
    Boolean(title.trim() || description.trim() || content.trim()),
  );
  /**
   * Is `language` the canonical article, rather than a translation of it?
   *
   * This one predicate decides whether a save is a PUT to `/api/zpage/{id}/`
   * or to the variant endpoint, whether scheduling is offered, and whether the
   * language label can be changed. It has to survive a **null**
   * `source_language`, which is what the column holds once detection ships and
   * has not run yet ( §3.2). Comparing a tag against null is false, so the
   * naive equality would classify edits to an unlabelled article as a
   * translation in whatever the reader's UI locale happens to be — and PUT the
   * canonical body to `/variants/en/`, reporting success while the article
   * itself never changed.
   *
   * With no label there is no translation addressable by "no language", so the
   * honest answer is: the editor is showing the canonical article unless the
   * creator explicitly asked for some other variant.
   */
  function isCanonicalLanguage(language: string | null | undefined): boolean {
    if (!currentZPage) return true;
    const source = currentZPage.source_language;
    if (!source) return !getRouteData().explicitLanguage;
    return language === source;
  }

  const canSchedule = $derived(isCanonicalLanguage(selectedLanguage));

  /**
   * A language's name in the reader's UI locale, or a short honest placeholder.
   *
   * The placeholder is the whole point. `languageDisplayName` returns null for
   * `und`, for a malformed tag, for anything CLDR cannot name — and this is the
   * only place that null becomes prose. It never becomes a subtag, and it never
   * becomes the old "Original — language unknown" copy, which was an internal
   * sentinel dressed up as a sentence.
   */
  function languageLabel(code: EditorLanguage | null | undefined): string {
    return (
      // The served name is consulted wherever a language is NAMED, not only in
      // the picker. Naming it in the picker alone is worse than not
      // naming it: the creator picks "Sakizaya" and every screen afterwards —
      // the chip, the switch prompt, the paid-translation dialog — calls it
      // "Detecting…", including the one that asks them to spend 2Z.
      describeLanguage(code, $locale, servedLanguageNames.get(code ?? ""))
        .name ?? $t("editor.languageChipDetectingShort", "Detecting…")
    );
  }

  /** What the chip says: the article's language, or "Detecting…". */
  const chip = $derived(
    languageChipState({
      // An unsaved draft has no server-side language yet: the chip shows the
      // label it will be created with.
      sourceLanguage: currentZPage
        ? currentZPage.source_language
        : selectedLanguage,
      detectedLanguage: currentZPage?.detected_language,
      detectionConfidence: currentZPage?.detection_confidence,
      languageSource: currentZPage?.language_source,
    }),
  );

  /** The open variant's language, normalized — `""` when we cannot name it. */
  const openLanguage = $derived(
    normalizeContentLanguage(selectedLanguage) ?? "",
  );

  /**
   * Has anything actually STATED the language of the document on screen, as
   * opposed to presuming it from the creator's product UI?
   *
   * `requestedLanguage` falls back to `layout.locale` for a brand-new draft
   * (`+page.ts`), so `openLanguage` on a fresh `/edit` is the creator's UI
   * locale. That is a defensible LABEL — the create call sends it as
   * `source_language` and detection corrects it later — but it is a statement
   * about the creator, not about the text, and direction is about the text.
   * Taking it would mean an English-UI creator starting an Arabic article types
   * into a left-to-right surface: the  conflation one layer down.
   *
   * `zpage?.actual_language || zpage?.source_language`, never a bare `zpage`:
   * `+page.ts` falls `requestedLanguage` back to `layout.locale` when a LOADED
   * article has neither, so keying on the article's mere existence would hand the
   * creator's UI locale back as though the article had stated it — giving an
   * unlabelled Hebrew article an explicit `ltr` in the editor while the reader
   * gives it `auto`, which breaks this issue's own "reader and preview agree"
   * requirement. Unreachable today (nothing writes a NULL `source_language`) and
   * live with  M4, so it is closed here rather than left as a comment
   * (outside review, F3).
   *
   * **Every term is ROUTE DATA, and that is the design.** Route data is replaced
   * wholesale by the loader, so nothing here is remembered between documents and
   * there is no path on which it can go stale — the property the thing it
   * replaced could not have.
   *
   * The earlier version of this comment claimed every term was "replaced
   * wholesale" while two of them read `currentZPage`, which is NOT: the relabel
   * does `currentZPage = {...currentZPage, source_language }`. That partial
   * update is harmless because it stays within one document — but the honest form
   * of the claim is "replaced wholesale, **or** updated only within one document",
   * and taking the weak form literally is what exposed F5 below. Terms that only
   * satisfy the weak form are gone, so the strong form is true again.
   *
   * **Why there is no `detected_language` / `language_source` term** (outside
   * review, F5 — the FIFTH defect in this lifecycle, and the only one that was
   * not about staleness). Those two said "the backend has identified a language",
   * and were used to license asserting `openLanguage` — which is
   * `selectedLanguage`, which **nothing ever moves from a save response**. So the
   * detector's own answer became permission to assert the UI LOCALE's direction:
   * an English-UI creator typing Arabic got a correct RTL surface, and then the
   * detection arriving on a later autosave flipped the whole draft to explicit
   * left-to-right, mislabelled `lang="en"` while the row said `ar`. That is codex
   * round 1's defect verbatim — "saving is incorrectly treated as proof that the
   * language is known" — re-entered through a different pair of terms, and it was
   * live rather than latent (`apply_detection` ships and fires from zPage
   * `post_save`).
   *
   * Nothing is lost by dropping them: `apply_detection` writes `source_language`
   * whenever `_may_relabel` allows, so the next loader run surfaces the detected
   * tag as term 2 or 3 — the same field `requestedLanguage` derives
   * `selectedLanguage` from, which is what makes it evidence about the value
   * actually being used. In the branches where `_may_relabel` refuses, the page
   * already carries a real `source_language` anyway.
   *
   * This also used to include a latched `languageStatedByCreator`, set when the
   * creator picked a language by hand. It accumulated FOUR defects — keyed on the
   * wrong signal, set before the write it depended on succeeded, surviving a
   * client-side navigation, then surviving a SHALLOW one (`updateEditorUrl` uses
   * `replaceState`, so the hydration key is unchanged for a never-saved draft and
   * the reset never ran). Each fix was correct and each was found by the next
   * review.
   *
   * The reason it could not be fixed, which is the part worth keeping: it
   * answered "has the creator stated a language" **without carrying document
   * identity**, while the question that decides direction is "…for the document
   * on screen". Correctness therefore depended on remembering to clear it on
   * every path that replaces the document, and we missed four. A key-based
   * version cannot work either, because a never-saved draft **has no identity at
   * all** — the hydration key is `["new", "en", "new"]` before and after. So the
   * remembered state is gone rather than reset a fifth time. Do not reintroduce a
   * remembered value in any form; `tests/text-direction.test.mjs` pins the shape
   * and `editor-direction.spec.ts` pins the behaviour.
   *
   * **What that costs, stated rather than hidden:** a creator who relabels an
   * UNSAVED draft by hand gets `dir="auto"` instead of that language's direction.
   * `auto` resolves from the first strong character and re-resolves live, so the
   * residual case is Latin-first text in a right-to-left language before anything
   * strong has been typed — where there is no correct answer to get right.
   *
   * That residual is SHORTER and LONGER than an earlier version of this comment
   * claimed. It does not end at  M4: it ends at the next LOADER run — a
   * reload or any `invalidateAll` — because the editor never re-reads its own
   * create response's label into route data. So it survives the first autosave,
   * and it ends the moment the page is loaded again.
   */
  const languageIsStated = $derived(
    Boolean(
      getRouteData().explicitLanguage ||
      getRouteData().zpage?.actual_language ||
      getRouteData().zpage?.source_language,
    ),
  );

  /**
   * The language to LAY THE WRITING SURFACE OUT for, or `null` for "nobody has
   * said" — which the composer renders as `dir="auto"`, so the browser reads the
   * first strong character actually typed and re-resolves live.
   */
  const writingLanguage = $derived(languageIsStated ? openLanguage : null);

  // ---- Translation jobs: many at once, above the route  ----------
  //
  // The single-purchase slot below (`translationProgress`) still drives the
  //  waiting screen and the receipt/recovery machinery its specs pin.
  // Everything about "which translations exist and how they are going" reads
  // from the store instead: it survives navigation, it is seeded from the
  // server's jobs list on any device, and it polls each job on its own.
  const pageJobs = $derived(
    currentZPage ? $translationJobs.pages[currentZPage.free2zaddr] : undefined,
  );
  /** This deployment can list jobs, so it can also run several at once. */
  const parallelTranslations = $derived(pageJobs?.listSupported === true);
  const jobList = $derived.by(() => {
    const out: TranslationJobEntry[] = [];
    for (const job of Object.values(pageJobs?.jobs ?? {})) {
      if (job.status !== "delivered") {
        out.push(job);
        continue;
      }
      // Whether its draft exists, and whether it is live, is the variants
      // index's to say when it has a row: it is re-read after EVERY save, so
      // publishing or unpublishing through the ordinary editor is reflected
      // here, which a cached job's `variant` would not be (codex adversarial
      // review). Without a row: the jobs list's own word (`null` = gone), and
      // a receipt nothing live has confirmed does not outlive the index.
      const row = variants?.find(
        (variant) => variant.language === job.language,
      );
      if (row) {
        out.push({
          ...job,
          variant: {
            is_published: row.is_published,
            is_stale: Boolean(row.is_stale),
          },
        });
        continue;
      }
      if (job.variant === null) continue;
      if (!job.variant && variants && job.receiptOnly) continue;
      out.push(job);
    }
    return out;
  });
  const jobSummary = $derived(summarizeJobs(jobList));
  const jobSummaryForIndicator = $derived({
    active: jobSummary.active,
    ready: jobSummary.ready,
    attention: 0,
  });
  const activeJobLanguages = $derived(
    jobList.filter(isActiveJob).map((job) => job.language),
  );
  const trayOpen = $derived(
    Boolean(currentZPage) &&
      $translationJobs.trayPage === currentZPage?.free2zaddr,
  );
  /**
   * Running translations that saving the OPEN version would stop.
   *
   * A job is bound to the source's body (`source_changed`) and to its own
   * target draft (`variant_changed`), so a source save stops every running
   * job and a translation save stops only its own. Autosave holds off while
   * this is non-empty, and an explicit save asks first, naming them.
   */
  const jobsStoppedBySavingOpenVariant = $derived.by(() => {
    // An unresolved bulk purchase may have committed and started its jobs
    // with only the answer lost; until it is re-sent and settled, its
    // languages count as running (codex adversarial review).
    const running = [
      ...new Set([...activeJobLanguages, ...(bulkIntent?.languages ?? [])]),
    ];
    return isCanonicalLanguage(selectedLanguage)
      ? running
      : running.filter((language) => language === openLanguage);
  });
  /** Delivered, unpublished translations — the review loop's queue. */
  const reviewQueue = $derived(
    jobList
      .filter((job) => job.status === "delivered" && !job.variant?.is_published)
      .map((job) => job.language)
      .sort((a, b) => languageLabel(a).localeCompare(languageLabel(b))),
  );
  let reviewLanguage = $state<string | null>(null);
  /** Bumped per review step: the original is read again (see the pane). */
  let reviewSourceRevision = $state(0);
  /** The last jobs re-read before an autosave of the original failed. */
  let jobsCheckFailed = $state(false);
  let translateIntoOpen = $state(false);
  /** The article the open "Translate…" dialog prices and buys for. */
  let translateIntoPage: string | null = null;
  let translateIntoInitial = $state<string[]>([]);
  /** Client clock of the last hydration: what is on screen is this old. */
  let lastHydratedAt = 0;
  /** The prose last read from or written to the server, per hydration. */
  let persistedProse = $state.raw({ title: "", description: "", content: "" });

  /**
   * An AI translation is being bought or written FOR THE LANGUAGE ON SCREEN.
   *
   * Covers the gap between the confirm click and the 202 as well as the poll:
   * `translationProgress` is still null while the purchase is in flight, and
   * the editor must not spend those seconds inviting the creator to write the
   * thing they are paying to have written.
   */
  const translationClaimsOpenVariant = $derived(
    Boolean(
      openLanguage &&
      ((isBuyingTranslation && translateAiLanguage === openLanguage) ||
        (translationPending &&
          visibleTranslationProgress?.language === openLanguage &&
          // `checking` is the difference between "a job is running" and "a job
          // is running AND WE ARE STILL WATCHING IT". Only the second may take
          // the writing surface away ( review, F2).
          //
          // The poll loop sets it false the moment it stops caring: at the
          // `TRANSLATION_POLL_TIMEOUT_MS` deadline with the job still `queued`,
          // and on a receipt/language mismatch. Neither mutates `job.status`,
          // so `translationPending` stays true FOREVER — and
          // `restoreTranslationProgress` rehydrates a receipt in that state
          // from `localStorage` on every later open of the article, so it is
          // durable rather than a session blip. Without this clause the waiting
          // screen outlived the job and locked the creator out of writing that
          // variant, permanently, with no control on screen.
          //
          // Deliberately NOT `&& !interrupted`: a dropped connection sets that
          // while the loop keeps polling, and yielding the whole screen on
          // every transient blip would flicker the composer in and out.
          visibleTranslationProgress.checking)),
    ),
  );

  /**
   * Whether the waiting screen stands in for the writing surface — decided
   * ONCE, when a translation takes over the open variant, and held until it
   * lets go. `null` means no translation owns this variant.
   *
   * Latched, not derived, and that is the whole point (codex adversarial
   * review of this PR). As a live `translationClaimsOpenVariant &&
   * !hasCreatorText` it watched the composer's own emptiness: select the
   * title-only draft you were mid-way through rewriting, press Delete, and the
   * field becomes empty for one keystroke — which unmounted the textarea under
   * the caret and took the undo history with it. There was then no way to type
   * the replacement, or to undo, until delivery. A decision about what kind of
   * screen this is belongs to the moment the job starts, not to every
   * keystroke.
   */
  let openVariantWaitLatch = $state<boolean | null>(null);

  $effect(() => {
    if (!translationClaimsOpenVariant) {
      if (openVariantWaitLatch !== null) openVariantWaitLatch = null;
      return;
    }
    // Rising edge only. Every way a job can come to own this variant — a fresh
    // purchase, a receipt restored from storage, another tab's settlement, a
    // reconnect — passes through here, which is why this is an effect on the
    // condition rather than a line in the purchase path.
    if (openVariantWaitLatch === null) openVariantWaitLatch = !hasCreatorText;
  });

  /**
   * Nobody hand-writes the Chinese while paying an AI to write the Chinese
   *. While a translation for the open language is in flight and there
   * was nothing of the creator's on screen when it started, the composer is
   * replaced by a waiting state rather than a blank "Start writing your story…".
   *
   * This is also what makes the delivery safe BY CONSTRUCTION rather than by
   * conflict resolution: the hazard the old code guarded against — a stale
   * autosave writing the pre-purchase document over the paid translation and
   * flipping its origin to `human` with no failure to refund — needs stale
   * text to exist. Never inviting the text is a stronger guarantee than
   * arbitrating it afterwards.
   *
   * A creator who HAD written something here before buying keeps their
   * composer, keeps typing, and still gets the explicit choice on delivery.
   * Hiding their words would be the worse bug.
   */
  const translationWaitingForOpenVariant = $derived(
    openVariantWaitLatch === true,
  );

  /**
   * A pending review for the SAME language as the job being reported. See the
   * note on the status region: one message, explicit precedence.
   */
  const reviewSupersedesJobStatus = $derived(
    Boolean(
      translationReviewNeeded &&
      translationReviewTarget &&
      visibleTranslationProgress &&
      translationReviewTarget.language === visibleTranslationProgress.language,
    ),
  );

  const variantRows = $derived(
    buildVariantRows({
      variants,
      sourceLanguage: currentZPage?.source_language,
      availableLanguages,
      selectedLanguage,
      isPublished: Boolean(currentZPage?.is_published),
      hasSource: Boolean(currentZPage),
    }),
  );
  /** The tray's own count: the indicator says what the tray will show. */
  const trayRowList = $derived(
    trayRows({
      jobs: jobList,
      variants: variantRows,
      drafts: pageJobs?.drafts ?? {},
      now: Date.now(),
    }),
  );
  const traySummary = $derived(summarizeTray(trayRowList));
  /**
   * The drafts "Publish all ready" considers: the tray's own rows, manual
   * drafts included (codex adversarial review). Flagged ones are passed in
   * too, so they can be named as left out; only clean ones are published,
   * which is what the button counts.
   */
  const trayReviewableLanguages = $derived(
    trayRowList
      .filter(
        (row) =>
          row.kind === "ready" ||
          row.kind === "draft" ||
          row.kind === "flagged",
      )
      .map((row) => row.language),
  );

  /**
   * The sellable language set, served by `GET /api/languages/`.
   *
   * Until this resolves — and forever, if the request fails —
   * `catalogTranslatableTags` answers with the compiled-in
   * `TRANSLATABLE_LANGUAGES` seed, so the picker is never empty and never
   * waits on the network. When it does resolve, a language added on the server
   * is offered here with no frontend release, which is the whole point of
   *  item 2.
   */
  let languageCatalog = $state<Awaited<
    ReturnType<typeof fetchLanguageCatalog>
  > | null>(null);

  /**
   * Only the *sellable* half. Everything the article already has is unioned in
   * through `extraLanguages` below, so a variant outside the sell list stays
   * visible (the `ja` case in ).
   */
  const translatableLanguages = $derived(
    catalogTranslatableTags(languageCatalog),
  );

  /**
   * What the server said about those tags, for the picker's fallback.
   *
   * The browser names a language itself wherever it can; this is what makes a
   * language the local CLDR data has never heard of visible at all instead of
   * being silently dropped from the list.
   *
   * `direction` rides along because the picker renders each autonym in its own
   * script  and the endpoint's `text_direction` is the answer that can
   * be corrected without a frontend release.
   */
  const servedLanguageNames = $derived(
    new Map(
      (languageCatalog?.languages ?? []).map((entry) => [
        entry.tag,
        {
          name: entry.name,
          autonym: entry.autonym,
          direction: entry.direction,
        },
      ]),
    ),
  );

  $effect(() => {
    if (!browser) return;
    // Names are localized, so the catalog is refetched when the UI locale
    // changes. The module caches per locale, so switching back costs nothing.
    const viewerLocale = $locale;
    // Re-read when a picker opens, too. The module's TTL makes that a no-op
    // while the catalog is fresh and its in-flight de-duplication collapses a
    // burst, so the cost is at most one request per five minutes of actually
    // using the picker. What it buys is recovery: a catalog fetch that failed
    // when the editor loaded would otherwise leave this tab on the offline
    // seed until someone reloaded the page.
    void languagePicker;
    let cancelled = false;
    // `fetchLanguageCatalog` never rejects: every failure resolves to the seed.
    fetchLanguageCatalog({ locale: viewerLocale }).then((catalog) => {
      if (!cancelled) languageCatalog = catalog;
    });
    return () => {
      cancelled = true;
    };
  });

  /** Languages this article does not have yet — the "add a translation" list. */
  const addableLanguages = $derived(
    untranslatedLanguages({
      rows: variantRows,
      translatable: translatableLanguages,
    }),
  );

  /**
   * Every language the article could be *labelled*, including the ones it
   * already has a variant in — relabelling is orthogonal to what is written.
   */
  const relabelLanguages = $derived(
    untranslatedLanguages({
      rows: [],
      extraLanguages: variantRows.map((row) => row.language),
      translatable: translatableLanguages,
    }),
  );

  /**
   * Relabelling is offered ONLY while the source variant is the one on screen.
   *
   * `selectedLanguage === source_language` is what decides whether the next
   * save is a PUT to `/api/zpage/{id}/` or to the translation endpoint. Change
   * the article's language while a translation draft is open and that equality
   * flips underneath the draft: the very next autosave writes the translation's
   * text over the canonical article, and the original is gone from the UI. So
   * the chip's "change" is live for the source variant and for a brand-new
   * draft (where it is a purely local label), and disabled otherwise.
   */
  const canRelabel = $derived(
    !currentZPage ||
      (Boolean(currentZPage.free2zaddr) &&
        isCanonicalLanguage(selectedLanguage)),
  );

  /**
   * A one-line, human reason for the most recent refused save. Bare sentences
   * so they compose into the "Not saved yet — …" notice and into the
   * language-switch failure toast.
   */
  function saveBlockMessage(reason: SaveBlockReason | null): string | null {
    switch (reason) {
      case "translation-unresolved":
        return $t(
          "editor.translationUnresolved",
          "Saving is paused while a translation purchase is unresolved. Recover the purchase to continue.",
        );
      case "translations-running":
        return $t(
          "translationJobs.saveBlockedRunning",
          "Saving now would stop translations that are still running.",
        );
      case "in-flight":
        return $t("editor.saveBlockedInFlight", "A save is still finishing.");
      case "title-required":
        return $t(
          "editor.saveBlockedTitleRequired",
          "A published article needs a title.",
        );
      case "content-required":
        return $t(
          "editor.saveBlockedEmptyContent",
          "This version has no article body yet.",
        );
      case "description-too-long":
        return $t(
          "editor.saveBlockedDescriptionTooLong",
          "The description is longer than {count} characters.",
          { count: DESCRIPTION_MAX_LENGTH },
        );
      case "canonical-url-invalid":
        return $t(
          "editor.saveBlockedCanonicalUrl",
          "The original article URL is not a full https:// address.",
        );
      case "canonical-url-unsaved":
        return $t(
          "editor.saveBlockedCanonicalUnsaved",
          "Everything saved except the original article URL.",
        );
      case "save-unconfirmed":
        return $t(
          "editor.saveBlockedUnconfirmed",
          "The server did not confirm the save.",
        );
      case "auth-required":
        return $t(
          "editor.saveBlockedAuth",
          "Your session has expired — sign in again.",
        );
      case "validation":
        return $t(
          "editor.saveBlockedValidation",
          "Some fields still need fixing.",
        );
      case "conflict":
        // NOT "The server could not be reached." A 412 means the server was
        // reached, understood the request, and refused it because a newer
        // version exists — sending the creator off to retry a save that will
        // be refused identically forever is the  failure again.
        return $t(
          "editor.saveBlockedConflict",
          "A newer version of this article was saved elsewhere. Reload to continue.",
        );
      case "request-failed":
        return $t(
          "editor.saveBlockedRequestFailed",
          "The server could not be reached.",
        );
      case "timed-out":
        //the save was abandoned at its bound, not refused. Say that
        // the words are still here and what to do — the alternative was
        // "Saving…" forever and a dead Publish button. Autosave also retries
        // on its own (bounded by MAX_AUTOSAVE_RETRIES), and a success clears
        // this notice; the sentence does not promise a retry because once
        // those are spent none is coming.
        return $t(
          "editor.saveBlockedTimedOut",
          "The server did not answer in time. Your changes are still here — try saving again.",
        );
      case "create-timed-out":
        return $t(
          "editor.saveBlockedCreateTimedOut",
          "The server did not answer in time, and this new page may have been created anyway. Your changes are still here — check your pages before saving again, or saving may make a second copy.",
        );
      case "create-page-gone":
        return $t(
          "editor.saveBlockedCreatePageGone",
          "This page was created and has since been deleted, so it was not created again. Your changes are still here — save to create it as a new page.",
        );
      case "needs-2z":
        return $t(
          "editor.saveBlockedNeeds2z",
          "Starting another zPage needs 1 2Z. Your text is still here, not saved yet.",
        );
      case "deleting":
        return $t("editor.saveBlockedDeleting", "A deletion is in progress.");
      case "switching":
        return $t(
          "editor.saveBlockedSwitching",
          "The editor is opening another language.",
        );
      case "relabelling":
        return $t(
          "editor.saveBlockedRelabelling",
          "The article's language is being changed.",
        );
      case "wrong-account":
        return $t(
          "editor.saveBlockedWrongAccount",
          "You are signed in as a different account. Sign in as {owner} to save this draft.",
          { owner: getRouteData().currentUser.username },
        );
      default:
        return null;
    }
  }

  const saveBlockNotice = $derived(
    saveNoticeReason(
      saveBlockReason,
      saveError,
      saveBlockMessage(saveBlockReason),
    ),
  );

  /**
   * Sign back in without leaving the editor. The draft only exists in
   * this document, so a login PAGE would throw it away.
   */
  function promptOwnerSignIn(reason: SaveBlockReason) {
    requestLogin({
      notice:
        reason === "wrong-account"
          ? $t(
              "editor.saveBlockedWrongAccount",
              "You are signed in as a different account. Sign in as {owner} to save this draft.",
              { owner: getRouteData().currentUser.username },
            )
          : $t(
              "editor.saveBlockedAuth",
              "Your session has expired — sign in again.",
            ),
    });
  }

  /** "Spanish, French and Japanese", in the creator's UI language. */
  function languageList(languages: readonly string[]): string {
    const names = languages.map((language) => languageLabel(language));
    try {
      return new Intl.ListFormat($locale, {
        style: "long",
        type: "conjunction",
      }).format(names);
    } catch {
      return names.join(", ");
    }
  }

  /**
   * The running translations an explicit save of the open version would stop
   * only when what it would write differs from what the job was bought
   * against. The source job is bound to the BODY alone (`content_digest`), so
   * a tags-only save is safe; a translation's job is bound to its whole draft.
   */
  function translationsStoppedBySave(
    overrides?: Partial<SavePayload>,
  ): string[] {
    if (!jobsStoppedBySavingOpenVariant.length) return [];
    const canonical = isCanonicalLanguage(selectedLanguage);
    // Publishing the open TRANSLATION stops a job still writing into it (the
    // worker refuses to overwrite a published variant) even when no word
    // changed. Publishing the original does not: the jobs translate its
    // text, not its visibility (codex adversarial review).
    const publishes = !canonical && overrides?.is_published === true;
    const changed = canonical
      ? content !== persistedProse.content
      : content !== persistedProse.content ||
        title !== persistedProse.title ||
        description !== persistedProse.description;
    return changed || publishes ? [...jobsStoppedBySavingOpenVariant] : [];
  }

  async function confirmStoppingTranslations(
    languages: readonly string[],
  ): Promise<boolean> {
    const choice = await askEditorPrompt({
      title: $t(
        "translationJobs.stopTitle",
        "Saving now stops running translations",
      ),
      body: $t(
        "translationJobs.stopBody",
        "{languages} are still translating from the text you saved earlier. Saving these changes stops them. A stopped translation is refunded, unless this article was already changed while it ran — then the work already done is charged for.",
        { languages: languageList(languages) },
      ),
      confirmLabel: $t("translationJobs.stopConfirm", "Save and stop them"),
      cancelLabel: $t("translationJobs.stopCancel", "Keep editing"),
      danger: true,
    });
    return choice === "confirm";
  }

  function failSave(reason: SaveBlockReason): false {
    saveBlockReason = reason;
    return false;
  }

  function askEditorPrompt(prompt: EditorPrompt): Promise<EditorPromptChoice> {
    // Only one prompt can be open; resolve any straggler as a cancel so its
    // awaiting caller can never hang.
    settleEditorPrompt("cancel");
    editorPrompt = prompt;
    // A prompt waits on a human, possibly for minutes. Suspend autosave for
    // the whole decision: "Discard" must not race a timer that would persist
    // the very edits being thrown away, and a delete must not race a PUT that
    // `update_or_create` would use to resurrect the deleted row.
    clearAutoSaveTimer();

    return new Promise<EditorPromptChoice>((resolve) => {
      settleEditorPromptChoice = resolve;
    });
  }

  function settleEditorPrompt(choice: EditorPromptChoice) {
    const resolve = settleEditorPromptChoice;
    settleEditorPromptChoice = null;
    editorPrompt = null;
    resolve?.(choice);
    // The clock restarts here unless the caller (discard, save, delete) makes
    // the editor clean. Callers run after this, so their `clearAutoSaveTimer`
    // wins.
    if (isDirty) {
      scheduleAutoSave();
    }
  }

  /**
   * Throw away the unsaved edits in the current variant. The editor rehydrates
   * from the server on the next navigation, so the discarded text is simply
   * never sent. This is the escape hatch the language control never had.
   */
  function discardPendingChanges() {
    clearAutoSaveTimer();
    changeVersion = 0;
    savedVersion = 0;
    firstPendingChangeAt = null;
    autoSaveRetries = 0;
    canonicalUrlNeedsSave = false;
    saveBlockReason = null;
    saveError = null;
    validationErrors = {};
  }

  function clearAutoSaveTimer() {
    if (!autoSaveTimeout) {
      return;
    }

    clearTimeout(autoSaveTimeout);
    autoSaveTimeout = null;
  }

  function scheduleAutoSave(delay = AUTOSAVE_DELAY) {
    if (destroyed) {
      return;
    }

    clearAutoSaveTimer();

    // The clock is stopped while a save/discard/cancel decision is pending —
    // `markDirty()` from a late image upload or a stray keystroke must not
    // restart it behind the dialog — and while a DELETE is in flight, where a
    // late PUT would have the backend's update_or_create resurrect the row.
    // `settleEditorPrompt()` and the delete's `finally` restart it if the
    // creator still has edits.
    if (
      editorPrompt ||
      isDeletingTranslation ||
      isDeletingPage ||
      isSwitchingLanguage ||
      isRelabelling ||
      translateAiLanguage !== null ||
      translateIntoOpen ||
      isTranslating ||
      translationPending ||
      jobsStoppedBySavingOpenVariant.length > 0 ||
      translationReviewNeeded ||
      unresolvedTranslationLanguage !== null
    ) {
      return;
    }

    const now = Date.now();

    if (firstPendingChangeAt === null) {
      firstPendingChangeAt = now;
    }

    // Debounce, but never defer past AUTOSAVE_MAX_WAIT from the first
    // pending change — continuous typing must not starve autosave forever.
    const maxWaitRemaining = Math.max(
      0,
      firstPendingChangeAt + AUTOSAVE_MAX_WAIT - now,
    );

    autoSaveTimeout = setTimeout(
      () => {
        autoSaveTimeout = null;

        if (
          editorPrompt ||
          isDeletingTranslation ||
          isDeletingPage ||
          isRelabelling
        ) {
          // A prompt opened, or a delete or relabel started, after this timer
          // was armed. Do not save behind any of them; each reschedules when
          // it finishes.
          return;
        }

        firstPendingChangeAt = null;
        void autoSaveAfterRereadingJobs();
      },
      Math.min(delay, maxWaitRemaining),
    );
  }

  function markDirty() {
    changeVersion += 1;
    autoSaveRetries = 0;
    // A fresh edit may well fix whatever blocked the last save; the pending
    // autosave re-derives the reason if it does not.
    saveBlockReason = null;
    scheduleAutoSave();
  }

  function getRouteData() {
    return data as EditPageData;
  }

  // A new route has no server-side page yet. Its empty body is an expected
  // starting state, not a failed save; keep that distinction separate from an
  // existing page whose body is genuinely blocking a save. A real save error
  // stays visible even if the creator clears the body while that request is
  // still resolving.
  const isNewPage = $derived(
    getRouteData().requestedId === "new" && currentZPage === null,
  );
  /**
   * A DIFFERENT account is now behind this editor (codex adversarial review
   * of ).
   *
   * Signing back in happens IN PLACE here — the draft only exists in this
   * document, so navigating away to a login page would throw it out. The
   * consequence is that the session the next save is sent with is no longer
   * necessarily the one the page loaded under: sign in as somebody else,
   * whether through the editor's own expired-session prompt or the navbar,
   * and `zPageViewSet.create()` takes ownership from `request.user` — so the
   * draft is created, and can be published, under an account that never
   * wrote it, while the editor's own `data.currentUser` still names the
   * original owner everywhere else on screen.
   *
   * An unresolved identity cannot prove ownership, regardless of which
   * component or background check discovered the session change.
   */
  const ownerSignedIn = $derived(
    Number.isSafeInteger($currentUser?.id) &&
      $currentUser?.id === getRouteData().currentUser.id,
  );
  // Every save requires a positively identified owner. A global auth failure
  // can clear identity before this editor ever receives its own save failure.
  const cannotSaveAsOwner = $derived(!ownerSignedIn);
  const hasValidationErrors = $derived(
    Object.values(validationErrors).some((message) => Boolean(message)),
  );
  const showEmptyDraftSaveState = $derived(
    isNewPage &&
      !content.trim() &&
      !saveError &&
      !hasValidationErrors &&
      (saveBlockReason === null || saveBlockReason === "content-required"),
  );

  function applyHydratedState() {
    const routeData = getRouteData();
    lastHydratedRouteData = routeData;
    // A different document: an unresolved create from the previous one must
    // not be adopted as this one's page.
    pendingCreate = null;
    relabelAfterReconcile = null;
    // Likewise the keyless-create latch: it guards against a duplicate of the
    // draft whose create timed out, and that draft is no longer on screen.
    // Left set, it would hold every autosave of the next document (New post).
    createOutcomeUnknown = false;
    createLatchReason = "create-timed-out";
    createNeeds2z = null;
    // A leave-flush still resolving belongs to the previous document; it
    // must not swallow this document's own navigations meanwhile.
    pendingNavigationFlush = false;
    // Before anything is written, so every child watching `metadataResetKey`
    // re-baselines against the state this function is about to install rather
    // than against what was on screen a moment ago.
    hydrationGeneration += 1;
    // The prior document may still have a write in flight, but it no longer
    // owns this editor's busy state. Its response is fenced by the generation
    // captured when that save started.
    isSaving = false;
    selectedLanguage = routeData.requestedLanguage;
    availableLanguages = (routeData.zpage?.available_languages || []).filter(
      (language): language is string =>
        typeof language === "string" && language !== "und",
    );
    // A variant the article does not have yet: the editor opens blank on
    // purpose so the creator can write it. Reaching this state is only ever
    // possible through the explicit "start writing the … version" action, and
    // the banner keyed off `isNewTranslationDraft` says so out loud.
    const requestedVariantMissing = Boolean(
      routeData.zpage &&
      isRequestedVariantMissing(
        routeData.zpage.actual_language,
        routeData.requestedLanguage,
      ),
    );
    isNewTranslationDraft = requestedVariantMissing;
    const exactVariant =
      routeData.zpage && requestedVariantMissing
        ? {
            ...routeData.zpage,
            title: "",
            description: "",
            content: "",
            variant_is_published: false,
            requested_language: routeData.requestedLanguage,
          }
        : routeData.zpage;
    const hydratedState = hydrateEditorState(exactVariant);

    currentZPage = hydratedState.currentZPage;
    title = hydratedState.title;
    description = hydratedState.description;
    canonicalUrl = hydratedState.canonicalUrl;
    coverImage = hydratedState.coverImage;
    coverImageId = hydratedState.coverImageId;
    tags = hydratedState.tags;
    zcashAddress = hydratedState.zcashAddress;
    content = hydratedState.content;
    persistedProse = {
      title: hydratedState.title,
      description: hydratedState.description,
      content: hydratedState.content,
    };
    lastHydratedAt = Date.now();
    vanity = hydratedState.vanity;
    derivedVanity = "";
    rejectedDerivedVanities.clear();
    isPublished = hydratedState.isPublished;
    isSubscriberOnly = hydratedState.isSubscriberOnly;
    publishAt =
      !exactVariant ||
      (exactVariant.source_language
        ? routeData.requestedLanguage === exactVariant.source_language
        : !routeData.explicitLanguage)
        ? hydratedState.publishAt
        : "";
    showCover = hydratedState.showCover;
    showSubtitle = hydratedState.showSubtitle;
    validationErrors = {};
    saveError = null;
    lastSavedAt = null;
    changeVersion = 0;
    savedVersion = 0;
    firstPendingChangeAt = null;
    autoSaveRetries = 0;
    canonicalUrlNeedsSave = false;
    saveBlockReason = null;
    languagePicker = null;
    saveConflicted = false;
    translationReviewNeeded = false;
    translationReviewTarget = null;
    // Seed the canonical article's validator from the load's own GET.
    // Re-seeded rather than merged on every hydration: a hydration means the
    // editor is now looking at freshly read state, and any validator held from
    // before it describes a version the creator can no longer see.
    seedCanonicalEtag(routeData);
    // Never show one article's variants next to another's while the refresh
    // is in flight.
    variants = null;
    clearAutoSaveTimer();
    void refreshVariants();
    syncUnresolvedTranslation();
    closeTranslateWithAi();
    if (currentZPage?.free2zaddr !== translationRestorePage) {
      // Another article: hand the slot's job back to the store NOW, not when
      // its watcher's in-flight read happens to return.
      if (translationProgress)
        translationJobs.release(
          translationProgress.page,
          translationProgress.language,
        );
      translationRestorePage = currentZPage?.free2zaddr ?? null;
      translationMonitorId += 1;
      isTranslating = false;
      isBuyingTranslation = false;
      translationProgress = null;
      if (translationRestorePage)
        void restoreTranslationProgress(translationRestorePage);
      reviewLanguage = null;
      translateIntoOpen = false;
      // After the restore: it claims the receipt's job synchronously, so the
      // store never starts a second poller for it.
      if (translationRestorePage) seedTranslationJobs(translationRestorePage);
    }
    translationJobs.setEditorPage(currentZPage?.free2zaddr ?? null);
  }

  /**
   * Fill the jobs store for this article: this browser's receipts first (so a
   * reload shows what it knew instantly), then the server's list, which wins.
   */
  function seedTranslationJobs(identifier: string) {
    if (!browser) return;
    try {
      for (const job of receiptJobs(
        localStorage,
        translationReceiptKey(identifier),
      ))
        translationJobs.ingest(identifier, job, { fromReceipt: true });
    } catch {
      /* No storage: the server list still answers. */
    }
    bulkIntent = readBulkIntent(identifier);
    void translationJobs.refresh(identifier);
  }

  /**
   * Point the registry at the canonical article's validator for this route.
   *
   * The load fetches `/api/zpage/{id}/` (with `?lang=` when a translation is
   * open) and that response's `ETag` always describes the CANONICAL row, so it
   * is filed under the canonical save URL and nothing else. A translation
   * variant's validator arrives on that variant's own response — which, in the
   * editor, is the first translation save. That first save therefore goes out
   * unconditioned, exactly as every save did before; every one after it
   * in the session is conditional. Closing that last gap needs a
   * `GET /variants/{lang}/` on editor open, which is a round trip this change
   * deliberately does not add.
   */
  function seedCanonicalEtag(routeData: EditPageData) {
    const identifier = routeData.zpage?.free2zaddr;
    if (!identifier) return;
    etags.set(canonicalEtagKey(identifier), routeData.zpageEtag);
    if (routeData.variantLanguage) {
      etags.set(
        variantResourceUrl(identifier, routeData.variantLanguage),
        routeData.variantEtag,
      );
    }
  }

  /**
   * The registry key for one variant — NOT necessarily the URL it is written
   * to.
   *
   * The editor still saves translations through the deprecated
   * `/translations/{lang}/` alias while it deletes them through the
   * `/variants/{lang}/` route. Both address the same state and the API returns
   * the same validator for both, so filing them under the URL each request
   * happens to use makes the two keys drift the moment a translation is saved:
   * the save updates the alias key, the delete keeps reading the `/variants/`
   * one from page load, and the next delete gets a 412 for a change the same
   * tab made. One key per RESOURCE, not per route. (codex adversarial review.)
   */
  function variantResourceUrl(identifier: string, language: string) {
    return `/api/zpage/${encodeURIComponent(identifier)}/variants/${encodeURIComponent(language)}/`;
  }

  /**
   * Drop every validator after a canonical write this tab made outside the
   * save path.
   *
   * Two of those exist — the article-language relabel PATCH and accepting an
   * AI tag suggestion — and both change the canonical row without returning a
   * readable `ETag`. A stale validator after a change we made ourselves is
   * worse than none: the next autosave 412s and the editor latches into "you
   * are holding a superseded version" over an edit nobody else made, and the
   * only way out is a reload that discards the creator's unsaved work.
   */
  function invalidateEtags(identifier: string | undefined) {
    if (!identifier) return;
    // Every validator, not just the canonical one. A translation's validator
    // digests the canonical row as well — a translation PUT writes `p2paddr`,
    // `vanity`, tags and the rest onto the parent — so a canonical write made
    // outside the save path leaves NO entry describing current state. Keeping
    // the variant entry latched a translation editor into a permanent false
    // "someone else saved this", whose only remedy discards their unsaved
    // work. (codex adversarial review.)
    etags.clear();
  }

  /** Registry key for the canonical article. */
  function canonicalEtagKey(identifier: string) {
    return `/api/zpage/${encodeURIComponent(identifier)}/`;
  }

  /** Which validator a save to `saveUrl` should carry, and record itself under. */
  function preconditionKeyFor(
    identifier: string | undefined,
    language: string,
    isCanonical: boolean,
  ): string | null {
    if (!identifier) return null;
    return isCanonical
      ? `/api/zpage/${encodeURIComponent(identifier)}/`
      : variantResourceUrl(identifier, language);
  }

  /**
   * Per-variant status for the Translations panel.
   *
   * Best-effort by design. The route shipped with, but a rolling deploy
   * can still put an older pod in front of this editor. Anything other than a
   * 200 leaves `variants` null, and the panel falls back to
   * `available_languages` — fewer facts, no wrong ones. A failure here must
   * never surface as an error or block writing.
   */
  async function refreshVariants(identifier = currentZPage?.free2zaddr) {
    // Last request wins: a fast switch can land two of these out of order.
    const requestId = ++variantsRequestId;

    if (!identifier || !variantsEndpointSupported) {
      variants = null;
      return;
    }

    try {
      const rows = await zpageVariantsList(identifier, { mine: true });
      if (requestId !== variantsRequestId) return;
      variants = Array.isArray(rows) ? rows : null;
    } catch (error: unknown) {
      // A deployment without the route at all (an older pod during a rolling
      // deploy, or a stale service worker). Asking again on every hydration
      // and every save would be a 404 per editing burst, forever — ask once.
      if (
        error instanceof ApiError &&
        (error.status === 404 || error.status === 405)
      ) {
        variantsEndpointSupported = false;
      }
      if (requestId === variantsRequestId) variants = null;
    }
  }

  /**
   * "Have I already put this server response into the composer?"
   *
   * This key throttles unconsented, destructive writes. Every time it changes,
   * the effect below replaces the composer's contents and resets the dirty
   * counters. The explicit New post action contributes a unique token because
   * it is the creator's request to begin a different document; every other
   * `data` refresh must still clear the higher bar. A `data` object arrives
   * from any `invalidateAll()` anywhere in the app (the layout's own startup
   * locale reconciliation is one), so the bar for "this response is worth
   * clobbering the editor over" has to stay high.
   *
   * Which is why it is deliberately NOT widened to name the response exactly.
   * `updated_at` is the zPage ROW's — `LocalizedZPageSerializerMixin` overlays
   * title/description/content for the requested language and leaves the stamp
   * alone, and `translation/tasks.py` writes the variant rows without ever
   * saving the parent — so a variant-only change is invisible here. An earlier
   * draft of the  fix added `actual_language`, `variant_is_published` and
   * both ETags to close that gap, and the codex adversarial review caught what
   * it opened: a delivery landing during a slow background reload would then
   * change the key and silently overwrite whatever the creator had typed in the
   * meantime. Seeing a variant change is worth nothing if the price is eating
   * unsaved work.
   *
   * The  blind spot is closed at the other end instead:
   * `commitLanguageSwitch` calls `rehydrateFromRoute()` and does not consult
   * this key at all. A reload the editor ASKED for, having already settled the
   * creator's unsaved work, is hydrated unconditionally. A reload that happened
   * TO it is still throttled exactly as it was before this change — no wider a
   * surface for a silent discard than the editor already had.
   *
   * The cost, stated plainly: a passive `invalidateAll()` that changes only a
   * variant still will not reach the composer. The next save then carries a
   * stale validator and gets a 412, which latches `saveConflicted` and tells
   * the creator a newer version exists — the honest outcome, and the one
   * built.
   */
  function hydrationKeyFor(
    routeData: EditPageData,
    newPostNavigation: string | null = lastNewPostNavigation,
  ) {
    // JSON, not a joined string: a separator that cannot appear in a vanity
    // slug or a language tag is a thing to get wrong later, and two fields
    // sliding into each other would silently re-create the bug.
    return JSON.stringify([
      routeData.requestedId,
      routeData.requestedLanguage,
      routeData.zpage?.updated_at ?? "new",
      newPostNavigation,
    ]);
  }

  /**
   * The exact `data` object the composer was last filled from.
   *
   * Identity, not a digest: it answers "have I already hydrated from THIS
   * response?", which is the only question `rehydrateFromRoute` needs and the
   * one `hydrationKeyFor` cannot answer without a false negative. It is
   * deliberately NOT what the effect below uses — see there.
   */
  let lastHydratedRouteData: unknown = null;

  /**
   * Put the route's current load into the composer, whatever the key says.
   *
   * For the one caller that navigated on purpose — `commitLanguageSwitch`,
   * which has already settled the creator's unsaved work before it asked. See
   * `hydrationKeyFor` for why the throttle it skips has to stay narrow.
   * Skipped only when the effect below has already hydrated this same
   * response object, so a switch costs exactly one hydration either way.
   */
  function rehydrateFromRoute() {
    if (getRouteData() === lastHydratedRouteData) return;
    const routeData = getRouteData();
    lastHydratedKey = hydrationKeyFor(routeData);
    applyHydratedState();
  }

  $effect(() => {
    const routeData = getRouteData();
    const requestedNewPostNavigation = page.url.searchParams.get("newPost");
    if (requestedNewPostNavigation) {
      lastNewPostNavigation = requestedNewPostNavigation;
      // The URL can update before SvelteKit finishes loading the new route.
      // Do not hydrate the article the creator is leaving during that gap;
      // the same marker will be present when the new route data arrives.
      if (routeData.requestedId !== "new") return;
    }
    const nextHydrationKey = hydrationKeyFor(
      routeData,
      requestedNewPostNavigation ?? lastNewPostNavigation,
    );

    // The key, not the object identity, on purpose. SvelteKit hands out a new
    // `data` object for every `invalidateAll` anywhere in the app, and
    // hydrating on each one would throw away whatever the creator has typed
    // since — this branch is the only thing standing between a background
    // reload and an unconsented overwrite. `rehydrateFromRoute` is the
    // exception, for a load the editor asked for and has already settled the
    // creator's edits over.
    if (nextHydrationKey === lastHydratedKey) {
      return;
    }

    lastHydratedKey = nextHydrationKey;
    applyHydratedState();
  });

  function updateEditorUrl(identifier: string) {
    if (!browser) {
      return;
    }

    // `editorVariantHref` drops an unnameable language (`und`) rather than put
    // it in a URL, so the legacy source keeps its query-free editor URL.
    replaceState(
      editorVariantHref(
        identifier === "new" ? null : identifier,
        selectedLanguage,
      ),
      {},
    );
  }

  function buildSavePayload() {
    return {
      // The backend requires a title, but drafts should autosave before the
      // user has typed one — fall back to a placeholder (Medium-style).
      // Publishing a real article still requires a real title.
      title: title.trim() || UNTITLED_DRAFT_TITLE,
      // Strip in-flight "Uploading image…" placeholders from the outgoing
      // payload only — local state keeps them until the upload resolves.
      content: stripUploadPlaceholders(content).trim(),
      // Keep cleared optional fields in the payload. Omitting them from a
      // PUT makes DRF preserve the previous value instead of clearing it.
      description: description.trim(),
      canonical_url: canonicalUrl.trim(),
      tags: [...tags],
      vanity: vanity.trim(),
      p2paddr: zcashAddress.trim(),
      featured_image: showCover ? coverImageId : null,
      is_published: isPublished,
      is_subscriber_only: isSubscriberOnly,
      publish_at: publishAt ? new Date(publishAt).toISOString() : null,
      ...(!currentZPage && normalizeContentLanguage(selectedLanguage)
        ? { source_language: selectedLanguage }
        : {}),
    } satisfies SavePayload;
  }

  function applySavedZPage(
    zpage: ZPage & { featured_image?: any },
    isClean: boolean,
    sentTags?: readonly string[],
    mayAdoptServerVanity = false,
  ) {
    currentZPage = zpage;
    isPublished = zpage.variant_is_published ?? zpage.is_published;

    // Never write title/description/content back from the response: the user
    // may have kept typing while the request was in flight, and overwriting
    // those fields would drop keystrokes and reset the cursor.
    if (!isClean) {
      // Edits arrived mid-save — keep all local state; the rescheduled
      // autosave will sync it. EXCEPT tags the server kept that this tab
      // never sent (: AI tags auto-applied to a blank page while the
      // editor was open). The response's ETag is adopted regardless, so
      // keeping the stale local list would make the rescheduled autosave
      // erase those tags under an exact precondition match. Only when the
      // tag field itself did not change during the request — otherwise the
      // creator's in-flight tag edit wins, as it should.
      if (
        sentTags &&
        Array.isArray(zpage.tags) &&
        JSON.stringify([...tags].sort()) ===
          JSON.stringify([...sentTags].sort())
      ) {
        tags = zpage.tags;
      }
      // A publish can assign a vanity on the server. Adopt that URL across
      // other in-flight edits only when the vanity field itself stayed
      // untouched; a creator edit to the field takes precedence.
      if (mayAdoptServerVanity && Object.hasOwn(zpage, "vanity")) {
        vanity = zpage.vanity || "";
        derivedVanity = "";
      }
      return;
    }

    vanity = zpage.vanity || "";
    // During a rolling deploy an older Django pod can return a successful
    // response without canonical_url. Keep the creator's local value in that
    // case instead of treating the missing field as an authoritative clear.
    if (Object.hasOwn(zpage, "canonical_url")) {
      canonicalUrl = zpage.canonical_url || "";
    }
    // Deliberately NOT adopted from the response. a write
    // answers with the read representation, whose `p2paddr` is the EFFECTIVE
    // support address -- the page's own, else the creator's. Copying that
    // into the field would turn "inherit my profile address" (an empty field)
    // into a pinned copy of it on the next autosave, and a later profile
    // address change would silently stop reaching this article. The server
    // stores exactly what was sent, so the local value is already the truth.
    tags = zpage.tags ?? tags;
    isSubscriberOnly = zpage.is_subscriber_only;
    publishAt = isCanonicalLanguage(selectedLanguage)
      ? toDatetimeLocal(zpage.publish_at)
      : "";

    if (typeof zpage.featured_image === "number") {
      coverImageId = zpage.featured_image;
      showCover = true;
      return;
    }

    if (zpage.featured_image?.url || zpage.featured_image?.thumbnail) {
      coverImageId = zpage.featured_image.id;
      coverImage = resolveMediaUrl(
        zpage.featured_image.url || zpage.featured_image.thumbnail,
      );
      showCover = true;
      return;
    }

    coverImageId = null;
    coverImage = "";
    showCover = false;
  }

  function handleTitleChange() {
    validationErrors.title = undefined;

    // Keep auto-slugging the vanity from the title until a vanity has been
    // saved — untitled drafts autosave early, so "has been saved" can't be
    // inferred from currentZPage alone.
    // ASCII only: a vanity derived with non-Latin letters in it is
    // refused by the API, and that refusal used to fail every autosave.
    if (title && !isPublished && !currentZPage?.vanity) {
      const proposed = vanityFromTitle(title);
      if (!rejectedDerivedVanities.has(proposed)) {
        vanity = proposed;
        derivedVanity = proposed;
      } else if (vanity === derivedVanity) {
        vanity = "";
        derivedVanity = "";
      }
    }

    markDirty();
  }

  function handleDescriptionChange() {
    markDirty();
  }

  function handleCoverImageChange() {
    markDirty();
  }

  function handleContentChange() {
    markDirty();
  }

  function handleMetadataChange() {
    validationErrors.vanity = undefined;
    // Any edit that leaves the vanity different from the editor's proposal
    // makes it the creator's: from here on its refusal is shown to them, never
    // silently dropped — even if they later type the proposal back.
    if (vanity !== derivedVanity) derivedVanity = "";

    // A description added from the publish sheet should surface the subtitle
    // in the composer and preview, which are gated on showSubtitle.
    if (description.trim()) {
      showSubtitle = true;
    }

    markDirty();
  }

  function recordVanityEdit() {
    vanityEditRevision += 1;
  }

  function canonicalUrlValidationMessage(
    error: ReturnType<typeof getCanonicalUrlError>,
    autosave = false,
  ) {
    if (!error) return undefined;
    if (error === "credentials") {
      return $t(
        "editor.canonicalUrlCredentials",
        "Remove the username and password from this URL.",
      );
    }
    if (error === "fragment") {
      return $t(
        "editor.canonicalUrlFragment",
        "Remove the #fragment from this URL.",
      );
    }
    return autosave
      ? $t(
          "editor.canonicalUrlAutosaveInvalid",
          "Enter the full original article URL, including https://. Your other article changes will continue saving.",
        )
      : $t(
          "editor.canonicalUrlInvalid",
          "Enter the full original article URL, including https://.",
        );
  }

  function handleCanonicalUrlChange(value: string) {
    if (!getCanonicalUrlError(value)) {
      validationErrors.canonical_url = undefined;
    }
    handleMetadataChange();
  }

  function handleCanonicalUrlBlur(value: string) {
    validationErrors.canonical_url = canonicalUrlValidationMessage(
      getCanonicalUrlError(value),
    );
  }

  class SaveOwnerChangedError extends Error {}
  class StaleSaveDocumentError extends Error {}

  function saveDocumentIsCurrent(generation: number) {
    return hydrationGeneration === generation;
  }

  // A superseded request is abandoned without changing the new document's
  // save status or error state.
  function abandonObsoleteDocumentSave(): false {
    return false;
  }

  function confirmSaveOwner(options: SaveOptions): boolean {
    if (!cannotSaveAsOwner) return true;
    const reason: SaveBlockReason = $currentUser
      ? "wrong-account"
      : "auth-required";
    if (!options.isAuto) promptOwnerSignIn(reason);
    return failSave(reason);
  }

  /**
   * Autosave, after asking whether jobs exist that this tab does not know
   * about (another tab or device bought them). `handleSave` then holds the
   * save by itself if any would be stopped ( review).
   */
  async function autoSaveAfterRereadingJobs(waitMs = 5000) {
    const documentGeneration = hydrationGeneration;
    if (saveMayStopUnseenJobs()) {
      const read = await rereadJobs(currentZPage!.free2zaddr, waitMs);
      if (!saveDocumentIsCurrent(documentGeneration))
        return abandonObsoleteDocumentSave();
      // Could not ask: hold, rather than save over jobs we cannot see. The
      // notice says so, an explicit save asks, and the next autosave tries
      // the question again (codex adversarial review).
      jobsCheckFailed = read === "failed";
      if (jobsCheckFailed) {
        scheduleAutoSave();
        return false;
      }
    }
    if (!saveDocumentIsCurrent(documentGeneration))
      return abandonObsoleteDocumentSave();
    return handleSave({ isAuto: true });
  }

  async function handleSave(options: SaveOptions = {}): Promise<boolean> {
    const documentGeneration = hydrationGeneration;
    // Visibility and navigation flushes bypass the debounce scheduler. Apply
    // the same pause here so backgrounding cannot overwrite a pending target.
    // Explicit source saves before quoting and explicit user choices still run.
    if (
      options.isAuto &&
      (editorPrompt ||
        isDeletingTranslation ||
        isDeletingPage ||
        isSwitchingLanguage ||
        isRelabelling ||
        translateAiLanguage !== null ||
        translateIntoOpen ||
        isBuyingTranslation ||
        isTranslating ||
        translationPending ||
        jobsStoppedBySavingOpenVariant.length > 0 ||
        translationReviewNeeded ||
        unresolvedTranslationLanguage !== null)
    )
      return false;
    if (unresolvedTranslationLanguage !== null)
      return failSave("translation-unresolved");
    if (translationReviewNeeded) return failSave("conflict");
    // An explicit save that would stop running translations asks first, and
    // names them. It used to go straight through: "Save and switch"
    // mid-job silently ended the job as `source_changed`.
    if (!options.isAuto && !options.stopsTranslations) {
      // What this save is FOR — the article, language and loaded draft. The
      // questions below await the network and the creator; if the editor
      // moves to another version meanwhile, this save (and any publish
      // override it carries) must not land on that one (codex adversarial
      // review,  verification round).
      const target = `${currentZPage?.free2zaddr ?? ""}|${openLanguage}|${hydrationGeneration}`;
      const moved = () =>
        target !==
        `${currentZPage?.free2zaddr ?? ""}|${openLanguage}|${hydrationGeneration}`;
      // Jobs bought in another tab or on another device are invisible until
      // asked for; a source save would stop them unannounced.
      const jobsRead = saveMayStopUnseenJobs()
        ? await rereadJobs(currentZPage!.free2zaddr, 5000)
        : null;
      if (!saveDocumentIsCurrent(documentGeneration))
        return abandonObsoleteDocumentSave();
      if (jobsRead === "failed") {
        const choice = await askEditorPrompt({
          title: $t(
            "translationJobs.cannotCheckSaveTitle",
            "Could not check for running translations",
          ),
          body: isCanonicalLanguage(selectedLanguage)
            ? $t(
                "translationJobs.cannotCheckSaveBody",
                "Saving the original stops any translation of it that is running — including one started on another device. Save anyway?",
              )
            : $t(
                "translationJobs.cannotCheckSaveDraftBody",
                "Saving this {language} draft stops a translation into it that is running — including one started on another device. Save anyway?",
                { language: languageLabel(openLanguage) },
              ),
          confirmLabel: $t("translationJobs.saveAnyway", "Save anyway"),
          cancelLabel: $t("translationJobs.stopCancel", "Keep editing"),
          danger: true,
        });
        if (!saveDocumentIsCurrent(documentGeneration))
          return abandonObsoleteDocumentSave();
        if (choice !== "confirm") return failSave("translations-running");
        options = { ...options, stopsTranslations: true };
      }
      if (moved()) return failSave("switching");
      const stopped = options.stopsTranslations
        ? []
        : translationsStoppedBySave(options.overrides);
      if (stopped.length) {
        const confirmed = await confirmStoppingTranslations(stopped);
        if (!saveDocumentIsCurrent(documentGeneration))
          return abandonObsoleteDocumentSave();
        if (!confirmed) return failSave("translations-running");
      }
      if (moved()) return failSave("switching");
    }
    // One choke point for every save trigger — autosave, Cmd-S, the publish
    // sheet, the visibility flush and the navigation flush. A PUT landing
    // during a DELETE would have the backend's update_or_create resurrect the
    // row; a PUT during a language switch would write the body still on screen
    // to the endpoint of the variant that has not loaded yet.
    // Refuse rather than misattribute. The work stays on screen, and a manual
    // save reopens the sign-in modal IN PLACE so this is a recoverable state
    // rather than a dead end — an autosave only leaves the notice, because a
    // timer that reopens a dialog every few seconds is its own bug.
    if (!confirmSaveOwner(options)) return false;
    if (!saveDocumentIsCurrent(documentGeneration))
      return abandonObsoleteDocumentSave();

    if (isDeletingTranslation) {
      return failSave("deleting");
    }

    if (isDeletingPage) {
      return failSave("deleting");
    }

    if (isSwitchingLanguage) {
      return failSave("switching");
    }

    // Latched by a 412. Refusing here rather than sending the request is the
    // point: the alternative is a save that either fails identically forever
    // or, if the validator were dropped, succeeds by overwriting the newer
    // version the creator was just told about.
    if (saveConflicted) {
      return failSave("conflict");
    }

    // A relabel is a PATCH on `/api/zpage/{id}/`. DRF loads the whole row,
    // sets one field and calls `.save()` — so a PUT that commits between that
    // load and that save is written straight back out of a stale instance,
    // silently reverting the body, the tags or the payout address. The two
    // writes are serialized instead: this refuses, and the relabel drains any
    // save already in flight before it starts.
    if (isRelabelling) {
      return failSave("relabelling");
    }

    if (isSaving) {
      if (options.isAuto) {
        // The in-flight save reschedules on completion if changes remain.
        return failSave("in-flight");
      }

      // Manual save / publish: wait for the in-flight save instead of
      // silently dropping the user's action.
      const createTimeoutsBeforeWait = createTimeouts;
      while (currentSavePromise) {
        await currentSavePromise;
      }
      if (!saveDocumentIsCurrent(documentGeneration))
        return abandonObsoleteDocumentSave();
      // A create that timed out WHILE this action waited may have made the
      // page. This click predates the warning, so it cannot be the creator's
      // informed "save anyway" — refuse rather than POST a second copy
      // (codex review). The next click, made after the notice, goes ahead.
      if (createTimeouts !== createTimeoutsBeforeWait) {
        return failSave("create-timed-out");
      }
    }

    // The session can change while a manual save waits for an older save.
    if (!confirmSaveOwner(options)) return false;

    const savePromise = performSave(options);
    currentSavePromise = savePromise;

    let saved = false;
    try {
      saved = await savePromise;
      return saved;
    } finally {
      if (currentSavePromise === savePromise) currentSavePromise = null;
      // A relabel the creator made while a create was unresolved:
      // the reconciled page exists in its ORIGINAL language, and the save
      // above wrote the draft there. Apply the label they chose the way any
      // persisted article is relabelled — never as a translation write.
      // Kept until a save succeeds, so a failed one does not lose the choice.
      const relabel = relabelAfterReconcile;
      if (saved && relabel && saveDocumentIsCurrent(documentGeneration)) {
        relabelAfterReconcile = null;
        void changeArticleLanguage(relabel);
      }
    }
  }

  /**
   * Resolve a keyed create whose outcome is unknown, before anything
   * else is saved.
   *
   * Re-sends the ORIGINAL body under the ORIGINAL key — not the current
   * draft, which the server would refuse as a different request under that
   * key. Whatever the creator typed since is then saved by the ordinary PUT
   * that follows, onto the page this establishes.
   *
   * - `"created"`: the page exists (made now, or replayed); `currentZPage` is
   *   set, so the caller carries on with an update.
   * - `"not-created"`: a 400 — the server checks the key first, so this
   *   means nothing committed under it and the key was never spent; the caller
   *   carries on with a fresh create.
   * - `"refused"`: the server will not honour the key (409). Back to the
   *   pre- latch — the creator is told to check their pages.
   * - `"auth-required"` / `"unknown"`: nothing learned; the attempt is kept.
   *
   * A timeout or network failure throws, into `performSave`'s catch, which
   * keeps the attempt and lets autosave retry it.
   */
  async function reconcilePendingCreate(
    attempt: { key: string; body: string },
    options: SaveOptions,
    documentGeneration: number,
  ): Promise<
    "created" | "not-created" | "refused" | "gone" | "auth-required" | "unknown"
  > {
    const operationNotice = captureAccountToast();
    if (!saveDocumentIsCurrent(documentGeneration)) {
      throw new StaleSaveDocumentError();
    }
    if (!confirmSaveOwner(options)) throw new SaveOwnerChangedError();
    const requestOwnership = authStore.captureRequestOwnership();
    const response = await apiFetch("/api/zpage/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Hand-wired: orval emits nothing for `in: header` parameters.
        [ZPAGE_CREATE_IDEMPOTENCY_HEADER]: attempt.key,
      },
      body: attempt.body,
    });
    if (!saveDocumentIsCurrent(documentGeneration)) {
      throw new StaleSaveDocumentError();
    }
    const honored = noteCreateResponse(response);
    const result = await response.json().catch((error: unknown) => {
      if (isRequestTimeout(error)) throw error;
      return {};
    });
    if (!saveDocumentIsCurrent(documentGeneration)) {
      throw new StaleSaveDocumentError();
    }
    const outcome = resolvesCreateAttempt(response.status, result);
    if (outcome !== "unresolved" && pendingCreate === attempt) {
      pendingCreate = null;
    }
    if (outcome === "refused") {
      return result?.code === "idempotency_page_gone" ? "gone" : "refused";
    }
    if (outcome === "not-created") return "not-created";
    if (outcome === "unresolved") {
      // This RETRY was turned away before it could consult the receipt
      // (expired session, CSRF, throttling, a proxy): it proves nothing about
      // the original, so the attempt is kept for the next one.
      if (response.status === 401 || response.status === 403) {
        if (requestOwnership()) {
          authStore.handleAuthFailure(response.status);
          promptOwnerSignIn("auth-required");
        }
        return "auth-required";
      }
      return "unknown";
    }

    etags.remember(
      `/api/zpage/${encodeURIComponent(result.free2zaddr)}/`,
      response,
    );
    // The body replayed is an OLDER draft than the one on screen, so nothing
    // local is overwritten — not even the publish toggle, which the save that
    // follows is about to send as the creator last set it.
    const localPublished = isPublished;
    const intendedLanguage = selectedLanguage;
    // EXCEPT a vanity the server generated: the replayed body sent
    // none, and the field is still blank here, so nobody chose one. Keeping
    // the blank would make the save that follows clear it — and once the
    // page is published the server never generates it again.
    let sentVanity = "";
    try {
      sentVanity = String(JSON.parse(attempt.body)?.vanity ?? "");
    } catch {
      sentVanity = "";
    }
    applySavedZPage(
      result as ZPage,
      false,
      undefined,
      !sentVanity.trim() && !vanity.trim(),
    );
    isPublished = localPublished;
    // The creator relabelled the unsaved draft while this create was
    // unresolved. The page exists in the language it was CREATED with, so
    // the save that follows must target its source — otherwise the new
    // language routes to `/variants/{lang}/` and the draft becomes a
    // translation (codex review). The chosen label is applied afterwards.
    const createdLanguage = (result as ZPage).source_language;
    if (
      typeof createdLanguage === "string" &&
      createdLanguage &&
      intendedLanguage !== createdLanguage &&
      normalizeContentLanguage(intendedLanguage)
    ) {
      selectedLanguage = createdLanguage as EditorLanguage;
      relabelAfterReconcile = intendedLanguage;
    }
    updateEditorUrl(result.vanity || result.free2zaddr);
    if (!honored) {
      // Answered by a backend that ignores the key (a rollback since this
      // session last saw the signal): this page is real, but the original
      // attempt may have made another. Say so; the capability is withdrawn,
      // so nothing will auto-retry a create again this session.
      operationNotice.error(
        $t(
          "editor.createMayHaveDuplicated",
          "Your page is saved, but an earlier attempt that timed out may have made a second copy. Check your pages and delete any duplicate.",
        ),
        { duration: Infinity },
      );
    }
    return "created";
  }

  async function performSave(options: SaveOptions): Promise<boolean> {
    const operationNotice = captureAccountToast();
    const { isAuto = false, overrides, successMessage } = options;
    const documentGeneration = hydrationGeneration;

    if (isSaving) {
      return failSave("in-flight");
    }

    // A timed-out create may have made the page already (see the catch
    // below). Autosave must not POST again on its own; a save the creator
    // asks for — after being told to check — goes ahead and clears the latch.
    if (createOutcomeUnknown && !currentZPage?.free2zaddr) {
      if (isAuto) return failSave(createLatchReason);
      createOutcomeUnknown = false;
    }

    //a create refused for want of 2Z is refused again until the
    // balance changes, so autosave does not re-send it. The creator's own
    // save does: they may have bought or been gifted 2Z since.
    if (createNeeds2z && !currentZPage?.free2zaddr && isAuto) {
      return failSave("needs-2z");
    }

    const preserveSaveFailure =
      isNewPage && !content.trim() && Boolean(saveError);
    const previousSaveBlockReason = saveBlockReason;
    saveBlockReason = preserveSaveFailure ? previousSaveBlockReason : null;

    if (!isAuto) {
      clearAutoSaveTimer();
      if (!preserveSaveFailure) {
        validationErrors = {};
        saveError = null;
      }
    }

    // Drafts may save without a title (a placeholder is sent instead), but a
    // live article must keep a real one.
    const willBePublished = overrides?.is_published ?? isPublished;

    if (!title.trim() && willBePublished) {
      if (!isAuto) {
        validationErrors.title = $t(
          "editor.titleRequired",
          "Title is required",
        );
        operationNotice.error(validationErrors.title);
      }
      return failSave("title-required");
    }

    if (!content.trim()) {
      if (!isAuto && !isNewPage) {
        saveError = $t("editor.contentRequired", "Content cannot be empty");
        operationNotice.error(saveError);
      }

      // A genuinely new page is allowed to wait for its first body content.
      // Do not replace an earlier request/server error with this expected
      // empty state; the failure remains actionable until a save succeeds.
      if (preserveSaveFailure) {
        return failSave(previousSaveBlockReason ?? "request-failed");
      }

      return failSave("content-required");
    }

    if (description.trim().length > DESCRIPTION_MAX_LENGTH) {
      if (!isAuto) {
        validationErrors.description = $t(
          "editor.descriptionTooLong",
          "Description must be {count} characters or fewer.",
          { count: DESCRIPTION_MAX_LENGTH },
        );
        operationNotice.error(validationErrors.description);
      }
      return failSave("description-too-long");
    }

    const canonicalValidationWasVisible = Boolean(
      validationErrors.canonical_url,
    );
    const canonicalUrlError = getCanonicalUrlError(canonicalUrl);
    let canonicalUrlErrorMessage =
      canonicalUrlValidationMessage(canonicalUrlError);

    if (canonicalUrlError) {
      if (!isAuto && canonicalUrlErrorMessage) {
        validationErrors.canonical_url = canonicalUrlErrorMessage;
        operationNotice.error(canonicalUrlErrorMessage);
        return failSave("canonical-url-invalid");
      }
    }

    isSaving = true;
    // Read by the catch: whether THIS attempt was a create.
    let saveWasCreate = false;
    const versionAtSaveStart = changeVersion;
    const vanityEditRevisionAtSaveStart = vanityEditRevision;
    // `let`: reconciling an unresolved create  can move it to the
    // language the adopted page actually has.
    let languageAtSaveStart = selectedLanguage;

    try {
      if (pendingCreate && !currentZPage?.free2zaddr) {
        saveWasCreate = true;
        if (isAuto && !backendHonorsCreateKey()) {
          // No proof this backend honours the key ( review): an
          // automatic re-send could be another page. Latch, exactly as a
          // keyless create does; the creator's own save still reconciles.
          createOutcomeUnknown = true;
          createLatchReason = "create-timed-out";
          saveError = saveBlockMessage("create-timed-out");
          return failSave("create-timed-out");
        }
        const outcome = await reconcilePendingCreate(
          pendingCreate,
          options,
          documentGeneration,
        );
        if (!saveDocumentIsCurrent(documentGeneration))
          return abandonObsoleteDocumentSave();
        if (outcome === "refused" || outcome === "gone") {
          const reason =
            outcome === "gone" ? "create-page-gone" : "create-timed-out";
          createOutcomeUnknown = true;
          createLatchReason = reason;
          saveError = saveBlockMessage(reason);
          if (!isAuto && saveError) operationNotice.error(saveError);
          return failSave(reason);
        }
        if (outcome === "auth-required") return failSave("auth-required");
        if (outcome === "unknown") {
          saveError = $t("editor.saveError", "Failed to save article");
          if (!isAuto && saveError) operationNotice.error(saveError);
          if (isAuto && autoSaveRetries < MAX_AUTOSAVE_RETRIES) {
            autoSaveRetries += 1;
            scheduleAutoSave(AUTOSAVE_DELAY * 2 ** autoSaveRetries);
          }
          return failSave("request-failed");
        }
        // "created" carries on as an update of that page; "not-created" as a
        // fresh create under a fresh key.
        languageAtSaveStart = selectedLanguage;
      }

      const payload: Partial<SavePayload> = {
        ...buildSavePayload(),
        ...overrides,
      };
      // Decided when the request leaves: a title typed while it is in flight
      // re-derives `derivedVanity`, and must not turn this response's
      // refusal of the OLD guess into a "the creator typed this" error.
      // Only while nothing is saved: once a vanity is persisted the page's
      // URL is real, and no refusal may ever quietly take it away.
      const sentDerivedVanity =
        !currentZPage?.vanity &&
        payload.vanity &&
        payload.vanity === derivedVanity
          ? payload.vanity
          : "";
      if (canonicalUrlError) {
        // Optional metadata must never block the article body from autosaving.
        // Keep the invalid local value visible, but leave the persisted value
        // unchanged until the creator fixes it and a later save succeeds.
        delete payload.canonical_url;
      }
      const currentIdentifier = currentZPage?.free2zaddr;
      const isCreate = !currentIdentifier;
      saveWasCreate = isCreate;
      const isCanonicalSave =
        Boolean(currentZPage) && isCanonicalLanguage(languageAtSaveStart);
      // What this editor believed the article's language was when the save
      // left. The response may name a different one: the background language
      // detector relabels a page minutes after a save, and that
      // no longer fails this save's precondition.
      const sourceAtSaveStart = currentZPage?.source_language;
      const translationSourceLanguage =
        currentIdentifier && !isCanonicalSave
          ? currentZPage?.source_language
          : null;
      //on a canonical update the same header tells the backend which
      // label this editor saw, so a background detector relabel since then
      // does not 412 this save. Sending it is a promise to follow the label
      // the response carries -- see `followedSource` below.
      const claimedSourceLanguage =
        translationSourceLanguage ||
        (currentIdentifier && isCanonicalSave ? sourceAtSaveStart : null);
      const preconditionKey = preconditionKeyFor(
        currentIdentifier,
        languageAtSaveStart,
        isCanonicalSave,
      );
      const saveUrl = currentIdentifier
        ? isCanonicalSave
          ? `/api/zpage/${encodeURIComponent(currentIdentifier)}/`
          : translationVariantUrl(currentIdentifier, languageAtSaveStart)
        : "/api/zpage/";
      //this save STARTS a translation the editor opened blank, so it
      // must not replace one somebody else started meanwhile — another tab,
      // an AI draft landing, or this tab's own earlier save whose answer was
      // lost. Decided at save start, like the language; whether the header
      // actually went out is recorded per attempt for the 412 branch.
      const startsVariant =
        !isCreate && !isCanonicalSave && isNewTranslationDraft;
      let sentCreateOnly = false;
      let saveRequestOwnership = authStore.captureRequestOwnership();
      const saveAttempt = await saveWithCanonicalAutosaveFallback({
        isAuto,
        payload,
        send: async (attemptPayload) => {
          if (!saveDocumentIsCurrent(documentGeneration)) {
            throw new StaleSaveDocumentError();
          }
          // Canonical-URL autosave fallback may call send again after awaiting
          // a response. Each request must still belong to the original owner.
          if (!confirmSaveOwner(options)) throw new SaveOwnerChangedError();
          const body = JSON.stringify(attemptPayload);
          //one key per create ATTEMPT (the canonical-URL fallback's
          // second send is a different body, so it is a different attempt).
          // Recorded before the request leaves, because a timeout gives us
          // nothing back to record it from.
          const createAttempt = isCreate
            ? (() => {
                const key = newZpageCreateKey();
                return key ? { key, body } : null;
              })()
            : null;
          if (createAttempt) pendingCreate = createAttempt;
          // Hand-wired like `If-Match` below: orval emits nothing for it.
          const createOnly =
            isCreate || !preconditionKey
              ? {}
              : createOnlyHeaders({
                  startsVariant,
                  etag: etags.get(preconditionKey),
                });
          sentCreateOnly = IF_NONE_MATCH_HEADER in createOnly;
          saveRequestOwnership = authStore.captureRequestOwnership();
          const response = await apiFetch(saveUrl, {
            method: isCreate ? "POST" : "PUT",
            headers: {
              "Content-Type": "application/json",
              ...(createAttempt
                ? { [ZPAGE_CREATE_IDEMPOTENCY_HEADER]: createAttempt.key }
                : {}),
              ...(claimedSourceLanguage
                ? {
                    [TRANSLATION_SOURCE_LANGUAGE_HEADER]: claimedSourceLanguage,
                  }
                : {}),
              // Optimistic concurrency. Hand-wired, and it has to be:
              // orval emits nothing for `in: header`, so a regenerated client
              // could never put this on the wire. Absent when we hold no
              // validator for this URL — a create, or a translation's first
              // save — which is the pre- behaviour rather than a failure.
              ...(isCreate || !preconditionKey
                ? {}
                : preconditionHeaders(
                    options.approvedRevision ?? etags.get(preconditionKey),
                  )),
              ...createOnly,
            },
            body,
          });
          if (!saveDocumentIsCurrent(documentGeneration)) {
            throw new StaleSaveDocumentError();
          }
          // A body that stalls past the bound is a timeout, not an empty
          // answer: rethrow it so the catch below treats it as one (retry,
          // named notice) instead of "the server did not confirm the save".
          const result = await response.json().catch((error: unknown) => {
            if (isRequestTimeout(error)) throw error;
            return {};
          });
          if (!saveDocumentIsCurrent(documentGeneration)) {
            throw new StaleSaveDocumentError();
          }
          // Drop the attempt only on proof of its outcome: a 201 that names
          // the page, or a 400 or the second-page 402 (rolled back, key
          // unspent). An expired
          // session, a 429, a 5xx or an unreadable 201 keeps it, so the next
          // save reconciles instead of minting a second page
          // (see `resolvesCreateAttempt`).
          if (isCreate) noteCreateResponse(response);
          if (
            createAttempt &&
            pendingCreate === createAttempt &&
            resolvesCreateAttempt(response.status, result) !== "unresolved"
          ) {
            pendingCreate = null;
          }
          return { response, result };
        },
      });
      if (!saveDocumentIsCurrent(documentGeneration))
        return abandonObsoleteDocumentSave();
      const { response, result, canonicalRejected } = saveAttempt;

      if (canonicalRejected) {
        canonicalUrlErrorMessage = canonicalUrlValidationMessage(
          "invalid",
          isAuto,
        );
      }

      if (isPreconditionFailure(response)) {
        // Somebody else saved this article since the version in front of the
        // creator was read. The one thing that must NOT happen here is
        // "Failed to save article": the creator needs to know their words are
        // still on screen, that the server has a newer version, and that
        // reloading is the way out. The stale validator is dropped so the
        // retry is not refused for the same reason forever, and the editor
        // stays dirty so nothing the creator typed is discarded.
        // The stale validator is deliberately KEPT. Dropping it would make
        // the next save unconditional, and the backend accepts unconditional
        // writes by design — so this tab would warn the creator about a
        // conflict and then silently clobber the other tab seconds later.
        // (codex adversarial review.)
        saveConflicted = true;
        // A save this tab abandoned at its bound  may still have
        // committed server-side — and then the "newer version" the 412 is
        // about is this tab's OWN earlier save, not somebody else's. Say so
        // rather than blaming a second editor who does not exist.
        saveError = saveTimedOutSinceLastSuccess
          ? $t(
              "editor.saveConflictAfterTimeout",
              "An earlier save that timed out may have gone through after all, so the server now has a newer version. Your changes are still here — reload to check, then re-apply anything missing.",
            )
          : // Localized first: `sentCreateOnly` is a fact this tab knows,
            // and the server's English `detail` would otherwise always win
            // over the translation ( review).
            sentCreateOnly
            ? $t(
                "editor.createConflict",
                "A {language} version already exists — from another tab, an AI translation or an earlier save. Your text is still here; copy it before reloading, which shows the saved version.",
                { language: languageLabel(languageAtSaveStart) },
              )
            : apiRequestErrorMessage(result) ||
              $t(
                "editor.saveConflict",
                "Someone else saved this article while you were editing. Your changes are still here — reload to get the newer version, then re-apply them.",
              );
        // Toasted even on an autosave, unlike every other failure. An autosave
        // is silent by design because its failures are transient and retried;
        // this one is neither, and staying silent would let the creator keep
        // typing into a page that can no longer be saved.
        if (!destroyed)
          editorActionToastIds.add(
            operationNotice.error(saveError, {
              duration: Infinity,
              action: {
                label: $t("editor.saveConflictReload", "Reload"),
                onClick: () => location.reload(),
              },
            }),
          );
        validationErrors = {};
        return failSave("conflict");
      }

      if (!response.ok) {
        //the first page is free and another needs 1 2Z. That refusal
        // is the platform's ordinary 402 `insufficient_funds`, so it gets the
        // notice with the ways to get 2Z, not a field error or a dead end.
        const needs2z =
          isCreate && response.status === 402
            ? parseInsufficientFunds(result)
            : null;
        if (needs2z) {
          createNeeds2z = needs2z;
          validationErrors = {};
          saveError = saveBlockMessage("needs-2z");
          if (!isAuto && saveError) operationNotice.error(saveError);
          return failSave("needs-2z");
        }

        // Whatever the API rejected reaches the creator — the fields listed
        // here just get the product's own wording instead of the serializer's.
        // Enumerating the fields worth *showing* is what left a past-due
        // schedule failing every autosave under the catch-all, and
        // would have done the same to the next field the serializer grows.
        const failure = describeSaveFailure({
          result,
          status: response.status,
          // `vanity` keeps the server's sentence: "taken", "reserved"
          // and "only a-z, numbers and hyphens" each need a different fix,
          // and one generic line hid which.
          curated: {
            title: $t("editor.titleInvalid", "Enter a valid article title."),
            canonical_url: canonicalUrlValidationMessage("invalid", isAuto),
            // Only when the payload just sent is the one the serializer
            // refuses (unpublished, schedule in the past). Any other
            // publish_at rejection — a malformed datetime, a rule added later
            // keeps the server's sentence instead of being mislabelled.
            publish_at: isScheduleInThePast(payload)
              ? $t(
                  "editor.publishAtPastDue",
                  "Your scheduled publish time has passed. Open the publish menu to publish now, or pick a new time.",
                )
              : undefined,
          },
          extra: {
            // The canonical-URL autosave fallback strips the field and
            // retries, so the response being read cannot name the field that
            // actually failed.
            canonical_url: canonicalRejected
              ? canonicalUrlValidationMessage("invalid", isAuto)
              : undefined,
          },
          genericMessage: $t("editor.saveError", "Failed to save article"),
          summaryMessage: $t(
            "editor.fixValidationErrors",
            "Please fix the validation errors.",
          ),
        });
        if (
          isAuto &&
          response.status === 400 &&
          sentDerivedVanity &&
          //...and the field is STILL the editor's. The creator may have
          // edited it while this request was in flight (`handleMetadataChange`
          // then clears `derivedVanity`); what they typed is never discarded,
          // even when it reads the same as the refused guess.
          vanity === derivedVanity &&
          failure.fieldErrors.vanity &&
          Object.keys(failure.fieldErrors).length === 1
        ) {
          // The API refused a vanity the EDITOR made up from the title. That
          // is our guess failing, not the creator's input, so it must not
          // cost them their autosave: forget the guess and save without it
          // (the page's address stands in until they choose a vanity).
          // Autosave only: a manual save or publish shows the refusal in the
          // publish sheet the creator is looking at, beside the field.
          rejectedDerivedVanities.add(sentDerivedVanity);
          // A newer proposal (the title changed in flight) is left alone and
          // simply goes out with the retry.
          if (derivedVanity === sentDerivedVanity) {
            vanity = "";
            derivedVanity = "";
          }
          validationErrors = {};
          saveError = null;
          scheduleAutoSave();
          return failSave("validation");
        }

        validationErrors = failure.fieldErrors;
        saveError = failure.saveError;

        if (isAuto && response.status === 400 && failure.fieldErrors.vanity) {
          // The vanity lives in the publish sheet, which is closed while the
          // creator writes, so an autosave refused over it used to fail on
          // every keystroke with nothing but a tooltip to say why.
          // One toast, updated in place rather than stacked per autosave.
          operationNotice.error(failure.fieldErrors.vanity, {
            id: "editor-vanity-rejected",
          });
        }

        if (response.status === 401 || response.status === 403) {
          // The draft is in THIS document. Do not navigate away from it:
          // open the sign-in modal in place  so the creator can sign
          // back in and retry the save with their work intact. The store is
          // told first, so the topbar stops claiming a session that is gone.
          if (saveRequestOwnership()) {
            authStore.handleAuthFailure(response.status);
            promptOwnerSignIn("auth-required");
          }
          return failSave("auth-required");
        }

        if (!isAuto && saveError) {
          operationNotice.error(saveError);
        }

        if (
          isAuto &&
          response.status >= 500 &&
          autoSaveRetries < MAX_AUTOSAVE_RETRIES
        ) {
          autoSaveRetries += 1;
          scheduleAutoSave(AUTOSAVE_DELAY * 2 ** autoSaveRetries);
        }

        return failSave(
          failure.isValidationFailure ? "validation" : "request-failed",
        );
      }

      if (!result.free2zaddr) {
        saveError = $t(
          "editor.saveNotConfirmed",
          "The API did not confirm that the article was saved.",
        );

        if (!isAuto) {
          operationNotice.error(saveError);
        }

        return failSave("save-unconfirmed");
      }

      createNeeds2z = null;

      // The write response carries the validator the next read will emit, so
      // the following autosave is conditional too — including the first save
      // of a translation, whose validator has no other source in the editor.
      etags.remember(
        isCreate
          ? `/api/zpage/${encodeURIComponent(result.free2zaddr)}/`
          : (preconditionKey as string),
        response,
      );

      const editsArrivedDuringSave = changeVersion !== versionAtSaveStart;
      const canonicalUrlUnsupported = Boolean(
        Object.hasOwn(payload, "canonical_url") &&
        !Object.hasOwn(result, "canonical_url") &&
        (canonicalUrl.trim() || currentZPage?.canonical_url),
      );
      if (canonicalUrlUnsupported) {
        canonicalUrlErrorMessage = $t(
          "editor.canonicalUrlSaveUnconfirmed",
          "Your article was saved, but the original URL was not. Please try again in a moment.",
        );
      }
      const canonicalUrlIsUnsaved = Boolean(
        canonicalUrlError || canonicalRejected || canonicalUrlUnsupported,
      );
      const isClean = !editsArrivedDuringSave && !canonicalUrlIsUnsaved;
      const savedZPage = result as ZPage;
      if (
        !isCurrentTranslationResponse(languageAtSaveStart, selectedLanguage)
      ) {
        return true;
      }
      const savedIdentifier = savedZPage.vanity || savedZPage.free2zaddr;

      //the detector relabelled the article while it was open here
      // (`en` -> `es`), and this canonical save succeeded across it. The
      // editor was showing the canonical article and still is -- so it
      // follows the new label, exactly as the manual relabel does. Staying
      // on the old tag would make `isCanonicalLanguage` false from here on,
      // and the NEXT autosave would PUT the creator's article body to
      // `/translations/en/` as a brand-new "translation" while the real article
      // stopped receiving edits. Set before `applySavedZPage`, which reads
      // `isCanonicalLanguage(selectedLanguage)` to decide the schedule.
      const savedSource = savedZPage.source_language;
      const followedSource =
        isCanonicalSave &&
        selectedLanguage === languageAtSaveStart &&
        typeof savedSource === "string" &&
        savedSource !== sourceAtSaveStart &&
        normalizeContentLanguage(savedSource)
          ? (savedSource as EditorLanguage)
          : null;
      if (followedSource) selectedLanguage = followedSource;
      const savedLanguage = followedSource ?? languageAtSaveStart;
      const mayAdoptServerVanity =
        vanityEditRevision === vanityEditRevisionAtSaveStart &&
        vanity.trim() === (payload.vanity ?? "").trim();

      applySavedZPage(
        savedZPage,
        isClean,
        Array.isArray(payload.tags) ? payload.tags : undefined,
        mayAdoptServerVanity,
      );
      updateEditorUrl(savedIdentifier);

      // This variant now has content, so it belongs in the language picker and
      // gains a delete affordance. Prefer the server's list, but never let a
      // response that omits the field erase what we know.
      if (Array.isArray(savedZPage.available_languages)) {
        availableLanguages = savedZPage.available_languages.filter(
          (language): language is string =>
            typeof language === "string" && language !== "und",
        );
      }
      if (
        normalizeContentLanguage(savedLanguage) &&
        !availableLanguages.includes(savedLanguage)
      ) {
        availableLanguages = [...availableLanguages, savedLanguage];
      }
      isNewTranslationDraft = false;
      // A brand-new variant changes the panel's rows; a save to an existing
      // one can flip other variants to stale. Both are the server's call.
      void refreshVariants(savedZPage.free2zaddr);

      const shouldShowCanonicalError = Boolean(
        canonicalUrlErrorMessage &&
        (!isAuto ||
          canonicalValidationWasVisible ||
          canonicalRejected ||
          canonicalUrlUnsupported),
      );
      validationErrors = shouldShowCanonicalError
        ? { canonical_url: canonicalUrlErrorMessage }
        : {};
      saveError = null;
      // A save went through, so whatever vanity refusal was on screen is
      // either fixed or no longer being sent.
      toast.dismiss("editor-vanity-rejected");
      lastSavedAt = Date.now();
      savedVersion = versionAtSaveStart;
      persistedProse = {
        title: payload.title ?? persistedProse.title,
        description: payload.description ?? persistedProse.description,
        content: payload.content ?? persistedProse.content,
      };
      canonicalUrlNeedsSave = canonicalUrlIsUnsaved;
      autoSaveRetries = 0;
      saveTimedOutSinceLastSuccess = false;
      // `canonicalUrlNeedsSave` pins `isDirty` true until the URL is accepted.
      // Say so, instead of leaving the editor permanently "unsaved" for no
      // stated reason.
      saveBlockReason = canonicalUrlIsUnsaved
        ? "canonical-url-unsaved"
        : editsArrivedDuringSave && !content.trim()
          ? "content-required"
          : null;

      if (editsArrivedDuringSave) {
        scheduleAutoSave();
      }

      if (canonicalUrlUnsupported && !isAuto) {
        operationNotice.error(
          canonicalUrlErrorMessage ??
            $t(
              "editor.canonicalUrlSaveUnconfirmed",
              "Your article was saved, but the original URL was not. Please try again in a moment.",
            ),
        );
        return failSave("canonical-url-unsaved");
      }

      if (!isAuto) {
        operationNotice.success(
          successMessage ||
            (isCreate
              ? $t("editor.articleSaved", "Article saved successfully.")
              : $t("editor.articleUpdated", "Article updated successfully.")),
        );
      }

      return true;
    } catch (error: any) {
      // A navigation hydrated another document while this request was
      // unresolved. Its success and failure paths both belong to the old
      // document and must not write into the new one.
      if (
        error instanceof StaleSaveDocumentError ||
        !saveDocumentIsCurrent(documentGeneration)
      ) {
        return abandonObsoleteDocumentSave();
      }
      // Keep the ownership refusal and the draft intact. This is not a
      // transport failure, a successful save, or a reason to clear Bob's auth.
      if (error instanceof SaveOwnerChangedError) return false;
      //`apiFetch` abandons a write at its bound and rejects with an
      // ApiTimeoutError. By the time we are here `finally` is about to clear
      // `isSaving` and `handleSave` clears `currentSavePromise`, so autosave
      // and Publish are live again; the draft stays dirty because
      // `savedVersion` was never advanced.
      const timedOut = isRequestTimeout(error);
      if (timedOut) saveTimedOutSinceLastSuccess = true;

      // A CREATE that timed out may still have committed, and the create
      // endpoint mints a fresh page on every POST — so an automatic retry
      // would make a second copy of the draft (codex review). Latch instead:
      // autosave stops creating, the creator is told to check, and only a
      // save they ask for sends the create again.
      //
      // Skipped  only for a KEYED create against a backend this
      // session has seen honour the key (`Idempotency-Key-Honored`): re-sending
      // it under the same key can only ever return the one page, so it is an
      // ordinary timed-out save that autosave retries. Without that proof an
      // older backend would ignore the key and every retry could be another
      // (possibly published) page — so the latch stays, and the creator's
      // own save still re-sends under the same key.
      const createTimedOut =
        timedOut &&
        saveWasCreate &&
        !(pendingCreate && backendHonorsCreateKey());
      if (createTimedOut) {
        createOutcomeUnknown = true;
        createLatchReason = "create-timed-out";
        createTimeouts += 1;
      }

      const reason: SaveBlockReason = createTimedOut
        ? "create-timed-out"
        : timedOut
          ? "timed-out"
          : "request-failed";
      saveError =
        reason === "request-failed"
          ? $t("editor.saveError", "Failed to save article")
          : saveBlockMessage(reason);

      if (!isAuto && saveError) {
        operationNotice.error(saveError);
      }

      if (isAuto && !createTimedOut && autoSaveRetries < MAX_AUTOSAVE_RETRIES) {
        autoSaveRetries += 1;
        scheduleAutoSave(AUTOSAVE_DELAY * 2 ** autoSaveRetries);
      }

      return failSave(reason);
    } finally {
      if (saveDocumentIsCurrent(documentGeneration)) isSaving = false;
    }
  }

  async function handlePublish(scheduleValue = publishAt): Promise<boolean> {
    const operationNotice = captureAccountToast();
    if (!title.trim()) {
      // Scheduling sends is_published=false, so guard here too — an article
      // must not go live (now or later) as "Untitled".
      validationErrors.title = $t("editor.titleRequired", "Title is required");
      operationNotice.error(validationErrors.title);
      return false;
    }

    const isScheduling =
      Boolean(scheduleValue) && new Date(scheduleValue).getTime() > Date.now();
    const isSourceVariant = isCanonicalLanguage(selectedLanguage);

    if (isScheduling && !isSourceVariant) {
      operationNotice.error(
        $t(
          "editor.translationSchedulingUnsupported",
          "Translated variants cannot be scheduled yet. Clear the schedule to publish this translation.",
        ),
      );
      return false;
    }
    let approvedRevision: string | undefined;
    if (!isScheduling) {
      const checkedRevision = await checkTranslationBeforePublish();
      if (!checkedRevision) return false;
      approvedRevision =
        typeof checkedRevision === "string" ? checkedRevision : undefined;
    }

    return writePublish({
      approvedRevision,
      overrides: {
        is_published: !isScheduling,
        publish_at: isScheduling ? new Date(scheduleValue).toISOString() : null,
      },
      successMessage: isScheduling
        ? $t(
            "editor.articleScheduled",
            "Article scheduled. It will go live automatically.",
          )
        : $t("editor.articlePublished", "Article published."),
    });
  }

  /**
   * Where a publish of the open version is: re-reading the jobs list
   * (`checking`), waiting on the creator's answer (`asking`), or writing.
   * The review bar says which, and keeps its navigation still meanwhile.
   */
  let publishPhase = $state<null | "checking" | "asking" | "writing">(null);

  /** The open version is a TRANSLATION of a saved article. */
  function openIsTranslation() {
    return (
      Boolean(currentZPage) &&
      Boolean(openLanguage) &&
      !isCanonicalLanguage(selectedLanguage)
    );
  }

  /**
   * Before the open TRANSLATION goes live: read the jobs list again and ask
   * about its warnings. Never for the original — and never for a
   * brand-new article, which has no translations — because translations
   * being slow or down must never stop an article going live (
   * verification round).
   *
   * The target is captured before the first await: if the creator moves to
   * another article, language or draft meanwhile, nothing is published
   * (codex adversarial review — Publish on Spanish, then Next, published
   * French unasked).
   */
  async function checkTranslationBeforePublish(): Promise<
    string | true | false
  > {
    const operationNotice = captureAccountToast();
    if (!openIsTranslation()) return true;
    const identifier = currentZPage!.free2zaddr;
    const language = openLanguage;
    const draft = hydrationGeneration;
    // The server only issues a review revision for persisted bytes. Drain any
    // autosave already in flight, then save a dirty draft before asking the
    // creator to approve it. This makes the revision checked below the
    // revision the publish PUT will carry, including the first draft save.
    //
    // Only a DIRTY draft is saved here. A clean editor that merely lacks a
    // validator (e.g. it was opened without one) must not acquire one by
    // writing: that save carries no If-Match, so it would overwrite a newer
    // draft -- and the shared article fields, payout address included --
    // from another device before the creator has reviewed anything. Without
    // a validator the revision comparison below refuses instead.
    while (currentSavePromise) {
      const inFlightSaved = await currentSavePromise;
      if (!inFlightSaved) return false;
    }
    if (
      currentZPage?.free2zaddr !== identifier ||
      openLanguage !== language ||
      hydrationGeneration !== draft
    ) {
      return false;
    }
    if (isDirty) {
      if (!(await handleSave())) return false;
      if (
        currentZPage?.free2zaddr !== identifier ||
        openLanguage !== language ||
        hydrationGeneration !== draft
      ) {
        return false;
      }
    }
    const reviewedChangeVersion = changeVersion;
    publishPhase = "checking";
    let approved: Awaited<
      ReturnType<typeof translationPublishing.confirmDespiteWarnings>
    > = null;
    try {
      approved = await translationPublishing.confirmDespiteWarnings(language, {
        onPhase: (phase) => (publishPhase = phase),
      });
    } finally {
      publishPhase = null;
    }
    if (!approved) return false;
    if (
      currentZPage?.free2zaddr !== identifier ||
      openLanguage !== language ||
      hydrationGeneration !== draft ||
      changeVersion !== reviewedChangeVersion ||
      isDirty
    ) {
      operationNotice.warning(
        $t(
          "translationJobs.publishTargetMoved",
          "The {language} version is no longer open, so it was not published.",
          { language: languageLabel(language) },
        ),
      );
      return false;
    }
    const revision = approved.revision;
    if (etags.get(variantResourceUrl(identifier, language)) !== revision) {
      operationNotice.warning(
        $t(
          "translationJobs.publishChanged",
          "The {language} draft changed somewhere else, so it was not published. Review it first.",
          { language: languageLabel(language) },
        ),
      );
      return false;
    }
    return revision;
  }

  async function writePublish(options: SaveOptions): Promise<boolean> {
    publishPhase = "writing";
    try {
      return await handleSave(options);
    } finally {
      publishPhase = null;
    }
  }

  async function handlePublishNow(approvedRevision?: string): Promise<boolean> {
    const operationNotice = captureAccountToast();
    // A translation delivered with warnings  is never published by a
    // single click: the creator may not read the language, and "$5" may now
    // read "$500". Every publish of the open version comes through here —
    // the editor's own button, the review loop, the tray row.
    if (approvedRevision) {
      const identifier = currentZPage?.free2zaddr;
      if (
        !identifier ||
        !openIsTranslation() ||
        etags.get(variantResourceUrl(identifier, openLanguage)) !==
          approvedRevision
      ) {
        operationNotice.warning(
          $t(
            "translationJobs.publishChanged",
            "The {language} draft changed somewhere else, so it was not published. Review it first.",
            { language: languageLabel(openLanguage) },
          ),
        );
        return false;
      }
    } else {
      const checkedRevision = await checkTranslationBeforePublish();
      if (!checkedRevision) return false;
      approvedRevision =
        typeof checkedRevision === "string" ? checkedRevision : undefined;
    }
    return writePublish({
      approvedRevision,
      overrides: {
        is_published: true,
        publish_at: null,
      },
      successMessage: $t("editor.articlePublished", "Article published."),
    });
  }

  async function handleCancelSchedule(): Promise<boolean> {
    return handleSave({
      overrides: { is_published: false, publish_at: null },
      successMessage: $t("editor.draftSaved", "Draft saved."),
    });
  }

  async function handleUnpublish(): Promise<boolean> {
    return handleSave({
      overrides: { is_published: false, publish_at: null },
      successMessage: $t(
        "editor.articleRevertedToDraft",
        "Article reverted to draft.",
      ),
    });
  }

  async function handleManualSave(): Promise<boolean> {
    return handleSave({
      successMessage: isPublished
        ? $t("editor.articleUpdated", "Article updated successfully.")
        : $t("editor.draftSaved", "Draft saved."),
    });
  }

  async function commitLanguageSwitch(
    nextLanguage: EditorLanguage,
    {
      canReturn = true,
      discardUnsaved = false,
    }: { canReturn?: boolean; discardUnsaved?: boolean } = {},
  ): Promise<boolean> {
    const operationNotice = captureAccountToast();
    if (!currentZPage) return false;

    const identifier = currentZPage.vanity || currentZPage.free2zaddr;
    const nextHref = editorVariantHref(identifier, nextLanguage);

    // The composer stays mounted and editable across an awaited navigation, so
    // keystrokes typed during a slow load would be silently replaced when the
    // next variant hydrates. Drop focus and cover the editor for the duration.
    if (browser) {
      (document.activeElement as HTMLElement | null)?.blur?.();
    }

    // `selectedLanguage` FOLLOWS the loaded route; it never leads it.
    // It decides which endpoint a save writes to, so pointing it at a variant
    // the editor has not loaded yet lets a Cmd-S during a slow navigation PUT
    // the body still on screen over the other language's translation. The
    // rehydration effect sets it from the route data once the load lands.
    isSwitchingLanguage = true;
    // Discarding does not clear anything up front: it suppresses the
    // navigation guard's flush and lets the rehydration on the other side
    // replace the fields. If the load fails, the creator's edits are still on
    // screen, still dirty and still guarded — rather than sitting there
    // silently "clean", where one later keystroke would autosave (and
    // republish) the very text they threw away.
    bypassNextNavigationGuard = discardUnsaved;

    let switched = false;
    try {
      await goto(nextHref, {
        refreshAll: true,
      });
      switched = true;
      // The editor asked for this load, so the answer reaches the composer —
      // full stop, and this line is the whole of the  fix for the blank
      // editor.
      //
      // `hydrationKeyFor` throttles hydration on facts an AI translation
      // delivered into the language already on screen does not move: same id,
      // same language, and the article's own `updated_at` — which the delivery
      // leaves alone, because it writes the variant rows and never saves the
      // parent. So the load came back with the translation in it and the effect
      // dropped it on the floor, and the only way to see what you had paid for
      // was to switch language away and back.
      //
      // That throttle stays narrow on purpose (see `hydrationKeyFor`): it is
      // what protects unsaved work from a background `invalidateAll()`. The way
      // out is not to teach it more facts, it is for the one caller that
      // NAVIGATED — having already settled the creator's edits before it asked
      // to say so out loud. This function's own contract is that the route,
      // the language chip and every editor field come from the response it just
      // fetched.
      rehydrateFromRoute();
    } catch {
      if (canReturn) {
        // Nothing moved: the editor is still showing the variant it loaded.
        operationNotice.error(
          $t(
            "editor.translationSwitchFailed",
            "Could not switch article language. Try again.",
          ),
        );
        return false;
      }

      // The variant we came from no longer exists (it was just deleted).
      // Staying on it would let the next save recreate it, so force a real
      // page load rather than falling back to a language that is gone.
      if (browser) {
        window.location.assign(nextHref);
      }
    } finally {
      isSwitchingLanguage = false;
      bypassNextNavigationGuard = false;

      // A switch that did not happen leaves unsaved work behind: restart the
      // clock the prompt stopped. (A successful switch rehydrates clean, so
      // this is a no-op there.)
      if (isDirty) {
        scheduleAutoSave();
      }
    }

    return switched;
  }

  /**
   * Move to another language variant. With unsaved work this offers
   * Save / Discard / Cancel — the same three outcomes `beforeNavigate` gives
   * every other navigation in the editor. There is no state from which this
   * control refuses to move.
   */
  async function requestLanguage(nextLanguage: EditorLanguage) {
    const operationNotice = captureAccountToast();
    // One switch at a time: a second navigation would let the first one's
    // `finally` clear the shared busy flag while the second is still running.
    if (isSwitchingLanguage || isDeletingTranslation || isDeletingPage) return;

    const plan = planLanguageSwitch({
      currentLanguage: selectedLanguage,
      nextLanguage,
      isDirty,
      isSaving,
      isNewPage: !currentZPage,
    });

    if (plan.action === "none") return;

    let discarding = false;

    if (plan.action === "relabel") {
      // Nothing is persisted yet: this only picks the language the draft will
      // be created with. No reload, no blanking, nothing to discard — and the
      // text stays genuinely unsaved until it is actually saved.
      selectedLanguage = nextLanguage;
      updateEditorUrl("new");
      return;
    }

    if (plan.action === "prompt") {
      // `askEditorPrompt` stops the autosave clock for the whole decision.
      const choice = await askEditorPrompt({
        title: $t(
          "editor.languageSwitchUnsavedTitle",
          "You have unsaved changes",
        ),
        body:
          unresolvedTranslationLanguage !== null
            ? $t(
                "editor.translationUnresolved",
                "Saving is paused while a translation purchase is unresolved. Recover the purchase to continue.",
              )
            : translationReviewNeeded
              ? $t(
                  "editor.translationReviewPaused",
                  "Your edits are kept here. Saving is paused until you review the saved translation.",
                )
              : !canFlushSave
                ? $t(
                    "editor.languageSwitchEmptyBody",
                    "These edits need body content before they can be saved. Keep editing, or discard them and switch versions.",
                  )
                : $t(
                    "editor.languageSwitchUnsavedBody",
                    "Your edits to the {current} version have not been saved. Save them, or discard them and open {next}?",
                    {
                      current: languageLabel(selectedLanguage),
                      next: languageLabel(nextLanguage),
                    },
                  ),
        confirmLabel:
          canFlushSave &&
          !translationReviewNeeded &&
          unresolvedTranslationLanguage === null
            ? $t("editor.languageSwitchSave", "Save and switch")
            : undefined,
        discardLabel: $t("editor.languageSwitchDiscard", "Discard and switch"),
        cancelLabel: $t("common.cancel", "Cancel"),
      });

      if (choice === "cancel") {
        // Staying put must not also stop autosaving.
        if (isDirty) {
          scheduleAutoSave();
        }
        return;
      }

      if (choice === "discard") {
        // A save may already be in flight — the navigation guard can start one
        // while the prompt is open, and an outstanding PUT cannot be recalled.
        // Let it settle so the state we switch away from is the real one.
        while (currentSavePromise) {
          await currentSavePromise;
        }

        clearAutoSaveTimer();
        discarding = true;
      } else {
        // Let an in-flight autosave land first: "a save is already running" is
        // never a reason to strand the creator here.
        while (currentSavePromise) {
          await currentSavePromise;
        }

        const saved = isDirty ? await handleSave() : true;

        if (!saved || isDirty) {
          operationNotice.error(
            $t(
              "editor.translationSwitchSaveFailed",
              "Nothing was saved — {reason} Switch again and choose “Discard and switch” to leave these edits behind.",
              {
                reason:
                  saveBlockMessage(saveBlockReason) ??
                  $t("editor.saveError", "Failed to save article"),
              },
            ),
          );

          if (isDirty) {
            scheduleAutoSave();
          }

          return;
        }
      }
    }

    await commitLanguageSwitch(nextLanguage, {
      discardUnsaved: discarding,
    });
  }

  /**
   * Rename the article's language. The label, and only the label.
   *
   * This is the control the owner's screenshot needed and did not have: an
   * obviously-English article stamped `und` could not be told it was English,
   * because `source_language` was immutable and the dropdown's only real
   * effect was to start a blank English *translation*. Here nothing is
   * created, nothing is blanked, and not one character of content moves —
   * `PATCH /api/zpage/{id}/` with a single field.
   */
  async function changeArticleLanguage(nextLanguage: string) {
    const operationNotice = captureAccountToast();
    const language = normalizeContentLanguage(nextLanguage);
    if (!language) return;

    languagePicker = null;

    // A draft that has never been saved has no server-side label to change:
    // the language is simply what it will be created with. Same in-place
    // relabel `planLanguageSwitch` already returns for this case — no reload,
    // nothing to discard.
    if (!currentZPage?.free2zaddr) {
      selectedLanguage = language;
      updateEditorUrl("new");
      return;
    }

    if (language === currentZPage.source_language) return;
    if (
      isRelabelling ||
      isSwitchingLanguage ||
      isDeletingTranslation ||
      isDeletingPage
    )
      return;
    // Defence in depth for the routing flip described on `canRelabel`: never
    // relabel from inside a variant that is not the source.
    if (!isCanonicalLanguage(selectedLanguage)) return;

    const previousLanguage = currentZPage.source_language;
    const identifier = currentZPage.free2zaddr;
    const label = languageLabel(language);
    // This language already belongs to another variant, so the backend will
    // refuse.  answers that with a 409 carrying an actionable `detail`;
    // an older pod mid-deploy still answers 400 through the pre- field
    // error. Knowing about the collision locally is what lets that 400 be
    // reported as the collision it is, without sniffing message text — which
    // would break the moment the copy changes.
    const collides = variantRows.some(
      (row) => row.language === language && !row.isSource,
    );
    isRelabelling = true;

    try {
      // Set the flag first, then drain: `handleSave` now refuses while
      // `isRelabelling`, so nothing new can start behind this, and the PATCH
      // reads a row no in-flight PUT is about to overwrite.
      clearAutoSaveTimer();
      while (currentSavePromise) {
        await currentSavePromise;
      }
      clearAutoSaveTimer();

      // Conditional, like every other canonical write. Without it,
      // DRF loads the whole row, sets one field and calls `.save()` — so a
      // PUT that commits between that load and that save is written straight
      // back out of a stale instance. The in-tab half of that race is already
      // serialized by `isRelabelling`; this is the cross-tab half.
      await zpagePartialUpdate(
        identifier,
        { source_language: language },
        undefined,
        {
          headers: preconditionHeaders(etags.get(canonicalEtagKey(identifier))),
        },
      );
      // The precondition passed, so server state was what this editor
      // believed — and the server then changed exactly the one field this
      // editor is about to mirror locally. `customInstance` discards response
      // headers, so the new validator is unreadable and the old one is now
      // wrong. Dropping it makes the next save unconditional (the pre-
      // behaviour for that one save) and its response re-seeds the registry.
      // Keeping the stale one instead would 412 that save and latch
      // `saveConflicted`, telling the creator somebody else edited their
      // article when they did it themselves — and offering a reload that
      // discards their unsaved work. (codex adversarial review.)
      invalidateEtags(identifier);

      // Relabel in place. Deliberately NOT a reload: rehydrating would replace
      // the composer's contents, and losing a keystroke to a *label* change is
      // the exact class of bug  exists to remove.
      currentZPage = { ...currentZPage, source_language: language };
      availableLanguages = availableLanguages.filter(
        (code) => code !== previousLanguage && code !== language,
      );
      // The source variant is the one open (see `canRelabel`), so the editor
      // follows the rename. `selectedLanguage === source_language` still holds,
      // which keeps the next save pointed at the canonical endpoint it was
      // already pointed at.
      selectedLanguage = language;
      updateEditorUrl(currentZPage.vanity || identifier);
      void refreshVariants(identifier);
      operationNotice.success(
        $t("editor.languageChangeSuccess", "This article is now {language}.", {
          language: label,
        }),
      );
    } catch (error: unknown) {
      const status = error instanceof ApiError ? error.status : 0;
      const data: any = error instanceof ApiError ? error.data : null;

      // 409 is the whole point of this endpoint's contract: the body carries a
      // `detail` written to be shown to the creator ("A Spanish translation
      // already exists. Delete or merge it first."). Substituting a generic
      // failure here is the same defect as the toast that started  —
      // telling someone it went wrong while withholding the one fact that
      // would let them fix it. Show `detail` VERBATIM.
      const conflictDetail =
        typeof data?.detail === "string" && data.detail.trim()
          ? data.detail.trim()
          : null;

      if (status === 409 || (status === 400 && collides)) {
        operationNotice.error(
          conflictDetail ??
            // Only when the server sent no detail — an older pod mid-deploy
            // answering 400 through the pre- field-error path.
            $t(
              "editor.languageChangeCollision",
              "A {language} version of this article already exists. Delete or merge it first, then make {language} the article's language.",
              { language: label },
            ),
        );
        return;
      }

      if (status === PRECONDITION_FAILED) {
        // Somebody saved this article between the editor reading it and this
        // relabel. The PATCH changed nothing, so the remedy is the same as
        // for a conflicted save: look at the newer version first.
        //
        // LATCH, do not forget. The `finally` below restarts the autosave
        // clock whenever the editor is dirty, so dropping the validator here
        // would put an unconditional PUT of this tab's stale body on the wire
        // 2.5 seconds after the 412 correctly refused it — performing the
        // exact overwrite the precondition just prevented. (codex adversarial
        // review.)
        saveConflicted = true;
        operationNotice.error(
          $t(
            "editor.saveConflict",
            "Someone else saved this article while you were editing. Your changes are still here — reload to get the newer version, then re-apply them.",
          ),
        );
        return;
      }

      if (status === 401 || status === 403) {
        operationNotice.error(
          $t(
            "editor.languageChangeForbidden",
            "You are not allowed to change this article's language.",
          ),
        );
        return;
      }

      if (status === 400) {
        operationNotice.error(
          $t(
            "editor.languageChangeRejected",
            "{language} was not accepted as this article's language.",
            { language: label },
          ),
        );
        return;
      }

      operationNotice.error(
        $t(
          "editor.languageChangeFailed",
          "Could not change the article's language. Try again.",
        ),
      );
      return;
    } finally {
      isRelabelling = false;
      // Whatever happened to the label, the creator's unsaved text is still
      // unsaved: put the clock the relabel stopped back.
      if (isDirty) {
        scheduleAutoSave();
      }
    }
  }

  /** Start a new, empty translation — explicit and labelled, never implicit. */
  async function startNewTranslation(language: string) {
    languagePicker = null;
    if (!normalizeContentLanguage(language)) return;
    await requestLanguage(language);
  }

  /**
   * Remove a translation for good.
   * Contract: `DELETE /api/zpage/{id}/translations/{language}/` — owner only,
   * and the backend refuses when the language is the page's own
   * `source_language`.
   *
   * Any row in the Translations panel can be deleted, not only the open one.
   * Deleting the variant currently on screen additionally discards its unsaved
   * edits and navigates away, because a later PUT would resurrect the row
   * through the backend's `update_or_create`; deleting some *other* language
   * leaves this editor's work untouched, because none of it was ever going to
   * that endpoint.
   */
  async function deleteTranslation(target: string) {
    const operationNotice = captureAccountToast();
    const language = target;
    if (
      !currentZPage ||
      isDeletingTranslation ||
      isDeletingPage ||
      isSwitchingLanguage
    ) {
      return;
    }
    // Guard on the row the creator actually clicked, not on the legacy
    // `available_languages` list. The variants index is authoritative and lists
    // rows that list does not have — a mirror-only variant, and from P8 an AI
    // draft. Rechecking against the legacy list rendered a Delete button that
    // silently did nothing, leaving a row only a DBA could remove and a 409 on
    // relabel telling the creator to delete it.
    const row = variantRows.find(
      (candidate) =>
        candidate.navigateAs === language || candidate.language === language,
    );
    if (!row?.canDelete || !row.exists) {
      return;
    }

    const isOpenVariant = language === selectedLanguage;
    const label = languageLabel(language);
    const identifier = currentZPage.free2zaddr;
    const sourceLanguage = currentZPage.source_language;

    const choice = await askEditorPrompt({
      title: $t(
        "editor.deleteTranslationTitle",
        "Delete the {language} translation?",
        { language: label },
      ),
      // Deleting has to abandon whatever is unsaved in this editor — including
      // shared article metadata like tags, the payout address or the canonical
      // URL — because a PUT after the DELETE would recreate the variant. Say so
      // rather than discarding it quietly.
      body:
        isDirty && isOpenVariant
          ? $t(
              "editor.deleteTranslationBodyUnsaved",
              "The {language} version is removed for good, and the unsaved changes in this editor — including shared article settings — are discarded with it. Your original article and every other language stay exactly as they are.",
              { language: label },
            )
          : $t(
              "editor.deleteTranslationBody",
              "The {language} version is removed for good. Your original article and every other language stay exactly as they are.",
              { language: label },
            ),
      confirmLabel: $t("editor.deleteTranslationConfirm", "Delete translation"),
      cancelLabel: $t("common.cancel", "Cancel"),
      danger: true,
    });

    if (choice !== "confirm") {
      return;
    }

    isDeletingTranslation = true;

    try {
      // A translation PUT still in flight would land after the DELETE, and the
      // backend's update_or_create would resurrect the row we just removed.
      // Let it finish first, then delete what is actually there — and keep the
      // autosave clock stopped for the round trip so a new one cannot start.
      clearAutoSaveTimer();
      while (currentSavePromise) {
        await currentSavePromise;
      }
      clearAutoSaveTimer();

      // `DELETE /api/zpage/{id}/variants/{lang}/`. The variant is
      // addressed by its own language, so there is nothing for the caller to
      // assert about the source: the API refuses `origin: "source"` with a 400
      // by itself. That is what retires the `X-Free2Z-Source-Language`
      // precondition the deprecated `/translations/` route needed for the
      // `und` cohort.
      // Conditional when we hold this variant's validator: a
      // confirmation dialog is exactly the kind of pause during which another
      // tab saves new translation work, and an unconditional DELETE would
      // throw that work away. When no validator is held the DELETE goes out
      // as it always has.
      await zpageVariantsDestroy(identifier, language, {
        headers: preconditionHeaders(
          etags.get(variantResourceUrl(identifier, language)),
        ),
      });

      availableLanguages = availableLanguages.filter(
        (code) => code !== language,
      );
      void refreshVariants(identifier);
      // Its job row has nothing left to review or publish.
      // A job still running into this language is NOT cancelled by the delete
      // and may recreate the draft: keep following it until it settles.
      if (!isActiveJob(pageJobs?.jobs[language]))
        translationJobs.remove(identifier, language);
      operationNotice.success(
        $t(
          "editor.deleteTranslationSuccess",
          "The {language} translation was deleted.",
          { language: label },
        ),
      );

      if (!isOpenVariant) {
        // A different language was removed. Nothing on screen belonged to it,
        // so the creator's unsaved edits stay unsaved and stay theirs.
        return;
      }

      isNewTranslationDraft = false;
      // Only now: the variant is really gone, so pending edits to it have
      // nowhere left to go. A *failed* delete must never mark them clean —
      // that would silently drop work the creator still has.
      discardPendingChanges();
      // There is no going back to a variant that no longer exists. With no
      // source label yet (detection pending) the query-free editor URL is the
      // canonical article, which is exactly what `commitLanguageSwitch("")`
      // navigates to.
      await commitLanguageSwitch(sourceLanguage ?? "", { canReturn: false });
    } catch (error: unknown) {
      const status = error instanceof ApiError ? error.status : 0;

      if (status === 401 || status === 403) {
        operationNotice.error(
          $t(
            "editor.deleteTranslationForbidden",
            "You are not allowed to delete this translation.",
          ),
        );
      } else if (status === 404) {
        // Ambiguous by design: the queryset is owner-scoped, so this is either
        // "already gone" or "this session no longer owns the page". Never
        // guess in favour of success — that would discard edits the creator
        // still has, for a translation that may still exist.
        operationNotice.error(
          $t(
            "editor.deleteTranslationMissing",
            "The {language} translation could not be found. Reload the editor to see this article's current languages.",
            { language: label },
          ),
        );
      } else if (status === 400) {
        operationNotice.error(
          $t(
            "editor.deleteTranslationRefused",
            "{language} is this article's own language, so it cannot be deleted.",
            { language: label },
          ),
        );
      } else if (status === PRECONDITION_FAILED) {
        // The precondition did its job: somebody saved this translation while
        // the confirmation dialog was open, and the delete was refused rather
        // than throwing their work away.
        //
        // The stale validator is KEPT, so a second click is refused for the
        // same reason. Dropping it would make the retry unconditional, and an
        // unconditional DELETE is exactly what would destroy the work this
        // 412 just saved — a warning followed by the deletion it warned
        // about. Reloading is the way out, and the toast says so. (codex
        // adversarial review.)
        void refreshVariants(identifier);
        operationNotice.error(
          $t(
            "editor.deleteTranslationConflict",
            "The {language} translation changed while this dialog was open, so nothing was deleted. Reload to see the newer version before deleting it.",
            { language: label },
          ),
        );
      } else {
        operationNotice.error(
          $t(
            "editor.deleteTranslationFailed",
            "Could not delete the {language} translation. Try again.",
            { language: label },
          ),
        );
      }
    } finally {
      isDeletingTranslation = false;
      // A delete that did not happen leaves the creator's edits unsaved and
      // still theirs: restart the clock. After a successful delete the editor
      // is clean (or already navigating), so this is a no-op.
      if (isDirty) {
        scheduleAutoSave();
      }
    }
  }

  /** Delete the canonical page and every translation from the editor. */
  async function deletePage(): Promise<boolean> {
    const operationNotice = captureAccountToast();
    if (!currentZPage || isDeletingPage || isDeletingTranslation) return false;

    const identifier = currentZPage.free2zaddr;
    const pageTitle = title.trim() || $t("editor.untitled", "Untitled");
    const choice = await askEditorPrompt({
      title: $t("editor.deletePageTitle", "Delete {title}?", {
        title: pageTitle,
      }),
      body: `${$t(
        "editor.deletePageBody",
        "This permanently deletes the canonical page and all of its translations.",
      )} ${
        currentZPage.is_published
          ? $t(
              "editor.deletePublishedPageWarning",
              "Because this page is published, it will also be removed from public access.",
            )
          : ""
      } ${
        isDirty
          ? $t(
              "editor.deletePageBodyUnsaved",
              "Any unsaved changes in this editor will be discarded.",
            )
          : ""
      }`,
      confirmLabel: $t("editor.deletePageConfirm", "Delete permanently"),
      cancelLabel: $t("common.cancel", "Cancel"),
      danger: true,
    });

    if (choice !== "confirm") return false;

    isDeletingPage = true;
    clearAutoSaveTimer();
    try {
      // Let a save already in flight finish first. Otherwise its PUT could
      // complete after this DELETE and recreate the page through the backend's
      // update-or-create path. The response then refreshes the ETag registry,
      // so deletion remains conditional on the newest saved version.
      while (currentSavePromise) {
        await currentSavePromise;
      }
      clearAutoSaveTimer();

      await deleteZPage(identifier, {
        etag: etags.get(canonicalEtagKey(identifier)),
      });
      discardPendingChanges();
      operationNotice.success(
        $t("editor.deletePageSuccess", "{title} was deleted.", {
          title: pageTitle,
        }),
      );
      await navigateWithoutUnsavedGuard(
        `/${encodeURIComponent(getRouteData().currentUser.username)}/dashboard/pages`,
      );
      return true;
    } catch (error: unknown) {
      const status = error instanceof ZPageDeleteError ? error.status : 0;
      if (status === 409 && error instanceof Error && error.message) {
        // A permanent refusal (e.g. on-chain payment records protect the
        // page): show the server's actionable `detail`, never "retry".
        operationNotice.error(error.message);
      } else if (status === 412) {
        const message = $t(
          "editor.deletePageConflict",
          "This page changed while the dialog was open, so nothing was deleted. Reload to see the newer version before deleting it.",
        );
        if (!destroyed)
          editorActionToastIds.add(
            operationNotice.error(message, {
              duration: Infinity,
              action: {
                label: $t("editor.deletePageReload", "Reload"),
                onClick: () => location.reload(),
              },
            }),
          );
      } else if (status === 401 || status === 403) {
        operationNotice.error(
          $t(
            "editor.deletePageForbidden",
            "You are no longer allowed to delete this page. Reload the editor and try again.",
          ),
        );
      } else {
        operationNotice.error(
          $t(
            "editor.deletePageFailed",
            "The page was not deleted. Check your connection and try again.",
          ),
        );
      }
      return false;
    } finally {
      isDeletingPage = false;
      if (isDirty) scheduleAutoSave();
    }
  }

  // -------------------------------------------------------------------------
  // Buying an AI translation —  §6.1: quote, confirm, debit, job, draft.
  //
  // The order is the product, not an implementation detail. A creator sees the
  // number BEFORE anything is committed, because pricing is cost-plus and
  // metered: there is no price list, and the quote endpoint is the only place
  // the figure exists. Everything else on this path already survives contact
  // with production on the server side (idempotent debit, refund on failure,
  // 202 + poll); what the editor owes it is (a) never committing from a screen
  // that has not shown the price, (b) one steady idempotency key per purchase,
  // and (c) saying out loud what every refusal was.
  // -------------------------------------------------------------------------

  /**
   * Open the price dialog for `target` and fetch the quote. Charges nothing.
   *
   * One purchase at a time through THIS dialog (its intent/recovery record is
   * one per article), but no longer one translation at a time: where the
   * deployment runs jobs in parallel, a second language may be bought while
   * the first is still translating. The same language twice is still
   * refused — its job is already running.
   */
  async function openTranslateWithAi(target: string) {
    const language = normalizeContentLanguage(target) ?? target;
    const slotBusy = isTranslating || translationPending;
    if (
      !currentZPage ||
      isBuyingTranslation ||
      (slotBusy && !parallelTranslations) ||
      // Recovering an unresolved purchase outranks "already running": the
      // running job may BE that purchase, and only its own key can say so.
      (activeJobLanguages.includes(language) &&
        unresolvedTranslationLanguage === null) ||
      isDeletingTranslation ||
      isDeletingPage
    )
      return;
    if (isSwitchingLanguage || isRelabelling) return;

    const requestId = ++translateAiRequestId;
    translateAiPage = currentZPage.free2zaddr;
    translateAiLanguage = language;
    translateAiQuote = null;
    translateAiIntentKey = null;
    translateAiError = null;
    translateAiPurchaseError = null;
    translateAiFunds = null;
    clearAutoSaveTimer();
    // Recover the exact undecided request, even after closing/reloading and
    // even when the current source now quotes differently. GET status is not
    // an intent lookup and must never resolve this record.
    try {
      const pending = readUnresolvedTranslation(currentZPage.free2zaddr);
      if (pending !== null) {
        if (
          !pending.quote?.source_digest ||
          typeof pending.language !== "string" ||
          typeof pending.key !== "string" ||
          !/^[0-9a-f-]{36}$/i.test(pending.key)
        )
          throw new Error("Unrecoverable translation intent");
        translateAiLanguage = pending.language;
        translateAiQuote = pending.quote;
        translateAiIntentKey = pending.key;
        return;
      }
    } catch {
      translateAiError = $t(
        "editor.translateAiErrorStorage",
        "Browser storage is unavailable. Restore it and check any previous payment before retrying. This attempt was not sent.",
      );
      return;
    }
    // The retry key is minted at CONFIRM, not here: opening a price screen and
    // closing it again is not a purchase, and minting one per look would leave
    // keys for decisions nobody made. It is kept across retries once it exists
    // -- see `translateAiKeys`.

    // The quote prices THIS body, and its `source_digest` binds the purchase
    // to it. Quoting over unsaved edits would show a price for text the server
    // has never seen, and the purchase would then be refused with
    // `price_changed` — a confusing way to learn you had not saved. Flush
    // first, and if the flush cannot happen, say so instead of quoting a lie.
    clearAutoSaveTimer();
    // Quotes always use the canonical original, never the open target. Keep
    // target edits in the composer until the creator explicitly loads delivery.
    while (currentSavePromise) await currentSavePromise;
    if (requestId !== translateAiRequestId) return;
    if (isDirty && canRelabel) {
      const saved = await handleSave({
        successMessage: $t(
          "editor.translateAiSavedFirst",
          "Saved, so the price is for what you actually wrote.",
        ),
      });
      if (requestId !== translateAiRequestId) return;
      if (!saved || isDirty) {
        translateAiError = $t(
          "editor.translateAiNeedsSave",
          "Save this article before buying a translation — the price is worked out from the saved text.",
        );
        return;
      }
    }

    const identifier = currentZPage?.free2zaddr;
    if (!identifier) return;

    // Re-read the variants BEFORE offering anything. The editor stops watching
    // a job after `TRANSLATION_POLL_TIMEOUT_MS`, and a queue backlog is not
    // bounded by that — so a draft can land while the panel still says "Not
    // started". Deciding from stale rows is how a creator buys the same
    // translation twice and overwrites the one they never saw arrive. This is
    // the decision point, so this is where the refresh has to be.
    // (codex adversarial review.)
    await refreshVariants(identifier);
    if (requestId !== translateAiRequestId) return;

    try {
      const readOrder = beginAccountBalanceRead();
      const quote = recordQuotedBalanceRead(
        await zpageTranslationQuote(identifier, language),
        readOrder,
      );
      if (requestId !== translateAiRequestId) return;

      // The quote deliberately prices a language that is already published —
      // it is a pure read and refusing there would make the price unknowable.
      // The PURCHASE is what refuses it (409 `variant_published`), so showing
      // a price here would be showing a number for something the very next
      // click cannot buy. Refuse on the price screen instead: same rule as
      // 's ceiling, one step earlier than the money. This is the other
      // half of  — the 409 stops being a surprise.
      if (quote.existing_variant?.is_published) {
        translateAiError = $t(
          "editor.translateAiErrorVariantPublished",
          "The {language} translation is published, and an AI translation never overwrites live content. Unpublish or delete it first — nothing was charged.",
          { language: languageLabel(language) },
        );
        return;
      }

      translateAiQuote = quote;
    } catch (error: unknown) {
      if (requestId !== translateAiRequestId) return;
      // Every refusal that can reach here is one the creator can act on —
      // including 's `published_variant_limit`, which is exactly why the
      // cap is checked at quote time: the price screen refuses instead of the
      // publish button refusing after the money is gone.
      translateAiError = translationPurchaseError(error, {
        t: $t,
        language: languageLabel(language),
      });
    }
  }

  function closeTranslateWithAi() {
    // Invalidate any quote still in flight before dropping the state, or it
    // will reopen the dialog when it lands.
    translateAiRequestId += 1;
    translateAiPage = null;
    translateAiLanguage = null;
    translateAiQuote = null;
    translateAiIntentKey = null;
    translateAiError = null;
    translateAiPurchaseError = null;
    translateAiFunds = null;
    if (isDirty) scheduleAutoSave();
    // The durable exact request survives closing; reopening restores its key.
  }

  /** Confirm the quoted price and buy. This is the only call that spends 2Z. */
  function readUnresolvedTranslation(identifier: string) {
    const stored = JSON.parse(
      localStorage.getItem(`${translationReceiptKey(identifier)}:pending`) ??
        "null",
    );
    return stored?.settled ? null : stored;
  }

  function receiptFromSettlement(
    stored: any,
  ): NonNullable<typeof translationProgress> | null {
    if (
      stored?.settled !== "success" ||
      typeof stored.job_id !== "string" ||
      typeof stored.language !== "string" ||
      !currentZPage
    )
      return null;
    // Compact durable proof is enough to reconnect a KNOWN purchase. Fields
    // not retained are unknown and never displayed before status refresh.
    const job: TranslationJob = {
      job_id: stored.job_id,
      language: stored.language,
      zpage_id: currentZPage.id,
      status: stored.status,
      price: stored.price,
      source_digest: "",
      charged: "",
      refunded: "",
      balance: "",
      ai_model: "",
      ai_model_id: "",
      error: null,
    };
    return {
      page: currentZPage.free2zaddr,
      language: stored.language,
      job,
      checking: false,
      interrupted: false,
      storageJobId: stored.job_id,
    };
  }

  function syncUnresolvedTranslation() {
    if (!browser) return;
    const identifier = currentZPage?.free2zaddr ?? null;
    if (identifier !== unresolvedTranslationPage) {
      unresolvedTranslationPage = identifier;
      unresolvedTranslationLanguage = null;
    }
    if (!currentZPage) return;
    try {
      const pending = readUnresolvedTranslation(currentZPage.free2zaddr);
      unresolvedTranslationLanguage =
        pending === null
          ? null
          : typeof pending.language === "string"
            ? pending.language
            : openLanguage;
      if (pending !== null) {
        showTranslations = true;
        clearAutoSaveTimer();
      } else if (saveBlockReason === "translation-unresolved") {
        saveBlockReason = null;
        saveError = null;
      }
    } catch {
      /* Preserve a known pause if storage becomes unavailable. */
    }
  }

  async function withTranslationIntentLock<T>(
    identifier: string,
    action: () => T,
    receiptBase = translationReceiptKey(identifier),
  ): Promise<T> {
    if (!navigator.locks)
      throw new Error("Translation purchase coordination unavailable");
    return navigator.locks.request(`${receiptBase}:pending`, action);
  }

  async function retireTranslationIntent(
    identity: Parameters<typeof clearIntentIdempotencyKey>[0],
    options: Parameters<typeof clearIntentIdempotencyKey>[1] = {},
    outcome: "success" | "refused",
    identifier: string,
    key: string,
    receipt?: NonNullable<typeof translationProgress>,
    operationNotice = captureAccountToast(),
    receiptBase = translationReceiptKey(identifier),
  ) {
    try {
      await withTranslationIntentLock(
        identifier,
        () => {
          const storageKey = `${receiptBase}:pending`;
          const pending = JSON.parse(
            localStorage.getItem(storageKey) ?? "null",
          );
          // Another tab may already have started a newer purchase. Its exact
          // request and key belong to it, never to this delayed response.
          if (pending?.key !== key) return;
          const proof = JSON.stringify({
            key,
            settled: outcome,
            language: pending.language,
            ...(receipt
              ? {
                  job_id: receipt.job.job_id,
                  status: receipt.job.status,
                  price: receipt.job.price,
                }
              : {}),
          });
          // A quota-full browser can still replace an existing value with a
          // smaller one. Never discard the exact request to allocate its proof.
          if (proof.length >= JSON.stringify(pending).length)
            throw new Error("Settlement proof must shrink the pending record");
          clearIntentIdempotencyKey(identity, options);
          localStorage.setItem(storageKey, proof);
        },
        receiptBase,
      );
    } catch {
      // Keep the unresolved payload if either storage cleanup failed. Replaying
      // it is safer than minting a new purchase after an unrecorded settlement.
      operationNotice.error(
        $t(
          outcome === "success"
            ? "editor.translateAiErrorStorageCleanup"
            : "editor.translateAiErrorStorageRefusalCleanup",
          outcome === "success"
            ? "Translation purchase succeeded, but browser storage could not be updated. Do not submit another purchase until the receipt is reconciled."
            : "The translation was not charged, but browser storage could not record the refusal. Reconcile it before retrying.",
        ),
      );
    } finally {
      if (
        operationNotice.isCurrent() &&
        translateAiPage === identifier &&
        translateAiIntentKey === key
      )
        translateAiIntentKey = null;
      if (
        operationNotice.isCurrent() &&
        currentZPage?.free2zaddr === identifier
      )
        syncUnresolvedTranslation();
    }
  }

  async function confirmTranslateWithAi() {
    const language = translateAiLanguage;
    const quote = translateAiQuote;
    const consentKey = translateAiIntentKey;
    // The article the QUOTE was for, never "the one loaded right now". See
    // `translateAiPage`.
    const identifier = translateAiPage;
    const receiptBase = identifier ? translationReceiptKey(identifier) : "";
    const operationNotice = captureAccountToast({
      onError: (message) => {
        if (
          translateAiPage !== identifier ||
          translateAiQuote !== quote ||
          translateAiLanguage !== language
        )
          return;
        translateAiPurchaseError = String(message);
        translateAiFailureGeneration = $toastPresentation.generation;
      },
    });
    // No quote means no price was shown, so there is nothing the creator
    // agreed to. Not reachable through the UI (the button does not exist
    // without a quote); asserted here so it stays unreachable.
    if (
      !ownerSignedIn ||
      !language ||
      !quote ||
      !identifier ||
      isBuyingTranslation ||
      translateAiFunds ||
      translateAiError ||
      !quote.affordable
    )
      return;
    // Navigated away with the dialog open. The price on screen describes an
    // article that is no longer the one this editor would act on, so there is
    // nothing safe to buy.
    if (identifier !== currentZPage?.free2zaddr) {
      closeTranslateWithAi();
      return;
    }

    translateAiPurchaseError = null;
    const ownsPurchase = authStore.captureRequestOwnership();
    const label = languageLabel(language);
    // The key belongs to the DECISION, not to this call. A retry after a
    // failed-looking request is the case idempotency exists for: the debit may
    // have committed and only the response lost, so re-sending the SAME key is
    // what turns a second click into a replay instead of a second charge.
    // `Idempotency-Key` is a header, and orval emits no code for headers, so
    // this call site is the only place it can reach the wire at all.
    //
    // The identity covers every field of the server's fingerprint — article,
    // language, price AND the body digest the quote was computed against
    //. An edited article is a different purchase on both sides, so it
    // gets a different key instead of a 409 that nothing ever clears.
    let intentIdentity;
    /** The pre- name for this same decision; see `supersedes` below. */
    const supersededIdentity = translationPurchaseLegacyIdentity({
      actor: data.currentUser.username,
      identifier,
      language,
      quote,
    });
    try {
      intentIdentity = translationPurchaseIdentity({
        actor: data.currentUser.username,
        identifier,
        language,
        quote,
      });
    } catch {
      // A quote with no `source_digest` cannot be bound to the server's
      // fingerprint, so no key minted for it could ever be replayed safely.
      // The schema makes the field required and the button does not exist
      // without a quote, so this is unreachable through the UI — but an
      // uncaught throw here would be an unhandled rejection: a dead button
      // with no message, on a money path. Say the true thing instead. It is
      // deliberately NOT the "we could not tell whether that went through"
      // copy: nothing was sent, so nothing is undecided.
      operationNotice.error(
        $t(
          "editor.translateAiErrorFailed",
          "The translation could not be bought. Nothing was charged — try again.",
        ),
      );
      return;
    }
    // `supersedes` carries an unresolved purchase minted by a build that had
    // no digest in the identity into this bucket, once, instead of abandoning
    // it — abandoning it would mint a fresh UUID for a retry whose original
    // may already have committed, and charge it twice.
    // Dialog requests are invalidated by any hydration. A paid purchase,
    // however, still owns this article after a language switch or browser Back.
    // Keep its autosave pause and attach its receipt to the article on arrival.
    const stillHere = () =>
      !destroyed &&
      operationNotice.isCurrent() &&
      ownsPurchase() &&
      currentZPage?.free2zaddr === identifier;
    const purchaseGeneration = ++translationPurchaseGeneration;
    const releasePurchase = () => {
      if (purchaseGeneration !== translationPurchaseGeneration) return;
      isBuyingTranslation = false;
      if (!stillHere()) isTranslating = false;
    };
    isBuyingTranslation = true;
    isTranslating = true;
    let key: string;
    try {
      key = await withTranslationIntentLock(
        identifier,
        () => {
          if (!ownsPurchase() || !operationNotice.isCurrent())
            throw new Error("Account changed before purchase");
          const pending = readUnresolvedTranslation(identifier);
          if (
            pending !== null &&
            ((consentKey !== null && pending.key !== consentKey) ||
              pending.language !== language ||
              pending.quote?.price !== quote.price ||
              pending.quote?.source_digest !== quote.source_digest ||
              typeof pending.key !== "string" ||
              !/^[0-9a-f-]{36}$/i.test(pending.key))
          )
            throw new Error("Unrecoverable translation intent");
          // A recovery decision retains its exact identity even if another tab
          // settles its durable request while this price dialog remains open.
          const requestKey =
            consentKey ??
            pending?.key ??
            intentIdempotencyKey(intentIdentity, {
              supersedes: supersededIdentity,
            });
          localStorage.setItem(
            `${receiptBase}:pending`,
            JSON.stringify({ language, quote, key: requestKey }),
          );
          return requestKey;
        },
        receiptBase,
      );
      if (
        operationNotice.isCurrent() &&
        translateAiPage === identifier &&
        translateAiQuote === quote
      )
        translateAiIntentKey = key;
      if (
        operationNotice.isCurrent() &&
        currentZPage?.free2zaddr === identifier
      )
        syncUnresolvedTranslation();
    } catch {
      releasePurchase();
      if (stillHere()) isTranslating = false;
      operationNotice.error(
        $t(
          "editor.translateAiErrorStorage",
          "Browser storage is unavailable. Restore it and check any previous payment before retrying. This attempt was not sent.",
        ),
      );
      return;
    }
    if (!stillHere()) {
      releasePurchase();
      return;
    }
    // A translation writes a variant server-side. An autosave landing in the
    // middle would be writing a different variant, but the panel refresh at
    // the end must not race one either — stop the clock for the round trip,
    // exactly as the delete path does.
    clearAutoSaveTimer();

    // ONE payload, built once and sent by BOTH calls below.
    //
    // The recovery POST is "re-send the SAME request", and it has to be the
    // same request in fact and not only in intent: it once carried only the
    // price and the digest, so a purchase that reached the server on the retry
    // recorded LEGACY refund terms while the identical purchase that landed
    // first recorded current ones. Two creators, the same screen, different
    // terms, decided by which of them had a network blip. (codex adversarial
    // review, round 6.)
    const purchase = {
      expected_price: quote.price,
      source_digest: quote.source_digest,
      // Which refund terms this build SHOWED. The dialog above
      // states the one case in which a failed translation is not refunded in
      // full, so this build may declare 1. Omitting it means "legacy terms,
      // refund everything" — which is what an older tab still open against
      // this backend gets, and correctly so: it is displaying the old promise.
      // Keep this number and the dialog copy in the same commit, always.
      settlement_policy: SETTLEMENT_POLICY_VERSION,
    };

    let job: TranslationJob | null = null;
    try {
      job = await zpageTranslationPurchase(identifier, language, purchase, {
        headers: { "Idempotency-Key": key },
      });
    } catch (error: unknown) {
      // A structured refusal is a DECISION and no money moved. A transport
      // failure or a bodyless 5xx is not: the debit and the 202 receipt may
      // have committed and only the answer been lost.
      //
      // Recover by re-sending the SAME request with the SAME key, not by
      // asking `GET.../translate/` what the latest purchase was. That GET
      // answers "the most recent purchase for this language", which for a
      // creator who bought Spanish last week is last week's job — the client
      // would then announce an old outcome, close the dialog and drop the key
      // while the real request was still deciding. The key is the only thing
      // that identifies THIS purchase, and re-sending it is exactly what it is
      // for: the server replays the receipt if the original landed, answers
      // `request_in_progress` if it is undecided, and performs the purchase
      // once if it never arrived. Never twice. (codex adversarial review.)
      if (isAmbiguousOutcome(error)) {
        try {
          job = await zpageTranslationPurchase(identifier, language, purchase, {
            headers: { "Idempotency-Key": key },
          });
        } catch (retryError: unknown) {
          // Still no answer, or an answer that is a decision. Either way the
          // key survives, so the creator's own next click is a third replay
          // rather than a second purchase.
          error = retryError;
          job = null;
        }
      }

      if (job === null) {
        // An old request may settle after another article has hydrated. Its
        // persistent intent remains retryable; it cannot alter the new editor.
        if (!stillHere()) {
          if (isNoChargeRefusal(error))
            await retireTranslationIntent(
              intentIdentity,
              {
                supersedes: supersededIdentity,
                ...(translationErrorCode(error) === "idempotency_mismatch"
                  ? { unresolved: true }
                  : {}),
              },
              "refused",
              identifier,
              key,
              undefined,
              operationNotice,
              receiptBase,
            );
          return;
        }
        translateAiFunds = insufficientFundsFromError(error);
        if (translateAiFunds) {
          await retireTranslationIntent(
            intentIdentity,
            {
              supersedes: supersededIdentity,
            },
            "refused",
            identifier,
            key,
            undefined,
            operationNotice,
            receiptBase,
          );
          if (!stillHere()) return;
          isBuyingTranslation = false;
          isTranslating = false;
          if (isDirty) scheduleAutoSave();
          return;
        }
        if (translationErrorCode(error) === "idempotency_mismatch") {
          // The server has decided this key belongs to a DIFFERENT request,
          // so re-sending it can only ever repeat this 409 — the wedge
          // is about. Retire it: nothing was charged for this attempt, and
          // the next click must be free to mint a key the server can accept.
          await retireTranslationIntent(
            intentIdentity,
            {
              supersedes: supersededIdentity,
              // A refusal, not a resolution: if this key came from a build that
              // had no digest in the identity, it belongs to whichever revision
              // it was bought for, and must stay available to that one.
              unresolved: true,
            },
            "refused",
            identifier,
            key,
            undefined,
            operationNotice,
            receiptBase,
          );
          if (!stillHere()) return;
        }
        if (
          ["source_changed", "price_changed"].includes(
            translationErrorCode(error) ?? "",
          )
        ) {
          // The server released this no-money claim after the locked digest
          // check. Re-open the quote immediately so the creator confirms the
          // price for the article that exists now, never the stale one.
          await retireTranslationIntent(
            intentIdentity,
            {
              supersedes: supersededIdentity,
            },
            "refused",
            identifier,
            key,
            undefined,
            operationNotice,
            receiptBase,
          );
          if (!stillHere()) return;
        }
        const refusalCode = translationErrorCode(error);
        // Only named pre-debit refusals from views/translate.py's _Refuse
        // path settle an intent. An arbitrary structured 500 is not proof.
        if (
          [
            "not_translatable",
            "unknown_source_language",
            "same_language",
            "empty_article",
            "translation_unavailable",
            "variant_published",
            "translation_in_progress",
            "translation_backlog",
            "published_variant_limit",
            "draft_variant_limit",
            "insufficient_funds",
          ].includes(refusalCode ?? "")
        ) {
          // A structured no-charge refusal releases its claim server-side.
          // Keeping that target's payload would hijack every later language.
          // Uncertain transport outcomes and undecided claims keep exact replay.
          await retireTranslationIntent(
            intentIdentity,
            { supersedes: supersededIdentity },
            "refused",
            identifier,
            key,
            undefined,
            operationNotice,
            receiptBase,
          );
          if (!stillHere()) return;
          translateAiError = translationPurchaseError(error, {
            t: $t,
            language: label,
          });
        }
        operationNotice.error(
          translationPurchaseError(error, { t: $t, language: label }),
        );
        // Otherwise the key is deliberately NOT cleared: the dialog stays
        // open, and the creator's next click re-sends it, which replays a
        // purchase that did land instead of buying a second one.
        isBuyingTranslation = false;
        isTranslating = false;
        void refreshVariants(identifier);
        if (
          ["source_changed", "price_changed"].includes(
            translationErrorCode(error) ?? "",
          )
        ) {
          void openTranslateWithAi(language);
          return;
        }
        if (isDirty) scheduleAutoSave();
        return;
      }
      // The purchase did happen. Fall through and treat it like the 202 it
      // was, so the creator sees the job rather than a scary non-event.
    } finally {
      releasePurchase();
    }

    // Record this receipt for its article even if navigation finished first.
    const receipt = {
      page: identifier,
      language,
      job,
      interrupted: false,
      checking: false,
      storageJobId: job.job_id,
    };
    await recordTranslationReceipt(receipt, key, receiptBase);

    // Settled: this key has done its job, and the next purchase in this
    // language is a genuinely new one.
    await retireTranslationIntent(
      intentIdentity,
      {
        supersedes: supersededIdentity,
      },
      "success",
      identifier,
      key,
      receipt,
      operationNotice,
      receiptBase,
    );
    if (!stillHere()) return;
    translationProgress = {
      page: identifier,
      language,
      job,
      interrupted: false,
      checking: true,
      storageJobId: job.job_id,
    };
    persistTranslationProgress();
    showTranslations = true;
    closeTranslateWithAi();
    // Deliberately NOT "you can keep writing". The job is bound to the body's
    // digest and gives up with `source_changed` if the article moves under it
    // (`translation/tasks.py`), refunding in full. That is the right behaviour
    // a translation of text that no longer exists is worthless — but a
    // creator who was told to keep typing and then watched their purchase
    // dissolve would rightly call that a bug. Say the true thing instead.
    //
    // This is the ONE place that caution belongs: once, at the moment the
    // creator still has a choice about editing the original. The waiting
    // notice does not repeat it — telling somebody who is waiting about a
    // footgun they are not near is what  objected to.
    operationNotice.success(
      $t(
        "editor.translateAiStarted",
        "Translating into {language} — {price} 2Z. It takes a few minutes. Rewriting the original before it finishes cancels the translation and returns your 2Z — unless you keep changing or publishing this article or its translation, and then the work already done is charged for.",
        { language: label, price: quote.price },
      ),
    );

    // `watchTranslationJob` takes the next monitor id synchronously. A later
    // purchase takes the one after, and from then on the busy flags are ITS
    // to clear, not this one's (: purchases may now overlap).
    const ownMonitor = translationMonitorId + 1;
    try {
      await watchTranslationJob(identifier, language, label, job);
    } finally {
      if (
        currentZPage?.free2zaddr === identifier &&
        translationMonitorId === ownMonitor
      ) {
        isTranslating = false;
        if (isDirty) scheduleAutoSave();
      }
    }
  }

  function translationReceiptKey(identifier: string) {
    return `translation-receipt:${data.currentUser.username}:${identifier}`;
  }

  async function recordTranslationReceipt(
    receipt: NonNullable<typeof translationProgress>,
    purchaseKey?: string,
    receiptBase = translationReceiptKey(receipt.page),
  ) {
    if (!browser) return;
    const snapshot = { ...receipt, job: { ...receipt.job } };
    try {
      await withTranslationIntentLock(
        snapshot.page,
        () => {
          const base = receiptBase;
          // Keep at most eight confirmed job records per article. The current
          // index and incoming job are pinned; unknown intent/proof is untouched.
          const indexedBefore = JSON.parse(
            localStorage.getItem(base) ?? "null",
          );
          const history = Object.keys(localStorage).filter((key) =>
            key.startsWith(`${base}:job:`),
          );
          const removable = history.filter(
            (key) =>
              key !== `${base}:job:${snapshot.job.job_id}` &&
              key !== `${base}:job:${indexedBefore?.job?.job_id}`,
          );
          while (history.length >= 8 && removable.length) {
            const key = removable.shift()!;
            localStorage.removeItem(key);
            history.splice(history.indexOf(key), 1);
          }
          // Every retained known job survives independently. A late receipt/status
          // must not erase another language's newer accepted purchase index.
          localStorage.setItem(
            `${base}:job:${snapshot.job.job_id}`,
            JSON.stringify(snapshot),
          );
          const indexed = JSON.parse(localStorage.getItem(base) ?? "null");
          const pending = JSON.parse(
            localStorage.getItem(`${base}:pending`) ?? "null",
          );
          if (
            !indexed ||
            indexed.job?.job_id ===
              (snapshot.storageJobId ?? snapshot.job.job_id) ||
            (purchaseKey !== undefined && pending?.key === purchaseKey)
          ) {
            localStorage.setItem(
              base,
              JSON.stringify({
                ...snapshot,
                storageJobId: snapshot.job.job_id,
              }),
            );
            receipt.storageJobId = snapshot.job.job_id;
          }
        },
        receiptBase,
      );
    } catch {
      /* Exact pending payload/settlement still allows recovery. */
    }
  }

  function persistTranslationProgress() {
    if (translationProgress) void recordTranslationReceipt(translationProgress);
  }

  /**
   * Re-read this article's jobs soon. Another tab on this browser bought,
   * delivered or published something (a storage event), or the creator came
   * back to this tab from elsewhere — possibly another device ( review).
   */
  let jobsRereadTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleJobsReread() {
    if (jobsRereadTimer) clearTimeout(jobsRereadTimer);
    jobsRereadTimer = setTimeout(() => {
      jobsRereadTimer = null;
      const identifier = currentZPage?.free2zaddr;
      if (identifier && !destroyed && pageJobs?.listSupported !== false)
        void translationJobs.refresh(identifier);
    }, 400);
  }

  async function handleTranslationStorage(event: StorageEvent) {
    const identifier = currentZPage?.free2zaddr;
    if (
      identifier &&
      (event.key === null ||
        event.key.startsWith("translation-") ||
        event.key.startsWith(translationReceiptKey(identifier)))
    )
      scheduleJobsReread();
    if (identifier && event.key === bulkIntentKey(identifier)) {
      bulkIntent = readBulkIntent(identifier);
      return;
    }
    if (
      !identifier ||
      event.key !== `${translationReceiptKey(identifier)}:pending`
    )
      return;
    const stillHere = () =>
      !destroyed && currentZPage?.free2zaddr === identifier;
    try {
      const previous = JSON.parse(event.oldValue ?? "null");
      const settlement = JSON.parse(event.newValue ?? "null");
      if (settlement && !settlement.settled) {
        syncUnresolvedTranslation();
        return;
      }
      if (
        settlement?.key === previous?.key &&
        settlement?.settled === "refused"
      ) {
        syncUnresolvedTranslation();
        if (isDirty) scheduleAutoSave();
        return;
      }
      const receipt =
        settlement?.key === previous?.key
          ? receiptFromSettlement(settlement)
          : null;
      if (!receipt || receipt.language !== previous?.language) {
        // Deletion without proof is not settlement. Preserve exact unknown
        // requests, but never replace a newer request another tab installed.
        await withTranslationIntentLock(identifier, () => {
          const key = `${translationReceiptKey(identifier)}:pending`;
          if (
            previous?.key &&
            !previous.settled &&
            localStorage.getItem(key) === null
          )
            localStorage.setItem(key, JSON.stringify(previous));
        });
        if (stillHere()) syncUnresolvedTranslation();
        return;
      }
      isTranslating = true;
      translationProgress = receipt;
      showTranslations = true;
      syncUnresolvedTranslation();
      await reconnectTranslation();
    } catch {
      /* Preserve the pause if the exact settlement cannot be read. */
    }
  }

  async function restoreTranslationProgress(identifier: string) {
    if (!browser) return;
    try {
      const cached = JSON.parse(
        localStorage.getItem(translationReceiptKey(identifier)) ?? "null",
      );
      const compact = receiptFromSettlement(
        JSON.parse(
          localStorage.getItem(
            `${translationReceiptKey(identifier)}:pending`,
          ) ?? "null",
        ),
      );
      const saved =
        compact && cached?.job?.job_id !== compact.job.job_id
          ? compact
          : (cached ?? compact);
      if (
        !saved ||
        saved.page !== identifier ||
        typeof saved.language !== "string" ||
        typeof saved.job?.job_id !== "string"
      )
        return;
      translationProgress = {
        ...saved,
        checking: false,
        // Older receipts predate the ownership field. Preserve their original
        // index owner before polling can replace job with a newer receipt.
        storageJobId: saved.storageJobId ?? saved.job.job_id,
      };
      if (!availableLanguages.includes(saved.language))
        availableLanguages = [...availableLanguages, saved.language];
      showTranslations = true;
      if (!isTerminalTranslationJob(saved.job)) await reconnectTranslation();
    } catch {
      /* No receipt in this browser. Never infer a purchase. */
    }
  }

  // ---- The tray, the bulk purchase and the review loop  ----------

  function announceTranslationReady(
    identifier: string,
    language: string,
    notice = captureAccountToast(),
  ) {
    notice.success(
      $t("translationJobs.deliveredToast", "{language} is ready to review.", {
        language: languageLabel(language),
      }),
      {
        action: {
          label: $t("translationJobs.review", "Review"),
          onClick: () => reviewTranslation(identifier, language),
        },
      },
    );
  }

  // A Review request — from a toast, the tray, or another route — is handled
  // here, on the article it names, through the ordinary language switch so
  // unsaved edits get the ordinary save/discard/cancel choice.
  $effect(() => {
    const request = $translationJobs.review;
    const identifier = currentZPage?.free2zaddr;
    if (!request || !identifier || request.page !== identifier) return;
    untrack(() => {
      translationJobs.clearReview();
      void startReview(request.language);
    });
  });

  // A job of this article finished: its draft (or its absence) changes the
  // variants index, which the panel and the tray both read.
  onDestroy(
    translationJobs.onTransition((entry) => {
      if (entry.page !== currentZPage?.free2zaddr) return;
      void refreshVariants(entry.page);
      // A job the editor is not itself watching delivered INTO the version on
      // screen (bought in bulk while it was open). The composer still holds
      // the pre-delivery text and validator; route it through the same
      // reconciliation the watched purchase uses, never a silent overwrite
      // (codex adversarial review of ).
      if (
        !entry.claimed &&
        entry.status === "delivered" &&
        entry.language === openLanguage &&
        !isCanonicalLanguage(selectedLanguage)
      )
        void reloadDeliveredOpenVariant(entry.page, entry.language);
    }),
  );

  /**
   * Bring a delivery into the version on screen: silently when nothing of the
   * creator's would be lost, through the load-or-keep choice when something
   * would. Returns whether the delivered text is what is on screen now.
   */
  async function reloadDeliveredOpenVariant(
    identifier: string,
    language: string,
  ): Promise<boolean> {
    if (currentZPage?.free2zaddr !== identifier || openLanguage !== language)
      return false;
    if (!isDirty) {
      const switched = await commitLanguageSwitch(language, {
        discardUnsaved: true,
      });
      if (switched) lastHydratedAt = Date.now();
      return switched;
    }
    await chooseDeliveredTranslation(identifier, language);
    return !translationReviewNeeded;
  }

  // When the last job that was holding autosave back settles, autosave picks
  // up the edits it was holding (codex adversarial review of ).
  let blockedByJobs = false;
  $effect(() => {
    const blocking = jobsStoppedBySavingOpenVariant.length > 0;
    if (blockedByJobs && !blocking)
      untrack(() => {
        if (isDirty) scheduleAutoSave();
      });
    blockedByJobs = blocking;
  });

  // Leaving the reviewed language any other way ends the review.
  $effect(() => {
    if (
      reviewLanguage &&
      !isSwitchingLanguage &&
      openLanguage !== reviewLanguage
    )
      reviewLanguage = null;
  });

  function openTray() {
    if (currentZPage) translationJobs.openTray(currentZPage.free2zaddr);
  }

  async function startReview(language: string) {
    if (!currentZPage) return;
    const identifier = currentZPage.free2zaddr;
    translationJobs.closeTray();
    if (openLanguage !== language) {
      await requestLanguage(language);
      if (currentZPage?.free2zaddr !== identifier || openLanguage !== language)
        return;
    } else {
      // Already open — but loaded before this delivery? Then what is on
      // screen is not the translation being reviewed.
      const job = pageJobs?.jobs[language];
      if (
        job?.status === "delivered" &&
        (job.changedAt ?? 0) > lastHydratedAt &&
        !(await reloadDeliveredOpenVariant(identifier, language))
      )
        return;
    }
    reviewLanguage = language;
    mode = "write";
    reviewSourceRevision += 1;
  }

  /** A publish is under way: the review stays on its language until it ends. */
  function reviewBusy() {
    return (
      publishPhase !== null ||
      (reviewLanguage !== null &&
        translationPublishing.publishing.has(reviewLanguage))
    );
  }

  function reviewStep(delta: 1 | -1) {
    const queue = reviewQueue;
    if (!queue.length || !reviewLanguage || reviewBusy()) return;
    const at = queue.indexOf(reviewLanguage);
    let index: number;
    if (at >= 0) {
      index = (at + delta + queue.length) % queue.length;
    } else {
      // The open one is not in the queue (it was just published): step to
      // its neighbour in the same alphabetical order the queue uses.
      const current = languageLabel(reviewLanguage);
      const after = queue.findIndex(
        (language) => languageLabel(language).localeCompare(current) > 0,
      );
      index =
        delta === 1
          ? after === -1
            ? 0
            : after
          : ((after === -1 ? queue.length : after) - 1 + queue.length) %
            queue.length;
    }
    const next = queue[index];
    if (next && next !== reviewLanguage) void startReview(next);
  }

  /** Reflect a publish at once in both the store and the variants index. */
  /**
   * Publishing translations — tray, review loop, "Publish all ready" — lives
   * in its own module ( review); the editor lends it its prompt, its
   * own publish, and what is open.
   */
  const translationPublishing = createTranslationPublishing({
    page: () => currentZPage?.free2zaddr,
    openLanguage: () => openLanguage,
    isDirty: () => isDirty,
    listSupported: () => pageJobs?.listSupported,
    readyLanguages: () => trayReviewableLanguages,
    label: (language) => languageLabel(language),
    list: (languages) => languageList(languages),
    t: () => $t,
    ask: (prompt) => askEditorPrompt(prompt),
    resumeAutosave: () => {
      if (isDirty) scheduleAutoSave();
    },
    publishOpen: (revision) => handlePublishNow(revision),
    markLocallyPublished: (identifier, language) => {
      if (currentZPage?.free2zaddr === identifier && variants)
        variants = variants.map((variant) =>
          variant.language === language
            ? { ...variant, is_published: true }
            : variant,
        );
    },
    refreshVariants: (identifier) => void refreshVariants(identifier),
  });
  const warningsOf = (language: string) =>
    translationPublishing.warningsOf(language);
  const rereadJobs = (identifier: string, waitMs?: number) =>
    translationPublishing.rereadJobs(identifier, waitMs);

  /**
   * A save whose text changed, so it would stop running jobs — including ones
   * another tab or device started, which this tab only sees by asking. The
   * ORIGINAL's body stops every job; a TRANSLATION's draft stops the job into
   * its own language (codex adversarial review: an edited Spanish draft
   * autosaved over a Spanish job bought on another device, unasked).
   */
  function saveMayStopUnseenJobs() {
    if (!currentZPage) return false;
    if (isCanonicalLanguage(selectedLanguage))
      return content !== persistedProse.content;
    return (
      content !== persistedProse.content ||
      title !== persistedProse.title ||
      description !== persistedProse.description
    );
  }

  async function publishReviewed({ confirm = false } = {}) {
    const operationNotice = captureAccountToast();
    const language = reviewLanguage;
    const identifier = currentZPage?.free2zaddr;
    if (
      !language ||
      !identifier ||
      translationPublishing.publishing.has(language)
    )
      return;
    // The `p` shortcut asks first. A warned draft is asked about (by name)
    // inside `handlePublishNow`; a clean one gets a plain confirmation here,
    // so no single key press ever publishes anything.
    if (confirm && !warningsOf(language).length) {
      const choice = await askEditorPrompt({
        title: $t("translationJobs.publishKeyTitle", "Publish {language}?", {
          language: languageLabel(language),
        }),
        body: $t(
          "translationJobs.publishKeyBody",
          "It goes live now, as it is on screen.",
        ),
        confirmLabel: $t("translationJobs.publishKeyConfirm", "Publish"),
        cancelLabel: $t("common.cancel", "Cancel"),
      });
      if (choice !== "confirm") {
        if (isDirty) scheduleAutoSave();
        return;
      }
      if (
        reviewLanguage !== language ||
        currentZPage?.free2zaddr !== identifier
      )
        return;
    }
    translationPublishing.setPublishing(language, true);
    let published = false;
    try {
      published = await handlePublishNow();
    } finally {
      translationPublishing.setPublishing(language, false);
    }
    if (!published || currentZPage?.free2zaddr !== identifier) return;
    translationPublishing.markPublished(identifier, language);
    const remaining = reviewQueue.filter((other) => other !== language);
    if (!remaining.length) {
      reviewLanguage = null;
      operationNotice.acknowledge(
        $t(
          "translationJobs.allReviewed",
          "Every ready translation is published.",
        ),
      );
      return;
    }
    const current = languageLabel(language);
    await startReview(
      remaining.find(
        (other) => languageLabel(other).localeCompare(current) > 0,
      ) ?? remaining[0],
    );
  }

  /** "Translate…": many languages where the deployment can, one where not. */
  function openTranslate(initial: string[] = []) {
    if (!currentZPage) return;
    if (parallelTranslations || readBulkIntent(currentZPage.free2zaddr)) {
      translateIntoPage = currentZPage.free2zaddr;
      bulkIntent = readBulkIntent(currentZPage.free2zaddr);
      translateIntoInitial = initial;
      translateIntoOpen = true;
      clearAutoSaveTimer();
      return;
    }
    if (initial.length === 1) void openTranslateWithAi(initial[0]);
    else languagePicker = "translate";
  }

  function closeTranslateInto() {
    translateIntoOpen = false;
    if (isDirty) scheduleAutoSave();
  }

  /** Languages the bulk picker offers: every one we sell but the source. */
  const translateIntoLanguages = $derived(
    translatableLanguages.filter(
      (language) =>
        language !== normalizeContentLanguage(currentZPage?.source_language),
    ),
  );
  /** Rows the bulk picker shows but will not tick, with the reason. */
  const translateIntoUnavailable = $derived.by(() => {
    const reasons = new Map<string, string>();
    for (const row of variantRows)
      if (row.status === "published" && !row.isSource)
        reasons.set(
          row.language,
          $t("editor.variantStatusPublished", "Published"),
        );
    for (const language of activeJobLanguages)
      reasons.set(
        language,
        $t("translationJobs.chipQueuedShort", "Translating"),
      );
    return reasons;
  });

  async function quoteBulk(languages: string[]): Promise<BulkQuote | null> {
    const identifier = translateIntoPage;
    if (!identifier || currentZPage?.free2zaddr !== identifier) return null;
    // Price the SAVED text, exactly as the single-language dialog does: a
    // quote over unsaved edits is a price for words the server has not seen.
    clearAutoSaveTimer();
    while (currentSavePromise) await currentSavePromise;
    if (isDirty && canRelabel) {
      const saved = await handleSave({
        successMessage: $t(
          "editor.translateAiSavedFirst",
          "Saved, so the price is for what you actually wrote.",
        ),
      });
      if (!saved || isDirty) {
        const message = $t(
          "editor.translateAiNeedsSave",
          "Save this article before buying a translation — the price is worked out from the saved text.",
        );
        throw new ApiError(message, 400, { error: message });
      }
    }
    const readOrder = beginAccountBalanceRead();
    const quote = await quoteTranslations(identifier, languages);
    // The article is part of the quote from here on: the purchase, its
    // automatic retry and any later replay all go to THIS article.
    return quote
      ? recordQuotedBalanceRead({ ...quote, page: identifier }, readOrder)
      : null;
  }

  /**
   * The bulk purchase whose outcome is unknown, per article, in storage.
   *
   * Written BEFORE the POST and removed only by an answer that settles it —
   * a 202, or a refusal that proves nothing was charged. Closing the dialog,
   * navigating, or reloading must not turn a lost answer into a fresh key and
   * a second charge (codex adversarial review of ).
   */
  function bulkIntentKey(identifier: string) {
    return bulkIntentStorageKey(translationReceiptKey(identifier));
  }

  function intentStorage(): Storage | null {
    if (!browser) return null;
    try {
      return localStorage;
    } catch {
      return null;
    }
  }

  function readBulkIntent(identifier: string | undefined) {
    if (!identifier) return null;
    return readBulkIntentFrom(intentStorage(), bulkIntentKey(identifier));
  }

  let bulkIntent = $state<BulkIntent | null>(null);

  function purchaseBulk(quote: BulkQuote, languages: string[], key: string) {
    const operationNotice = captureAccountToast();
    const actor = data.currentUser.username;
    const ownsPurchase = authStore.captureRequestOwnership();
    if (!ownerSignedIn)
      throw new Error(
        "Sign in as the article owner before buying translations.",
      );
    const receiptKey = (identifier: string) =>
      `translation-receipt:${actor}:${identifier}`;
    return purchaseBulkTranslations(
      {
        storage: intentStorage,
        receiptKey,
        isOwned: ownsPurchase,
        withLock: (identifier, fn) =>
          withTranslationIntentLock(identifier, fn, receiptKey(identifier)),
        isHere: (identifier) =>
          operationNotice.isCurrent() &&
          ownsPurchase() &&
          ownerSignedIn &&
          currentZPage?.free2zaddr === identifier,
        onIntentChanged: (identifier) => {
          bulkIntent = readBulkIntent(identifier);
        },
        t: () => $t,
        list: (languages) => languageList(languages),
      },
      quote,
      languages,
      key,
      translateIntoPage,
    );
  }

  async function reviewTranslationDraft() {
    const progress = visibleTranslationProgress;
    if (!progress) return;
    if (progress.language !== openLanguage)
      return requestLanguage(progress.language);
    // `isDirty` alone, for the reason spelled out in the delivery branch: an
    // empty composer can still be holding unsaved SHARED article settings, and
    // this path discards them.
    if (isDirty) {
      const choice = await askEditorPrompt({
        title: $t("editor.translationReviewDraft", "Review translated draft"),
        body: $t(
          // "changes", not "text": this fires on `isDirty`, which a tags-only
          // or cover-only edit sets just as much as typing does, and naming the
          // wrong thing is how a creator clicks the wrong button ( review).
          "editor.translateAiArrivedBody",
          "You have unsaved {language} changes in this editor. Open the translation and they are gone; keep them and they overwrite the translation the next time this version saves.",
          { language: languageLabel(progress.language) },
        ),
        confirmLabel: $t(
          "editor.translateAiArrivedLoad",
          "Load the translation",
        ),
        cancelLabel: $t("editor.translateAiArrivedKeep", "Keep my text"),
      });
      if (choice !== "confirm" || progress !== translationProgress) return;
    }
    await commitLanguageSwitch(progress.language, { discardUnsaved: true });
  }

  async function chooseDeliveredTranslation(
    identifier: string,
    language: string,
  ) {
    const operationNotice = captureAccountToast();
    if (currentZPage?.free2zaddr !== identifier || openLanguage !== language)
      return;
    const hydration = lastHydratedKey;
    const progress =
      translationProgress?.language === language ? translationProgress : null;
    // The review belongs to these unsaved fields, independently of whichever
    // purchase receipt arrived most recently (possibly for another language).
    translationReviewTarget = { page: identifier, language };
    const reviewOwner = translationReviewTarget;
    const stillOpen = () =>
      !destroyed &&
      currentZPage?.free2zaddr === identifier &&
      openLanguage === language &&
      lastHydratedKey === hydration &&
      translationReviewTarget === reviewOwner;
    translationReviewNeeded = true;
    clearAutoSaveTimer();
    try {
      // The body and ETag must come from ONE read before the choice. Installing
      // an ETag read after consent could silently authorize a later writer.
      const resourceUrl = variantResourceUrl(identifier, language);
      const response = await apiFetch(`${resourceUrl}?mine=true`);
      const snapshot = await response.json();
      const etag = response.headers.get("ETag");
      if (!stillOpen()) return;
      if (
        !response.ok ||
        !etag ||
        !/^"[^"]+"$/.test(etag) ||
        snapshot.free2zaddr !== identifier ||
        snapshot.actual_language !== language ||
        snapshot.source_language !== currentZPage?.source_language ||
        typeof snapshot.variant_is_published !== "boolean"
      )
        throw new Error("Cannot reconcile translated revision");
      if (progress) progress.interrupted = false;
      const published = snapshot.variant_is_published;
      // Variant PUT also writes shared article settings. Consent to keep text
      // must not authorize stale payout/visibility/cover metadata over changes
      // that happened before this read. Those changes still require review.
      const previous = hydrateEditorState(currentZPage);
      const latest = hydrateEditorState(snapshot);
      const sharedKeys = [
        "canonicalUrl",
        "coverImageId",
        "zcashAddress",
        "vanity",
        "isSubscriberOnly",
        "publishAt",
      ] as const;
      const sharedChanged =
        sharedKeys.some((key) => previous[key] !== latest[key]) ||
        JSON.stringify([...previous.tags].sort()) !==
          JSON.stringify([...latest.tags].sort());
      const choice = await askEditorPrompt({
        title: $t("editor.translationReviewDraft", "Review translated draft"),
        body: sharedChanged
          ? $t(
              "editor.translationSettingsChanged",
              "Shared article settings changed elsewhere. Load the saved version, or keep your edits here with saving paused to protect those settings.",
            )
          : published
            ? $t(
                "editor.translationPublishedDuringReview",
                "This translation was published elsewhere. Load the published version, or keep your edits here with saving paused to protect it.",
              )
            : // Both outcomes, concretely, in the order the buttons are in.
              // The old wording named a "saved draft" and a "revision" and
              // left the creator to work out which button lost which text.
              $t(
                "editor.translationKeepRevision",
                "A {language} draft is saved on the server: “{title}”. Open it and your unsaved changes here are gone. Keep them and they overwrite that draft the next time this version saves.",
                {
                  language: languageLabel(language),
                  title: snapshot.title || UNTITLED_DRAFT_TITLE,
                },
              ),
        confirmLabel: $t(
          "editor.translateAiArrivedLoad",
          "Load the translation",
        ),
        cancelLabel: $t("editor.translateAiArrivedKeep", "Keep my text"),
        cancelChoice: "keep",
      });
      if (!stillOpen()) return;
      if (choice === "confirm") {
        await commitLanguageSwitch(language, { discardUnsaved: true });
      } else if (choice === "keep" && !published && !sharedChanged) {
        // Explicit consent applies to exactly the snapshot shown above. A
        // concurrent save after that read still fails with 412; never drop
        // If-Match just because the creator chose to keep their text.
        etags.set(variantResourceUrl(identifier, language), etag);
        // The variant exists and the creator chose to replace it, so this is
        // no longer a create. Left set, a later validator drop (a tag
        // accept clears the registry) would turn the next save into
        // `If-None-Match: *` against the draft they just consented to replace.
        isNewTranslationDraft = false;
        // Consent replaces a saved DRAFT. A stale published editor must not
        // silently republish text after another tab deliberately unpublished it.
        isPublished = false;
        saveConflicted = false;
        saveBlockReason = null;
        saveError = null;
        translationReviewNeeded = false;
        translationReviewTarget = null;
        if (isDirty) scheduleAutoSave();
      }
    } catch {
      if (!stillOpen()) return;
      if (progress) progress.interrupted = true;
      operationNotice.error(
        $t(
          "editor.translationReviewRetry",
          "Your edits are still here. Read the saved draft again before continuing to save.",
        ),
      );
    }
  }

  async function reconnectTranslation() {
    const progress = translationProgress;
    if (
      !progress ||
      progress.checking ||
      progress.page !== currentZPage?.free2zaddr
    )
      return;
    progress.checking = true;
    isTranslating = true;
    try {
      await watchTranslationJob(
        progress.page,
        progress.language,
        languageLabel(progress.language),
        progress.job,
      );
    } finally {
      if (progress === translationProgress) {
        progress.checking = false;
        isTranslating = false;
        if (isDirty) scheduleAutoSave();
      }
    }
  }

  /**
   * Poll until the purchase settles, then say which way it went.
   *
   * "Settled" is always one of two things, never neither: a draft exists, or
   * every 2Z is back. The server guarantees that (the reaper refunds a job
   * that never ran), so this loop never has to reason about a third outcome —
   * it only has to stop watching politely if the article is long.
   */
  async function watchTranslationJob(
    identifier: string,
    language: string,
    label: string,
    initial: TranslationJob,
  ) {
    // The jobs store follows every job; this watcher takes this one over
    // while the editor is the better narrator (the open variant, unsaved
    // edits), and hands it back when it stops — on navigation, on a newer
    // purchase, at its deadline — so the job is never left unwatched.
    translationJobs.ingest(
      identifier,
      initial as unknown as ServerTranslationJob,
    );
    translationJobs.claim(identifier, language);
    try {
      await followTranslationJob(identifier, language, label, initial);
    } finally {
      translationJobs.release(identifier, language);
    }
  }

  async function followTranslationJob(
    identifier: string,
    language: string,
    label: string,
    initial: TranslationJob,
  ) {
    const operationNotice = captureAccountToast();
    const deadline = Date.now() + TRANSLATION_POLL_TIMEOUT_MS;
    let job = initial;
    const monitorId = ++translationMonitorId;
    const progress = translationProgress;

    try {
      while (translationJobState(job) === "queued" && Date.now() < deadline) {
        await new Promise((resolve) =>
          setTimeout(resolve, TRANSLATION_POLL_INTERVAL_MS),
        );
        // Leaving the editor stops the watching, not the translation: the job
        // and its money settle server-side either way, and the draft is waiting
        // in the panel next time.
        if (
          !operationNotice.isCurrent() ||
          destroyed ||
          monitorId !== translationMonitorId ||
          currentZPage?.free2zaddr !== identifier
        )
          return;
        try {
          // Bounded: a stalled read must not hold this job's claim (and the
          // store's poller off it) forever (codex adversarial review).
          const latest = await zpageTranslationStatus(identifier, language, {
            timeoutMs: 20_000,
          });
          if (
            !operationNotice.isCurrent() ||
            destroyed ||
            monitorId !== translationMonitorId ||
            currentZPage?.free2zaddr !== identifier
          )
            return;
          // The API returns the latest receipt, not the receipt requested. Never
          // announce a different purchase as this one's outcome.
          if (
            latest.language !== language ||
            latest.zpage_id !== initial.zpage_id ||
            !latest.job_id
          ) {
            if (progress) {
              progress.interrupted = true;
              progress.checking = false;
            }
            return;
          }
          if (latest.job_id !== job.job_id && progress) {
            // A later accepted purchase supersedes this receipt, not an
            // ambiguous POST. Follow it explicitly without claiming J1 settled
            // or auto-loading a historical result over the editor.
            progress.superseded = true;
          }
          job = latest;
          translationJobs.ingest(
            identifier,
            latest as unknown as ServerTranslationJob,
          );
          if (progress) {
            progress.job = job;
            progress.interrupted = false;
          }
          // Complete the owned index write before reporting settled controls.
          // Otherwise an immediate reload can restore the previous queued job.
          if (progress) await recordTranslationReceipt(progress);
          if (
            !operationNotice.isCurrent() ||
            destroyed ||
            monitorId !== translationMonitorId ||
            progress !== translationProgress ||
            currentZPage?.free2zaddr !== identifier
          )
            return;
        } catch {
          if (
            !operationNotice.isCurrent() ||
            destroyed ||
            monitorId !== translationMonitorId ||
            currentZPage?.free2zaddr !== identifier
          )
            return;
          if (progress) progress.interrupted = true;
          // Keep polling. A lost connection is not a failed translation, and
          // must not re-enable another purchase of work already in progress.
        }
      }
      if (progress) progress.checking = false;

      const state = translationJobState(job);

      // EVERY branch below writes shared editor state — `variants`,
      // `availableLanguages`, and in one case the route itself. This component
      // survives navigation between two `/edit` URLs, so a job started on
      // article A can settle while article B is on screen: `destroyed` is false,
      // and A's refresh would install A's variants into B's panel and could
      // navigate B on A's result. The job and its money are unaffected — the
      // draft is waiting on A — so there is simply nothing to say here.
      // (codex adversarial review.)
      if (currentZPage?.free2zaddr !== identifier) return;

      if (progress?.superseded && state === "delivered") {
        void refreshVariants(identifier);
        if (language === openLanguage)
          await chooseDeliveredTranslation(identifier, language);
        else announceTranslationReady(identifier, language, operationNotice);
        return;
      }
      if (state === "delivered") {
        void refreshVariants(identifier);
        if (!availableLanguages.includes(language)) {
          availableLanguages = [...availableLanguages, language];
        }

        // THE DELIVERED VARIANT MAY BE THE ONE ON SCREEN.
        //
        // Buying a translation for the language you are looking at is the most
        // natural flow there is — you open the empty Spanish draft and decide to
        // have it written. But the composer still holds the text it loaded, and
        // the editor considers that text saved. The very next keystroke
        // autosaves the whole stale document over the translation that was just
        // paid for, flipping its origin to `human` and destroying it with no
        // failure to refund. Refreshing the variants LIST does not touch the
        // document, so it does not help. (codex adversarial review.)
        if (language === openLanguage) {
          // `!isDirty` ALONE, and deliberately not "or the prose fields are
          // empty" (codex adversarial review of this PR).
          //
          // An earlier draft of this fix also took this branch whenever the
          // composer held no prose, as belt-and-braces against the dirty flag
          // being wrong again. That authorizes a silent discard of things a blank
          // variant genuinely can hold: a variant PUT writes the article's SHARED
          // settings too — payout address, tags, canonical URL, subscriber-only —
          // the publish sheet stays reachable while a translation runs, and
          // autosave is suspended for the duration, so those edits are local and
          // unsaved when delivery lands. `commitLanguageSwitch(discardUnsaved)`
          // would have reverted a corrected payout address without asking.
          // `chooseDeliveredTranslation`'s own `sharedKeys` check exists for
          // exactly that class of change; routing around it here would have
          // undone it.
          //
          // Fixing a false dirty signal is not a licence to ignore a true one.
          // The false one is fixed at its source (`metadataResetKey`), and
          // "a freshly loaded article is not reported as having unsaved changes"
          // is the spec that keeps it fixed.
          if (!isDirty) {
            // Nothing of the creator's to lose: load what they bought.
            if (
              await commitLanguageSwitch(language, { discardUnsaved: true })
            ) {
              operationNotice.success(
                $t(
                  "editor.translateAiDeliveredHere",
                  "The {language} translation is ready, and it is what you are looking at now. Read it over before publishing.",
                  { language: label },
                ),
              );
            }
            return;
          }

          await chooseDeliveredTranslation(identifier, language);
          return;
        }

        // THE DELIVERED VARIANT IS ANOTHER LANGUAGE.
        //
        // This used to switch the editor to the delivery by itself, or stop the
        // creator with a load-or-keep prompt. With several languages landing
        // minutes apart while the creator keeps writing, either one yanks them
        // out of what they are doing. A delivery is news, not a navigation: a
        // toast with a Review action, and its row in the tray. Staying put is
        // safe — the open version's saves still go to the open version.
        announceTranslationReady(identifier, language, operationNotice);
        return;
      }

      if (state === "refunded") {
        operationNotice.error(
          $t(
            "editor.translateAiRefunded",
            "The {language} translation could not be completed, so all {price} 2Z were credited back to your balance.",
            { language: label, price: job.price },
          ),
        );
        return;
      }

      // `settled`: the article moved under a job that had already
      // been paid for, and the translation had already been generated and billed
      // to us by then. Part of the charge covers that work. Say the numbers --
      // "all your 2Z came back" would be false, and a creator who cannot see
      // which part was kept cannot tell a settlement from a bug.
      if (state === "settled") {
        operationNotice.error(
          $t(
            "editor.translateAiSettled",
            "The {language} translation could not be delivered because the article or its translation changed while it was running. {refunded} of {price} 2Z are back in your balance; {billed} 2Z cover the work already done.",
            {
              language: label,
              price: job.price,
              refunded: job.refunded,
              billed: job.billed ?? "0",
            },
          ),
        );
        return;
      }

      // Still queued at the deadline, or a status we do not recognize. Say
      // nothing about the money — it is settled or will be, and guessing is how
      // a creator ends up believing a false thing about their balance. Refresh
      // anyway: it may have landed on the boundary, and a stale panel is what
      // makes buying the same language twice look like a reasonable thing to do.
      void refreshVariants(identifier);
      operationNotice.info(
        $t(
          // The comment above says not to guess about the money, and this line
          // was guessing. Its old wording promised an unqualified refund, which
          // is now true of every failure except one — and the one it is not true
          // of is reachable from exactly this state: the poll timed out while the
          // job is still generating, and the creator's next move might be to edit
          // the article. Say what is certain and name the exception. (codex
          // adversarial review, round 5.)
          "editor.translateAiStillRunning",
          "The {language} translation is taking a while. It will appear in the Translations panel when it is done. If it fails your 2Z come back — unless you keep changing or publishing this article or its translation while it runs, which is charged for the work already done.",
          { language: label },
        ),
      );
    } finally {
      // Session invalidation stops this watcher, but must leave its receipt
      // resumable. A newer monitor owns any shared progress it took over.
      if (progress && monitorId === translationMonitorId)
        progress.checking = false;
    }
  }

  // `::embed[]` of a zPage / converse thread in the preview: resolved
  // as the AUTHOR (their own browser, their own cookie), only while the
  // preview is on screen, debounced so typing does not hammer the API, and
  // cached per API path + language for this editor session. A card for the
  // author's own draft is theirs to see — and lives only in this in-memory
  // store: the editor saves markdown, never rendered HTML, and every other
  // reader resolves that markdown as themselves.
  const previewCards = createFirstPartyPreviewResolver();
  onDestroy(() => previewCards.destroy());
  $effect(() => {
    if (mode === "preview" || mode === "split") {
      previewCards.request(content, "editor", $previewCards.generation);
    }
  });
  const renderedHtml = $derived(
    renderMarkdown(content, $t, { firstPartyCards: $previewCards.cards }),
  );

  const canFlushSave = $derived(
    Boolean(content.trim() && (title.trim() || !isPublished)),
  );

  async function navigateWithoutUnsavedGuard(destination: string) {
    bypassNextNavigationGuard = true;

    try {
      await goto(destination);
    } finally {
      // Usually the editor is destroyed by a successful navigation. Reset
      // this if navigation is rejected so later attempts remain protected.
      bypassNextNavigationGuard = false;
    }
  }

  beforeNavigate((navigation) => {
    if (bypassNextNavigationGuard) {
      return;
    }

    if (navigation.type === "leave") {
      // Tab close / hard reload: cancel() triggers the native
      // "leave site?" confirmation.
      if (isDirty || isSaving) {
        navigation.cancel();
      }
      return;
    }

    clearAutoSaveTimer();

    if (!isDirty) {
      return;
    }

    // With a save/discard/cancel decision pending, flushing would persist the
    // edits the creator may be about to discard. Fall through to the explicit
    // "leave anyway?" confirm instead, which is not a dead end either.
    if (!isSaving && canFlushSave && !editorPrompt && navigation.to?.url) {
      navigation.cancel();

      if (pendingNavigationFlush) {
        return;
      }

      const destination = navigation.to.url.href;
      // The flush belongs to the document on screen now. A second New post
      // the creator confirms while it is unresolved hydrates another document
      // in this same mounted editor; this flush must then neither ask about
      // that document's edits nor navigate it to a stale destination.
      const flushGeneration = hydrationGeneration;
      pendingNavigationFlush = true;

      void (async () => {
        const saved = await autoSaveAfterRereadingJobs();

        if (destroyed || !saveDocumentIsCurrent(flushGeneration)) {
          return;
        }
        pendingNavigationFlush = false;

        if (saved && !isDirty) {
          await navigateWithoutUnsavedGuard(destination);
          return;
        }

        // Refused only because saving would stop running translations
        //. "Leave anyway?" used to throw these edits away without
        // saying why they could not be kept; name the trade instead.
        const stopped = translationsStoppedBySave();
        if (
          stopped.length &&
          unresolvedTranslationLanguage === null &&
          !translationReviewNeeded
        ) {
          const choice = await askEditorPrompt({
            title: $t(
              "translationJobs.leaveTitle",
              "Your changes are not saved yet",
            ),
            body: $t(
              "translationJobs.leaveBody",
              "Saving them now stops {languages}, which are still translating. Save and stop them, or leave and lose these changes.",
              { languages: languageList(stopped) },
            ),
            confirmLabel: $t(
              "translationJobs.stopConfirm",
              "Save and stop them",
            ),
            discardLabel: $t(
              "translationJobs.leaveDiscard",
              "Leave without saving",
            ),
            cancelLabel: $t("translationJobs.stopCancel", "Keep editing"),
            danger: true,
          });
          if (destroyed || !saveDocumentIsCurrent(flushGeneration)) return;
          if (choice === "cancel") {
            if (isDirty) scheduleAutoSave();
            return;
          }
          if (
            choice === "discard" ||
            ((await handleSave({ stopsTranslations: true })) && !isDirty)
          )
            await navigateWithoutUnsavedGuard(destination);
          return;
        }

        const confirmed = confirm(
          $t("editor.unsavedLeave", "You have unsaved changes. Leave anyway?"),
        );

        if (confirmed) {
          await navigateWithoutUnsavedGuard(destination);
        } else if (isDirty) {
          scheduleAutoSave();
        }
      })();
      return;
    }

    const confirmed = confirm(
      $t("editor.unsavedLeave", "You have unsaved changes. Leave anyway?"),
    );

    if (!confirmed) {
      navigation.cancel();
    }
  });

  function focusOnMount(node: HTMLElement) {
    node.focus();
  }

  onDestroy(() => {
    destroyed = true;
    for (const id of editorActionToastIds) toast.dismiss(id);
    editorActionToastIds.clear();
    translationJobs.setEditorPage(null);
    if (translationProgress)
      translationJobs.release(
        translationProgress.page,
        translationProgress.language,
      );
    clearAutoSaveTimer();
    // Never leave a caller awaiting a prompt that no longer has a DOM.
    settleEditorPrompt("cancel");
  });

  /**
   * "The metadata sheet is looking at a different document now — re-baseline."
   *
   * `hydrationGeneration` is in here because of, and it is load-bearing.
   * `PublishSheet` turns a change in the TAG LIST into one dirty signal, and it
   * decides "changed" by comparing against the signature it last saw for this
   * key. Its first pass runs while `tags` is still the pre-hydration `[]`, so
   * it recorded an empty baseline; `applyHydratedState` then installed the
   * article's real tags, the key had not moved, and the sheet reported a tag
   * change the creator never made. `markDirty()` on mount.
   *
   * The damage was not cosmetic. Every article with at least one tag opened
   * "dirty": the header said "Unsaved changes" over an untouched document, an
   * autosave fired immediately, a blank variant draft failed that save with
   * `content-required`, going back to the source demanded a save/discard
   * decision for edits nobody had made — and, the reported bug, a delivered AI
   * translation for the open language took the "the creator has work to
   * protect" branch and parked behind a conflict prompt instead of loading.
   *
   * A hydration means the composer is now showing state read fresh from the
   * server, which is exactly the moment every baseline in the sheet has to be
   * retaken. Anything the creator does afterwards still fires normally.
   */
  const metadataResetKey = $derived(
    `${currentZPage?.free2zaddr ?? getRouteData().requestedId}#${hydrationGeneration}`,
  );

  const viewHref = $derived.by(() => {
    if (!currentZPage) return null;
    const canonicalPath = zpageCanonicalPath({
      ...currentZPage,
      creator: { username: getRouteData().currentUser.username },
    });
    if (!canonicalPath || isCanonicalLanguage(selectedLanguage)) {
      return canonicalPath;
    }
    return articleVariantHref(canonicalPath, selectedLanguage);
  });
</script>

<svelte:head>
  <title>{$t("editor.title", "Write Article")} - Free2Z</title>
</svelte:head>

<div class="flex min-h-[calc(100vh-4rem)] w-full flex-col bg-background">
  <EditorTopbar
    currentUser={getRouteData().currentUser}
    {canSchedule}
    bind:mode
    {isSaving}
    {saveError}
    {lastSavedAt}
    {isDirty}
    {isPublished}
    {title}
    {content}
    handleSave={handleManualSave}
    bind:description
    bind:canonicalUrl
    bind:vanity
    bind:tags
    free2zaddr={currentZPage?.free2zaddr ?? ""}
    onTagSuggestionWrite={() => invalidateEtags(currentZPage?.free2zaddr)}
    bind:zcashAddress
    bind:isSubscriberOnly
    bind:publishAt
    {validationErrors}
    resetKey={metadataResetKey}
    {viewHref}
    onMetadataChange={handleMetadataChange}
    onVanityChange={recordVanityEdit}
    onCanonicalUrlChange={handleCanonicalUrlChange}
    onCanonicalUrlBlur={handleCanonicalUrlBlur}
    onPublish={handlePublish}
    onPublishNow={handlePublishNow}
    hidePublish={Boolean(reviewLanguage)}
    onCancelSchedule={handleCancelSchedule}
    onUnpublish={handleUnpublish}
    onDelete={deletePage}
    isDeleting={isDeletingPage}
  />

  <div class="flex flex-col gap-2 border-b border-border/60 px-4 py-2 text-sm">
    <div class="flex min-h-9 flex-wrap items-center justify-between gap-2">
      <!--
        The chip replaces the "Article language" `<select>` ( Part 7). It
        is a label, not a control that creates anything: pressing "change"
        renames the article, and nothing it can do blanks the editor.

        min-h-9 reserves the row at its worst-case height: at narrow
        viewports the localized chip ("Idioma: inglés · cambiar", plus a
        disabled-reason hint when one applies) can wrap to two text-xs lines
        (2 × 16px + 4px row gap = 36px). Without the reservation the row is
        one line tall in English and two elsewhere, so a chip re-render moves
        the writing surface underneath it — exactly what  forbids. The
        chip's own states never exceed two lines at the narrowest supported
        width.

        The Series trigger ("· Series: None") shares the left cluster as one
        nowrap item. Below `sm` it always takes its own line, so the row is
        two lines whether series are loading, absent, or long-named; at `sm`
        and up it sits inline and, if a long name wraps it, still fits the
        same two-line reservation. Its popover and dialog float — nothing
        they do changes this row's height. The cluster is `flex-1` (basis 0)
        so its content never pushes Translations onto a line of its own.
      -->
      <div class="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
        <LanguageChip
          editingLanguage={openLanguage}
          language={chip.language}
          viewerLocale={$locale}
          lowConfidence={chip.lowConfidence}
          disabledReason={canRelabel
            ? undefined
            : $t(
                "editor.languageChangeNeedsSource",
                "Open the original to change this article's language.",
              )}
          disabled={!canRelabel ||
            isSaving ||
            isRelabelling ||
            isDeletingTranslation ||
            isDeletingPage ||
            isSwitchingLanguage}
          onchange={() => (languagePicker = "relabel")}
        />

        {#key currentZPage?.free2zaddr ?? getRouteData().requestedId}
          <!-- Series belongs to the page, shared by all of its language versions. -->
          <SeriesEditor
            page={{ free2zaddr: currentZPage?.free2zaddr ?? "", title }}
          />
        {/key}
      </div>

      <div class="flex shrink-0 items-center gap-2">
        <!-- ONE entry point for translations where the jobs list exists
             ( review): the indicator, always there, opens the tray that
             holds everything the old panel did. Elsewhere it only appears
             with news, beside the old panel's toggle. -->
        <TranslationJobsIndicator
          summary={parallelTranslations ? traySummary : jobSummaryForIndicator}
          always={parallelTranslations && Boolean(currentZPage)}
          onopen={openTray}
        />
        {#if !parallelTranslations && bulkIntent && currentZPage}
          <button
            type="button"
            onclick={() => openTranslate()}
            class="hidden rounded-md border border-primary/60 px-2 py-1 text-xs text-foreground hover:bg-primary/10 sm:inline-flex"
            data-testid="editor-translate-many"
          >
            {$t("translationJobs.translateMany", "Translate…")}
          </button>
        {/if}
        {#if !parallelTranslations}
          <button
            type="button"
            onclick={() => {
              showTranslations = !showTranslations;
              if (showTranslations && !translationProgress && currentZPage)
                void restoreTranslationProgress(currentZPage.free2zaddr);
            }}
            aria-expanded={showTranslations}
            aria-controls="editor-translations-region"
            class="shrink-0 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
          >
            {$t("editor.translationsToggle", "Translations ({count})", {
              count: variantRows.length,
            })}
          </button>
        {/if}
      </div>
    </div>

    {#if bulkIntent && currentZPage && !translateIntoOpen}
      <!-- Visible whatever the jobs list said, or failed to say: an unresolved
           purchase is holding saves, and this is the way out of that. -->
      <div
        role="status"
        class="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs"
        data-testid="bulk-purchase-unresolved"
      >
        <span>
          {$t(
            "translationJobs.unresolvedBulk",
            "A translation purchase was not confirmed. Re-send it to find out — this never charges twice.",
          )}
        </span>
        <button
          type="button"
          class="inline-flex min-h-10 items-center rounded-md border border-border bg-background px-3 hover:bg-muted"
          onclick={() => openTranslate()}
        >
          {$t("translationJobs.resend", "Re-send purchase")}
        </button>
      </div>
    {/if}

    {#if createNeeds2z && !currentZPage}
      <!--. Links open a new tab: this draft is not saved anywhere yet,
           and following a link in this tab would leave it behind. -->
      <div
        role="alert"
        class="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
        data-testid="editor-second-page-needs-2z"
      >
        <p class="font-medium text-foreground">
          {$t(
            "editor.secondPageNeeds2z",
            "Your first zPage is free. To start another one you need at least {required} 2Z, and you have {balance} 2Z. This draft is not saved yet: keep this tab open, or copy your text, then save again once you have 2Z.",
            {
              required: formatDecimalText(createNeeds2z.cost, $locale),
              balance: formatDecimalText(createNeeds2z.balance, $locale),
            },
          )}
        </p>
        <p class="text-muted-foreground">
          {$t(
            "insufficientFunds.giftWaiting",
            "Your zPage is your introduction. Members can gift 2Z to writers they want to read more from.",
          )}
        </p>
        <div class="flex flex-wrap gap-x-4 gap-y-1">
          <a
            href={`/${encodeURIComponent(getRouteData().currentUser.username)}/dashboard/pages`}
            target="_blank"
            rel="noopener"
            class="font-medium text-primary underline-offset-2 hover:underline"
            data-testid="editor-second-page-your-pages"
          >
            {$t("insufficientFunds.yourPages", "Your zPages")}
          </a>
          <a
            href="/buy-2z"
            target="_blank"
            rel="noopener"
            class="font-medium text-primary underline-offset-2 hover:underline"
            data-testid="editor-second-page-buy"
          >
            {$t("insufficientFunds.buy", "Buy 2Z")}
          </a>
        </div>
      </div>
    {/if}

    {#if reviewLanguage}
      <TranslationReviewBar
        language={languageLabel(reviewLanguage)}
        position={Math.max(1, reviewQueue.indexOf(reviewLanguage) + 1)}
        count={reviewQueue.length}
        warnings={pageJobs?.drafts?.[reviewLanguage]?.warnings ??
          pageJobs?.jobs[reviewLanguage]?.warnings ??
          []}
        priorWarnings={pageJobs?.drafts?.[reviewLanguage]?.priorWarnings ?? []}
        {content}
        phase={publishPhase ??
          (translationPublishing.publishing.has(reviewLanguage)
            ? "checking"
            : null)}
        published={!reviewQueue.includes(reviewLanguage) && isPublished}
        onPrev={() => reviewStep(-1)}
        onNext={() => reviewStep(1)}
        onPublish={(options) => void publishReviewed(options)}
        onDone={() => {
          if (!reviewBusy()) reviewLanguage = null;
        }}
      />
    {/if}

    {#if showTranslations || parallelTranslations}
      <!--
        ONE status region, with an order.

        These three used to be three independent `{#if}`s, so a single purchase
        could render "Translation in progress", "Translation ready as a draft"
        and "Saving is paused until you review the saved translation" on screen
        at the same time, over a blank editor. Contradictory states have to be
        unrepresentable, not merely unlikely, so the branches are chained: an
        unresolved purchase outranks a pending review, and a pending review
        outranks the job's own status FOR THE SAME LANGUAGE.

        For the same language only, deliberately. A French job running while a
        Spanish review waits is two facts about two variants, not a
        contradiction, and hiding the live job would be hiding a job.
      -->
      <div
        id="editor-translations-region"
        class="space-y-2 [&:not(:has(*))]:hidden"
      >
        {#if unresolvedTranslationLanguage !== null && !isBuyingTranslation && !isTranslating}
          <div
            role="status"
            data-testid="translation-unresolved"
            class="rounded-md border border-border p-3 text-sm"
          >
            <p>
              {$t(
                "editor.translationUnresolved",
                "Saving is paused while a translation purchase is unresolved. Recover the purchase to continue.",
              )}
            </p>
            <button
              type="button"
              class="mt-2 rounded-md border border-border px-3 py-1"
              onclick={() =>
                void openTranslateWithAi(unresolvedTranslationLanguage!)}
              >{$t(
                "editor.translationRecoverPurchase",
                "Recover translation purchase",
              )}</button
            >
          </div>
        {/if}
        {#if translationReviewNeeded && translationReviewTarget}
          <div
            role="status"
            data-testid="translation-review-status"
            class="rounded-md border border-border p-3 text-sm"
          >
            <p>
              {$t(
                "editor.translationReviewPaused",
                "Your edits are still here. Saving is paused until you choose between them and the translation that was saved.",
              )}
            </p>
            <button
              type="button"
              class="mt-2 rounded-md border border-border px-3 py-1"
              onclick={() => {
                const target = translationReviewTarget;
                if (target)
                  void chooseDeliveredTranslation(target.page, target.language);
              }}
              >{$t(
                "editor.translationReviewSavedLanguage",
                "Review saved {language} draft",
                { language: languageLabel(translationReviewTarget.language) },
              )}</button
            >
          </div>
        {/if}
        {#if visibleTranslationProgress && !reviewSupersedesJobStatus}
          <div
            role="status"
            data-testid="translation-job-status"
            class="rounded-md border border-border p-3 text-sm"
          >
            {#if visibleTranslationProgress.superseded}<p>
                {$t(
                  "editor.translationNewerReceipt",
                  "A newer translation purchase was found. Showing its current status; your editor text has been kept.",
                )}
              </p>{/if}
            <p>
              {#if visibleTranslationProgress.interrupted}
                {$t(
                  "editor.translationConnection",
                  "Lost the connection while checking the {language} translation. The purchase is recorded — checking again never buys it twice.",
                  {
                    language: languageLabel(
                      visibleTranslationProgress.language,
                    ),
                  },
                )}
              {:else if visibleTranslationProgress.job.status === "delivered"}
                {$t(
                  "editor.translationReady",
                  "The {language} translation is ready as a draft. Read it over before publishing.",
                  {
                    language: languageLabel(
                      visibleTranslationProgress.language,
                    ),
                  },
                )}
              {:else if visibleTranslationProgress.job.status === "refunded"}
                {$t(
                  "editor.translationRefunded",
                  "The {language} translation failed. All {price} 2Z are back in your balance.",
                  {
                    language: languageLabel(
                      visibleTranslationProgress.language,
                    ),
                    price: visibleTranslationProgress.job.price,
                  },
                )}
              {:else if visibleTranslationProgress.job.status === "settled"}
                {$t(
                  "editor.translationSettled",
                  "The {language} translation was not delivered — the article or its translation changed while it was running. {refunded} of {price} 2Z are back; {billed} 2Z cover work already done.",
                  {
                    language: languageLabel(
                      visibleTranslationProgress.language,
                    ),
                    price: visibleTranslationProgress.job.price,
                    refunded: visibleTranslationProgress.job.refunded,
                    billed: visibleTranslationProgress.job.billed ?? "0",
                  },
                )}
              {:else}
                <!--
                  State, not mechanism. This used to read "Changing the original
                  or saving changes to the target can cancel it and refund your
                  credits." — a rule about a footgun, told to someone who is
                  waiting and cannot act on it. The purchase toast says that
                  once, at the moment it is actionable.
                -->
                {$t(
                  "editor.translationProgress",
                  "Translating into {language}…",
                  {
                    language: languageLabel(
                      visibleTranslationProgress.language,
                    ),
                  },
                )}
              {/if}
            </p>
            {#if visibleTranslationProgress.job.status === "delivered" && visibleTranslationProgress.superseded}
              <button
                type="button"
                class="mt-2 rounded-md border border-border px-3 py-1"
                onclick={() => void reviewTranslationDraft()}
                >{$t(
                  "editor.translationReviewDraft",
                  "Review translated draft",
                )}</button
              >
            {/if}
            {#if translationPending && !visibleTranslationProgress.checking}
              <button
                type="button"
                class="mt-2 rounded-md border border-border px-3 py-1"
                onclick={() => void reconnectTranslation()}
                >{$t(
                  "editor.translationReconnect",
                  "Check translation status",
                )}</button
              >
            {/if}
          </div>
        {/if}
        {#if !parallelTranslations}
          <TranslationsPanel
            rows={variantRows}
            selectedLanguage={openLanguage}
            viewerLocale={$locale}
            busy={isSaving ||
              isRelabelling ||
              isDeletingTranslation ||
              isDeletingPage ||
              isSwitchingLanguage}
            translationBusy={isBuyingTranslation ||
              ((isTranslating || translationPending) && !parallelTranslations)}
            activeLanguages={activeJobLanguages}
            onTranslateMany={parallelTranslations && currentZPage
              ? () => openTranslate()
              : undefined}
            canAddTranslation={Boolean(currentZPage) &&
              addableLanguages.length > 0}
            onOpen={(language) => void requestLanguage(language)}
            onWrite={(language) => void requestLanguage(language)}
            onDelete={(language) => void deleteTranslation(language)}
            onAddTranslation={() => (languagePicker = "add")}
            onTranslateWithAi={currentZPage
              ? (language) => void openTranslateWithAi(language)
              : undefined}
          />
        {/if}
      </div>
    {/if}

    <!--
      "Waiting for you to write it" is false the moment an AI translation for
      this language is on its way, and it was one of the four notices arguing
      with each other over a blank editor in. `isNewTranslationDraft`
      itself is cleared by the delivery (the hydration of the delivered variant
      clears it, and so does the first save); this only suppresses the
      invitation for the minutes in between.
    -->
    {#if isNewTranslationDraft && !translationClaimsOpenVariant}
      <p role="status" class="text-right text-xs text-muted-foreground">
        {$t(
          "editor.newTranslationNotice",
          "This is a blank {language} version, waiting for you to write it. Your original {source} article has not changed — open it from the Translations panel to go back to it.",
          {
            language: languageLabel(selectedLanguage),
            source: languageLabel(currentZPage?.source_language),
          },
        )}
      </p>
    {/if}

    <!--
      Autosave can learn that a new page is empty after this header has
      rendered. Keep the status row mounted so changing from the neutral
      waiting copy to a genuine blocker never moves the writing surface.
    -->
    <!-- While reviewing, an empty status row collapses: the review bar sits
         right above the side-by-side, not 55px of nothing away from it (
         verification). The layout already moved when the bar appeared. -->
    <div
      class={reviewLanguage
        ? "text-right text-xs empty:hidden"
        : "min-h-8 text-right text-xs"}
      data-testid="editor-save-status-row"
    >
      {#if translationClaimsOpenVariant && !saveError && (saveBlockReason === null || saveBlockReason === "content-required")}
        <!--
          "Not saved yet — Add body content before saving this version" is true
          of the composer and false of the article, and it was the reddest of
          's four notices: red, over a blank editor, next to a paid
          translation sitting on the server. The status region above owns this
          variant's state while the job runs.

          Narrowly: only the empty-body complaint and the neutral waiting line.
          A real failure — an expired session, a 412, an unreachable server —
          still says so. Blanking this row wholesale would hide the one class of
          message a creator has to act on, for the several minutes a translation
          takes.
        -->
      {:else if showEmptyDraftSaveState}
        <p role="status" class="text-muted-foreground">
          {$t(
            "editor.saveWaitingForContent",
            "We'll save this page when you add something to the body.",
          )}
        </p>
      {:else if saveBlockNotice}
        <p class="text-destructive" role="status">
          {$t("editor.saveBlockedNotice", "Not saved yet — {reason}", {
            reason: saveBlockNotice,
          })}
        </p>
      {:else if isDirty && jobsCheckFailed && saveMayStopUnseenJobs()}
        <p class="text-muted-foreground" data-testid="autosave-paused-check">
          {$t(
            "translationJobs.autosaveCheckFailed",
            "Autosave is waiting: could not check for running translations. Trying again — Save asks first.",
          )}
        </p>
      {:else if isDirty && translationsStoppedBySave().length}
        <!-- Autosave is holding off for the running translations.
             Say so, rather than leave "unsaved" unexplained for minutes. -->
        <p class="text-muted-foreground" data-testid="autosave-paused-for-jobs">
          {$t(
            "translationJobs.autosavePaused",
            "Autosave is paused while {languages} translate. Saving now stops them.",
            { languages: languageList(translationsStoppedBySave()) },
          )}
        </p>
      {/if}
    </div>
  </div>

  <div class="relative flex flex-1 flex-col lg:flex-row">
    {#if translationWaitingForOpenVariant}
      <!--
        The waiting state, in place of the writing surface. See
        `translationWaitingForOpenVariant`: an empty variant whose translation
        is being written is not a document anybody should be invited to start.
        Destroying the composer here is the same operation a Write → Preview
        switch already performs, which is why `EditorContentField` takes
        `isAbandoned` from the page rather than from its own lifecycle.
      -->
      <div
        class="flex w-full flex-1 items-center justify-center px-6 py-16"
        data-testid="translation-waiting-here"
      >
        <div class="max-w-sm space-y-2 text-center">
          <p class="text-base font-medium text-foreground" role="status">
            {$t(
              "editor.translationWaitingHere",
              "Translating into {language}…",
              {
                language: languageLabel(openLanguage),
              },
            )}
          </p>
          <p class="text-sm text-muted-foreground">
            {$t(
              "editor.translationWaitingHereBody",
              "It takes a few minutes. The draft opens right here when it is ready, yours to read and edit before publishing.",
            )}
          </p>
          <!--
            The way out, from inside ( review, F2). This was the only
            full-screen state in the editor with no control in it, and a screen
            that makes a promise the client might stop keeping must never also
            be a dead end. Nothing is cancelled: the purchase stands, and the
            translation still loads when it lands — with the ordinary
            load-or-keep choice if there is something of theirs by then.
          -->
          <button
            type="button"
            class="mt-2 rounded-md border border-border px-3 py-1 text-sm hover:bg-muted"
            data-testid="translation-waiting-write-instead"
            onclick={() => (openVariantWaitLatch = false)}
          >
            {$t(
              "editor.translationWaitingWriteInstead",
              "Write it myself instead",
            )}
          </button>
        </div>
      </div>
    {:else if reviewLanguage || mode === "write" || mode === "split"}
      {#if reviewLanguage}
        <!--
          The review side-by-side: the original, read-only, next to
          the translation being reviewed — which stays the ordinary editable
          composer, so a fix is typed where it is seen. On a phone the
          original folds away above the translation.
        -->
        {#if currentZPage}
          <TranslationReviewSource
            page={currentZPage.free2zaddr}
            sourceLanguage={currentZPage.source_language}
            revision={reviewSourceRevision}
            label={(language) => languageLabel(language)}
          />
        {/if}
      {/if}
      <div
        class="flex flex-col bg-background {reviewLanguage || mode === 'split'
          ? 'w-full border-b border-border lg:w-1/2 lg:border-r lg:border-b-0'
          : 'w-full'}"
      >
        <!-- The ARTICLE's language and NOT `$locale`: the writing surface has
             to run the way the language being written runs, while the toolbar,
             slash menu and Translations panel stay in the creator's UI
             direction. `null` for a draft whose language is still only
             presumed, which the composer turns into `dir="auto"`. -->
        <EditorComposer
          bind:title
          bind:description
          bind:coverImage
          bind:coverImageId
          bind:content
          bind:showCover
          bind:showSubtitle
          language={writingLanguage}
          subscriberOnly={isSubscriberOnly}
          {validationErrors}
          onTitleChange={handleTitleChange}
          onDescriptionChange={handleDescriptionChange}
          onCoverImageChange={handleCoverImageChange}
          onContentChange={handleContentChange}
          isAbandoned={() => destroyed}
        />
      </div>
    {/if}

    {#if !translationWaitingForOpenVariant && !reviewLanguage && (mode === "preview" || mode === "split")}
      <!-- The same value through the same helper as the reader route: a
           creator must not approve one layout and publish another. -->
      <EditorPreview
        {title}
        {description}
        {content}
        {showCover}
        {coverImage}
        {showSubtitle}
        {mode}
        {renderedHtml}
        language={writingLanguage}
      />
    {/if}
  </div>

  <EditorStats {content} {mode} />
</div>

{#if isSwitchingLanguage || isDeletingTranslation || isDeletingPage}
  <!--
    Saves are deliberately suspended while a language loads or a translation is
    deleted, so the composer must not accept input it would silently throw away
    when the next variant hydrates.
  -->
  <div
    role="status"
    aria-live="polite"
    class="fixed inset-0 z-40 flex items-start justify-center bg-background/70 pt-24 text-sm text-muted-foreground"
  >
    {#if isDeletingPage}
      {$t("editor.deletingPage", "Deleting this page…")}
    {:else if isDeletingTranslation}
      {$t("editor.deletingTranslation", "Deleting this translation…")}
    {:else}
      {$t("editor.switchingLanguage", "Opening this language…")}
    {/if}
  </div>
{/if}

<!-- Before every dialog: they share its layer and must paint above it. -->
<TranslationTray
  open={trayOpen}
  covered={editorPrompt !== null ||
    translateIntoOpen ||
    translateAiLanguage !== null}
  jobs={jobList}
  variants={variantRows}
  drafts={pageJobs?.drafts ?? {}}
  loading={pageJobs?.loading ?? false}
  error={pageJobs?.error ?? false}
  canTranslateMany={parallelTranslations}
  canTranslate={Boolean(currentZPage)}
  canAddTranslation={Boolean(currentZPage) && addableLanguages.length > 0}
  onAddTranslation={() => {
    translationJobs.closeTray();
    languagePicker = "add";
  }}
  onOpen={(language) => {
    translationJobs.closeTray();
    void requestLanguage(language);
  }}
  publishing={translationPublishing.publishing}
  label={(language) => languageLabel(language)}
  onTranslate={(initial) => openTranslate(initial)}
  onReview={(language) => void startReview(language)}
  onPublish={(language) => void translationPublishing.publishOne(language)}
  onPublishAll={() => void translationPublishing.publishAll()}
  onDelete={(language) => void deleteTranslation(language)}
  onCheckAgain={(language) =>
    currentZPage && translationJobs.resume(currentZPage.free2zaddr, language)}
  onRefresh={() =>
    currentZPage && void translationJobs.refresh(currentZPage.free2zaddr)}
  onclose={() => translationJobs.closeTray()}
  unresolvedPurchase={Boolean(bulkIntent) && !translateIntoOpen}
  onResend={() => openTranslate()}
/>

<!--
  Two pickers, one component, and a hard split in what they do. "change" only
  ever renames the article; "add a translation" only ever opens a new, empty
  variant. The screenshot that started  showed a single `<select>` doing
  both, where picking your own language silently blanked the editor.
-->
<LanguagePicker
  open={languagePicker === "relabel"}
  languages={relabelLanguages}
  names={servedLanguageNames}
  selected={chip.language}
  viewerLocale={$locale}
  title={$t(
    "editor.languagePickerRelabelTitle",
    "What language is this article written in?",
  )}
  description={$t(
    "editor.languagePickerRelabelBody",
    "This only changes the label. Your article text is not touched, and no translation is created.",
  )}
  onselect={(language) => void changeArticleLanguage(language)}
  onclose={() => (languagePicker = null)}
/>

<LanguagePicker
  open={languagePicker === "add"}
  languages={addableLanguages}
  names={servedLanguageNames}
  viewerLocale={$locale}
  title={$t("editor.languagePickerAddTitle", "Add a translation")}
  description={$t(
    "editor.languagePickerAddBody",
    "This opens a new, empty version for you to write. To correct the language of the article you already wrote, use “change” next to Language instead.",
  )}
  onselect={(language) => void startNewTranslation(language)}
  onclose={() => (languagePicker = null)}
/>

<TranslateWithAiDialog
  owner={getRouteData().currentUser}
  open={translateAiLanguage !== null}
  language={languageLabel(translateAiLanguage)}
  quote={translateAiQuote}
  error={translateAiError}
  purchaseError={translateAiPurchaseError}
  replaying={translateAiIntentKey !== null}
  insufficientFunds={translateAiFunds}
  buying={isBuyingTranslation}
  onretry={() =>
    translateAiLanguage && void openTranslateWithAi(translateAiLanguage)}
  onconfirm={() => void confirmTranslateWithAi()}
  onclose={closeTranslateWithAi}
/>

<!-- "Translate…" with no jobs list deployed: one language, the old dialog. -->
<LanguagePicker
  open={languagePicker === "translate"}
  languages={translateIntoLanguages}
  names={servedLanguageNames}
  viewerLocale={$locale}
  title={$t("translationJobs.translateOneTitle", "Translate with AI into…")}
  onselect={(language) => {
    languagePicker = null;
    void openTranslateWithAi(language);
  }}
  onclose={() => (languagePicker = null)}
/>

<TranslateIntoDialog
  owner={getRouteData().currentUser}
  open={translateIntoOpen}
  languages={translateIntoLanguages}
  names={servedLanguageNames}
  viewerLocale={$locale}
  unavailable={translateIntoUnavailable}
  initial={translateIntoInitial}
  maxItems={pageJobs?.maxInFlight ?? null}
  pending={bulkIntent}
  replaces={new Set(
    variantRows
      .filter((row) => row.exists && !row.isSource && row.status === "draft")
      .map((row) => row.language),
  )}
  label={(language) => languageLabel(language)}
  quote={quoteBulk}
  purchase={purchaseBulk}
  onclose={closeTranslateInto}
/>

{#if editorPrompt}
  <!-- Above everything, and clickable over a modal sheet: the publish sheet
       (bits-ui) sets `pointer-events: none` on the body while it is open, and
       a save or publish started from it can need this prompt. -->
  <div
    class="pointer-events-auto fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
  >
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="editor-prompt-title"
      aria-describedby="editor-prompt-body"
      class="w-full max-w-md rounded-lg border border-border bg-background p-5 shadow-lg"
    >
      <h2 id="editor-prompt-title" class="text-lg font-semibold">
        {editorPrompt.title}
      </h2>
      <p id="editor-prompt-body" class="mt-2 text-sm text-muted-foreground">
        {editorPrompt.body}
      </p>
      <div class="mt-5 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          class="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
          onclick={() =>
            settleEditorPrompt(editorPrompt?.cancelChoice ?? "cancel")}
        >
          {editorPrompt.cancelLabel}
        </button>
        {#if editorPrompt.discardLabel}
          <button
            type="button"
            class="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
            onclick={() => settleEditorPrompt("discard")}
          >
            {editorPrompt.discardLabel}
          </button>
        {/if}
        {#if editorPrompt.confirmLabel}
          <button
            type="button"
            use:focusOnMount
            class="rounded-md px-3 py-1.5 text-sm text-white {editorPrompt.danger
              ? 'bg-destructive hover:bg-destructive/90'
              : 'bg-primary hover:bg-primary/90'}"
            onclick={() => settleEditorPrompt("confirm")}
          >
            {editorPrompt.confirmLabel}
          </button>
        {/if}
      </div>
    </div>
  </div>
{/if}

<svelte:window
  onstorage={(event) => void handleTranslationStorage(event)}
  onkeydown={(event) => {
    if (editorPrompt) {
      if (event.key === "Escape") {
        event.preventDefault();
        settleEditorPrompt("cancel");
      }
      return;
    }

    // Escape backs out of the price screen. A purchase already in flight is
    // not cancellable — the 2Z are committed and the server owns the outcome
    // so it holds the dialog open rather than pretending otherwise.
    if (translateAiLanguage !== null) {
      if (event.key === "Escape" && !isBuyingTranslation) {
        event.preventDefault();
        closeTranslateWithAi();
      }
      return;
    }

    // The picker owns Escape while it is open, and a Cmd-S behind it would
    // save without the creator seeing the editor they are saving.
    if (languagePicker || translateIntoOpen) {
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key === "s") {
      event.preventDefault();
      void handleManualSave();
    }
  }}
/>

<svelte:document
  onvisibilitychange={() => {
    if (document.visibilityState === "visible") scheduleJobsReread();
    if (
      document.visibilityState === "hidden" &&
      // A pending save/discard/cancel decision suspends autosave: hiding the
      // tab must not persist edits the creator is about to throw away.
      !editorPrompt &&
      isDirty &&
      !isSaving &&
      canFlushSave
    ) {
      clearAutoSaveTimer();
      // Hidden tabs get little time: ask briefly, and hold if no answer.
      void autoSaveAfterRereadingJobs(2000);
    }
  }}
/>
