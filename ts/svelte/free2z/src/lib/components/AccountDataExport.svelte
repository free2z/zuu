<script lang="ts">
  import { onMount } from "svelte";
  import { authStore } from "$lib/stores/auth";
  import { tStore as t } from "$lib/i18n";
  import { ApiError } from "$lib/api/mutator";
  import {
    accountDataExportCreate,
    accountDataExportLatest,
    accountDataExportRetrieve,
    accountDataExportDownload,
  } from "$lib/api/exports/exports";
  import type { AccountExport } from "$lib/api/f2z.schemas";

  export let enabled = false;
  export let reauthenticate: () => void;
  let job: AccountExport | null = null;
  let busy = false;
  let error = "";
  let needsReauth = false;
  let owner: number | null = null;
  let revision = 0;
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let objectUrl: string | null = null;

  function reset() {
    revision++;
    controller?.abort();
    controller = null;
    clearTimeout(timer);
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
    job = null;
    busy = false;
    error = "";
    needsReauth = false;
  }
  onMount(() => {
    let ownership = authStore.captureRequestOwnership();
    const unsubscribe = authStore.subscribe((state) => {
      const next =
        enabled && state.status === "authenticated"
          ? (state.creator?.id ?? null)
          : null;
      if (next !== owner || !ownership()) {
        reset();
        owner = next;
        ownership = authStore.captureRequestOwnership();
        if (owner !== null) void latest();
      }
    });
    return () => {
      unsubscribe();
      reset();
    };
  });
  function start() {
    controller?.abort();
    controller = new AbortController();
    const version = ++revision;
    const owns = authStore.captureRequestOwnership();
    return {
      signal: controller.signal,
      current: () => version === revision && owns() && owner !== null,
    };
  }
  function failure(e: unknown, current: () => boolean) {
    if (!current() || (e instanceof Error && e.name === "AbortError")) return;
    if (
      e instanceof ApiError &&
      e.status === 401 &&
      e.data?.code === "insufficient_user_authentication"
    )
      needsReauth = true;
    else
      error = $t(
        "account.export.failed",
        "The export could not be completed. Please try again.",
      );
  }
  function schedule(value: AccountExport) {
    clearTimeout(timer);
    if (value.status === "queued" || value.status === "running")
      timer = setTimeout(() => void refresh(value.id), 3000);
  }
  async function latest() {
    const op = start();
    try {
      const result = await accountDataExportLatest(undefined, op.signal);
      if (!op.current()) return;
      job = result.export;
      if (job) schedule(job);
    } catch (e) {
      failure(e, op.current);
    }
  }
  async function refresh(id: string) {
    const op = start();
    try {
      const result = await accountDataExportRetrieve(id, undefined, op.signal);
      if (!op.current() || result.id !== id) return;
      job = result;
      schedule(result);
    } catch (e) {
      failure(e, op.current);
    }
  }
  async function create() {
    const op = start();
    busy = true;
    error = "";
    needsReauth = false;
    try {
      const result = await accountDataExportCreate(undefined, op.signal);
      if (!op.current()) return;
      job = result;
      schedule(result);
    } catch (e) {
      failure(e, op.current);
    } finally {
      if (op.current()) busy = false;
    }
  }
  async function download() {
    if (!job?.download_token) return;
    const id = job.id,
      token = job.download_token;
    const op = start();
    busy = true;
    error = "";
    try {
      let blob: Blob;
      try {
        blob = await accountDataExportDownload(
          id,
          { headers: { "X-Account-Export-Signature": token } },
          op.signal,
        );
      } catch (e) {
        if (!op.current()) return;
        if (!(e instanceof ApiError) || ![404, 410].includes(e.status)) throw e;
        const updated = await accountDataExportRetrieve(
          id,
          undefined,
          op.signal,
        );
        if (!op.current() || updated.id !== id) return;
        job = updated;
        if (!updated.download_token || updated.status !== "ready") {
          error = $t(
            "account.export.expired",
            "This archive is no longer available.",
          );
          return;
        }
        blob = await accountDataExportDownload(
          id,
          { headers: { "X-Account-Export-Signature": updated.download_token } },
          op.signal,
        );
      }
      if (!op.current() || job?.id !== id) return;
      objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = job.file_name || "account-data.zip";
      link.click();
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    } catch (e) {
      failure(e, op.current);
    } finally {
      if (op.current()) busy = false;
    }
  }
</script>

{#if enabled && owner !== null}
  <section class="space-y-2 rounded-lg border p-4" data-testid="account-export">
    <h2 class="font-medium">
      {$t("account.export.title", "Download your account data")}
    </h2>
    <p>
      {$t(
        "account.export.partial",
        "This archive is partial. Some sensitive identity, shared and operational records are excluded. The manifest explains its coverage. No email is required.",
      )}
    </p>
    <p>
      {$t(
        "account.export.limits",
        "Archives are size and time limited, and expire after 24 hours. Download links expire after 15 minutes.",
      )}
    </p>
    {#if job}
      <p data-testid="account-export-status">{job.status}</p>
      {#if !job.complete && job.status === "ready"}<p role="status">
          {$t(
            "account.export.incomplete",
            "This archive is incomplete; review its warnings and manifest.",
          )}
        </p>{/if}
      {#each job.warnings as warning}<p>{warning}</p>{/each}
      {#if job.status === "ready" && job.download_token}<button
          type="button"
          disabled={busy}
          onclick={download}
          >{$t("account.export.download", "Download archive")}</button
        >{/if}
    {/if}
    {#if !job || job.status === "failed" || job.status === "expired"}<button
        type="button"
        disabled={busy}
        onclick={create}
        >{$t("account.export.request", "Request export")}</button
      >{/if}
    {#if needsReauth}<button type="button" onclick={reauthenticate}
        >{$t("account.export.reauth", "Sign in again")}</button
      >{/if}
    {#if error}<p role="alert">{error}</p>{/if}
  </section>
{/if}
