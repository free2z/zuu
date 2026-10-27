<script lang="ts">
  /**
   * The translations tray: every language of one article, live — the
   * ONE place for translations ( review). Running jobs, drafts to
   * review, failures to retry, and the translations that already exist.
   *
   * It docks to the right on a wide screen and rises from the bottom on a
   * phone. Calm, not chatty: elapsed clocks tick silently, and the only
   * live-region text is the summary line, which changes when a job does.
   * Status changes are announced once each, by the toast that offers Review.
   *
   * A row the translation check flagged ( warnings) looks different and
   * has no Publish: it is reviewed, by itself, first.
   */
  import { onDestroy } from "svelte";
  import { Ellipsis } from "@lucide/svelte";
  import { tStore as t } from "$lib/i18n";
  import { focusTrap } from "$lib/focus-trap";
  import {
    formatElapsed,
    summarizeTray,
    summaryText,
    trayRows,
    type DraftRecord,
    type TrayRow,
    type TrayRowKind,
    type TrayVariant,
    type TranslationJobEntry,
  } from "$lib/translation-jobs";

  interface Props {
    open: boolean;
    /**
     * Another modal (a confirmation, the "Translate…" dialog) is open on top.
     * Only ONE surface may be the modal: this one steps back — inert and out
     * of the accessibility tree — until it closes.
     */
    covered?: boolean;
    jobs: readonly TranslationJobEntry[];
    /** The article's saved languages (the old Translations panel's rows). */
    variants?: readonly TrayVariant[];
    /** What each language's current draft was written by, and its warnings. */
    drafts?: Readonly<Record<string, DraftRecord>>;
    loading?: boolean;
    error?: boolean;
    /** Several languages in one purchase are possible on this deployment. */
    canTranslateMany?: boolean;
    /** The article exists server-side, so it can be translated at all. */
    canTranslate?: boolean;
    /** A language can be added and written by hand. */
    canAddTranslation?: boolean;
    /** Languages with a publish in flight. */
    publishing?: ReadonlySet<string>;
    label: (language: string) => string;
    onTranslate: (initial?: string[]) => void;
    onReview: (language: string) => void;
    onOpen: (language: string) => void;
    onPublish: (language: string) => void;
    onPublishAll: () => void;
    onDelete: (language: string) => void;
    onAddTranslation?: () => void;
    onCheckAgain: (language: string) => void;
    onRefresh: () => void;
    onclose: () => void;
    /**
     * A purchase whose answer was lost is waiting to be re-sent. The tray
     * says so too: on a wide screen it covers the editor's own notice.
     */
    unresolvedPurchase?: boolean;
    onResend?: () => void;
  }

  let {
    open,
    covered = false,
    jobs,
    variants = [],
    drafts = {},
    loading = false,
    error = false,
    canTranslateMany = false,
    canTranslate = true,
    canAddTranslation = false,
    publishing = new Set(),
    label,
    onTranslate,
    onReview,
    onOpen,
    onPublish,
    onPublishAll,
    onDelete,
    onAddTranslation,
    onCheckAgain,
    onRefresh,
    onclose,
    unresolvedPurchase = false,
    onResend,
  }: Props = $props();

  const ORDER: Record<TrayRowKind, number> = {
    flagged: 0,
    ready: 0,
    translating: 1,
    queued: 2,
    failed: 3,
    draft: 4,
    unknown: 5,
    published: 6,
  };

  let now = $state(Date.now());
  let expanded = $state<string | null>(null);
  let menuFor = $state<string | null>(null);
  const rows = $derived(
    trayRows({ jobs, variants, drafts, now }).sort(
      (a, b) =>
        ORDER[a.kind] - ORDER[b.kind] ||
        label(a.language).localeCompare(label(b.language)),
    ),
  );
  const summary = $derived(summarizeTray(rows));

  // One clock for every row, and only while something is running.
  let ticker: ReturnType<typeof setInterval> | null = null;
  $effect(() => {
    const running = open && summary.active > 0;
    if (running && !ticker) {
      now = Date.now();
      ticker = setInterval(() => (now = Date.now()), 1000);
    } else if (!running && ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  });
  onDestroy(() => ticker && clearInterval(ticker));

  function chipText(row: TrayRow) {
    switch (row.kind) {
      case "queued":
        return $t("translationJobs.chipQueued", "Queued");
      case "translating":
        return $t("translationJobs.chipTranslating", "Translating {elapsed}", {
          elapsed: formatElapsed(row.elapsedMs ?? 0),
        });
      case "ready":
        return $t("translationJobs.chipReady", "Ready to review");
      case "flagged":
        return $t("translationJobs.chipFlagged", "Check {count} warnings", {
          count: row.warnings,
        });
      case "draft":
        return $t("editor.variantStatusDraft", "Draft");
      case "published":
        return $t("editor.variantStatusPublished", "Published");
      case "failed":
        return row.failure === "settled"
          ? $t("translationJobs.chipStopped", "Stopped: the article changed")
          : $t("translationJobs.chipRefunded", "Failed, refunded");
      default:
        return $t("translationJobs.chipUnknown", "Checking…");
    }
  }

  const CHIP_CLASS: Record<TrayRowKind, string> = {
    queued: "border-border text-muted-foreground",
    translating: "border-primary/40 text-foreground",
    ready: "border-primary bg-primary/10 text-foreground",
    flagged:
      "border-amber-500/60 bg-amber-500/15 text-amber-800 dark:text-amber-300",
    draft: "border-border text-muted-foreground",
    published: "border-border text-muted-foreground",
    failed: "border-destructive/40 text-destructive",
    unknown: "border-border text-muted-foreground",
  };

  const SEGMENT_CLASS: Record<TrayRowKind, string> = {
    queued: "bg-muted-foreground/30",
    translating: "bg-primary/40 motion-safe:animate-pulse",
    ready: "bg-primary",
    flagged: "bg-amber-500",
    draft: "bg-muted-foreground/40",
    published: "bg-primary/60",
    failed: "bg-destructive/60",
    unknown: "bg-muted",
  };

  /** One sentence. The amounts are the job's own record. */
  function failureSentence(job: TranslationJobEntry | null) {
    if (!job) return "";
    return job.status === "settled"
      ? $t(
          "translationJobs.failedSettled",
          "{refunded} of {price} 2Z are back; {billed} 2Z cover the work done.",
          {
            price: job.price ?? "",
            refunded: job.refunded ?? "0",
            billed: job.billed ?? "0",
          },
        )
      : $t(
          "translationJobs.failedRefunded",
          "All {price} 2Z are back in your balance.",
          { price: job.price ?? "" },
        );
  }

  function trayKeydown(event: KeyboardEvent) {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    if (menuFor) menuFor = null;
    else onclose();
  }

  const primary =
    "inline-flex min-h-10 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50";
  const secondary =
    "inline-flex min-h-10 items-center justify-center rounded-md border border-border px-3 text-sm hover:bg-muted disabled:opacity-50";
</script>

{#if open}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <!-- A dialog, because it traps focus ( verification): a screen reader
       must be told the rest of the page is out of reach while it is open. -->
  <div
    role="dialog"
    aria-modal={covered ? undefined : "true"}
    aria-hidden={covered ? "true" : undefined}
    inert={covered}
    aria-labelledby="translation-tray-title"
    tabindex="-1"
    use:focusTrap
    onkeydown={trayKeydown}
    data-testid="translation-tray"
    class="fixed inset-x-0 bottom-0 z-50 flex max-h-[75dvh] flex-col rounded-t-xl border-t border-border bg-background shadow-2xl outline-none motion-safe:animate-in motion-safe:slide-in-from-bottom md:inset-x-auto md:top-0 md:right-0 md:bottom-0 md:max-h-none md:w-[400px] md:rounded-none md:border-t-0 md:border-l md:motion-safe:slide-in-from-right"
  >
    <header class="space-y-3 border-b border-border/60 p-4">
      <div class="flex items-center justify-between gap-3">
        <h2 id="translation-tray-title" class="text-base font-semibold">
          {$t("editor.translationsPanelTitle", "Translations")}
        </h2>
        <button
          type="button"
          class="inline-flex size-10 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
          aria-label={$t("common.close", "Close")}
          onclick={onclose}
        >
          <span aria-hidden="true" class="text-lg leading-none">×</span>
        </button>
      </div>

      {#if rows.length}
        <div class="space-y-1.5">
          <!-- The one live line: it changes when a job does. -->
          <p
            class="text-sm text-muted-foreground"
            aria-live="polite"
            data-testid="translation-tray-summary"
          >
            {summaryText(summary, $t) ||
              $t("translationJobs.summaryAllPublished", "All published")}
          </p>
          <div
            class="flex h-1.5 gap-0.5 overflow-hidden rounded-full"
            aria-hidden="true"
          >
            {#each rows as row (row.language)}
              <span
                class="h-full flex-1 transition-colors duration-500 {SEGMENT_CLASS[
                  row.kind
                ]}"
              ></span>
            {/each}
          </div>
        </div>
      {/if}

      {#if unresolvedPurchase && onResend}
        <div
          role="status"
          class="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs"
          data-testid="translation-tray-unresolved"
        >
          <p>
            {$t(
              "translationJobs.unresolvedBulk",
              "A translation purchase was not confirmed. Re-send it to find out — this never charges twice.",
            )}
          </p>
          <button type="button" class={secondary} onclick={onResend}>
            {$t("translationJobs.resend", "Re-send purchase")}
          </button>
        </div>
      {/if}

      <div class="flex flex-wrap gap-2">
        {#if canTranslate}
          <button
            type="button"
            class={primary}
            onclick={() => onTranslate()}
            data-testid="translation-tray-translate"
          >
            {canTranslateMany
              ? $t("translationJobs.translateMany", "Translate…")
              : $t("translationJobs.translateOne", "Translate with AI…")}
          </button>
        {/if}
        {#if canAddTranslation && onAddTranslation}
          <button
            type="button"
            class={secondary}
            onclick={onAddTranslation}
            data-testid="translation-tray-add"
          >
            {$t("editor.addTranslationAction", "Add a translation")}
          </button>
        {/if}
        {#if summary.clean && summary.ready > 1}
          <button
            type="button"
            class={secondary}
            onclick={onPublishAll}
            data-testid="translation-tray-publish-all"
          >
            {$t("translationJobs.publishAll", "Publish all ready ({count})", {
              count: summary.clean,
            })}
          </button>
        {/if}
      </div>
    </header>

    <div class="flex-1 overflow-y-auto">
      {#if error && !rows.length}
        <div class="space-y-3 p-6 text-center text-sm">
          <p>
            {$t(
              "translationJobs.loadFailed",
              "Could not load this article's translations.",
            )}
          </p>
          <button type="button" class={secondary} onclick={onRefresh}>
            {$t("translationJobs.tryAgain", "Try again")}
          </button>
        </div>
      {:else if loading && !rows.length}
        <ul
          class="space-y-3 p-4"
          aria-busy="true"
          aria-label={$t(
            "translationJobs.loading",
            "Checking for translations…",
          )}
        >
          {#each [0, 1, 2] as placeholder (placeholder)}
            <li
              class="h-11 rounded-md bg-muted/60 motion-safe:animate-pulse"
            ></li>
          {/each}
        </ul>
      {:else if !rows.length}
        <div class="space-y-2 p-6 text-center">
          <p class="text-sm font-medium">
            {$t("translationJobs.emptyTitle", "No translations yet")}
          </p>
          <p class="text-sm text-muted-foreground">
            {canTranslate
              ? $t(
                  "translationJobs.emptyBody",
                  "Pick as many languages as you like. They translate side by side while you keep writing, and each one waits here for your review.",
                )
              : $t(
                  "editor.variantTranslateAiNeedsSaveHint",
                  "Save this article first — there is nothing to translate yet.",
                )}
          </p>
        </div>
      {:else}
        <ul
          class="divide-y divide-border/50"
          data-testid="translation-tray-rows"
        >
          {#each rows as row (row.language)}
            {@const job = row.job}
            <li
              class="space-y-2 px-4 py-3"
              data-language={row.language}
              data-status={row.kind}
            >
              <div class="flex items-center justify-between gap-3">
                <span class="font-medium">{label(row.language)}</span>
                <span
                  class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs tabular-nums transition-colors duration-500 {CHIP_CLASS[
                    row.kind
                  ]}"
                  data-testid={row.kind === "flagged"
                    ? "translation-tray-warnings"
                    : "translation-chip"}
                >
                  {#if row.kind === "translating" || row.kind === "queued"}
                    <span
                      class="size-1.5 rounded-full bg-primary motion-safe:animate-pulse"
                      aria-hidden="true"
                    ></span>
                  {/if}
                  {chipText(row)}
                </span>
              </div>

              {#if (row.kind === "translating" || row.kind === "queued") && job && (job.interrupted || !job.watching)}
                <p class="text-xs text-muted-foreground">
                  {job.interrupted
                    ? $t(
                        "translationJobs.reconnecting",
                        "Lost the connection for a moment. Still checking — nothing is bought twice.",
                      )
                    : $t(
                        "translationJobs.notWatching",
                        "Still running on our side. Check again to see if it is done.",
                      )}
                </p>
              {/if}
              {#if row.kind === "failed"}
                <p
                  class="text-xs text-muted-foreground"
                  data-testid="translation-failure"
                >
                  {failureSentence(job)}
                </p>
              {/if}

              <div class="flex flex-wrap items-center gap-2">
                {#if row.kind === "ready" || row.kind === "flagged"}
                  <button
                    type="button"
                    class={primary}
                    onclick={() => onReview(row.language)}
                  >
                    {$t("translationJobs.review", "Review")}
                  </button>
                {:else if row.kind === "draft"}
                  <button
                    type="button"
                    class={primary}
                    onclick={() => onOpen(row.language)}
                  >
                    {$t("translationJobs.open", "Open")}
                  </button>
                {:else if row.kind === "published"}
                  <button
                    type="button"
                    class={secondary}
                    onclick={() => onOpen(row.language)}
                  >
                    {$t("translationJobs.open", "Open")}
                  </button>
                {:else if row.kind === "failed"}
                  <button
                    type="button"
                    class={primary}
                    onclick={() => onTranslate([row.language])}
                  >
                    {$t("translationJobs.retry", "Retry")}
                  </button>
                  {#if row.hasDraft}
                    <button
                      type="button"
                      class={secondary}
                      onclick={() => onOpen(row.language)}
                    >
                      {$t("translationJobs.openDraft", "Open the saved draft")}
                    </button>
                  {/if}
                  {#if job?.attempted_output_preview}
                    <button
                      type="button"
                      class="inline-flex min-h-10 items-center px-1 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                      aria-expanded={expanded === row.language}
                      onclick={() =>
                        (expanded =
                          expanded === row.language ? null : row.language)}
                    >
                      {expanded === row.language
                        ? $t(
                            "translationJobs.hideAttempt",
                            "Hide what the AI wrote",
                          )
                        : $t(
                            "translationJobs.showAttempt",
                            "See what the AI wrote",
                          )}
                    </button>
                  {/if}
                {:else if (row.kind === "translating" || row.kind === "queued") && job && !job.watching}
                  <button
                    type="button"
                    class={secondary}
                    onclick={() => onCheckAgain(row.language)}
                  >
                    {$t(
                      "editor.translationReconnect",
                      "Check translation status",
                    )}
                  </button>
                {/if}
                {#if (row.kind === "ready" || row.kind === "draft") && !row.warnings}
                  <button
                    type="button"
                    class={secondary}
                    disabled={publishing.has(row.language)}
                    onclick={() => onPublish(row.language)}
                  >
                    {publishing.has(row.language)
                      ? $t("translationJobs.publishing", "Publishing…")
                      : $t("translationJobs.publish", "Publish")}
                  </button>
                {/if}
                {#if row.canDelete && row.kind !== "translating" && row.kind !== "queued"}
                  <div class="relative ms-auto">
                    <button
                      type="button"
                      class="inline-flex size-10 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                      aria-haspopup="menu"
                      aria-expanded={menuFor === row.language}
                      aria-label={$t(
                        "translationJobs.moreFor",
                        "More for {language}",
                        { language: label(row.language) },
                      )}
                      onclick={() =>
                        (menuFor =
                          menuFor === row.language ? null : row.language)}
                    >
                      <Ellipsis class="size-4" aria-hidden="true" />
                    </button>
                    {#if menuFor === row.language}
                      <div
                        role="menu"
                        class="absolute end-0 top-11 z-10 min-w-40 rounded-md border border-border bg-background p-1 shadow-lg"
                      >
                        <button
                          type="button"
                          role="menuitem"
                          class="flex min-h-10 w-full items-center rounded px-3 text-sm text-destructive hover:bg-destructive/10"
                          onclick={() => {
                            menuFor = null;
                            onDelete(row.language);
                          }}
                        >
                          {$t("editor.variantDelete", "Delete")}
                        </button>
                      </div>
                    {/if}
                  </div>
                {/if}
              </div>
              {#if row.kind === "failed" && expanded === row.language && job?.attempted_output_preview}
                <pre
                  class="max-h-48 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap"
                  lang={row.language}>{job.attempted_output_preview}</pre>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </div>
{/if}
