<script lang="ts">
  /**
   * The review loop's control strip: which language, how far through
   * the ready ones, what to check, and Publish — then on to the next.
   *
   * Keyboard: `j` next, `k` previous, `p` publish. Only when focus is NOT in
   * something you type into: the translation itself is editable right below
   * this bar, and a shortcut that ate the letter p would be a bug.
   */
  import {
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    Keyboard,
    TriangleAlert,
  } from "@lucide/svelte";
  import * as Tooltip from "$lib/components/ui/tooltip/index.js";
  import { tStore as t } from "$lib/i18n";
  import {
    warningItemText,
    warningLabel,
    type TranslationWarning,
  } from "$lib/translation-jobs";

  interface Props {
    language: string;
    position: number;
    count: number;
    warnings: readonly TranslationWarning[];
    priorWarnings?: readonly TranslationWarning[];
    content: string;
    /**
     * Where a publish of this language is: re-reading the jobs list, waiting
     * on the creator's answer, or writing. While it is anything, the bar
     * stays on this language — Previous, Next and Done wait for it (codex
     * adversarial review: Next mid-publish published the NEXT language).
     */
    phase: null | "checking" | "asking" | "writing";
    published: boolean;
    onPrev: () => void;
    onNext: () => void;
    /**
     * `confirm: true` from the `p` shortcut: a single key press never
     * publishes by itself, it opens the same confirmation a click would.
     */
    onPublish: (options?: { confirm?: boolean }) => void;
    onDone: () => void;
  }

  let {
    language,
    position,
    count,
    warnings,
    priorWarnings = [],
    content,
    phase,
    published,
    onPrev,
    onNext,
    onPublish,
    onDone,
  }: Props = $props();

  let showWarnings = $state(false);
  let showFlaggedText = $state(false);
  const busy = $derived(phase !== null);
  const inlineMatches = $derived.by(() => {
    const text = typeof content === "string" ? content : "";
    const folded = text.toLocaleLowerCase();
    const matches: {
      item: string;
      before: string;
      match: string | null;
      after: string;
    }[] = [];
    for (const warning of warnings) {
      for (const raw of warning.items ?? []) {
        if (matches.length >= 20) return matches;
        const item = warningItemText(raw).slice(0, 200);
        if (!item) continue;
        const start = folded.indexOf(item.toLocaleLowerCase());
        if (start < 0) {
          matches.push({ item, before: "", match: null, after: "" });
          continue;
        }
        const end = start + item.length;
        const contextStart = Math.max(0, start - 48);
        const contextEnd = Math.min(text.length, end + 48);
        matches.push({
          item,
          before: `${contextStart ? "…" : ""}${text.slice(contextStart, start)}`,
          match: text.slice(start, end),
          after: `${contextEnd < text.length ? "…" : ""}${text.slice(end, contextEnd)}`,
        });
      }
    }
    return matches;
  });
  const shortcuts = $derived(
    $t(
      "translationJobs.reviewShortcuts",
      "Shortcuts when you are not typing: j next, k previous, p publish.",
    ),
  );

  function typing(target: EventTarget | null) {
    const node = target as HTMLElement | null;
    if (!node) return false;
    return (
      node.isContentEditable ||
      ["INPUT", "TEXTAREA", "SELECT"].includes(node.tagName)
    );
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing)
      return;
    if (typing(event.target) || document.querySelector('[aria-modal="true"]'))
      return;
    if (busy) return;
    if (event.key === "j" && count > 1) {
      event.preventDefault();
      onNext();
    } else if (event.key === "k" && count > 1) {
      event.preventDefault();
      onPrev();
    } else if (event.key === "p" && !published) {
      event.preventDefault();
      onPublish({ confirm: true });
    }
  }

  const btn =
    "inline-flex min-h-10 min-w-10 items-center justify-center rounded-md border border-border px-2 text-sm hover:bg-muted disabled:opacity-50 sm:px-3";
</script>

<svelte:window onkeydown={onKeydown} />

<section
  class="space-y-2 border-b border-border/60 bg-muted/30 px-4 py-2"
  aria-label={$t("translationJobs.reviewRegion", "Review translation")}
  data-testid="translation-review-bar"
>
  <!-- Desktop: one row, language · n of m · Previous / Next · Publish · Done.
       Phone: the language on its own line, then the four controls on ONE row
       (Previous / Next as icons), every target 40px ( verification). -->
  <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
    <p class="w-full text-sm sm:me-auto sm:w-auto">
      <span class="font-medium">
        {$t("translationJobs.reviewing", "Reviewing {language}", { language })}
      </span>
      {#if count > 1}
        <span class="text-muted-foreground tabular-nums">
          · {$t("translationJobs.reviewPosition", "{position} of {count}", {
            position,
            count,
          })}
        </span>
      {/if}
    </p>
    <div
      class="flex flex-1 flex-nowrap items-center justify-end gap-2 sm:flex-none"
      data-testid="translation-review-controls"
    >
      {#if count > 1}
        <button
          type="button"
          class={btn}
          onclick={onPrev}
          disabled={busy}
          aria-keyshortcuts="k"
          aria-label={$t("translationJobs.previous", "Previous")}
        >
          <ChevronLeft class="size-4 sm:hidden" aria-hidden="true" />
          <span class="hidden sm:inline"
            >{$t("translationJobs.previous", "Previous")}</span
          >
        </button>
        <button
          type="button"
          class={btn}
          onclick={onNext}
          disabled={busy}
          aria-keyshortcuts="j"
          aria-label={$t("translationJobs.next", "Next")}
        >
          <ChevronRight class="size-4 sm:hidden" aria-hidden="true" />
          <span class="hidden sm:inline"
            >{$t("translationJobs.next", "Next")}</span
          >
        </button>
      {/if}
      {#if published}
        <span class="px-2 text-sm text-muted-foreground">
          {$t("editor.variantStatusPublished", "Published")}
        </span>
      {:else}
        <button
          type="button"
          class="inline-flex min-h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          disabled={busy}
          onclick={() => onPublish()}
          aria-keyshortcuts="p"
          data-testid="translation-review-publish"
        >
          <!-- Only a write says "Publishing…": checking the jobs list, or
             waiting on the warnings question, is not publishing yet. -->
          {phase === "writing"
            ? $t("translationJobs.publishing", "Publishing…")
            : phase === "checking"
              ? $t("translationJobs.checking", "Checking…")
              : $t("translationJobs.publish", "Publish")}
        </button>
      {/if}
      <button type="button" class={btn} onclick={onDone} disabled={busy}>
        {$t("translationJobs.doneReviewing", "Done")}
      </button>
      <Tooltip.Root>
        <Tooltip.Trigger
          class="hidden size-10 items-center justify-center rounded-md text-muted-foreground hover:text-foreground md:inline-flex"
          aria-label={shortcuts}
        >
          <Keyboard class="size-4" aria-hidden="true" />
        </Tooltip.Trigger>
        <Tooltip.Content>
          <p>{shortcuts}</p>
        </Tooltip.Content>
      </Tooltip.Root>
    </div>
  </div>
  {#if warnings.length}
    <!-- A compact amber strip that names every flagged item at a glance and
         expands to say what each one is ( review). -->
    <div
      class="rounded-md border border-amber-500/50 bg-amber-500/10 text-sm"
      data-testid="translation-review-warnings"
    >
      <button
        type="button"
        class="flex min-h-10 w-full cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 rounded-md px-3 py-1.5 text-left hover:bg-amber-500/15"
        data-testid="translation-review-warnings-toggle"
        aria-expanded={showWarnings}
        aria-controls="translation-review-warning-list"
        onclick={() => (showWarnings = !showWarnings)}
      >
        <TriangleAlert
          class="size-4 shrink-0 text-amber-700 dark:text-amber-400"
          aria-hidden="true"
        />
        <span class="font-medium">
          {$t("translationJobs.chipFlagged", "Check {count} warnings", {
            count: warnings.length,
          })}
        </span>
        {#each warnings.flatMap((w) => w.items ?? []) as item, itemIndex (itemIndex)}
          <code
            class="rounded bg-amber-500/20 px-1.5 py-0.5 text-xs"
            data-testid="translation-review-warning-item"
            >{warningItemText(item)}</code
          >
        {/each}
        <span
          class="ms-auto inline-flex items-center gap-1 text-xs text-muted-foreground"
        >
          {showWarnings
            ? $t("translationJobs.hideDetails", "Hide details")
            : $t("translationJobs.showDetails", "Details")}
          <ChevronDown
            class="size-4 transition-transform {showWarnings
              ? 'rotate-180'
              : ''}"
            aria-hidden="true"
          />
        </span>
      </button>
      {#if showWarnings}
        <ul
          id="translation-review-warning-list"
          class="list-disc space-y-1 border-t border-amber-500/30 px-3 py-2 ps-8"
        >
          {#each warnings as warning, index (index)}
            <li data-code={warning.code}>
              {warningLabel(warning, $t)}{#if warning.items?.length}:
                <span class="text-muted-foreground"
                  >{warning.items.map(warningItemText).join(", ")}</span
                >{/if}
            </li>
          {/each}
        </ul>
      {/if}
    </div>
    {#if warnings.some((warning) => warning.items?.length)}
      <section
        class="rounded-md border border-amber-500/40 bg-background/70 text-sm"
        data-testid="translation-review-inline-highlights"
      >
        <button
          type="button"
          class="min-h-10 w-full rounded-md px-3 text-left font-medium hover:bg-amber-500/10"
          aria-expanded={showFlaggedText}
          aria-controls="translation-review-inline-matches"
          onclick={() => (showFlaggedText = !showFlaggedText)}
        >
          {$t(
            "translationJobs.flaggedTextInDraft",
            "Find flagged items in the draft",
          )}
        </button>
        {#if showFlaggedText}
          <ul
            id="translation-review-inline-matches"
            class="space-y-1 border-t border-amber-500/30 px-3 py-2"
          >
            {#each inlineMatches as entry, index (`${entry.item}:${index}`)}
              <li
                class="leading-relaxed"
                data-testid="translation-review-inline-match"
              >
                {#if entry.match !== null}
                  <code
                    >{entry.before}<mark
                      class="rounded bg-amber-300 px-0.5 text-foreground dark:bg-amber-600"
                      >{entry.match}</mark
                    >{entry.after}</code
                  >
                {:else}
                  <span
                    >{entry.item}: {$t(
                      "translationJobs.flaggedItemNotFound",
                      "not present verbatim in this draft; compare it with the original",
                    )}</span
                  >
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/if}
  {/if}
  {#if priorWarnings.length}
    <div
      class="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm"
      data-testid="translation-review-prior-warnings"
    >
      <p class="font-medium">
        {$t(
          "translationJobs.priorWarningsLabel",
          "Earlier delivery check (before this draft was edited):",
        )}
      </p>
      <ul class="list-disc space-y-1 ps-5 text-muted-foreground">
        {#each priorWarnings as warning, index (index)}
          <li data-code={warning.code}>
            {warningLabel(warning, $t)}{#if warning.items?.length}:
              {warning.items.map(warningItemText).join(", ")}{/if}
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</section>
