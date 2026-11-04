<script lang="ts">
  /**
   * `Language: English · change` ( Part 7).
   *
   * This replaces the "Article language" `<select>`, which was a
   * create-an-empty-translation button wearing a label's clothes. The chip is
   * only ever a label: pressing "change" opens a picker that renames the
   * article's language and never touches a character of its content.
   *
   * The unset state reads "Detecting…". It never reads "Original (language
   * unknown)", and it never renders a BCP-47 subtag — `und` is an internal
   * sentinel, and dressing one up as prose is exactly the  defect.
   */
  import { tStore as t } from "$lib/i18n";
  import { languageDisplayName } from "$lib/zpage-language.js";

  interface Props {
    language: string | null;
    editingLanguage?: string | null;
    viewerLocale?: string;
    lowConfidence?: boolean;
    disabled?: boolean;
    /** Set when "change" is unavailable, and says why rather than just greying. */
    disabledReason?: string | undefined;
    onchange: () => void;
  }

  let {
    language,
    editingLanguage = null,
    viewerLocale = "en",
    lowConfidence = false,
    disabled = false,
    disabledReason = undefined,
    onchange,
  }: Props = $props();

  const isDisabled = $derived(disabled || Boolean(disabledReason));

  // Null for anything we cannot name, which is what keeps a subtag out of the
  // sentence below. A named language and "Detecting…" are the only two states.
  const name = $derived(languageDisplayName(language, viewerLocale));
  const editingName = $derived(
    languageDisplayName(editingLanguage, viewerLocale),
  );
</script>

<div
  class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
  data-testid="editor-language-chip"
>
  {#if editingName && editingLanguage !== language}
    <span
      >{$t("editor.editingLanguage", "Editing: {language}", {
        language: editingName,
      })}</span
    >
    <span aria-hidden="true">·</span>
  {/if}
  {#if name}
    <span>
      {editingName && editingLanguage !== language
        ? $t("editor.originalLanguage", "Original: {language}", {
            language: name,
          })
        : $t("editor.languageChip", "Language: {language}", { language: name })}
    </span>
  {:else}
    <span aria-live="polite">
      {$t("editor.languageChipDetecting", "Language: Detecting…")}
    </span>
  {/if}

  <span aria-hidden="true">·</span>

  <button
    type="button"
    onclick={onchange}
    disabled={isDisabled}
    title={disabledReason}
    class="rounded underline decoration-dotted underline-offset-2 hover:text-foreground disabled:opacity-50"
  >
    {$t("editor.languageChipChange", "change")}
  </button>

  {#if disabledReason}
    <span class="text-[11px]">{disabledReason}</span>
  {/if}

  {#if lowConfidence && name}
    <!--
      A soft, ignorable prompt — never a modal and never a blocker (
      Part 5). Low confidence is a detector telling the truth about a short or
      mixed-language draft, not an error the creator has to clear.
    -->
    <button
      type="button"
      onclick={onchange}
      disabled={isDisabled}
      class="rounded-full border border-border px-2 py-0.5 text-[11px] hover:bg-muted disabled:opacity-50"
    >
      {$t("editor.languageChipUnsure", "Is this right?")}
    </button>
  {/if}
</div>
