<script>
  /**
   * Revenue-share identity verification (KYC) intake.
   *
   * This page exists because the classic React stepper was the only KYC intake
   * in the product: every creator who switched to the new UI had no way to
   * complete verification at all. It is a port of that stepper, not a
   * redesign — same six data steps, same endpoints, same server-side state.
   *
   * Three properties worth protecting when editing this file:
   *
   *  * **Resumable.** No progress lives in this component. Every step reads and
   *    writes the server immediately, and `resumeStepIndex()` re-derives where
   *    the applicant was from that state alone. Refresh, new device, session
   *    death mid-upload: all land in the same place.
   *  * **SSR-safe.** The app is genuinely server-rendered. Nothing here touches
   *    a browser global during render; the camera lives behind `onMount` in
   *    `KycLivePhoto.svelte` and always has a file-upload fallback.
   *  * **No document in the server-rendered HTML.** The load function returns
   *    presence booleans, never URLs. Preview URLs are fetched by the browser
   *    after mount.
   *
   * Language: a **revenue share** is money. **2Z are platform credits** and are
   * not money, currency, or a cryptocurrency. Those two ideas must never be
   * merged into one sentence in this file — this page sits closer to the payout
   * surface than anything else in the app, which makes it the easiest place in
   * the product to imply something untrue.
   */
  import { onMount, tick } from "svelte";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import {
    AlertTriangle,
    CheckCircle2,
    Clock,
    Info,
    Loader2,
    ShieldCheck,
  } from "@lucide/svelte";
  import { tStore as t } from "$lib/i18n";
  import KycDocumentField from "$lib/components/kyc/KycDocumentField.svelte";
  import KycLivePhoto from "$lib/components/kyc/KycLivePhoto.svelte";
  import {
    KYC_STEPS,
    canSubmit,
    completionProgress,
    isEditable,
    requiredTaxForm,
    resumeStepIndex,
    stepCompletion,
    toServerState,
  } from "$lib/kyc/state.js";
  import {
    IDENTITY_PHOTO_ACCEPT,
    IDENTITY_PHOTO_EXTENSIONS,
    SUPPORTING_DOCUMENT_ACCEPT,
    SUPPORTING_DOCUMENT_EXTENSIONS,
    TAX_FORM_ACCEPT,
    TAX_FORM_EXTENSIONS,
    preflightUpload,
  } from "$lib/kyc/uploads.js";
  import {
    KycRequestError,
    changeApplicationStatus,
    deleteTaxForm,
    fetchIdentityDocuments,
    fetchTaxFormFile,
    saveBasicInfo,
    saveSignature,
    uploadTaxForm,
  } from "$lib/kyc/client.js";

  export let data;
  let state = toServerState(data);
  let activeStep = resumeStepIndex(state);

  // Preview URLs, fetched in the browser only. Null on the server and until
  // the first client read resolves — the presence booleans carry the UI until
  // then, so nothing flickers between "empty" and "uploaded".
  /** @type {Record<"id_front"|"id_back"|"additional_document"|"live_photo", string|null>} */
  let documentUrls = {
    id_front: null,
    id_back: null,
    additional_document: null,
    live_photo: null,
  };
  /** @type {string|null} */
  let taxFormUrl = null;

  let signatureDraft = state.signature;
  let signatureConsent = Boolean(state.signature);
  let consentAccepted = false;

  let busy = false;
  let pageError = "";
  /** @type {HTMLHeadingElement|null} */
  let stepHeading = null;
  /** @type {HTMLInputElement|null} */
  let taxFormInput = null;

  $: completion = stepCompletion(state);
  $: progress = completionProgress(state);
  $: editable = isEditable(state.applicationStatus);
  $: taxForm = requiredTaxForm({
    isUs: state.isUs,
    isIndividual: state.isIndividual,
  });
  $: submittable = canSubmit(state) && consentAccepted;

  onMount(async () => {
    // Document URLs are deliberately absent from the SSR payload. Fetch them
    // now so the applicant can actually see what they uploaded.
    try {
      const [documents, taxFormFile] = await Promise.all([
        fetchIdentityDocuments(),
        fetchTaxFormFile(),
      ]);
      documentUrls = {
        id_front: documents?.id_front_url ?? null,
        id_back: documents?.id_back_url ?? null,
        additional_document: documents?.additional_document_url ?? null,
        live_photo: documents?.live_photo_url ?? null,
      };
      taxFormUrl = taxFormFile?.file ?? null;
    } catch {
      // Previews are a nicety; the flow works without them and the presence
      // booleans from the server load are already correct.
    }
  });

  /**
   * Move to a step and put focus on its heading.
   *
   * Without this a keyboard or screen-reader user activates "Next", the page
   * silently swaps its contents, and focus is still on a button that no longer
   * relates to anything visible.
   *
   * @param {number} index
   */
  async function goToStep(index) {
    if (index < 0 || index >= KYC_STEPS.length) return;
    activeStep = index;
    pageError = "";
    await tick();
    stepHeading?.focus();
  }

  /** @param {number} index */
  function stepReachable(index) {
    // Everything already done is revisitable, plus the step immediately after
    // the last completed one. Jumping to an arbitrary later step would show a
    // form whose prerequisites are not met.
    if (index <= activeStep) return true;
    return KYC_STEPS.slice(0, index).every(
      (step) => step === "review" || completion[step],
    );
  }

  /**
   * @param {unknown} err
   * @param {string} fallbackKey
   * @param {string} fallbackText
   */
  function describeError(err, fallbackKey, fallbackText) {
    if (err instanceof KycRequestError && err.detail) return err.detail;
    return $t(fallbackKey, fallbackText);
  }

  /** @param {import("$lib/api/f2z.schemas").IdentityDocuments|null} documents */
  function applyDocuments(documents) {
    state = {
      ...state,
      hasIdFront: Boolean(documents?.id_front_url),
      hasIdBack: Boolean(documents?.id_back_url),
      hasAdditionalDocument: Boolean(documents?.additional_document_url),
      hasLivePhoto: Boolean(documents?.live_photo_url),
    };
    documentUrls = {
      id_front: documents?.id_front_url ?? null,
      id_back: documents?.id_back_url ?? null,
      additional_document: documents?.additional_document_url ?? null,
      live_photo: documents?.live_photo_url ?? null,
    };
  }

  async function submitBasicInfo() {
    if (state.isUs === null || state.isIndividual === null) return;
    busy = true;
    pageError = "";
    try {
      const profile = await saveBasicInfo({
        isUs: state.isUs,
        isIndividual: state.isIndividual,
      });
      // The stored tax form is NOT a single row: `TaxFormUploadView` writes to
      // W9, W8BEN or W8BENE depending on exactly these two answers, and
      // `GetTaxFormFileView` reads back whichever one the *current* answers
      // select. So changing "US person" after uploading a W-9 does not migrate
      // that PDF — it makes the applicant owe a W-8BEN they have not uploaded.
      // Re-read rather than assume: keeping `hasTaxForm` from before the change
      // would mark the step complete and let them submit an application whose
      // required tax form does not exist.
      const taxFormFile = await fetchTaxFormFile().catch(() => null);
      taxFormUrl = taxFormFile?.file ?? null;

      state = {
        ...state,
        isUs: profile?.is_us ?? state.isUs,
        isIndividual: profile?.is_individual ?? state.isIndividual,
        applicationStatus:
          profile?.application_status ?? state.applicationStatus,
        hasTaxForm: Boolean(taxFormFile?.file),
      };
      await goToStep(activeStep + 1);
    } catch (err) {
      pageError = describeError(
        err,
        "dashboard.kyc.errors.saveFailed",
        "We could not save that. Please try again.",
      );
    } finally {
      busy = false;
    }
  }

  /** @param {Event & {currentTarget: EventTarget & HTMLInputElement}} event */
  async function handleTaxFormFile(event) {
    const file = event.currentTarget?.files?.[0];
    if (!file) return;

    const problem = preflightUpload(file, TAX_FORM_EXTENSIONS);
    if (problem) {
      pageError = $t(problem.key, problem.fallback, problem.params);
      if (taxFormInput) taxFormInput.value = "";
      return;
    }

    busy = true;
    pageError = "";
    try {
      const result = await uploadTaxForm(file);
      taxFormUrl = result?.file_url ?? null;
      state = { ...state, hasTaxForm: true };
      await invalidateSignature();
    } catch (err) {
      pageError = describeError(
        err,
        "dashboard.kyc.errors.uploadFailed",
        "We could not save that file. Please try again.",
      );
    } finally {
      busy = false;
      if (taxFormInput) taxFormInput.value = "";
    }
  }

  async function removeTaxForm() {
    busy = true;
    pageError = "";
    try {
      await deleteTaxForm();
      taxFormUrl = null;
      state = { ...state, hasTaxForm: false };
      await invalidateSignature();
    } catch (err) {
      pageError = describeError(
        err,
        "dashboard.kyc.errors.removeFailed",
        "We could not remove that file. Please try again.",
      );
    } finally {
      busy = false;
    }
  }

  /**
   * Drop a signature that no longer belongs to the document it signed.
   *
   * `tax_form_signature` lives on the profile, not on the tax form, so
   * replacing or deleting the PDF leaves the old typed name attached to a
   * document nobody signed. An electronic signature that outlives its document
   * is not a signature, and on this surface that is a tax-compliance problem
   * rather than a UI wrinkle — so clear it server-side and send the applicant
   * back through the signature step.
   *
   * A no-op when nothing has been signed yet, which is the common path.
   */
  async function invalidateSignature() {
    if (!state.signature.trim()) return;
    try {
      await saveSignature("");
      state = { ...state, signature: "" };
      signatureDraft = "";
      signatureConsent = false;
    } catch (err) {
      // Do not swallow this: leaving the stale signature in place while the
      // UI shows a new document is exactly the state we are trying to avoid.
      pageError = describeError(
        err,
        "dashboard.kyc.errors.signatureResetFailed",
        "Your form was saved, but we could not clear your old signature. Please sign again.",
      );
    }
  }

  async function submitSignature() {
    busy = true;
    pageError = "";
    try {
      const result = await saveSignature(signatureDraft.trim());
      state = {
        ...state,
        signature: result?.tax_form_signature ?? signatureDraft.trim(),
      };
      await goToStep(activeStep + 1);
    } catch (err) {
      pageError = describeError(
        err,
        "dashboard.kyc.errors.saveFailed",
        "We could not save that. Please try again.",
      );
    } finally {
      busy = false;
    }
  }

  async function submitApplication() {
    busy = true;
    pageError = "";
    try {
      await changeApplicationStatus();
      // The endpoint answers with a sentence, not a status. Set what the
      // transition means rather than parsing English out of the response.
      state = { ...state, applicationStatus: "PENDING" };
    } catch (err) {
      pageError = describeError(
        err,
        "dashboard.kyc.errors.submitFailed",
        "We could not submit your application. Please try again.",
      );
    } finally {
      busy = false;
    }
  }

  async function reopenApplication() {
    busy = true;
    pageError = "";
    try {
      await changeApplicationStatus();
      state = { ...state, applicationStatus: "NEW" };
      await goToStep(resumeStepIndex({ ...state, applicationStatus: "NEW" }));
    } catch (err) {
      pageError = describeError(
        err,
        "dashboard.kyc.errors.reopenFailed",
        "We could not reopen your application. Please try again.",
      );
    } finally {
      busy = false;
    }
  }

  const STEP_TITLES = {
    intro: ["dashboard.kyc.steps.intro", "Before you start"],
    basicInfo: ["dashboard.kyc.steps.basicInfo", "About you"],
    taxForm: ["dashboard.kyc.steps.taxForm", "Tax form"],
    identity: ["dashboard.kyc.steps.identity", "Identity documents"],
    livePhoto: ["dashboard.kyc.steps.livePhoto", "Photo of you"],
    signature: ["dashboard.kyc.steps.signature", "Electronic signature"],
    review: ["dashboard.kyc.steps.review", "Review and submit"],
  };

  const STATUS_COPY = {
    NEW: ["dashboard.kyc.status.new", "Not submitted yet"],
    PENDING: ["dashboard.kyc.status.pending", "Waiting for review"],
    APPROVED: ["dashboard.kyc.status.approved", "Approved"],
    REJECTED: ["dashboard.kyc.status.rejected", "Not approved"],
  };
</script>

<svelte:head>
  <title>{$t("dashboard.kyc.pageTitle", "Creator verification")} · Free2Z</title
  >
  <!--
    The layout's `privateSurface` rule already covers every /dashboard/ path,
    and the server load sends `X-Robots-Tag` too. This is the third belt on the
    same trousers, and on this page that is the correct number.
  -->
  <meta name="robots" content="noindex, nofollow, noarchive, noimageindex" />
</svelte:head>

<div class="mx-auto w-full max-w-2xl px-4 py-8">
  <header class="mb-6">
    <h1 class="text-2xl font-semibold tracking-tight">
      {$t("dashboard.kyc.title", "Creator verification")}
    </h1>
    <p class="mt-2 text-sm text-muted-foreground">
      {$t(
        "dashboard.kyc.subtitle",
        "Complete the creator verification application. Payment review may require tax information. You can save your progress and return later.",
      )}
    </p>
  </header>

  <!-- Status -->
  <div
    class="mb-6 rounded-lg border border-border p-4"
    role="status"
    aria-live="polite"
  >
    <div class="flex items-center gap-2">
      {#if state.applicationStatus === "APPROVED"}
        <CheckCircle2 class="h-5 w-5 text-primary" aria-hidden="true" />
      {:else if state.applicationStatus === "PENDING"}
        <Clock class="h-5 w-5 text-muted-foreground" aria-hidden="true" />
      {:else if state.applicationStatus === "REJECTED"}
        <AlertTriangle class="h-5 w-5 text-destructive" aria-hidden="true" />
      {:else}
        <ShieldCheck class="h-5 w-5 text-muted-foreground" aria-hidden="true" />
      {/if}
      <p class="text-sm font-medium">
        {$t(
          STATUS_COPY[state.applicationStatus][0],
          STATUS_COPY[state.applicationStatus][1],
        )}
      </p>
    </div>

    {#if state.applicationStatus === "NEW"}
      <p class="mt-2 text-sm text-muted-foreground">
        {$t(
          "dashboard.kyc.status.newHelp",
          "{done} of {total} steps done. Nothing is sent for review until you submit it.",
          { done: progress.done, total: progress.total },
        )}
      </p>
      <div
        class="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={progress.done}
        aria-valuemin={0}
        aria-valuemax={progress.total}
        aria-label={$t("dashboard.kyc.progressLabel", "Verification progress")}
      >
        <div
          class="h-full bg-primary transition-all"
          style={`width: ${progress.percent}%`}
        ></div>
      </div>
    {:else if state.applicationStatus === "PENDING"}
      <p class="mt-2 text-sm text-muted-foreground">
        {$t(
          "dashboard.kyc.status.pendingHelp",
          "A person is reviewing your application. You cannot change it while it is being reviewed.",
        )}
      </p>
    {:else if state.applicationStatus === "APPROVED"}
      <p class="mt-2 text-sm text-muted-foreground">
        {$t(
          "dashboard.kyc.status.approvedHelp",
          "Your identity is verified. Reopen the application if you need to update a document.",
        )}
      </p>
      <Button
        class="mt-3"
        variant="outline"
        size="sm"
        disabled={busy}
        onclick={reopenApplication}
      >
        {$t("dashboard.kyc.reopen", "Reopen my application")}
      </Button>
    {:else if state.applicationStatus === "REJECTED"}
      {#if state.rejectionReason}
        <p class="mt-2 text-sm">
          <span class="font-medium"
            >{$t("dashboard.kyc.status.reason", "Reason:")}</span
          >
          {state.rejectionReason}
        </p>
      {/if}
      <p class="mt-2 text-sm text-muted-foreground">
        {$t(
          "dashboard.kyc.status.rejectedHelp",
          "Contact support to reopen your application so you can correct it.",
        )}
      </p>
    {/if}
  </div>

  <p class="mb-6 text-sm text-muted-foreground">
    {$t(
      "dashboard.kyc.eligibilityNote",
      "Usage credits are not required to apply. Verification and tax signatures do not accept a compensation agreement; agreement acceptance is recorded separately in Credits & Earnings.",
    )}
  </p>

  {#if pageError}
    <p
      class="mb-4 rounded-md border border-destructive/40 p-3 text-sm text-destructive"
      role="alert"
    >
      {pageError}
    </p>
  {/if}

  <ol class="space-y-3">
    {#each KYC_STEPS as step, index (step)}
      <li class="rounded-lg border border-border">
        <h2 class="m-0">
          <button
            type="button"
            class="flex w-full items-center gap-3 rounded-lg px-4 py-3 text-left text-sm font-medium focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
            aria-expanded={index === activeStep}
            aria-controls={`kyc-step-panel-${step}`}
            disabled={!stepReachable(index)}
            on:click={() => goToStep(index)}
          >
            <span
              class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border text-xs"
              aria-hidden="true"
            >
              {#if completion[step]}
                <CheckCircle2 class="h-4 w-4 text-primary" />
              {:else}
                {index}
              {/if}
            </span>
            <span>{$t(STEP_TITLES[step][0], STEP_TITLES[step][1])}</span>
            {#if completion[step] && step !== "intro" && step !== "review"}
              <span class="sr-only"
                >{$t("dashboard.kyc.stepDone", "Completed")}</span
              >
            {/if}
          </button>
        </h2>

        {#if index === activeStep}
          <div
            class="border-t border-border px-4 py-4"
            id={`kyc-step-panel-${step}`}
          >
            <!--
              tabindex=-1 so goToStep() can move focus here. Not reachable by
              Tab; it is a focus target, not a control.
            -->
            <h3
              bind:this={stepHeading}
              tabindex="-1"
              class="mb-3 text-base font-medium focus-visible:outline-none"
            >
              {$t(STEP_TITLES[step][0], STEP_TITLES[step][1])}
            </h3>

            {#if step === "intro"}
              <div class="space-y-3 text-sm text-muted-foreground">
                <p>
                  {$t(
                    "dashboard.kyc.intro.body",
                    "This application identifies the proposed payee for review. Approval, a tax signature, and acceptance of a compensation agreement are separate records.",
                  )}
                </p>
                <p>
                  {$t(
                    "dashboard.kyc.intro.collectIntro",
                    "You will be asked for:",
                  )}
                </p>
                <ul class="list-disc space-y-1 pl-5">
                  <li>
                    {$t(
                      "dashboard.kyc.intro.collectBasics",
                      "Whether you are a US taxpayer, and whether you are applying as a person or as a business.",
                    )}
                  </li>
                  <li>
                    {$t(
                      "dashboard.kyc.intro.collectTaxForm",
                      "A completed IRS tax form — which one depends on your answers.",
                    )}
                  </li>
                  <li>
                    {$t(
                      "dashboard.kyc.intro.collectId",
                      "A photo of a government-issued ID.",
                    )}
                  </li>
                  <li>
                    {$t(
                      "dashboard.kyc.intro.collectPhoto",
                      "A photo of your face, so we can check it matches the ID.",
                    )}
                  </li>
                  <li>
                    {$t(
                      "dashboard.kyc.intro.collectSignature",
                      "Your name typed as an electronic signature for the tax form.",
                    )}
                  </li>
                </ul>
                <p>
                  {$t(
                    "dashboard.kyc.intro.resume",
                    "Each step is saved as you go. You can close this page and pick it up later.",
                  )}
                </p>
              </div>
              <div class="mt-4 flex justify-end">
                <Button onclick={() => goToStep(index + 1)}>
                  {$t("dashboard.kyc.start", "Start")}
                </Button>
              </div>
            {:else if step === "basicInfo"}
              <fieldset class="mb-4" disabled={!editable || busy}>
                <legend class="mb-2 text-sm font-medium">
                  {$t(
                    "dashboard.kyc.basicInfo.isUsLegend",
                    "Are you a US person for tax purposes?",
                  )}
                </legend>
                <div class="flex flex-col gap-2">
                  <label class="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="kyc-is-us"
                      class="h-4 w-4"
                      checked={state.isUs === true}
                      on:change={() => (state = { ...state, isUs: true })}
                    />
                    {$t("dashboard.kyc.basicInfo.isUsYes", "Yes — US person")}
                  </label>
                  <label class="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="kyc-is-us"
                      class="h-4 w-4"
                      checked={state.isUs === false}
                      on:change={() => (state = { ...state, isUs: false })}
                    />
                    {$t(
                      "dashboard.kyc.basicInfo.isUsNo",
                      "No — outside the US",
                    )}
                  </label>
                </div>
              </fieldset>

              <fieldset class="mb-4" disabled={!editable || busy}>
                <legend class="mb-2 text-sm font-medium">
                  {$t(
                    "dashboard.kyc.basicInfo.isIndividualLegend",
                    "Are you applying as a person or as a business?",
                  )}
                </legend>
                <div class="flex flex-col gap-2">
                  <label class="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="kyc-is-individual"
                      class="h-4 w-4"
                      checked={state.isIndividual === true}
                      on:change={() =>
                        (state = { ...state, isIndividual: true })}
                    />
                    {$t("dashboard.kyc.basicInfo.person", "A person")}
                  </label>
                  <label class="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="kyc-is-individual"
                      class="h-4 w-4"
                      checked={state.isIndividual === false}
                      on:change={() =>
                        (state = { ...state, isIndividual: false })}
                    />
                    {$t(
                      "dashboard.kyc.basicInfo.entity",
                      "A business or other entity",
                    )}
                  </label>
                </div>
              </fieldset>

              {#if taxForm}
                <p class="mb-4 text-sm text-muted-foreground">
                  {$t(
                    "dashboard.kyc.basicInfo.formHint",
                    "With these answers you will need to submit form {form}.",
                    { form: taxForm.id },
                  )}
                </p>
              {/if}

              <div class="flex justify-between">
                <Button
                  variant="outline"
                  disabled={busy}
                  onclick={() => goToStep(index - 1)}
                >
                  {$t("dashboard.kyc.back", "Back")}
                </Button>
                <Button
                  disabled={busy ||
                    !editable ||
                    state.isUs === null ||
                    state.isIndividual === null}
                  onclick={submitBasicInfo}
                >
                  {#if busy}
                    <Loader2
                      class="mr-2 h-4 w-4 animate-spin"
                      aria-hidden="true"
                    />
                  {/if}
                  {$t("dashboard.kyc.saveAndContinue", "Save and continue")}
                </Button>
              </div>
            {:else if step === "taxForm"}
              {#if taxForm}
                <p class="mb-3 text-sm text-muted-foreground">
                  {$t(
                    "dashboard.kyc.taxForm.instructions",
                    "Download form {form}, fill it in, and upload it here as a PDF. You do not need to print or hand-sign it — you sign electronically later in this flow.",
                    { form: taxForm.id },
                  )}
                </p>
                <p class="mb-4">
                  <a
                    class="text-sm underline underline-offset-2"
                    href={taxForm.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {$t(
                      "dashboard.kyc.taxForm.download",
                      "Download {form} from irs.gov",
                      {
                        form: taxForm.id,
                      },
                    )}
                  </a>
                </p>

                <div class="rounded-lg border border-border p-4">
                  {#if state.hasTaxForm}
                    <p class="text-sm">
                      {$t(
                        "dashboard.kyc.taxForm.uploaded",
                        "Your {form} is uploaded. Open it to check it before you continue.",
                        { form: taxForm.id },
                      )}
                    </p>
                    <div class="mt-3 flex flex-wrap gap-2">
                      {#if taxFormUrl}
                        <a
                          class="text-sm underline underline-offset-2"
                          href={taxFormUrl}
                          target="_blank"
                          rel="noopener noreferrer nofollow"
                        >
                          {$t(
                            "dashboard.kyc.taxForm.open",
                            "Open my uploaded form",
                          )}
                        </a>
                      {/if}
                      {#if editable}
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onclick={removeTaxForm}
                        >
                          {$t("dashboard.kyc.removeFile", "Remove")}
                        </Button>
                      {/if}
                    </div>
                  {:else if editable}
                    <input
                      bind:this={taxFormInput}
                      id="kyc-tax-form-file"
                      class="sr-only"
                      type="file"
                      accept={TAX_FORM_ACCEPT}
                      disabled={busy}
                      on:change={handleTaxFormFile}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onclick={() => taxFormInput?.click()}
                    >
                      {#if busy}
                        <Loader2
                          class="mr-2 h-4 w-4 animate-spin"
                          aria-hidden="true"
                        />
                      {/if}
                      {$t(
                        "dashboard.kyc.taxForm.choose",
                        "Upload my completed form",
                      )}
                    </Button>
                  {/if}
                </div>
              {:else}
                <p class="text-sm text-muted-foreground">
                  {$t(
                    "dashboard.kyc.taxForm.needBasics",
                    "Answer the questions in the previous step and we will tell you which form you need.",
                  )}
                </p>
              {/if}

              <div class="mt-4 flex justify-between">
                <Button
                  variant="outline"
                  disabled={busy}
                  onclick={() => goToStep(index - 1)}
                >
                  {$t("dashboard.kyc.back", "Back")}
                </Button>
                <Button
                  disabled={busy || !completion.taxForm}
                  onclick={() => goToStep(index + 1)}
                >
                  {$t("dashboard.kyc.continue", "Continue")}
                </Button>
              </div>
            {:else if step === "identity"}
              <div class="space-y-3">
                <KycDocumentField
                  docType="id_front"
                  required
                  {editable}
                  label={$t(
                    "dashboard.kyc.identity.frontLabel",
                    "Front of your ID",
                  )}
                  hint={$t(
                    "dashboard.kyc.identity.frontHint",
                    "A passport, driving licence or national ID card. All four corners visible, no glare.",
                  )}
                  accept={IDENTITY_PHOTO_ACCEPT}
                  extensions={IDENTITY_PHOTO_EXTENSIONS}
                  present={state.hasIdFront}
                  previewUrl={documentUrls.id_front}
                  on:change={(event) => applyDocuments(event.detail)}
                />
                <KycDocumentField
                  docType="id_back"
                  {editable}
                  label={$t(
                    "dashboard.kyc.identity.backLabel",
                    "Back of your ID",
                  )}
                  hint={$t(
                    "dashboard.kyc.identity.backHint",
                    "Only if your ID has something on the back.",
                  )}
                  accept={IDENTITY_PHOTO_ACCEPT}
                  extensions={IDENTITY_PHOTO_EXTENSIONS}
                  present={state.hasIdBack}
                  previewUrl={documentUrls.id_back}
                  on:change={(event) => applyDocuments(event.detail)}
                />
                <KycDocumentField
                  docType="additional_document"
                  {editable}
                  label={$t(
                    "dashboard.kyc.identity.additionalLabel",
                    "Proof of address",
                  )}
                  hint={$t(
                    "dashboard.kyc.identity.additionalHint",
                    "A utility bill or bank statement, if you have been asked for one. Image or PDF.",
                  )}
                  accept={SUPPORTING_DOCUMENT_ACCEPT}
                  extensions={SUPPORTING_DOCUMENT_EXTENSIONS}
                  present={state.hasAdditionalDocument}
                  previewUrl={documentUrls.additional_document}
                  on:change={(event) => applyDocuments(event.detail)}
                />
              </div>

              <div class="mt-4 flex justify-between">
                <Button
                  variant="outline"
                  disabled={busy}
                  onclick={() => goToStep(index - 1)}
                >
                  {$t("dashboard.kyc.back", "Back")}
                </Button>
                <Button
                  disabled={busy || !completion.identity}
                  onclick={() => goToStep(index + 1)}
                >
                  {$t("dashboard.kyc.continue", "Continue")}
                </Button>
              </div>
            {:else if step === "livePhoto"}
              <KycLivePhoto
                {editable}
                present={state.hasLivePhoto}
                previewUrl={documentUrls.live_photo}
                on:change={(event) => applyDocuments(event.detail)}
              />

              <div class="mt-4 flex justify-between">
                <Button
                  variant="outline"
                  disabled={busy}
                  onclick={() => goToStep(index - 1)}
                >
                  {$t("dashboard.kyc.back", "Back")}
                </Button>
                <Button
                  disabled={busy || !completion.livePhoto}
                  onclick={() => goToStep(index + 1)}
                >
                  {$t("dashboard.kyc.continue", "Continue")}
                </Button>
              </div>
            {:else if step === "signature"}
              <label class="mb-1 block text-sm font-medium" for="kyc-signature">
                {$t(
                  "dashboard.kyc.signature.label",
                  "Type your full legal name",
                )}
              </label>
              <Input
                id="kyc-signature"
                autocomplete="name"
                disabled={!editable || busy}
                aria-describedby="kyc-signature-help"
                bind:value={signatureDraft}
              />
              <p
                id="kyc-signature-help"
                class="mt-1 text-sm text-muted-foreground"
              >
                {$t(
                  "dashboard.kyc.signature.help",
                  "This stands in for your handwritten signature on the tax form you uploaded.",
                )}
              </p>

              <label class="mt-4 flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  class="mt-0.5 h-4 w-4"
                  disabled={!editable || busy}
                  bind:checked={signatureConsent}
                />
                <span>
                  {$t(
                    "dashboard.kyc.signature.consent",
                    "I understand that typing my name here is my legal signature on the tax form I uploaded.",
                  )}
                </span>
              </label>

              <div class="mt-4 flex justify-between">
                <Button
                  variant="outline"
                  disabled={busy}
                  onclick={() => goToStep(index - 1)}
                >
                  {$t("dashboard.kyc.back", "Back")}
                </Button>
                <Button
                  disabled={busy ||
                    !editable ||
                    !signatureConsent ||
                    !signatureDraft.trim()}
                  onclick={submitSignature}
                >
                  {#if busy}
                    <Loader2
                      class="mr-2 h-4 w-4 animate-spin"
                      aria-hidden="true"
                    />
                  {/if}
                  {$t("dashboard.kyc.saveAndContinue", "Save and continue")}
                </Button>
              </div>
            {:else if step === "review"}
              <ul class="mb-4 space-y-2 text-sm">
                <li class="flex items-start gap-2">
                  <span aria-hidden="true"
                    >{completion.basicInfo ? "✓" : "•"}</span
                  >
                  <span>
                    {#if taxForm}
                      {$t(
                        "dashboard.kyc.review.basicInfo",
                        "You are applying as {who}, and your form is {form}.",
                        {
                          who: state.isIndividual
                            ? $t("dashboard.kyc.basicInfo.person", "A person")
                            : $t(
                                "dashboard.kyc.basicInfo.entity",
                                "A business or other entity",
                              ),
                          form: taxForm.id,
                        },
                      )}
                    {:else}
                      {$t(
                        "dashboard.kyc.review.basicInfoMissing",
                        "Your answers about who you are are not finished.",
                      )}
                    {/if}
                  </span>
                </li>
                <li class="flex items-start gap-2">
                  <span aria-hidden="true"
                    >{completion.taxForm ? "✓" : "•"}</span
                  >
                  <span>
                    {completion.taxForm
                      ? $t(
                          "dashboard.kyc.review.taxFormDone",
                          "Tax form uploaded.",
                        )
                      : $t(
                          "dashboard.kyc.review.taxFormMissing",
                          "Tax form still missing.",
                        )}
                  </span>
                </li>
                <li class="flex items-start gap-2">
                  <span aria-hidden="true"
                    >{completion.identity ? "✓" : "•"}</span
                  >
                  <span>
                    {completion.identity
                      ? $t("dashboard.kyc.review.identityDone", "ID uploaded.")
                      : $t(
                          "dashboard.kyc.review.identityMissing",
                          "ID still missing.",
                        )}
                  </span>
                </li>
                <li class="flex items-start gap-2">
                  <span aria-hidden="true"
                    >{completion.livePhoto ? "✓" : "•"}</span
                  >
                  <span>
                    {completion.livePhoto
                      ? $t(
                          "dashboard.kyc.review.photoDone",
                          "Photo of you saved.",
                        )
                      : $t(
                          "dashboard.kyc.review.photoMissing",
                          "Photo of you still missing.",
                        )}
                  </span>
                </li>
                <li class="flex items-start gap-2">
                  <span aria-hidden="true"
                    >{completion.signature ? "✓" : "•"}</span
                  >
                  <span>
                    {completion.signature
                      ? $t(
                          "dashboard.kyc.review.signatureDone",
                          "Signed as {name}.",
                          {
                            name: state.signature,
                          },
                        )
                      : $t(
                          "dashboard.kyc.review.signatureMissing",
                          "Electronic signature still missing.",
                        )}
                  </span>
                </li>
              </ul>

              <div
                class="space-y-2 rounded-lg border border-border p-4 text-sm text-muted-foreground"
              >
                <p class="font-medium text-foreground">
                  {$t(
                    "dashboard.kyc.review.consentTitle",
                    "What you are agreeing to",
                  )}
                </p>
                <p>
                  {$t(
                    "dashboard.kyc.review.consentCollect",
                    "We collect the tax form, the identity documents and the photo you uploaded, plus the name you typed as your signature.",
                  )}
                </p>
                <p>
                  {$t(
                    "dashboard.kyc.review.consentWhy",
                    "We use this information to review the payee and applicable payment reporting requirements.",
                  )}
                </p>
                <p>
                  {$t(
                    "dashboard.kyc.review.consentRetention",
                    "We keep them for as long as tax and anti-money-laundering rules require us to. Contact support with any question about your application.",
                  )}
                </p>
                <p>
                  {$t(
                    "dashboard.kyc.review.consentAccess",
                    "Only Free2Z administrators reviewing applications can open these documents. They are never shown on your profile, never public, and never indexed by search engines.",
                  )}
                </p>
              </div>

              {#if editable}
                <label class="mt-4 flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    class="mt-0.5 h-4 w-4"
                    disabled={busy}
                    bind:checked={consentAccepted}
                  />
                  <span>
                    {$t(
                      "dashboard.kyc.review.consentCheckbox",
                      "The information I have given is accurate, and I agree to Free2Z collecting and keeping it as described above.",
                    )}
                  </span>
                </label>
              {/if}

              <div class="mt-4 flex justify-between">
                <Button
                  variant="outline"
                  disabled={busy}
                  onclick={() => goToStep(index - 1)}
                >
                  {$t("dashboard.kyc.back", "Back")}
                </Button>
                {#if editable}
                  <Button
                    disabled={busy || !submittable}
                    onclick={submitApplication}
                  >
                    {#if busy}
                      <Loader2
                        class="mr-2 h-4 w-4 animate-spin"
                        aria-hidden="true"
                      />
                    {/if}
                    {$t("dashboard.kyc.submit", "Submit for review")}
                  </Button>
                {/if}
              </div>

              {#if editable && !canSubmit(state)}
                <p class="mt-2 text-sm text-muted-foreground">
                  {$t(
                    "dashboard.kyc.review.incomplete",
                    "Finish the steps marked above before you can submit.",
                  )}
                </p>
              {/if}
            {/if}
          </div>
        {/if}
      </li>
    {/each}
  </ol>
</div>
