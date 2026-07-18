<script lang="ts">
  import { env } from "$env/dynamic/public";
  import { onDestroy, onMount } from "svelte";
  import { fade } from "svelte/transition";
  import { page } from "$app/stores";
  import { toast } from "svelte-sonner";
  import MediaUploader from "$lib/components/media/MediaUploader.svelte";
  import MediaPreviewDialog from "$lib/components/media/MediaPreviewDialog.svelte";
  import { resolveMediaUrl } from "$lib/components/media/mediaUrl.js";
  import {
    File as FileIcon,
    Image as ImageIcon,
    RefreshCw,
    Copy,
    Share2,
    AlertCircle,
    Loader2,
    LayoutGrid,
    List,
    Search,
    X,
    ArrowDownUp,
    Check,
  } from "@lucide/svelte";

  type ViewMode = "grid" | "list";
  type MediaTypeFilter = "all" | "image" | "video";
  type SortOrder = "newest" | "oldest";

  type UploadedMedia = {
    id: number;
    url: string;
    name: string;
    thumbnail?: string | null;
    title?: string;
    description?: string;
    mime_type?: string;
    created_at: string;
    sizeBytes?: number;
  };

  const apiBase = (env.PUBLIC_API_BASE_URL || "").replace(/\/$/, "");

  let media: UploadedMedia[] = [];
  let mediaError = "";
  let loadingMedia = true;
  let loadingMore = false;
  let hasNext = true;
  let pageIndex = 1;
  let previewOpen = false;
  let previewItem: UploadedMedia | null = null;
  let mediaRequestController: AbortController | null = null;
  let requestSequence = 0;
  let searchQuery = "";
  let mediaType: MediaTypeFilter = "all";
  let sortOrder: SortOrder = "newest";
  let viewMode: ViewMode = "grid";
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  let copiedMediaId: number | null = null;
  let copiedResetTimer: ReturnType<typeof setTimeout> | null = null;
  let userRefreshing = false;

  $: vanityUsername = $page.params.username;

  const buildApiUrl = (path: string) => `${apiBase}${path}`;

  const buildMediaUrl = (path?: string | null, absolute = false) =>
    resolveMediaUrl(
      path || "",
      apiBase,
      absolute && typeof window !== "undefined" ? window.location.origin : "",
    );

  const formatBytes = (bytes?: number) => {
    if (!bytes || Number.isNaN(bytes)) return "—";
    const units = ["B", "KB", "MB", "GB"];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }
    return `${value.toFixed(value >= 10 || value % 1 === 0 ? 0 : 1)} ${units[unitIndex]}`;
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };

  const copyToClipboard = async (
    text: string,
    successMessage = "Link copied to clipboard",
  ) => {
    try {
      let copied = false;

      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(text);
          copied = true;
        } catch {
          // The API may exist while clipboard permission is unavailable.
        }
      }

      if (!copied) {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        try {
          textarea.select();
          copied = document.execCommand("copy");
        } finally {
          textarea.remove();
        }
      }

      if (!copied) throw new Error("Clipboard unavailable");
      toast.success(successMessage);
      return true;
    } catch (err) {
      toast.error("Failed to copy link");
      return false;
    }
  };

  const copyMediaLink = async (
    item: UploadedMedia,
    successMessage?: string,
  ) => {
    const copied = await copyToClipboard(
      buildMediaUrl(item.url, true),
      successMessage,
    );
    if (!copied) return;

    copiedMediaId = item.id;
    if (copiedResetTimer) clearTimeout(copiedResetTimer);
    copiedResetTimer = setTimeout(() => {
      copiedMediaId = null;
      copiedResetTimer = null;
    }, 2000);
  };

  const shareMedia = async (item: UploadedMedia) => {
    const url = buildMediaUrl(item.url, true);
    const title = item.title || item.name || "Free2Z media";

    if (navigator.share) {
      try {
        await navigator.share({ title, url });
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError")
          return;
      }
    }

    await copyMediaLink(item);
  };

  const openPreview = (item: UploadedMedia) => {
    previewItem = item;
    previewOpen = true;
  };

  const copyPreviewLink = () => {
    if (previewItem) void copyMediaLink(previewItem);
  };

  const sharePreview = () => {
    if (previewItem) void shareMedia(previewItem);
  };

  const scheduleSearch = () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchTimer = null;
      void refreshMedia();
    }, 300);
  };

  const changeMediaType = (event: Event) => {
    mediaType = (event.currentTarget as HTMLSelectElement)
      .value as MediaTypeFilter;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = null;
    void refreshMedia();
  };

  const toggleSortOrder = () => {
    sortOrder = sortOrder === "newest" ? "oldest" : "newest";
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = null;
    void refreshMedia();
  };

  const clearFilters = () => {
    searchQuery = "";
    mediaType = "all";
    sortOrder = "newest";
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = null;
    void refreshMedia();
  };

  const changeViewMode = (mode: ViewMode) => {
    viewMode = mode;
    localStorage.setItem("free2z-media-view", mode);
  };

  const refreshMedia = async () => {
    pageIndex = 1;
    hasNext = true;
    await loadMedia(true);
  };

  const handleUserRefresh = async () => {
    userRefreshing = true;
    try {
      await refreshMedia();
    } finally {
      userRefreshing = false;
    }
  };

  const fetchSizeForItem = async (item: UploadedMedia) => {
    const url = buildMediaUrl(item.url);
    if (!url) return item;
    try {
      const response = await fetch(url, {
        method: "HEAD",
        credentials: "include",
      });
      const sizeHeader = response.headers.get("content-length");
      if (sizeHeader) {
        const size = Number(sizeHeader);
        if (!Number.isNaN(size)) {
          return { ...item, sizeBytes: size } as UploadedMedia;
        }
      }
    } catch (err) {
      console.warn("Failed to fetch size for", item.name, err);
    }
    return item;
  };

  const enrichSizes = async (items: UploadedMedia[]) => {
    const updated = await Promise.all(items.map((i) => fetchSizeForItem(i)));
    const sizes = new Map(
      updated
        .filter((item) => item.sizeBytes !== undefined)
        .map((item) => [item.id, item.sizeBytes]),
    );
    if (sizes.size === 0) return;
    media = media.map((item) =>
      sizes.has(item.id) ? { ...item, sizeBytes: sizes.get(item.id) } : item,
    );
  };

  const loadMedia = async (reset = false) => {
    if ((!hasNext && !reset) || ((loadingMedia || loadingMore) && !reset))
      return;

    if (reset) mediaRequestController?.abort();
    const controller = new AbortController();
    mediaRequestController = controller;
    const requestId = ++requestSequence;
    const requestedPage = reset ? 1 : pageIndex;

    loadingMedia = reset;
    loadingMore = !reset;
    mediaError = "";
    const params = new URLSearchParams({ page: String(requestedPage) });
    const normalizedSearch = searchQuery.trim();
    if (normalizedSearch) params.set("search", normalizedSearch);
    if (mediaType !== "all") params.set("mime_type", `${mediaType}/`);
    params.set(
      "ordering",
      sortOrder === "newest" ? "-created_at,-id" : "created_at,id",
    );
    const url = buildApiUrl(`/api/myuploads/?${params.toString()}`);
    try {
      const response = await fetch(url, {
        credentials: "include",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Failed to load media (${response.status})`);
      }
      const data = await response.json();
      const results = (data?.results || []) as UploadedMedia[];
      if (requestId !== requestSequence) return;

      if (reset) {
        media = results;
      } else {
        const knownIds = new Set(media.map((item) => item.id));
        media = [...media, ...results.filter((item) => !knownIds.has(item.id))];
      }
      hasNext = Boolean(data?.next);
      pageIndex = requestedPage + 1;
      void enrichSizes(results);
    } catch (error: any) {
      if (error?.name === "AbortError") return;
      if (requestId !== requestSequence) return;
      mediaError = error?.message || "Failed to load media";
    } finally {
      if (requestId === requestSequence) {
        loadingMedia = false;
        loadingMore = false;
      }
    }
  };

  onMount(() => {
    const savedView = localStorage.getItem("free2z-media-view");
    if (savedView === "grid" || savedView === "list") viewMode = savedView;
    loadMedia(true);
  });

  onDestroy(() => {
    if (searchTimer) clearTimeout(searchTimer);
    if (copiedResetTimer) clearTimeout(copiedResetTimer);
    mediaRequestController?.abort();
  });
</script>

<svelte:head>
  <title>Media | {vanityUsername}</title>
</svelte:head>

<div
  class="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8"
>
  <!-- Upload Area -->
  <MediaUploader on:upload-success={refreshMedia} />

  <!-- Media Library -->
  <div class="space-y-4">
    <div class="flex items-center justify-between">
      <h2 class="text-lg font-semibold tracking-tight">Library</h2>
      {#if loadingMedia && !loadingMore}
        <div
          class="flex items-center gap-2 text-sm text-muted-foreground"
          in:fade
        >
          <Loader2 class="h-3 w-3 animate-spin" />
          <span>Syncing...</span>
        </div>
      {/if}
    </div>

    <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
      <div class="relative min-w-0 flex-1">
        <Search
          class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <input
          type="search"
          bind:value={searchQuery}
          on:input={scheduleSearch}
          placeholder="Search your media"
          aria-label="Search media library"
          class="h-10 w-full appearance-none rounded-lg border border-border bg-background pr-10 pl-9 text-sm transition-colors outline-none placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/20 [&::-webkit-search-cancel-button]:hidden [&::-webkit-search-decoration]:hidden"
        />
        {#if searchQuery}
          <button
            type="button"
            on:click={() => {
              searchQuery = "";
              scheduleSearch();
            }}
            class="absolute top-1/2 right-2 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Clear search"
            title="Clear search"
          >
            <X class="size-4" />
          </button>
        {/if}
      </div>

      <div class="flex items-center gap-2">
        <label class="sr-only" for="media-type-filter">Filter by type</label>
        <select
          id="media-type-filter"
          value={mediaType}
          on:change={changeMediaType}
          class="h-10 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 text-sm transition-colors outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 sm:w-36 sm:flex-none"
          aria-label="Filter media by type"
        >
          <option value="all">All media</option>
          <option value="image">Images</option>
          <option value="video">Videos</option>
        </select>

        <button
          type="button"
          on:click={toggleSortOrder}
          data-sort-order={sortOrder}
          class="inline-flex h-10 w-10 shrink-0 items-center justify-center gap-2 rounded-lg border border-border bg-background px-0 text-sm font-medium transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:outline-none sm:w-36 sm:px-3"
          aria-label={`Sort: ${sortOrder === "newest" ? "Newest first" : "Oldest first"}. Click to reverse order.`}
          title={`Showing ${sortOrder === "newest" ? "newest" : "oldest"} first`}
        >
          <ArrowDownUp
            class={`size-4 shrink-0 transition-transform duration-300 motion-reduce:transition-none ${sortOrder === "oldest" ? "rotate-180" : "rotate-0"}`}
          />
          <span class="hidden truncate sm:inline">
            {sortOrder === "newest" ? "Newest" : "Oldest"}
          </span>
        </button>

        <div
          class="inline-flex h-10 items-center rounded-lg border border-border bg-background p-1"
        >
          <button
            type="button"
            on:click={() => changeViewMode("grid")}
            class={`inline-flex size-8 items-center justify-center rounded-md transition-colors ${viewMode === "grid" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            aria-label="Grid view"
            aria-pressed={viewMode === "grid"}
            title="Grid view"
          >
            <LayoutGrid class="size-4" />
          </button>
          <button
            type="button"
            on:click={() => changeViewMode("list")}
            class={`inline-flex size-8 items-center justify-center rounded-md transition-colors ${viewMode === "list" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            aria-label="List view"
            aria-pressed={viewMode === "list"}
            title="List view"
          >
            <List class="size-4" />
          </button>
        </div>

        <button
          class="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-background shadow-sm transition-all hover:bg-muted hover:text-foreground active:scale-95 disabled:opacity-50"
          on:click={handleUserRefresh}
          disabled={loadingMedia}
          aria-label="Refresh media list"
          title="Refresh media list"
        >
          <RefreshCw
            class={`h-4 w-4 ${userRefreshing ? "animate-spin" : ""}`}
          />
        </button>
      </div>
    </div>

    {#if mediaError}
      <div
        class="flex items-center gap-2 rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive"
      >
        <AlertCircle class="h-4 w-4" />
        {mediaError}
      </div>
    {/if}

    {#if loadingMedia && !loadingMore && media.length === 0}
      <div class="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {#each Array.from({ length: 8 }) as _, i}
          <div class="overflow-hidden rounded-xl border bg-card shadow-sm">
            <div class="aspect-video w-full animate-pulse bg-muted"></div>
            <div class="space-y-3 p-4">
              <div class="h-4 w-3/4 animate-pulse rounded bg-muted"></div>
              <div class="flex justify-between">
                <div class="h-3 w-1/4 animate-pulse rounded bg-muted"></div>
                <div class="h-3 w-1/4 animate-pulse rounded bg-muted"></div>
              </div>
            </div>
          </div>
        {/each}
      </div>
    {:else if media.length === 0 && !loadingMedia}
      <div
        class="flex flex-col items-center justify-center rounded-xl border border-dashed py-16 text-center"
        in:fade={{ duration: 300 }}
      >
        <div class="mb-4 rounded-full bg-muted p-4">
          <ImageIcon class="h-8 w-8 text-muted-foreground/50" />
        </div>
        {#if searchQuery.trim() || mediaType !== "all"}
          <h3 class="text-lg font-semibold">No matching media</h3>
          <p class="mx-auto mt-1 max-w-xs text-sm text-muted-foreground">
            Try another search or clear the current filter.
          </p>
          <button
            type="button"
            on:click={clearFilters}
            class="mt-4 inline-flex h-9 items-center justify-center rounded-lg border border-border bg-background px-4 text-sm font-medium hover:bg-muted"
          >
            Clear filters
          </button>
        {:else}
          <h3 class="text-lg font-semibold">No media found</h3>
          <p class="mx-auto mt-1 max-w-xs text-sm text-muted-foreground">
            Upload your first image or video to get started with your
            collection.
          </p>
        {/if}
      </div>
    {:else}
      <div
        class={viewMode === "grid"
          ? "grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
          : "flex flex-col gap-3"}
        data-view={viewMode}
      >
        {#each media as item (item.id)}
          <article
            class={`group relative overflow-hidden rounded-xl border bg-card shadow-sm transition-all duration-300 hover:border-primary/20 hover:shadow-lg ${viewMode === "grid" ? "flex flex-col hover:-translate-y-1" : "flex min-h-28 flex-row"}`}
          >
            <!-- Thumbnail -->
            <div
              class={viewMode === "grid"
                ? "relative aspect-video w-full overflow-hidden bg-muted"
                : "relative w-28 shrink-0 overflow-hidden bg-muted sm:w-40"}
            >
              <button
                type="button"
                class="block h-full w-full cursor-zoom-in focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none focus-visible:ring-inset"
                on:click={() => openPreview(item)}
                aria-label={`Preview ${item.title || item.name}`}
              >
                {#if item.thumbnail || item.mime_type?.startsWith("image/")}
                  <img
                    src={buildMediaUrl(item.thumbnail || item.url)}
                    alt={item.title || item.name}
                    class="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
                    loading="lazy"
                  />
                {:else if item.mime_type?.startsWith("video/")}
                  <video
                    src={buildMediaUrl(item.url)}
                    title={item.title || item.name}
                    preload="metadata"
                    muted
                    playsinline
                    class="pointer-events-none h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
                  >
                    <track kind="captions" />
                  </video>
                {:else}
                  <div
                    class="flex h-full w-full items-center justify-center text-muted-foreground"
                  >
                    <FileIcon class="h-12 w-12 opacity-20" />
                  </div>
                {/if}
              </button>

              <!-- Overlay Actions -->
              <div
                class="pointer-events-none absolute inset-0 bg-black/0 transition-colors duration-300 group-hover:bg-black/10"
              ></div>

              <div
                class="absolute top-2 right-2 z-10 flex gap-1.5 opacity-100 transition-all duration-200 sm:translate-y-2 sm:opacity-0 sm:group-focus-within:translate-y-0 sm:group-focus-within:opacity-100 sm:group-hover:translate-y-0 sm:group-hover:opacity-100"
              >
                <button
                  data-media-action="copy"
                  data-copied={copiedMediaId === item.id}
                  class="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border/70 bg-background/95 text-foreground shadow-sm backdrop-blur-sm transition-colors hover:bg-background hover:text-primary focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
                  on:click={() => copyMediaLink(item)}
                  title="Copy full link"
                  aria-label={`Copy full link for ${item.title || item.name}`}
                >
                  {#if copiedMediaId === item.id}
                    <Check class="h-4 w-4 text-green-500" />
                  {:else}
                    <Copy class="h-4 w-4" />
                  {/if}
                </button>
                <button
                  data-media-action="share"
                  class="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border/70 bg-background/95 text-foreground shadow-sm backdrop-blur-sm transition-colors hover:bg-background hover:text-primary focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
                  on:click={() => shareMedia(item)}
                  title="Share"
                  aria-label={`Share ${item.title || item.name}`}
                >
                  <Share2 class="h-4 w-4" />
                </button>
              </div>
            </div>

            <!-- Info -->
            <div
              class={`flex min-w-0 flex-1 flex-col ${viewMode === "grid" ? "p-4" : "justify-center p-3 sm:p-4"}`}
            >
              <div class="mb-2">
                <h3
                  class="truncate text-sm font-semibold text-foreground"
                  title={item.title || item.name}
                >
                  {item.title || item.name}
                </h3>
                <p
                  class="truncate text-xs text-muted-foreground"
                  title={item.name}
                >
                  {item.name}
                </p>
              </div>

              <div
                class="mt-auto flex items-center justify-between border-t pt-3 text-xs text-muted-foreground"
              >
                <span class="font-medium">{formatBytes(item.sizeBytes)}</span>
                <span>{formatDate(item.created_at)}</span>
              </div>
            </div>
          </article>
        {/each}
      </div>
    {/if}

    {#if hasNext}
      <div class="flex justify-center pt-8">
        <button
          class="group inline-flex items-center justify-center gap-2 rounded-full border border-border bg-background px-6 py-2.5 text-sm font-medium shadow-sm transition-all hover:bg-muted hover:shadow-md disabled:opacity-50"
          on:click={() => loadMedia(false)}
          disabled={loadingMore || loadingMedia}
        >
          {#if loadingMore}
            <Loader2 class="h-4 w-4 animate-spin" />
            <span>Loading more...</span>
          {:else}
            <span>Load more</span>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              class="transition-transform group-hover:translate-y-0.5"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          {/if}
        </button>
      </div>
    {/if}
  </div>
</div>

{#if previewItem}
  <MediaPreviewDialog
    bind:open={previewOpen}
    url={buildMediaUrl(previewItem.url, true)}
    title={previewItem.title || previewItem.name}
    mimeType={previewItem.mime_type || ""}
    onCopy={copyPreviewLink}
    onShare={sharePreview}
  />
{/if}
