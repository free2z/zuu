<script lang="ts">
  import * as Dialog from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import { Copy, ExternalLink, File as FileIcon, Share2 } from "@lucide/svelte";

  export let open = false;
  export let url = "";
  export let title = "Media preview";
  export let mimeType = "";
  export let onCopy: () => void = () => {};
  export let onShare: () => void = () => {};

  $: path = url.split(/[?#]/, 1)[0].toLowerCase();
  $: isImage =
    mimeType?.startsWith("image/") ||
    /\.(avif|gif|jpe?g|png|svg|webp)$/.test(path);
  $: isVideo =
    mimeType?.startsWith("video/") || /\.(mp4|m4v|mov|webm)$/.test(path);
  $: isAudio =
    mimeType?.startsWith("audio/") || /\.(mp3|m4a|ogg|wav|flac)$/.test(path);
</script>

<Dialog.Root bind:open>
  <Dialog.Content
    class="flex max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-6xl flex-col gap-0 overflow-hidden border-border/70 bg-background/98 p-0 shadow-2xl sm:max-w-6xl"
  >
    <Dialog.Header
      class="shrink-0 border-b border-border/70 px-4 py-3 pr-12 text-left sm:px-5"
    >
      <Dialog.Title class="truncate text-base" {title}>{title}</Dialog.Title>
      <Dialog.Description class="sr-only">
        Preview and sharing actions for {title}
      </Dialog.Description>
    </Dialog.Header>

    <div
      class="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-black/95 p-2 sm:p-5"
    >
      {#if isImage}
        <img
          src={url}
          alt={title}
          loading="eager"
          decoding="async"
          class="max-h-[calc(100dvh-9rem)] max-w-full object-contain"
        />
      {:else if isVideo}
        <video
          src={url}
          {title}
          controls
          playsinline
          preload="metadata"
          class="max-h-[calc(100dvh-9rem)] max-w-full bg-black"
        >
          <track kind="captions" />
        </video>
      {:else if isAudio}
        <div
          class="flex w-full max-w-2xl flex-col items-center gap-6 rounded-2xl border border-white/10 bg-white/5 p-6 sm:p-10"
        >
          <div class="rounded-full bg-white/10 p-5 text-white/70">
            <FileIcon class="size-10" />
          </div>
          <audio src={url} {title} controls preload="metadata" class="w-full">
            <track kind="captions" />
          </audio>
        </div>
      {:else}
        <div
          class="flex flex-col items-center gap-3 p-10 text-center text-white/70"
        >
          <FileIcon class="size-12 opacity-70" />
          <p class="text-sm">This file cannot be previewed in the browser.</p>
        </div>
      {/if}
    </div>

    <Dialog.Footer
      class="shrink-0 flex-row justify-between gap-2 border-t border-border/70 bg-background px-3 py-3 sm:px-5"
    >
      <div class="min-w-0 flex-1">
        <p class="truncate text-xs text-muted-foreground" title={url}>{url}</p>
      </div>
      <div class="flex shrink-0 items-center gap-1.5">
        <Button
          variant="ghost"
          size="icon"
          onclick={onCopy}
          aria-label="Copy full link"
          title="Copy full link"
        >
          <Copy class="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onclick={onShare}
          aria-label="Share media"
          title="Share media"
        >
          <Share2 class="size-4" />
        </Button>
        <Button
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          variant="outline"
          size="sm"
          class="gap-2"
        >
          <ExternalLink class="size-4" />
          <span class="hidden sm:inline">Open original</span>
          <span class="sm:hidden">Open</span>
        </Button>
      </div>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
