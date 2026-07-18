<script lang="ts">
  import { env } from '$env/dynamic/public';
  import { onMount } from 'svelte';
  import { fade } from 'svelte/transition';
  import { page } from '$app/stores';
  import { toast } from "svelte-sonner";
  import MediaUploader from '$lib/components/media/MediaUploader.svelte';
  import {
    File as FileIcon,
    Image as ImageIcon,
    RefreshCw,
    Copy,
    AlertCircle,
    Loader2,
  } from '@lucide/svelte';

  type UploadedMedia = {
    id: number;
    url: string;
    name: string;
    thumbnail?: string | null;
    title?: string;
    description?: string;
    mime_type: string;
    created_at: string;
    sizeBytes?: number;
  };

  const apiBase = (env.PUBLIC_API_BASE_URL || '').replace(/\/$/, '');

  let media: UploadedMedia[] = [];
  let mediaError = '';
  let loadingMedia = true;
  let loadingMore = false;
  let hasNext = true;
  let pageIndex = 1;

  $: vanityUsername = $page.params.username;

  const buildApiUrl = (path: string) => `${apiBase}${path}`;

  const buildMediaUrl = (path?: string | null) => {
    if (!path) return '';
    if (/^https?:\/\//.test(path)) return path;
    return `${apiBase}${path.startsWith('/') ? '' : '/'}${path}`;
  };

  const formatBytes = (bytes?: number) => {
    if (!bytes || Number.isNaN(bytes)) return '—';
    const units = ['B', 'KB', 'MB', 'GB'];
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
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Link copied to clipboard');
    } catch (err) {
      toast.error('Failed to copy link');
    }
  };

  const refreshMedia = async () => {
    pageIndex = 1;
    hasNext = true;
    media = [];
    await loadMedia(true);
  };

  const fetchSizeForItem = async (item: UploadedMedia) => {
    const url = buildMediaUrl(item.url);
    if (!url) return item;
    try {
      const response = await fetch(url, { method: 'HEAD', credentials: 'include' });
      const sizeHeader = response.headers.get('content-length');
      if (sizeHeader) {
        const size = Number(sizeHeader);
        if (!Number.isNaN(size)) {
          return { ...item, sizeBytes: size } as UploadedMedia;
        }
      }
    } catch (err) {
      console.warn('Failed to fetch size for', item.name, err);
    }
    return item;
  };

  const enrichSizes = async (items: UploadedMedia[]) => {
    const updated = await Promise.all(items.map((i) => fetchSizeForItem(i)));
    media = updated;
  };

  const loadMedia = async (reset = false) => {
    if (!hasNext && !reset) return;
    loadingMedia = reset;
    loadingMore = !reset;
    mediaError = '';
    const url = buildApiUrl(`/api/myuploads/?page=${pageIndex}`);
    try {
      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) {
        throw new Error(`Failed to load media (${response.status})`);
      }
      const data = await response.json();
      const results = (data?.results || []) as UploadedMedia[];
      media = reset ? results : [...media, ...results];
      hasNext = Boolean(data?.next);
      pageIndex += 1;
      enrichSizes(media);
    } catch (error: any) {
      mediaError = error?.message || 'Failed to load media';
    } finally {
      loadingMedia = false;
      loadingMore = false;
    }
  };

  onMount(() => {
    loadMedia(true);
  });
</script>

<svelte:head>
  <title>Media | {vanityUsername}</title>
</svelte:head>

<div class="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
  <!-- Header -->
  <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
    <button
      class="group inline-flex items-center justify-center gap-2 rounded-lg border border-border bg-background px-4 py-2 text-sm font-medium shadow-sm transition-all hover:bg-muted hover:text-foreground active:scale-95 disabled:opacity-50"
      on:click={() => refreshMedia()}
      disabled={loadingMedia}
      aria-label="Refresh media list"
    >
      <RefreshCw class={`h-4 w-4 transition-transform ${loadingMedia ? 'animate-spin' : 'group-hover:rotate-180'}`} />
      <span>Refresh</span>
    </button>
  </div>

  <!-- Upload Area -->
  <MediaUploader on:upload-success={refreshMedia} />

  <!-- Media Grid -->
  <div class="space-y-4">
    <div class="flex items-center justify-between">
      <h2 class="text-lg font-semibold tracking-tight">Library</h2>
      {#if loadingMedia && !loadingMore}
        <div class="flex items-center gap-2 text-sm text-muted-foreground" in:fade>
          <Loader2 class="h-3 w-3 animate-spin" />
          <span>Syncing...</span>
        </div>
      {/if}
    </div>

    {#if mediaError}
      <div class="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive flex items-center gap-2">
        <AlertCircle class="h-4 w-4" />
        {mediaError}
      </div>
    {/if}

    {#if loadingMedia && !loadingMore}
      <div class="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {#each Array.from({ length: 8 }) as _, i}
          <div class="overflow-hidden rounded-xl border bg-card shadow-sm">
            <div class="aspect-video w-full animate-pulse bg-muted"></div>
            <div class="p-4 space-y-3">
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
        <div class="rounded-full bg-muted p-4 mb-4">
          <ImageIcon class="h-8 w-8 text-muted-foreground/50" />
        </div>
        <h3 class="text-lg font-semibold">No media found</h3>
        <p class="text-sm text-muted-foreground max-w-xs mx-auto mt-1">
          Upload your first image or video to get started with your collection.
        </p>
      </div>
    {:else}
      <div class="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {#each media as item (item.id)}
          <article 
            class="group relative flex flex-col overflow-hidden rounded-xl border bg-card shadow-sm transition-all duration-300 hover:-translate-y-1 hover:shadow-lg hover:border-primary/20"
          >
            <!-- Thumbnail -->
            <div class="relative aspect-video w-full overflow-hidden bg-muted">
              {#if item.thumbnail || item.url}
                <img
                  src={buildMediaUrl(item.thumbnail || item.url)}
                  alt={item.title || item.name}
                  class="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
                  loading="lazy"
                />
              {:else}
                <div class="flex h-full w-full items-center justify-center text-muted-foreground">
                  <FileIcon class="h-12 w-12 opacity-20" />
                </div>
              {/if}
              
              <!-- Overlay Actions -->
              <div class="absolute inset-0 bg-black/0 transition-colors duration-300 group-hover:bg-black/10"></div>
              
              <div class="absolute top-2 right-2 flex gap-2 opacity-0 transform translate-y-2 transition-all duration-200 group-hover:opacity-100 group-hover:translate-y-0">
                <button
                  class="inline-flex h-8 w-8 items-center justify-center rounded-full bg-background/90 text-foreground shadow-sm backdrop-blur-sm transition-colors hover:bg-background hover:text-primary focus:outline-none focus:ring-2 focus:ring-primary"
                  on:click={() => copyToClipboard(buildMediaUrl(item.url))}
                  title="Copy link"
                >
                  <Copy class="h-4 w-4" />
                </button>
              </div>
            </div>

            <!-- Info -->
            <div class="flex flex-1 flex-col p-4">
              <div class="mb-2">
                <h3 class="truncate text-sm font-semibold text-foreground" title={item.title || item.name}>
                  {item.title || item.name}
                </h3>
                <p class="truncate text-xs text-muted-foreground" title={item.name}>
                  {item.name}
                </p>
              </div>
              
              <div class="mt-auto flex items-center justify-between border-t pt-3 text-xs text-muted-foreground">
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
          disabled={loadingMore}
        >
          {#if loadingMore}
            <Loader2 class="h-4 w-4 animate-spin" />
            <span>Loading more...</span>
          {:else}
            <span>Load more</span>
            <svg 
              xmlns="http://www.w3.org/2000/svg" 
              width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
              class="transition-transform group-hover:translate-y-0.5"
            >
              <path d="m6 9 6 6 6-6"/>
            </svg>
          {/if}
        </button>
      </div>
    {/if}
  </div>
</div>

