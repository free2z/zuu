<script lang="ts">
  import { Check } from "@lucide/svelte";
  import * as Avatar from "$lib/components/ui/avatar";
  import { tStore as t } from "$lib/i18n";
  import type { CreatorList } from "$lib/api/f2z.schemas";
  import { getMenuPositionStyle } from "./menuPosition";
  import { resolveMediaUrl } from "./utils";

  let {
    mentionMenuRef = $bindable(),
    mentionMenuPosition,
    mentionResults,
    selectedMention = $bindable(),
    insertMention,
    selectedMentionRefs = $bindable([]),
    isLoading = false,
  } = $props();

  function avatarUrl(creator: CreatorList) {
    return (
      resolveMediaUrl(
        creator.avatar_image?.thumbnail || creator.avatar_image?.url,
      ) || undefined
    );
  }

  const positionStyle = $derived(getMenuPositionStyle(mentionMenuPosition));
</script>

<div
  bind:this={mentionMenuRef}
  onpointerdown={(event) => event.preventDefault()}
  class="fixed z-[100] flex max-h-[320px] w-[320px] animate-in flex-col overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md fade-in slide-in-from-bottom-2"
  style={positionStyle}
>
  <div
    class="flex shrink-0 items-center justify-between border-b bg-muted/50 px-3 py-2"
  >
    <span class="text-xs font-medium text-muted-foreground"
      >{$t("editor.mentionMenu.title", "Mention a creator")}</span
    >
    <span class="font-mono text-[10px] text-muted-foreground opacity-70"
      >↑↓ Navigate · ↵ Select · Esc Close</span
    >
  </div>
  <div class="mention-menu-items max-h-[260px] overflow-y-auto p-1">
    {#each mentionResults as creator, index (creator.username)}
      {@const isSelected = index === selectedMention}
      <button
        bind:this={selectedMentionRefs[index]}
        type="button"
        class="group relative flex w-full cursor-pointer items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-left text-sm transition-colors outline-none {isSelected
          ? 'bg-primary text-primary-foreground'
          : 'hover:bg-primary/8'}"
        onclick={() => insertMention(creator)}
        onmouseenter={() => (selectedMention = index)}
      >
        <Avatar.Root class="h-6 w-6 shrink-0 border border-border/60">
          <Avatar.Image
            src={avatarUrl(creator)}
            alt={creator.username}
            class="object-cover"
          />
          <Avatar.Fallback
            class="bg-muted text-[10px] text-muted-foreground uppercase"
          >
            {creator.username.substring(0, 2)}
          </Avatar.Fallback>
        </Avatar.Root>

        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1 leading-none font-medium">
            <span class="truncate">@{creator.username}</span>
            {#if creator.is_verified}
              <span
                class="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full {isSelected
                  ? 'bg-primary-foreground text-primary'
                  : 'bg-primary text-primary-foreground'}"
              >
                <Check class="h-2 w-2 stroke-4" />
              </span>
            {/if}
          </div>
          {#if creator.full_name}
            <div
              class="mt-1 truncate text-xs transition-colors {isSelected
                ? 'text-primary-foreground/85'
                : 'text-muted-foreground group-hover:text-foreground/70'}"
            >
              {creator.full_name}
            </div>
          {/if}
        </div>
      </button>
    {/each}

    {#if mentionResults.length === 0}
      <div class="py-6 text-center text-sm text-muted-foreground">
        {isLoading
          ? $t("editor.mentionMenu.searching", "Searching creators…")
          : $t("editor.mentionMenu.empty", "No creators found.")}
      </div>
    {/if}
  </div>
</div>

<style>
  .mention-menu-items::-webkit-scrollbar {
    width: 6px;
    height: 6px;
  }
  .mention-menu-items::-webkit-scrollbar-track {
    background: transparent;
  }
  .mention-menu-items::-webkit-scrollbar-thumb {
    background: var(--border);
    border-radius: 3px;
  }
  .mention-menu-items::-webkit-scrollbar-thumb:hover {
    background: var(--muted-foreground);
  }
</style>
