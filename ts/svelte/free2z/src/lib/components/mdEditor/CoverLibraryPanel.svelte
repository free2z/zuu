<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import { t } from "$lib/i18n";
  import { Loader2, RefreshCw } from "@lucide/svelte";
  import type { CoverLibraryImage } from "./coverTypes";

  interface Props {
    items: CoverLibraryImage[];
    hasNext: boolean;
    isLoading: boolean;
    isLoadingMore: boolean;
    error: string;
    loadingItemId: number | null;
    buildMediaUrl: (path?: string | null) => string;
    onRefresh: () => void | Promise<void>;
    onLoadMore: () => void | Promise<void>;
    onChoose: (item: CoverLibraryImage) => void | Promise<void>;
  }

  let {
    items,
    hasNext,
    isLoading,
    isLoadingMore,
    error,
    loadingItemId,
    buildMediaUrl,
    onRefresh,
    onLoadMore,
    onChoose,
  }: Props = $props();
</script>

<div class="flex items-center justify-between gap-3">
  <p class="text-sm text-muted-foreground">
    {t(
      "editor.libraryHint",
      "Choose an image from your uploaded media, then crop it for the cover.",
    )}
  </p>
  <Button
    variant="ghost"
    size="sm"
    onclick={() => void onRefresh()}
    disabled={isLoading}
  >
    {#if isLoading}
      <Loader2 class="h-4 w-4 animate-spin" />
    {:else}
      <RefreshCw class="h-4 w-4" />
    {/if}
    {t("editor.refreshLibrary", "Refresh")}
  </Button>
</div>

{#if error}
  <div
    class="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
  >
    {error}
  </div>
{/if}

{#if isLoading && !items.length}
  <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
    {#each Array.from({ length: 6 }) as _, index (index)}
      <div class="overflow-hidden rounded-xl border bg-card">
        <div class="aspect-[4/3] animate-pulse bg-muted"></div>
        <div class="space-y-2 p-3">
          <div class="h-3 animate-pulse rounded bg-muted"></div>
          <div class="h-3 w-2/3 animate-pulse rounded bg-muted"></div>
        </div>
      </div>
    {/each}
  </div>
{:else if !items.length}
  <div
    class="rounded-2xl border border-dashed border-border/50 py-12 text-center text-sm text-muted-foreground"
  >
    {t("editor.libraryEmpty", "You do not have any uploaded images yet.")}
  </div>
{:else}
  <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
    {#each items as item (item.id)}
      <button
        type="button"
        class="group relative overflow-hidden rounded-xl border bg-card text-left transition hover:border-primary/35 hover:shadow-md"
        onclick={() => void onChoose(item)}
        disabled={loadingItemId === item.id}
      >
        <div class="aspect-[4/3] overflow-hidden bg-muted">
          <img
            src={buildMediaUrl(item.thumbnail || item.url)}
            alt={item.title || item.name || "Library image"}
            class="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
            loading="lazy"
          />
        </div>
        <div class="space-y-1 p-3">
          <p class="truncate text-sm font-medium text-foreground">
            {item.title || item.name || `Image ${item.id}`}
          </p>
          <p class="truncate text-xs text-muted-foreground">
            {item.access || "private"} • {item.mime_type}
          </p>
        </div>
        {#if loadingItemId === item.id}
          <div
            class="absolute inset-0 flex items-center justify-center bg-background/70 backdrop-blur-[2px]"
          >
            <Loader2 class="h-5 w-5 animate-spin text-primary" />
          </div>
        {/if}
      </button>
    {/each}
  </div>

  {#if hasNext}
    <div class="flex justify-center pt-2">
      <Button
        variant="outline"
        size="sm"
        onclick={() => void onLoadMore()}
        disabled={isLoadingMore}
      >
        {#if isLoadingMore}
          <Loader2 class="h-4 w-4 animate-spin" />
        {/if}
        {t("editor.loadMoreImages", "Load More")}
      </Button>
    </div>
  {/if}
{/if}
