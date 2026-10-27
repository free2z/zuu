<script lang="ts">
  /**
   * Free-form tag entry.
   *
   * The field this drives is `django-taggit` — an open vocabulary. The editor
   * previously fronted it with a twenty-item picker, which is why this
   * component's whole job is to have no vocabulary: type anything, comma or
   * Enter commits it, chips come off with a click.
   *
   * Suggestions come from `GET /api/tagging/autocomplete`, the endpoint that
   * has backed the profile page's tag filter all along. They are ranked by how
   * many published zPages carry the tag, so the list doubles as the platform's
   * real, self-maintaining "featured tags" — no curated array, no deploy to
   * change it, and nothing that assumes English.
   *
   * Picking a suggestion is also the free half of tag normalization: a typed
   * `ZCASh` adopts the corpus's `zcash` spelling (see `mergeTags`) without any
   * destructive case-folding of what the creator wrote.
   */
  import X from "@lucide/svelte/icons/x";
  import TagIcon from "@lucide/svelte/icons/tag";
  import { tStore as t, formatLocalizedNumber, locale } from "$lib/i18n";
  import { cn } from "$lib/utils.js";
  // Deliberately NO `maxlength` on the input. The 100-character limit is a
  // limit on ONE tag; `maxlength` limits the whole buffer, so pasting
  // `alpha, beta, gamma, …` past 100 characters would have the browser chop
  // the paste before `oninput` ever saw it — the tail tags simply gone, the
  // last one silently truncated, and both states saved by the next autosave.
  // `mergeTags` enforces the real rule per tag and says so out loud.
  import {
    TAG_MAX_LENGTH,
    TAG_SEPARATOR_PATTERN,
    mergeTags,
    normalizeTag,
    parseTagInput,
    removeTag,
    tagKey,
  } from "$lib/tags.js";

  type Suggestion = { name: string; count: number };

  let {
    tags = $bindable<string[]>([]),
    onChange,
    id = "tag-input",
    disabled = false,
  }: {
    tags: string[];
    onChange?: () => void;
    id?: string;
    disabled?: boolean;
  } = $props();

  let draft = $state("");
  let suggestions = $state<Suggestion[]>([]);
  let open = $state(false);
  let activeIndex = $state(-1);
  let notice = $state("");
  let inputElement = $state<HTMLInputElement | null>(null);
  let requestGeneration = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const selectedKeys = $derived(new Set(tags.map(tagKey)));
  const visibleSuggestions = $derived(
    suggestions.filter(
      (suggestion) => !selectedKeys.has(tagKey(suggestion.name)),
    ),
  );

  async function loadSuggestions(query: string) {
    const generation = ++requestGeneration;
    const params = new URLSearchParams({ type: "zpage", num_results: "12" });
    if (query) params.set("query", query);
    try {
      const response = await fetch(`/api/tagging/autocomplete?${params}`, {
        credentials: "include",
      });
      if (!response.ok) return;
      const payload = await response.json();
      // Stale response from a query the creator has already typed past.
      if (generation !== requestGeneration) return;
      suggestions = Array.isArray(payload)
        ? payload.filter(
            (item): item is Suggestion =>
              Boolean(item) && typeof item.name === "string",
          )
        : [];
    } catch {
      // Suggestions are a convenience. A creator can always type the tag, so a
      // failed lookup must never block entry or shout at them.
      if (generation === requestGeneration) suggestions = [];
    }
  }

  function scheduleSuggestions(query: string) {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => loadSuggestions(query), 180);
  }

  function commit(raw: string) {
    const candidates = parseTagInput(raw);
    if (candidates.length === 0) return;
    const corpus = suggestions.map((suggestion) => suggestion.name);
    const result = mergeTags(tags, candidates, corpus);
    notice =
      result.rejected.length > 0
        ? $t("editor.tagTooLong", "Tags are limited to {max} characters.", {
            max: TAG_MAX_LENGTH,
          })
        : "";
    if (result.tags.length !== tags.length) {
      tags = result.tags;
      onChange?.();
    }
    draft = "";
    activeIndex = -1;
    scheduleSuggestions("");
  }

  function drop(tag: string) {
    const next = removeTag(tags, tag);
    if (next.length === tags.length) return;
    tags = next;
    notice = "";
    onChange?.();
  }

  function onInput(event: Event) {
    const target = event.currentTarget as HTMLInputElement;
    // A comma finishes a tag wherever it lands — typed, or arriving in a paste
    // of `a, b, c`. Splitting here rather than only on Enter is what makes
    // pasting a list behave the way every tag field on the internet does.
    if (TAG_SEPARATOR_PATTERN.test(target.value)) {
      commit(target.value);
      return;
    }
    draft = target.value;
    open = true;
    activeIndex = -1;
    scheduleSuggestions(normalizeTag(draft));
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Enter") {
      event.preventDefault();
      if (activeIndex >= 0 && visibleSuggestions[activeIndex]) {
        commit(visibleSuggestions[activeIndex].name);
        return;
      }
      commit(draft);
      return;
    }
    if (event.key === "Backspace" && draft === "" && tags.length > 0) {
      drop(tags[tags.length - 1]);
      return;
    }
    if (event.key === "Escape") {
      open = false;
      activeIndex = -1;
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (visibleSuggestions.length === 0) return;
      event.preventDefault();
      open = true;
      const count = visibleSuggestions.length;
      // -1 means "the text I typed", and it is a real stop on the way round:
      // arrowing past the last suggestion must return the creator to their own
      // wording rather than trapping them in the corpus.
      if (event.key === "ArrowDown") {
        activeIndex = activeIndex + 1 >= count ? -1 : activeIndex + 1;
      } else {
        activeIndex = activeIndex - 1 < -1 ? count - 1 : activeIndex - 1;
      }
    }
  }

  function onBlur() {
    // Committing on blur is the difference between "I typed a tag and it
    // saved" and "I typed a tag, clicked Publish, and it vanished."
    if (draft.trim()) commit(draft);
    open = false;
    activeIndex = -1;
  }
</script>

<div class="space-y-2">
  <div
    class={cn(
      "flex min-h-9 w-full flex-wrap items-center gap-1.5 rounded-md border border-input bg-transparent px-2 py-1.5 text-sm shadow-xs transition-[color,box-shadow]",
      "focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50",
      disabled && "cursor-not-allowed opacity-50",
    )}
  >
    <TagIcon class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    {#each tags as tag (tag)}
      <span
        class="inline-flex max-w-full items-center gap-1 rounded-full border border-transparent bg-secondary py-0.5 pr-1 pl-2 text-xs font-medium text-secondary-foreground"
      >
        <span class="truncate">{tag}</span>
        <button
          type="button"
          class="flex size-4 shrink-0 items-center justify-center rounded-full text-secondary-foreground/70 transition-colors hover:text-secondary-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
          aria-label={$t("editor.removeTag", "Remove tag {tag}", { tag })}
          {disabled}
          onclick={() => drop(tag)}
        >
          <X class="size-3" aria-hidden="true" />
        </button>
      </span>
    {/each}
    <input
      {id}
      bind:this={inputElement}
      data-testid="tag-input"
      class="min-w-[8rem] flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed"
      type="text"
      autocomplete="off"
      role="combobox"
      aria-expanded={open && visibleSuggestions.length > 0}
      aria-controls="{id}-suggestions"
      aria-autocomplete="list"
      {disabled}
      placeholder={tags.length === 0
        ? $t("editor.tagsPlaceholder", "Add a tag and press Enter")
        : ""}
      value={draft}
      oninput={onInput}
      onkeydown={onKeydown}
      onfocus={() => {
        open = true;
        scheduleSuggestions(normalizeTag(draft));
      }}
      onblur={onBlur}
    />
  </div>

  {#if open && visibleSuggestions.length > 0}
    <ul
      id="{id}-suggestions"
      role="listbox"
      class="max-h-56 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
    >
      {#each visibleSuggestions as suggestion, index (suggestion.name)}
        <li>
          <button
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            class={cn(
              "flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground",
              index === activeIndex && "bg-accent text-accent-foreground",
            )}
            onmousedown={(event) => {
              // The input's blur fires before a click would; committing on
              // mousedown is what keeps a clicked suggestion from being eaten
              // by the blur handler.
              event.preventDefault();
              commit(suggestion.name);
              inputElement?.focus();
            }}
          >
            <span class="truncate">{suggestion.name}</span>
            <span class="shrink-0 text-xs text-muted-foreground">
              {formatLocalizedNumber(suggestion.count, $locale)}
            </span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}

  <p class="text-xs text-muted-foreground">
    {notice ||
      $t(
        "editor.tagsHint",
        "Tag with anything that describes your work — broad or specific. Separate with commas.",
      )}
  </p>
</div>
