<script lang="ts">
  import Check from "@lucide/svelte/icons/check";
  import ChevronsUpDown from "@lucide/svelte/icons/chevrons-up-down";
  import { tick } from "svelte";
  import * as Command from "$lib/components/ui/command/index.js";
  import * as Popover from "$lib/components/ui/popover/index.js";
  import { Button, type ButtonProps } from "$lib/components/ui/button/index.js";
  import { cn } from "$lib/utils.js";
  import { formatLocalizedNumber, locale, tStore as t } from "$lib/i18n";

  type AvailableTag = { name: string; count: number };
  type ForwardedTriggerProps = Pick<
    ButtonProps,
    "onclick" | "onkeydown" | "onpointerenter" | "onpointerleave"
  >;

  let {
    availableTags,
    currentTag,
    onSelect,
    username,
    mine = false,
  } = $props<{
    availableTags: AvailableTag[];
    currentTag: string;
    onSelect: (tag: string) => void;
    username: string;
    mine?: boolean;
  }>();

  let open = $state(false);
  let triggerRef = $state<HTMLButtonElement>(null!);
  let query = $state("");
  let remoteTags = $state<AvailableTag[] | null>(null);
  let remoteLoading = $state(false);
  let requestGeneration = 0;
  let abortController: AbortController | null = null;
  let previousScopeKey: string | null = null;

  function scopeKey() {
    return `${username}\u0000${mine ? "mine" : "public"}`;
  }

  function isAvailableTag(value: unknown): value is AvailableTag {
    if (!value || typeof value !== "object") return false;
    const tag = value as { name?: unknown; count?: unknown };
    return typeof tag.name === "string" && typeof tag.count === "number";
  }

  // A SvelteKit navigation can reuse this component while changing the
  // profile. Never carry a query or response from the previous creator into
  // the new scope; the SSR-provided list becomes the new baseline.
  $effect(() => {
    const nextScopeKey = scopeKey();
    if (previousScopeKey !== null && previousScopeKey !== nextScopeKey) {
      query = "";
      remoteTags = null;
      remoteLoading = false;
    }
    previousScopeKey = nextScopeKey;
  });

  // The initial SSR list is deliberately only a starting vocabulary. Once a
  // query is non-empty, the server owns filtering and ranking; cmdk must not
  // apply a second local filter that can hide a valid remote result.
  $effect(() => {
    const requestedQuery = query.trim();
    const requestedScope = scopeKey();
    const requestedUsername = username;
    const requestedMine = mine;
    const generation = ++requestGeneration;

    abortController?.abort();
    abortController = null;

    if (!requestedQuery) {
      remoteTags = null;
      remoteLoading = false;
      return;
    }

    remoteTags = [];
    remoteLoading = true;
    const timer = setTimeout(() => {
      void fetchRemoteTags(
        requestedQuery,
        requestedScope,
        generation,
        requestedUsername,
        requestedMine,
      );
    }, 200);

    return () => {
      clearTimeout(timer);
      abortController?.abort();
    };
  });

  async function fetchRemoteTags(
    requestedQuery: string,
    requestedScope: string,
    generation: number,
    requestedUsername: string,
    requestedMine: boolean,
  ) {
    const controller = new AbortController();
    abortController = controller;
    const params = new URLSearchParams({
      type: "zpage",
      username: requestedUsername,
      query: requestedQuery,
      num_results: "100",
    });
    if (requestedMine) params.set("mine", "true");

    try {
      const response = await fetch(
        `/api/tagging/autocomplete?${params.toString()}`,
        { credentials: "include", signal: controller.signal },
      );
      if (!response.ok) return;

      const payload: unknown = await response.json();
      const tags = Array.isArray(payload) ? payload.filter(isAvailableTag) : [];
      const stillCurrent =
        generation === requestGeneration &&
        requestedScope === scopeKey() &&
        requestedQuery === query.trim() &&
        !controller.signal.aborted;
      if (stillCurrent) remoteTags = tags;
    } catch {
      // Tag search is a convenience. The SSR list remains available when the
      // query is cleared, and a failed request should not disrupt filtering.
    } finally {
      if (
        generation === requestGeneration &&
        requestedScope === scopeKey() &&
        requestedQuery === query.trim()
      ) {
        remoteLoading = false;
      }
      if (abortController === controller) abortController = null;
    }
  }

  function selectTag(tag: string) {
    onSelect(tag);
    query = "";
    remoteTags = null;
    remoteLoading = false;
    closeAndFocusTrigger();
  }

  function closeAndFocusTrigger() {
    open = false;
    tick().then(() => {
      triggerRef.focus();
    });
  }
</script>

<Popover.Root bind:open>
  <Popover.Trigger bind:ref={triggerRef}>
    {#snippet child({ props })}
      <Button
        {...props}
        variant="outline"
        class="h-9 w-full justify-between border-border/50 bg-muted/50 md:w-48"
        role="combobox"
        aria-label={currentTag || $t("tags.label", "Tag")}
        aria-expanded={open}
        onclick={(props as ForwardedTriggerProps).onclick}
        onkeydown={(props as ForwardedTriggerProps).onkeydown}
        onpointerenter={(props as ForwardedTriggerProps).onpointerenter}
        onpointerleave={(props as ForwardedTriggerProps).onpointerleave}
      >
        <span class="truncate">
          {currentTag || $t("tags.label", "Tag")}
        </span>
        <ChevronsUpDown class="ml-2 size-4 opacity-50" />
      </Button>
    {/snippet}
  </Popover.Trigger>
  <Popover.Content class="w-[200px] p-0">
    <Command.Root shouldFilter={false} filter={() => 1}>
      <Command.Input
        bind:value={query}
        placeholder={$t("tags.searchPlaceholder", "Search tags...")}
      />
      <Command.List class="max-h-[300px] overflow-x-hidden overflow-y-auto">
        {#if !remoteLoading && query.trim() && remoteTags !== null && remoteTags.length === 0}
          <div
            class="py-6 text-center text-sm"
            role="status"
            aria-live="polite"
          >
            {$t("tags.noTagFound", "No tag found.")}
          </div>
        {:else}
          <Command.Empty>{$t("tags.noTagFound", "No tag found.")}</Command.Empty
          >
        {/if}
        <Command.Group>
          <Command.Item
            value="all-tags-clear-selection"
            onSelect={() => selectTag("")}
          >
            <Check
              class={cn("mr-2 size-4", !currentTag && "text-transparent")}
            />
            {$t("tags.allTags", "All Tags")}
          </Command.Item>

          {#each remoteTags ?? availableTags as tag (tag.name)}
            <Command.Item value={tag.name} onSelect={() => selectTag(tag.name)}>
              <Check
                class={cn(
                  "mr-2 size-4",
                  currentTag !== tag.name && "text-transparent",
                )}
              />
              <div
                class="flex flex-1 items-center justify-between gap-2 overflow-hidden"
              >
                <span class="truncate">{tag.name}</span>
                <span class="ml-auto shrink-0 text-xs text-muted-foreground"
                  >{formatLocalizedNumber(tag.count, $locale)}</span
                >
              </div>
            </Command.Item>
          {/each}
        </Command.Group>
      </Command.List>
    </Command.Root>
  </Popover.Content>
</Popover.Root>
