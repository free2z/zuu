<script lang="ts">
  import AudioVisualizer from "$lib/components/stream/AudioVisualizer.svelte";
  import { getSafeMediaUrl, isThirdPartyMediaUrl } from "$lib/utils/safe-url";

  export let src: string;
  // ExternalEmbed supplies `metadata` only after the reader has granted
  // consent. Without an override, the old `none` fallback remains defence in
  // depth if a third-party URL is ever mounted outside the gate.
  export let preload: "none" | "metadata" | undefined = undefined;

  let audioElement: HTMLAudioElement;
  let hasStarted = false;

  /**
   * SECURITY  — `src` comes from the `data-audio-url` attribute on the
   * placeholder that MarkdownContent finds in sanitized markdown, and
   * DOMPurify does NOT apply its URI policy to `data-*` attributes. A
   * `javascript:` URL therefore arrives here intact, and this component feeds
   * it to two live sinks: `<audio src>` and the `<a href>` fallback inside it.
   *
   * The `<a>` is only reachable in a browser with no `<audio>` support, which
   * is the only reason this was not already critical — not a control. Validate
   * it here, at the sink.
   *
   * `getSafeMediaUrl` and not `getSafeHttpUrl`: uploads are served relative to
   * `PUBLIC_API_BASE_URL`, which is empty whenever the API is same-origin, so
   * a legitimate value is often the root-relative `/uploadz/...`.
   */
  $: safeSrc = getSafeMediaUrl(src);

  /**
   * PRIVACY  — MarkdownContent now routes every third-party direct
   * audio URL through ExternalEmbed and does not mount this component until
   * consent. Keep `none` as the default for a third-party URL anyway: if a
   * future call site bypasses that routing, metadata preload must not silently
   * become an on-mount beacon again. ExternalEmbed explicitly overrides it to
   * `metadata` after consent so Load once actually mounts and fetches media.
   *
   * Same-origin audio keeps `metadata`. A hosted upload leaks nothing to a
   * third party, and the duration in the native controls is a real affordance.
   * In production hosted uploads are `/uploadz/...` on our own origin.
   *
   * Read the origin once: it cannot change without a document swap, and
   * reading it at module scope would break SSR.
   */
  const pageOrigin = typeof location === "undefined" ? null : location.origin;

  // Annotated rather than inferred: `<audio preload>` takes a literal union,
  // and a bare `$:` widens the ternary to `string`.
  let preloadStrategy: "none" | "metadata";
  $: preloadStrategy =
    preload ??
    (isThirdPartyMediaUrl(safeSrc, pageOrigin) ? "none" : "metadata");
</script>

{#if safeSrc}
  <div class="markdown-audio">
    {#if hasStarted && audioElement}
      <div class="markdown-audio-visualizer" aria-hidden="true">
        <AudioVisualizer {audioElement} />
      </div>
    {/if}
    <audio
      bind:this={audioElement}
      src={safeSrc}
      controls
      crossorigin="anonymous"
      preload={preloadStrategy}
      onplay={() => (hasStarted = true)}
    >
      <a href={safeSrc}>Open the audio file</a>
    </audio>
  </div>
{/if}

<style>
  .markdown-audio {
    display: flex;
    width: min(100%, 42rem);
    flex-direction: column;
    gap: 0.5rem;
    margin: 1.5rem auto;
  }

  .markdown-audio-visualizer {
    height: 9rem;
    overflow: hidden;
    border-radius: 0.65rem;
  }

  audio {
    width: 100%;
  }
</style>
