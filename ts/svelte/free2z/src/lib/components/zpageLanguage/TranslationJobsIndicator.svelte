<script lang="ts">
  /**
   * "3 ready to review · 1 translating · 2 need attention" — the one-line
   * answer to "how are my translations?", and the ONE way into the tray
   * (review).
   *
   * In the editor it is always there (`always`), labelled "Translations" when
   * there is nothing to report, because it is the entry point and failed jobs
   * must stay reachable. Elsewhere it only appears when there is news.
   *
   * On a phone each state is an icon and a count, never one mixed number.
   */
  import {
    CircleAlert,
    CircleCheck,
    Languages,
    LoaderCircle,
  } from "@lucide/svelte";
  import { tStore as t } from "$lib/i18n";
  import { summaryText, type TraySummary } from "$lib/translation-jobs";

  interface Props {
    summary: Pick<TraySummary, "active" | "ready" | "attention">;
    onopen: () => void;
    /** Render even with nothing to report (the editor's entry point). */
    always?: boolean;
    class?: string;
  }

  let {
    summary,
    onopen,
    always = false,
    class: className = "",
  }: Props = $props();

  const text = $derived(summaryText(summary, $t));
  const visible = $derived(
    always || summary.active > 0 || summary.ready > 0 || summary.attention > 0,
  );
</script>

{#if visible}
  <button
    type="button"
    onclick={onopen}
    class="inline-flex min-h-10 min-w-10 shrink-0 items-center justify-center gap-2 rounded-full border border-border px-3 text-xs tabular-nums hover:bg-muted {className}"
    data-testid="translation-jobs-indicator"
    aria-label={$t(
      "translationJobs.indicatorLabel",
      "{status}. Open the translation tray.",
      {
        status: text || $t("editor.translationsPanelTitle", "Translations"),
      },
    )}
  >
    <Languages class="size-4" aria-hidden="true" />
    <!-- Wide: the sentence. Narrow: an icon and a count per state. -->
    <span aria-hidden="true" class="hidden sm:inline"
      >{text || $t("editor.translationsPanelTitle", "Translations")}</span
    >
    <span aria-hidden="true" class="inline-flex items-center gap-2 sm:hidden">
      {#if summary.ready}
        <span class="inline-flex items-center gap-0.5"
          ><CircleCheck class="size-3.5 text-primary" />{summary.ready}</span
        >
      {/if}
      {#if summary.active}
        <span class="inline-flex items-center gap-0.5"
          ><LoaderCircle
            class="size-3.5 motion-safe:animate-spin"
          />{summary.active}</span
        >
      {/if}
      {#if summary.attention}
        <span class="inline-flex items-center gap-0.5"
          ><CircleAlert
            class="size-3.5 text-destructive"
          />{summary.attention}</span
        >
      {/if}
    </span>
  </button>
{/if}
