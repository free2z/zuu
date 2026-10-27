<script lang="ts">
  import * as Dialog from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import { tStore as t } from "$lib/i18n";
  import {
    Copy,
    Download,
    ExternalLink,
    File as FileIcon,
    Share2,
  } from "@lucide/svelte";
  import { documentLabel } from "./supportedUploadTypes";

  export let open = false;
  export let url = "";
  export let title = "Media preview";
  export let mimeType = "";
  /**
   * Same-origin href for the Save button. `download` is ignored by browsers on
   * a cross-origin link, and `url` is deliberately absolute (it is the value
   * "copy link" puts on the clipboard, ), so the caller passes the
   * relative form here. Defaults to `url` for callers that have only one.
   */
  export let downloadUrl = "";
  export let onCopy: () => void = () => {};
  export let onShare: () => void = () => {};
  /**
   * Whether anybody but the owner could open `url`. A `private` upload 401s
   * for every recipient (`uploads/views.py`), so the Share button on that file
   * offers a link that cannot work — the caller passes `false` and it is not
   * rendered. Copy stays: the owner still legitimately wants the URL.
   */
  export let canShare = true;

  $: path = url.split(/[?#]/, 1)[0].toLowerCase();
  $: isImage =
    mimeType?.startsWith("image/") ||
    /\.(avif|gif|jpe?g|png|svg|webp)$/.test(path);
  $: isVideo =
    mimeType?.startsWith("video/") || /\.(mp4|m4v|mov|webm)$/.test(path);
  $: isAudio =
    mimeType?.startsWith("audio/") || /\.(mp3|m4a|ogg|wav|flac)$/.test(path);
  $: saveHref = downloadUrl || url;
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
        <!-- A document (PDF today). Deliberately NOT embedded in an <iframe>
             or <object>: that would add a new inline-rendering surface for
             uploaded bytes on the cookie-bearing app origin, which is exactly
             the boundary  was about. The file is offered as a download and
             as an explicit new-tab navigation instead. -->
        <div
          class="flex flex-col items-center gap-4 p-10 text-center text-white/70"
          data-preview-kind="document"
        >
          <div
            class="flex size-24 flex-col items-center justify-center gap-1 rounded-2xl border border-white/10 bg-white/5"
          >
            <FileIcon class="size-9 opacity-80" />
            <span class="text-[11px] font-semibold tracking-wide">
              {documentLabel(mimeType, url)}
            </span>
          </div>
          <p class="max-w-sm text-sm break-all text-white/80">{title}</p>
          <p class="max-w-sm text-xs text-white/50">
            {$t(
              "media.documentNoPreview",
              "This document has no in-page preview. Download it or open it in a new tab.",
            )}
          </p>
          <Button
            href={saveHref}
            download={title}
            variant="secondary"
            size="sm"
            class="gap-2"
            data-preview-action="download"
          >
            <Download class="size-4" />
            <span>{$t("media.download", "Download")}</span>
          </Button>
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
        {#if canShare}
          <Button
            variant="ghost"
            size="icon"
            onclick={onShare}
            aria-label="Share media"
            title="Share media"
          >
            <Share2 class="size-4" />
          </Button>
        {/if}
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
