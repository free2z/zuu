<script lang="ts">
  /**
   * AI tag suggestions, as chips the creator accepts or rejects.
   *
   * The `zpage-tag` Deployment used to write its output straight onto the
   * article. It now writes `TagSuggestion` rows and this is where they surface:
   * nothing a machine proposed becomes a tag until somebody clicks it.
   *
   * Broad and narrow are rendered as two groups. The distinction is not
   * a stored attribute — the API derives it from how many published zPages
   * carry the tag, so `crypto` and `halo2 recursion` sort themselves out with
   * no taxonomy to maintain. Broad first, because that is the browse
   * vocabulary; narrow after, because that is where the long tail lives, and
   * both are worth having.
   *
   * Failure is silent by design. Suggestions are a convenience on top of a tag
   * input that works perfectly well without them, so a 404 (no such page yet),
   * a 401, or a dead network renders nothing rather than an error the creator
   * can do nothing about.
   */
  import Check from "@lucide/svelte/icons/check";
  import Sparkles from "@lucide/svelte/icons/sparkles";
  import X from "@lucide/svelte/icons/x";
  import { tStore as t, formatLocalizedNumber, locale } from "$lib/i18n";
  import { mergeTags } from "$lib/tags.js";
  import {
    taggingZpageSuggestionsDecideCreate,
    taggingZpageSuggestionsList,
  } from "$lib/api/tagging/tagging";
  import type { ZPageTagSuggestion } from "$lib/api/f2z.schemas";

  let {
    free2zaddr = "",
    tags = $bindable<string[]>([]),
    disabled = false,
    onServerWrote = undefined,
  }: {
    free2zaddr?: string;
    tags: string[];
    disabled?: boolean;
    /**
     * Called after the decide endpoint has written this article's tags.
     *
     * Accepting a suggestion is a canonical write that does not go through
     * the editor's save path, so the editor's optimistic-concurrency
     * validator is stale the moment it returns. Without this the very
     * next autosave 412s and the editor latches into "somebody else saved
     * this article" over a change the creator made in this same tab — and the
     * only way out is a reload that discards their unsaved work.
     * (codex adversarial review.)
     */
    onServerWrote?: () => void;
  } = $props();

  let suggestions = $state<ZPageTagSuggestion[]>([]);
  let busy = $state<string[]>([]);
  let loadedFor = $state("");

  const broad = $derived(suggestions.filter((s) => s.level === "broad"));
  const narrow = $derived(suggestions.filter((s) => s.level === "narrow"));

  async function load(id: string) {
    if (!id) {
      suggestions = [];
      return;
    }
    try {
      const rows = await taggingZpageSuggestionsList(id);
      // A stale response for a page the editor has already navigated away
      // from must not repaint the current one.
      if (loadedFor !== id) return;
      suggestions = Array.isArray(rows) ? rows : [];
    } catch {
      if (loadedFor === id) suggestions = [];
    }
  }

  $effect(() => {
    const id = free2zaddr;
    if (id === loadedFor) return;
    loadedFor = id;
    suggestions = [];
    void load(id);
  });

  async function decide(name: string, accept: boolean) {
    // The page this request is FOR, captured before any await. The editor
    // survives navigation between `/edit` URLs, so without this the response
    // for article A can land while article B is open — and since the response
    // carries A's authoritative tag list, applying it would merge A's tags into
    // B and the next autosave would write them there. The GET path has the same
    // guard; a mutation needs it more, not less.
    const id = free2zaddr;
    if (!id || busy.includes(name)) return;
    busy = [...busy, name];
    // Optimistic removal. The chip is gone the moment it is clicked; if the
    // request fails the reload below puts it back, and a still-pending
    // suggestion reappearing is a far better outcome than a chip that ignores
    // clicks while the network thinks about it.
    suggestions = suggestions.filter((row) => row.name !== name);
    try {
      const result = await taggingZpageSuggestionsDecideCreate(id, {
        accept: accept ? [name] : [],
        dismiss: accept ? [] : [name],
      });
      if (loadedFor !== id) return;
      // The server's tag list is authoritative — it has just written it — but
      // merge rather than replace so a tag the creator typed in this same tick
      // and has not saved yet is not thrown away.
      if (Array.isArray(result?.tags)) {
        tags = mergeTags(tags, result.tags).tags;
      }
      if (Array.isArray(result?.suggestions)) {
        suggestions = result.suggestions;
      }
      // Only an ACCEPT writes the article. A dismissal updates the
      // `TagSuggestion` row and leaves the zPage — and its validator —
      // untouched, so signalling here would drop a still-valid validator and
      // put the next autosave on the wire unconditioned. `dismissAll` does not
      // call this at all, which is the same statement. (codex adversarial
      // review.)
      if (accept) onServerWrote?.();
    } catch {
      if (loadedFor === id) await load(id);
    } finally {
      busy = busy.filter((item) => item !== name);
    }
  }

  async function dismissAll() {
    const id = free2zaddr;
    const names = suggestions.map((row) => row.name);
    if (!id || names.length === 0) return;
    suggestions = [];
    try {
      await taggingZpageSuggestionsDecideCreate(id, { dismiss: names });
    } catch {
      if (loadedFor === id) await load(id);
    }
  }
</script>

{#if suggestions.length > 0}
  <div class="space-y-2 rounded-md border border-dashed border-border p-3">
    <div class="flex items-center justify-between gap-2">
      <span
        class="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground"
      >
        <Sparkles class="size-3.5" aria-hidden="true" />
        {$t("editor.tagSuggestionsTitle", "Suggested tags")}
      </span>
      <button
        type="button"
        class="text-xs text-muted-foreground underline-offset-2 hover:underline"
        {disabled}
        onclick={dismissAll}
      >
        {$t("editor.tagSuggestionsDismissAll", "Dismiss all")}
      </button>
    </div>

    {#each [{ key: "broad", rows: broad, label: $t("editor.tagSuggestionsBroad", "Broad") }, { key: "narrow", rows: narrow, label: $t("editor.tagSuggestionsNarrow", "Specific") }] as group (group.key)}
      {#if group.rows.length > 0}
        <div class="space-y-1">
          <p
            class="text-[0.7rem] tracking-wide text-muted-foreground uppercase"
          >
            {group.label}
          </p>
          <ul class="flex flex-wrap gap-1.5">
            {#each group.rows as suggestion (suggestion.name)}
              <li
                class="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-background py-0.5 pr-1 pl-2 text-xs"
              >
                <button
                  type="button"
                  class="flex min-w-0 items-center gap-1 font-medium hover:text-primary"
                  {disabled}
                  aria-label={$t("editor.acceptTag", "Add tag {tag}", {
                    tag: suggestion.name,
                  })}
                  onclick={() => decide(suggestion.name, true)}
                >
                  <Check class="size-3 shrink-0" aria-hidden="true" />
                  <span class="truncate">{suggestion.name}</span>
                  {#if suggestion.count > 0}
                    <span class="shrink-0 text-muted-foreground">
                      {formatLocalizedNumber(suggestion.count, $locale)}
                    </span>
                  {/if}
                </button>
                <button
                  type="button"
                  class="flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
                  {disabled}
                  aria-label={$t("editor.rejectTag", "Reject tag {tag}", {
                    tag: suggestion.name,
                  })}
                  onclick={() => decide(suggestion.name, false)}
                >
                  <X class="size-3" aria-hidden="true" />
                </button>
              </li>
            {/each}
          </ul>
        </div>
      {/if}
    {/each}

    <p class="text-xs text-muted-foreground">
      {$t(
        "editor.tagSuggestionsHint",
        "Suggested by AI from what you wrote. Nothing is added until you accept it, and a rejected tag is not suggested again.",
      )}
    </p>
  </div>
{/if}
