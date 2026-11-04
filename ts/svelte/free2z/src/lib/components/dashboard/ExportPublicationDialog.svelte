<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { tStore as t } from "$lib/i18n";
  import * as Dialog from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import {
    publicationExportsList,
    publicationExportsCreate,
    publicationExportsRetrieve,
  } from "$lib/api/exports/exports";
  import type { PublicationExportJob } from "$lib/api/f2z.schemas";
  import {
    POLL_REQUEST_TIMEOUT_MS,
    classifyLatestJobError,
    createExportPoller,
    isActiveExportStatus,
    withDeadline,
  } from "$lib/publication-export-poll";
  import {
    Download,
    Loader2,
    CheckCircle2,
    AlertCircle,
    AlertTriangle,
    Clock,
    FileArchive,
    RotateCw,
  } from "@lucide/svelte";

  let {
    open = $bindable(false),
  }: {
    open: boolean;
  } = $props();

  let job = $state<PublicationExportJob | null>(null);
  let loading = $state(false);
  let errorMessage = $state<string | null>(null);
  // Whether the "latest export" lookup actually answered. Only a 404
  // means "no export yet"; any other failure is "unknown", and the dialog must
  // not offer "Start export" over a job that may already be running.
  let latestLoadFailed = $state(false);
  // A status poll failed and a backed-off retry is scheduled.
  let pollRetrying = $state(false);
  // Polling gave up after repeated failures: say so, and offer a retry,
  // instead of spinning "running" forever.
  let pollGaveUp = $state(false);

  const poller = createExportPoller<PublicationExportJob>({
    fetchJob: (jobId, signal) =>
      publicationExportsRetrieve(jobId, undefined, signal),
    onUpdate: (updated) => {
      job = updated;
      latestLoadFailed = false;
      pollRetrying = false;
      pollGaveUp = false;
    },
    onRetry: () => {
      pollRetrying = true;
    },
    onGiveUp: () => {
      pollRetrying = false;
      pollGaveUp = true;
    },
  });

  function formatBytes(bytes: number | null | undefined): string {
    if (!bytes || bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  }

  // Bumped by every lookup and by closing the dialog, so a lookup that was
  // still in flight when the dialog closed (or was superseded by a newer one)
  // cannot land afterwards and overwrite the current state ( review).
  let lookupGeneration = 0;
  // The first lookup gets the same deadline as a status poll: without one, a
  // request that stalls mid-deploy leaves the dialog on "Loading…" forever.
  // A timeout is classified like any non-404 failure: "failed to load".
  let lookupController: AbortController | null = null;

  function cancelLookup() {
    lookupGeneration += 1;
    lookupController?.abort();
    lookupController = null;
  }

  async function checkLatestJob() {
    stopPolling();
    cancelLookup();
    const gen = lookupGeneration;
    const controller = new AbortController();
    lookupController = controller;
    try {
      loading = true;
      errorMessage = null;
      latestLoadFailed = false;
      const res = await withDeadline(
        (signal) => publicationExportsList(undefined, signal),
        POLL_REQUEST_TIMEOUT_MS,
        controller,
      );
      if (gen !== lookupGeneration) return;
      if (res && res.id) {
        job = res;
        if (isActiveExportStatus(res.status)) {
          startPolling(res.id);
        }
      } else {
        job = null;
      }
    } catch (err) {
      if (gen !== lookupGeneration) return;
      if (classifyLatestJobError(err) === "none") {
        // 404: this creator has never exported.
        job = null;
      } else {
        // 5xx / network / timeout: we do not know whether a job exists, so
        // show neither a stale job nor "no export yet".
        job = null;
        latestLoadFailed = true;
      }
    } finally {
      if (gen === lookupGeneration) {
        loading = false;
        lookupController = null;
      }
    }
  }

  async function startExport() {
    try {
      loading = true;
      errorMessage = null;
      const res = await publicationExportsCreate();
      if (res && res.id) {
        job = res;
        if (isActiveExportStatus(res.status)) {
          startPolling(res.id);
        }
      }
    } catch (err: any) {
      errorMessage =
        err?.message ||
        $t("dashboard.pages.exportStatus.failed", "Export failed");
    } finally {
      loading = false;
    }
  }

  function startPolling(jobId: string, immediate = false) {
    pollRetrying = false;
    pollGaveUp = false;
    poller.start(jobId, { immediate });
  }

  function stopPolling() {
    poller.stop();
    pollRetrying = false;
    pollGaveUp = false;
  }

  function checkStatusAgain() {
    if (job?.id) startPolling(job.id, true);
  }

  $effect(() => {
    if (open) {
      untrack(() => checkLatestJob());
    } else {
      untrack(() => {
        cancelLookup();
        loading = false;
        stopPolling();
      });
    }
  });

  onDestroy(() => {
    // Cancel an in-flight first lookup too: a reply landing after unmount
    // must not start a poller nobody can see.
    cancelLookup();
    stopPolling();
  });

  function triggerDownload() {
    if (!job || !job.id) return;
    const downloadUrl = `/api/exports/publications/${job.id}/download/`;
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.setAttribute("download", job.file_name || "publication-export.zip");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="max-w-lg">
    <Dialog.Header>
      <Dialog.Title class="flex items-center gap-2 text-xl font-bold">
        <FileArchive class="size-5 text-primary" />
        {$t("dashboard.pages.exportDialog.title", "Export Publication")}
      </Dialog.Title>
      <Dialog.Description class="text-sm text-muted-foreground">
        {$t(
          "dashboard.pages.exportDialog.description",
          "Download a complete, self-contained archive of your publication. The archive includes all your published and draft articles, subscriber-only writing, language translations, and referenced media. Because it includes drafts and private writing, this archive is private. Generation costs 0 credits.",
        )}
      </Dialog.Description>
    </Dialog.Header>

    <div class="space-y-4 py-4">
      {#if loading && !job}
        <div class="flex items-center justify-center p-6 text-muted-foreground">
          <Loader2 class="mr-2 size-6 animate-spin text-primary" />
          <span>{$t("dashboard.pages.exportStatus.loading", "Loading…")}</span>
        </div>
      {:else if latestLoadFailed}
        <div
          data-testid="export-load-failed"
          role="alert"
          class="space-y-3 rounded-lg border border-destructive/20 bg-destructive/5 p-4"
        >
          <div class="flex items-center gap-2 text-destructive">
            <AlertCircle class="size-5 shrink-0" />
            <span class="text-sm font-semibold">
              {$t(
                "dashboard.pages.exportStatus.loadFailed",
                "Couldn't load your export status.",
              )}
            </span>
          </div>
          <Button
            onclick={checkLatestJob}
            variant="outline"
            class="w-full gap-2"
            disabled={loading}
          >
            <RotateCw class="size-4" />
            {$t("dashboard.pages.exportStatus.retry", "Try again")}
          </Button>
        </div>
      {:else if job && isActiveExportStatus(job.status) && pollGaveUp}
        <div
          data-testid="export-poll-failed"
          role="alert"
          class="space-y-3 rounded-lg border border-destructive/20 bg-destructive/5 p-4"
        >
          <div class="flex items-center gap-2 text-destructive">
            <AlertCircle class="size-5 shrink-0" />
            <span class="text-sm font-semibold">
              {$t(
                "dashboard.pages.exportStatus.pollFailed",
                "Couldn't check your export's status. It may still be running.",
              )}
            </span>
          </div>
          <Button
            onclick={checkStatusAgain}
            variant="outline"
            class="w-full gap-2"
          >
            <RotateCw class="size-4" />
            {$t("dashboard.pages.exportStatus.checkAgain", "Check again")}
          </Button>
        </div>
      {:else if job && isActiveExportStatus(job.status)}
        <div
          class="space-y-3 rounded-lg border border-primary/20 bg-primary/5 p-4 text-center"
        >
          <div class="flex items-center justify-center gap-2">
            <Loader2 class="size-6 animate-spin text-primary" />
            <h3 class="font-semibold text-foreground">
              {job.status === "queued"
                ? $t(
                    "dashboard.pages.exportStatus.queued",
                    "Your export is queued…",
                  )
                : $t(
                    "dashboard.pages.exportStatus.running",
                    "Generating your publication archive…",
                  )}
            </h3>
          </div>
          <p class="text-xs text-muted-foreground">
            {$t(
              "dashboard.pages.exportStatus.inProgressNotice",
              "This may take a moment while article Markdown, multilingual variants, and original media assets are bundled.",
            )}
          </p>
          {#if pollRetrying}
            <p
              data-testid="export-poll-retrying"
              class="text-xs text-muted-foreground"
            >
              {$t(
                "dashboard.pages.exportStatus.pollRetrying",
                "Having trouble reaching the server — retrying…",
              )}
            </p>
          {/if}
        </div>
      {:else if job && job.status === "ready" && !job.is_expired}
        <div
          class="space-y-3 rounded-lg border border-green-500/20 bg-green-500/5 p-4"
        >
          <div
            class="flex items-center gap-2 text-green-600 dark:text-green-400"
          >
            <CheckCircle2 class="size-5 shrink-0" />
            <span class="text-sm font-semibold">
              {$t(
                "dashboard.pages.exportStatus.ready",
                "Your publication archive is ready.",
              )}
            </span>
          </div>

          <div
            class="grid grid-cols-2 gap-2 rounded border bg-background/60 p-2.5 text-xs text-muted-foreground"
          >
            <div>
              <span class="font-medium text-foreground">
                {$t("dashboard.pages.exportStatus.articlesLabel", "Articles:")}
              </span>
              {job.article_count}
            </div>
            <div>
              <span class="font-medium text-foreground">
                {$t("dashboard.pages.exportStatus.assetsLabel", "Assets:")}
              </span>
              {job.asset_count}
            </div>
            <div>
              <span class="font-medium text-foreground">
                {$t("dashboard.pages.exportStatus.sizeLabel", "Size:")}
              </span>
              {formatBytes(job.file_size)}
            </div>
            <div class="truncate" title={job.file_name}>
              <span class="font-medium text-foreground">
                {$t("dashboard.pages.exportStatus.fileLabel", "File:")}
              </span>
              {job.file_name}
            </div>
          </div>

          {#if job.warnings && job.warnings.length > 0}
            <div
              class="space-y-1 rounded border border-amber-500/20 bg-amber-500/10 p-2.5"
            >
              <div
                class="flex items-center gap-1.5 text-xs font-semibold text-amber-600 dark:text-amber-400"
              >
                <AlertTriangle class="size-3.5" />
                <span
                  >{$t(
                    "dashboard.pages.exportStatus.warningsTitle",
                    "Export warnings:",
                  )}</span
                >
              </div>
              <ul
                class="list-inside list-disc space-y-0.5 text-xs text-amber-700 dark:text-amber-300"
              >
                {#each job.warnings as warning}
                  <li class="truncate">{warning}</li>
                {/each}
              </ul>
            </div>
          {/if}

          <div class="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Clock class="size-3.5" />
            <span
              >{$t(
                "dashboard.pages.exportStatus.expiresIn",
                "Available for download for 24 hours.",
              )}</span
            >
          </div>

          <div class="space-y-2 pt-2">
            <Button onclick={triggerDownload} class="w-full gap-2 shadow-md">
              <Download class="size-4" />
              {$t("dashboard.pages.exportStatus.download", "Download archive")}
            </Button>
            <Button
              onclick={startExport}
              variant="outline"
              class="w-full gap-2"
              disabled={loading}
            >
              <RotateCw class="size-4" />
              {$t(
                "dashboard.pages.exportStatus.createUpdated",
                "Create updated export",
              )}
            </Button>
          </div>
        </div>
      {:else if job && (job.status === "failed" || job.status === "expired" || job.is_expired)}
        <div
          class="space-y-3 rounded-lg border border-destructive/20 bg-destructive/5 p-4"
        >
          <div class="flex items-center gap-2 text-destructive">
            <AlertCircle class="size-5 shrink-0" />
            <span class="text-sm font-semibold">
              {job.status === "failed"
                ? $t("dashboard.pages.exportStatus.failed", "Export failed")
                : $t(
                    "dashboard.pages.exportStatus.expired",
                    "This export has expired.",
                  )}
            </span>
          </div>
          {#if job.error_message}
            <p class="text-xs text-muted-foreground">{job.error_message}</p>
          {/if}
          <Button
            onclick={startExport}
            variant="outline"
            class="w-full gap-2"
            disabled={loading}
          >
            <RotateCw class="size-4" />
            {job.status === "failed"
              ? $t("dashboard.pages.exportStatus.retry", "Try again")
              : $t(
                  "dashboard.pages.exportStatus.newExport",
                  "Start new export",
                )}
          </Button>
        </div>
      {/if}

      {#if errorMessage}
        <div
          class="flex items-center gap-2 rounded border border-destructive/20 bg-destructive/10 p-2.5 text-xs text-destructive"
        >
          <AlertCircle class="size-4 shrink-0" />
          <span>{errorMessage}</span>
        </div>
      {/if}
    </div>

    <Dialog.Footer class="gap-2 sm:justify-between">
      <Button variant="ghost" onclick={() => (open = false)}>
        {$t("dashboard.pages.exportDialog.cancel", "Cancel")}
      </Button>
      {#if !latestLoadFailed && (!job || (job.status !== "queued" && job.status !== "running" && job.status !== "ready" && !job.is_expired))}
        <Button onclick={startExport} disabled={loading} class="gap-2">
          {#if loading}
            <Loader2 class="size-4 animate-spin" />
          {:else}
            <Download class="size-4" />
          {/if}
          {$t("dashboard.pages.exportDialog.confirm", "Start export")}
        </Button>
      {/if}
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
