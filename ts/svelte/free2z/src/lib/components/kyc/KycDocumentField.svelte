<script>
  /**
   * One identity-document slot: choose a file, see it, replace or remove it.
   *
   * The preview is rendered from a URL the *browser* fetched — it is never part
   * of the SSR payload, so no identity document is ever inside a server-rendered
   * page. `previewUrl` is null until the parent's client-side read lands, and
   * the slot renders "uploaded" from the presence boolean in the meantime, so
   * the resumable state is visible immediately on a refresh.
   */
  import { createEventDispatcher } from "svelte";
  import { Button } from "$lib/components/ui/button";
  import { Loader2, Trash2, Upload, FileCheck2 } from "@lucide/svelte";
  import { tStore as t } from "$lib/i18n";
  import { preflightUpload } from "$lib/kyc/uploads.js";
  import {
    deleteIdentityDocument,
    uploadIdentityDocument,
    KycRequestError,
  } from "$lib/kyc/client.js";

  /** @type {"id_front"|"id_back"|"additional_document"|"live_photo"} */
  export let docType;
  export let label = "";
  export let hint = "";
  export let accept = "";
  /** @type {readonly string[]} */
  export let extensions = [];
  export let present = false;
  /** @type {string|null} */
  export let previewUrl = null;
  export let editable = true;
  export let required = false;

  const dispatch = createEventDispatcher();
  const inputId = `kyc-doc-${docType}`;

  let busy = false;
  let errorMessage = "";
  /** @type {HTMLInputElement|null} */
  let input = null;

  $: isPdf = Boolean(previewUrl && previewUrl.toLowerCase().endsWith(".pdf"));

  /** @param {Event & {currentTarget: EventTarget & HTMLInputElement}} event */
  async function handleChange(event) {
    const file = event.currentTarget?.files?.[0];
    if (!file) return;

    const problem = preflightUpload(file, extensions);
    if (problem) {
      errorMessage = $t(problem.key, problem.fallback, problem.params);
      if (input) input.value = "";
      return;
    }

    errorMessage = "";
    busy = true;
    try {
      const documents = await uploadIdentityDocument(docType, file);
      dispatch("change", documents);
    } catch (err) {
      errorMessage =
        err instanceof KycRequestError && err.detail
          ? err.detail
          : $t(
              "dashboard.kyc.errors.uploadFailed",
              "We could not save that file. Please try again.",
            );
    } finally {
      busy = false;
      // Always clear: re-picking the SAME file after a failure fires no change
      // event otherwise, and the applicant is stuck with a retry that does
      // nothing.
      if (input) input.value = "";
    }
  }

  async function handleRemove() {
    busy = true;
    errorMessage = "";
    try {
      const documents = await deleteIdentityDocument(docType);
      dispatch("change", documents);
    } catch (err) {
      errorMessage =
        err instanceof KycRequestError && err.detail
          ? err.detail
          : $t(
              "dashboard.kyc.errors.removeFailed",
              "We could not remove that file. Please try again.",
            );
    } finally {
      busy = false;
    }
  }
</script>

<div class="rounded-lg border border-border p-4">
  <div class="flex flex-wrap items-baseline justify-between gap-2">
    <span class="text-sm font-medium">
      {label}
      {#if required}
        <span class="text-destructive" aria-hidden="true">*</span>
        <span class="sr-only">
          {$t("dashboard.kyc.required", "Required")}
        </span>
      {:else}
        <span class="ml-1 text-xs font-normal text-muted-foreground">
          {$t("dashboard.kyc.optional", "Optional")}
        </span>
      {/if}
    </span>
    {#if present}
      <span
        class="inline-flex items-center gap-1 text-xs text-muted-foreground"
      >
        <FileCheck2 class="h-3.5 w-3.5" aria-hidden="true" />
        {$t("dashboard.kyc.uploaded", "Uploaded")}
      </span>
    {/if}
  </div>

  {#if hint}
    <p class="mt-1 text-sm text-muted-foreground" id="{inputId}-hint">{hint}</p>
  {/if}

  {#if present && previewUrl}
    <div class="mt-3">
      {#if isPdf}
        <a
          class="text-sm underline underline-offset-2"
          href={previewUrl}
          target="_blank"
          rel="noopener noreferrer nofollow"
        >
          {$t("dashboard.kyc.viewDocument", "Open the file you uploaded")}
        </a>
      {:else}
        <!-- Client-rendered only; see the component note. -->
        <img
          src={previewUrl}
          alt={$t("dashboard.kyc.previewAlt", "Preview of {label}", { label })}
          class="max-h-48 rounded-md border border-border object-contain"
        />
      {/if}
    </div>
  {/if}

  <div class="mt-3 flex flex-wrap items-center gap-2">
    {#if editable}
      <input
        bind:this={input}
        id={inputId}
        class="sr-only"
        type="file"
        {accept}
        disabled={busy}
        aria-describedby={hint ? `${inputId}-hint` : undefined}
        on:change={handleChange}
      />
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        onclick={() => input?.click()}
      >
        {#if busy}
          <Loader2 class="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
        {:else}
          <Upload class="mr-2 h-4 w-4" aria-hidden="true" />
        {/if}
        {present
          ? $t("dashboard.kyc.replaceFile", "Replace file")
          : $t("dashboard.kyc.chooseFile", "Choose file")}
      </Button>

      {#if present}
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onclick={handleRemove}
        >
          <Trash2 class="mr-2 h-4 w-4" aria-hidden="true" />
          {$t("dashboard.kyc.removeFile", "Remove")}
        </Button>
      {/if}
    {/if}
  </div>

  {#if errorMessage}
    <p class="mt-2 text-sm text-destructive" role="alert">{errorMessage}</p>
  {/if}
</div>
