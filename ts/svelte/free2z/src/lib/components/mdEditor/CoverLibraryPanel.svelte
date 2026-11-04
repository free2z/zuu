<script lang="ts">
  import * as env from "$app/env/public";
  import { onMount } from "svelte";
  import { toast, captureAccountToast } from "$lib/toast.js";
  import { Button } from "$lib/components/ui/button";
  import { tStore as t } from "$lib/i18n";
  import { apiFetch } from "$lib/api/config";
  import { LayoutGrid, List, Loader2, RefreshCw } from "@lucide/svelte";
  import MediaAccessBadge from "$lib/components/media/MediaAccessBadge.svelte";
  import { satisfiesSlot } from "$lib/components/media/mediaAccess";
  import { readCurrentUpload } from "$lib/components/media/promoteMediaAccess";
  import type { CoverLibraryImage } from "./coverTypes";

  type LibraryView = "grid" | "list";

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

  let libraryView = $state<LibraryView>("grid");
  let libraryViewChosen = false;
  /**
   * A restricted image the creator picked for the cover, held until they say
   * yes. `EditorCoverField` crops what it is given and uploads the result as a
   * NEW public file (`uploadPublicFile`), so the cover it produces is never
   * broken — but the copy publishes the bytes of a private or subscribers-only
   * file to anyone, and that is not a thing to do without asking.
   */
  let pendingItem = $state<CoverLibraryImage | null>(null);
  /** The row whose current tier is being read, so its spinner can show. */
  let checkingItemId = $state<number | null>(null);

  const apiBase = env.PUBLIC_API_BASE_URL?.replace(/\/$/, "") ?? "";

  function chooseLibraryView(view: LibraryView) {
    libraryViewChosen = true;
    libraryView = view;
  }

  function imageName(item: CoverLibraryImage) {
    return (
      item.title ||
      item.name ||
      $t("editor.imageFallback", "Image {id}", { id: item.id })
    );
  }

  async function requestChoose(item: CoverLibraryImage) {
    const operationNotice = captureAccountToast();
    // Ask the server what this file's tier is NOW. The snapshot can be minutes
    // old, and the consequence of trusting it here is not a broken image — the
    // cover flow re-uploads a public COPY, which always works — it is that a
    // file the creator has since made private gets published without the
    // dialog that would have told them.
    checkingItemId = item.id;
    const current = await readCurrentUpload<CoverLibraryImage>({
      id: item.id,
      request: apiFetch,
      apiBase,
    });
    checkingItemId = null;

    if (!current) {
      operationNotice.error(
        $t(
          "editor.imageAccessCheckFailed",
          "Could not check who can open that image. Please try again.",
        ),
      );
      return;
    }

    // The cover rule does not depend on `is_subscriber_only`: redaction
    // replaces `content` and leaves `title`, `description` and
    // `featured_image` in the anonymous response, so a cover is public reach
    // by definition. See `mediaAccess.ts`.
    if (satisfiesSlot(current.access, { slot: "cover" })) {
      await onChoose(current);
      return;
    }

    pendingItem = current;
  }

  function confirmChoose() {
    const item = pendingItem;
    pendingItem = null;
    if (item) void onChoose(item);
  }

  onMount(() => {
    const mobileQuery = window.matchMedia("(max-width: 639px)");
    const applyResponsiveDefault = () => {
      if (!libraryViewChosen) {
        libraryView = mobileQuery.matches ? "list" : "grid";
      }
    };

    applyResponsiveDefault();
    mobileQuery.addEventListener("change", applyResponsiveDefault);

    return () => {
      mobileQuery.removeEventListener("change", applyResponsiveDefault);
    };
  });
</script>

<div class="relative flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
  <div
    class="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
  >
    <p class="text-sm text-muted-foreground">
      {$t(
        "editor.libraryHint",
        "Choose an image from your uploaded media to use as the cover.",
      )}
    </p>
    <div class="flex shrink-0 items-center gap-2 self-end sm:self-auto">
      <div
        class="flex items-center rounded-md border bg-muted/40 p-0.5"
        role="group"
        aria-label={$t("editor.libraryView", "Library view")}
      >
        <Button
          type="button"
          variant={libraryView === "grid" ? "secondary" : "ghost"}
          size="icon-sm"
          class="h-8 w-8"
          aria-label={$t("editor.gridView", "Grid view")}
          aria-pressed={libraryView === "grid"}
          title={$t("editor.gridView", "Grid view")}
          onclick={() => chooseLibraryView("grid")}
        >
          <LayoutGrid class="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant={libraryView === "list" ? "secondary" : "ghost"}
          size="icon-sm"
          class="h-8 w-8"
          aria-label={$t("editor.listView", "List view")}
          aria-pressed={libraryView === "list"}
          title={$t("editor.listView", "List view")}
          onclick={() => chooseLibraryView("list")}
        >
          <List class="h-4 w-4" />
        </Button>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        class="h-9 w-9"
        aria-label={$t("editor.refreshLibrary", "Refresh")}
        title={$t("editor.refreshLibrary", "Refresh")}
        onclick={() => void onRefresh()}
        disabled={isLoading}
      >
        {#if isLoading}
          <Loader2 class="h-4 w-4 animate-spin" />
        {:else}
          <RefreshCw class="h-4 w-4" />
        {/if}
      </Button>
    </div>
  </div>

  <div
    class="min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-xl border bg-muted/10 p-2 sm:p-3"
    data-media-results
    role="region"
    aria-label={$t("editor.cloudImageResults", "Uploaded image results")}
    aria-busy={isLoading || isLoadingMore}
  >
    {#if isLoading && !items.length}
      <p class="sr-only" role="status">
        {$t("editor.loadingLibrary", "Loading uploaded images…")}
      </p>
      <div
        class={libraryView === "grid"
          ? "grid grid-cols-2 gap-2 sm:grid-cols-2 sm:gap-3 lg:grid-cols-3"
          : "flex flex-col gap-2"}
      >
        {#each Array.from({ length: 6 }) as _, index (index)}
          <div
            class={`overflow-hidden rounded-lg border bg-card ${libraryView === "list" ? "flex items-center" : ""}`}
          >
            <div
              class={`${libraryView === "list" ? "h-20 w-24 shrink-0" : "aspect-square sm:aspect-[4/3]"} animate-pulse bg-muted`}
            ></div>
            <div
              class={`${libraryView === "list" ? "min-w-0 flex-1" : ""} space-y-2 p-3`}
            >
              <div class="h-3 animate-pulse rounded bg-muted"></div>
              <div class="h-3 w-2/3 animate-pulse rounded bg-muted"></div>
            </div>
          </div>
        {/each}
      </div>
    {:else if error && !items.length}
      <div
        class="flex min-h-40 flex-col items-center justify-center gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-6 text-center text-sm text-destructive"
        role="alert"
      >
        <p>{error}</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onclick={() => void onRefresh()}
        >
          <RefreshCw class="h-4 w-4" />
          {$t("editor.retryLibrary", "Try Again")}
        </Button>
      </div>
    {:else if !items.length}
      <div
        class="flex min-h-40 items-center justify-center rounded-xl border border-dashed border-border/50 px-4 py-12 text-center text-sm text-muted-foreground"
        role="status"
      >
        {$t("editor.libraryEmpty", "You do not have any uploaded images yet.")}
      </div>
    {:else}
      {#if error}
        <div
          class="mb-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
          role="alert"
        >
          {error}
        </div>
      {/if}

      <div
        class={libraryView === "grid"
          ? "grid grid-cols-2 gap-2 sm:grid-cols-2 sm:gap-3 lg:grid-cols-3"
          : "flex flex-col gap-2"}
      >
        {#each items as item (item.id)}
          <button
            type="button"
            class={`group relative overflow-hidden rounded-lg border bg-card text-left transition hover:border-primary/35 hover:shadow-md ${libraryView === "list" ? "flex min-h-20 items-center" : ""}`}
            onclick={() => void requestChoose(item)}
            disabled={loadingItemId !== null || checkingItemId !== null}
          >
            <div
              class={`${libraryView === "list" ? "h-20 w-24 shrink-0 sm:h-24 sm:w-32" : "aspect-square sm:aspect-[4/3]"} overflow-hidden bg-muted`}
            >
              <img
                src={buildMediaUrl(item.thumbnail || item.url)}
                alt={item.title ||
                  item.name ||
                  $t("editor.libraryImageAlt", "Image from your library")}
                class="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                loading="lazy"
              />
            </div>
            <div
              class={`${libraryView === "list" ? "min-w-0 flex-1" : ""} space-y-1 p-2.5 sm:p-3`}
            >
              <p class="truncate text-sm font-medium text-foreground">
                {imageName(item)}
              </p>
              <!-- The raw server enum used to be rendered here verbatim and
                   untranslated — the only hint anybody got that a cover was
                   about to be published from a private file. -->
              <div class="flex min-w-0 items-center gap-1.5">
                <MediaAccessBadge access={item.access} />
                <span
                  class={`truncate text-xs text-muted-foreground ${libraryView === "grid" ? "hidden sm:block" : ""}`}
                >
                  {item.mime_type}
                </span>
              </div>
            </div>
            {#if loadingItemId === item.id || checkingItemId === item.id}
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
        <div class="flex justify-center pt-4 pb-1">
          <Button
            variant="outline"
            size="sm"
            onclick={() => void onLoadMore()}
            disabled={isLoadingMore}
          >
            {#if isLoadingMore}
              <Loader2 class="h-4 w-4 animate-spin" />
            {/if}
            {$t("editor.loadMoreImages", "Load More")}
          </Button>
        </div>
      {/if}
    {/if}
  </div>

  {#if pendingItem}
    <div
      class="absolute inset-0 z-30 flex items-center justify-center rounded-xl bg-background/92 p-4 backdrop-blur-[2px] sm:p-6"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="cover-access-gate-title"
      data-media-access-gate="cover"
    >
      <div class="w-full max-w-md space-y-4">
        <div class="space-y-2">
          <h3
            id="cover-access-gate-title"
            class="text-base font-semibold text-foreground"
          >
            {$t("editor.coverAccessTitle", "A cover is always public")}
          </h3>
          <p class="text-sm leading-relaxed text-muted-foreground">
            {$t(
              "editor.coverAccessBody",
              "“{name}” is not public. Covers are shown to everyone — in listings, in search results and in link previews — even for a subscribers-only page, so a public copy of this image will be uploaded and used. The original file keeps the access it has now.",
              { name: imageName(pendingItem) },
            )}
          </p>
        </div>

        <div class="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{$t("editor.imageAccessCurrent", "Right now:")}</span>
          <MediaAccessBadge access={pendingItem.access} />
        </div>

        <div class="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            data-media-access-gate-action="cancel"
            onclick={() => (pendingItem = null)}
          >
            {$t("common.cancel", "Cancel")}
          </Button>
          <Button
            type="button"
            data-media-access-gate-action="promote"
            onclick={confirmChoose}
          >
            {$t("editor.coverAccessConfirm", "Use a public copy")}
          </Button>
        </div>
      </div>
    </div>
  {/if}
</div>
