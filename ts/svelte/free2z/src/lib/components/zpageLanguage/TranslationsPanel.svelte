<script lang="ts">
  /**
   * The Translations panel ( Part 7).
   *
   * One row per language this article actually has, with real status and real
   * actions. Rows come from `buildVariantRows`, which is fed by the API — the
   * variants list when it is deployed, `available_languages` otherwise. No
   * four-locale assumption anywhere: a `ja` variant created through the API
   * shows up here.
   *
   * Two invariants this component exists to hold:
   *
   * - **Nothing here is reachable by accident.** "Add a translation" is an
   *   explicit, labelled action that opens a picker; every row action is a
   *   button with a verb on it.  fixed the `<select>` that could blank the
   *   editor, and no control here can regress that.
   * - **"Stale" is whatever the API said.** It is never derived locally. Every
   *   backfilled translation has a NULL `source_digest`, so a locally computed
   *   badge would fire on ~100% of them — the false-positive rate that got
   *   's fallback banner deleted.
   */
  import { tStore as t } from "$lib/i18n";
  import { languageDisplayName } from "$lib/zpage-language.js";
  import type { VariantRow } from "./types";

  interface Props {
    rows: readonly VariantRow[];
    selectedLanguage: string | null;
    viewerLocale?: string;
    busy?: boolean;
    translationBusy?: boolean;
    canAddTranslation?: boolean;
    /**
     * Buy an AI translation into this language ( §6.1). The callback opens
     * a price screen; nothing is charged until the creator confirms there.
     *
     * Still optional, and the reason changed with P8: it is undefined for an
     * article that does not exist on the server yet. There is nothing to
     * quote, price or translate until a draft has been saved once.
     */
    onTranslateWithAi?: ((language: string) => void) | undefined;
    onOpen: (language: string) => void;
    onWrite: (language: string) => void;
    onDelete: (language: string) => void;
    onAddTranslation: () => void;
    /**
     * Languages with a translation running right now. Their row says
     * so and cannot start another; every other row still can.
     */
    activeLanguages?: readonly string[];
    /** "Translate…": several languages at once, where the deployment can. */
    onTranslateMany?: (() => void) | undefined;
  }

  let {
    rows,
    selectedLanguage,
    viewerLocale = "en",
    busy = false,
    translationBusy = false,
    canAddTranslation = true,
    onTranslateWithAi = undefined,
    onOpen,
    onWrite,
    onDelete,
    onAddTranslation,
    activeLanguages = [],
    onTranslateMany = undefined,
  }: Props = $props();

  // Every row action is a real touch target: 40px, not the 22px
  // these buttons used to be.
  const action =
    "inline-flex min-h-10 items-center rounded-md border border-border px-3 hover:bg-muted disabled:opacity-50";

  function statusLabel(row: VariantRow): string {
    switch (row.status) {
      case "source":
        return $t("editor.variantStatusSource", "Source");
      case "published":
        return $t("editor.variantStatusPublished", "Published");
      case "draft":
        return $t("editor.variantStatusDraft", "Draft");
      case "not-started":
        return $t("editor.variantStatusNotStarted", "Not started");
      default:
        // The variants endpoint is not answering, so per-variant publication
        // is genuinely unknown. Say "Written" rather than guess "Published".
        return $t("editor.variantStatusWritten", "Written");
    }
  }

  function originLabel(row: VariantRow): string | null {
    if (row.origin === "ai") return $t("editor.variantOriginAi", "AI");
    return null;
  }
</script>

<section
  class="rounded-md border border-border/60 p-3"
  aria-labelledby="editor-translations-heading"
  data-testid="editor-translations-panel"
>
  <div class="flex flex-wrap items-center justify-between gap-2">
    <h2 id="editor-translations-heading" class="text-sm font-medium">
      {$t("editor.translationsPanelTitle", "Translations")}
    </h2>

    <span class="flex flex-wrap gap-2">
      {#if onTranslateMany}
        <button
          type="button"
          onclick={onTranslateMany}
          disabled={busy}
          class="inline-flex min-h-10 items-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {$t("translationJobs.translateMany", "Translate…")}
        </button>
      {/if}
      {#if canAddTranslation}
        <button
          type="button"
          onclick={onAddTranslation}
          disabled={busy}
          class="{action} text-xs"
        >
          {$t("editor.addTranslationAction", "Add a translation")}
        </button>
      {/if}
    </span>
  </div>

  <ul class="mt-2 divide-y divide-border/50">
    {#each rows as row (row.language)}
      {@const name =
        languageDisplayName(row.language, viewerLocale) ??
        (row.isSource
          ? $t("editor.languageChipDetectingShort", "Detecting…")
          : // A real language whose name this browser's CLDR data does not
            // carry. Dropping the row would make the variant invisible — and
            // therefore impossible to open or delete — which is a worse
            // outcome than showing its tag. The  rule is about *prose*
            // ("showing the und version"); in a management table the tag is
            // the variant's identity, and it is labelled as a code.
            $t("editor.variantUnnamedLanguage", "Language code {tag}", {
              tag: row.language,
            }))}
      {#if name}
        <li
          class="flex flex-wrap items-center justify-between gap-2 py-1.5 text-xs"
          data-language={row.language}
        >
          <span class="flex flex-wrap items-center gap-2">
            <span class="font-medium text-foreground">{name}</span>
            <span class="text-muted-foreground">{statusLabel(row)}</span>
            {#if originLabel(row)}
              <span
                class="rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground"
                >{originLabel(row)}</span
              >
            {/if}
            {#if activeLanguages.includes(row.language)}
              <span
                class="inline-flex items-center gap-1 rounded-full border border-primary/40 px-1.5 py-0.5 text-[10px] text-foreground"
                data-testid="variant-translating"
              >
                <span
                  class="size-1.5 rounded-full bg-primary motion-safe:animate-pulse"
                  aria-hidden="true"
                ></span>
                {$t("translationJobs.chipQueuedShort", "Translating")}
              </span>
            {/if}
            {#if row.isStale}
              <span
                class="rounded-full border border-amber-500/50 px-1.5 py-0.5 text-[10px] text-amber-600 dark:text-amber-400"
                data-testid="variant-stale"
              >
                {$t("editor.variantStatusStale", "Stale")}
              </span>
            {/if}
            {#if row.language === selectedLanguage}
              <!--
                A label for the row you are on, not an invitation to do
                anything. "open now" read as an imperative — "open, now" —
                on the one row where opening is the thing you cannot do
                .
              -->
              <span class="text-muted-foreground"
                >{$t("editor.variantOpenNow", "currently editing")}</span
              >
            {/if}
          </span>

          <span class="flex flex-wrap items-center gap-1.5">
            {#if row.language === selectedLanguage}
              <!-- Already open: no navigation action to offer. -->
            {:else if row.exists}
              <button
                type="button"
                onclick={() => onOpen(row.navigateAs)}
                disabled={busy}
                class={action}
              >
                {$t("editor.variantEdit", "Edit")}
              </button>
            {:else}
              <button
                type="button"
                onclick={() => onWrite(row.navigateAs)}
                disabled={busy}
                class={action}
              >
                {$t("editor.variantWrite", "Write")}
              </button>
            {/if}

            {#if !row.isSource}
              <!--
                Live P8. No price is shown HERE on purpose: pricing
                is cost-plus and metered, so the figure only exists once the
                quote endpoint has been asked about this exact article. A
                number rendered in a row would be an invented one, and the
                whole money contract is that the creator sees the real price
                before committing — which is what this button opens.
              -->
              <button
                type="button"
                onclick={() => onTranslateWithAi?.(row.navigateAs)}
                disabled={busy ||
                  translationBusy ||
                  activeLanguages.includes(row.language) ||
                  !onTranslateWithAi}
                title={onTranslateWithAi
                  ? undefined
                  : $t(
                      "editor.variantTranslateAiNeedsSaveHint",
                      "Save this article first — there is nothing to translate yet.",
                    )}
                class={action}
              >
                {row.origin === "ai"
                  ? // Offering "Translate with AI" on a row that already says
                    // "AI" invites the creator to buy what they just bought.
                    // Re-translating after editing the original is a real and
                    // legitimate action, so the button stays — it just stops
                    // pretending this is the first time.
                    $t("editor.variantTranslateAiAgain", "Translate again")
                  : $t("editor.variantTranslateAi", "Translate with AI")}
              </button>
            {/if}

            {#if row.canDelete && row.exists}
              <button
                type="button"
                onclick={() => onDelete(row.navigateAs)}
                disabled={busy}
                class="inline-flex min-h-10 items-center rounded-md border border-destructive/40 px-3 text-destructive hover:bg-destructive/10 disabled:opacity-50"
              >
                {$t("editor.variantDelete", "Delete")}
              </button>
            {/if}
          </span>
        </li>
      {/if}
    {/each}
  </ul>
</section>
