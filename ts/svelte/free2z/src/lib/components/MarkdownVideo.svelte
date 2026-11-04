<script lang="ts">
  import { getSafeMediaUrl } from "$lib/utils/safe-url";

  export let src: string;
  /**
   * Poster frame URL, or null when this upload has none. Arrives via
   * `data-video-poster`, which the sanitizer does NOT URL-filter, so it is
   * revalidated below at the live `poster=` sink.
   */
  export let poster: string | null = null;

  /**
   * SECURITY  — `src` crosses the sanitizer in a `data-video-url`
   * attribute. DOMPurify does not apply its URI policy to `data-*`, so validate
   * again at the live `<source src>` sink just as MarkdownAudio does.
   */
  $: safeSrc = getSafeMediaUrl(src);
  $: safePoster = poster ? getSafeMediaUrl(poster) : null;
  $: extension = safeSrc
    ? /\.(mp4|m4v|webm|mov|qt)(?:[?#].*)?$/i.exec(safeSrc)?.[1].toLowerCase()
    : undefined;
  $: mimeType =
    extension === "webm"
      ? "video/webm"
      : extension === "mov" || extension === "qt"
        ? "video/quicktime"
        : "video/mp4";
</script>

{#if safeSrc}
  <video
    controls
    preload="metadata"
    class="markdown-video"
    poster={safePoster ?? undefined}
  >
    <source src={safeSrc} type={mimeType} />
    <span data-markdown-video-fallback></span>
  </video>
{/if}
