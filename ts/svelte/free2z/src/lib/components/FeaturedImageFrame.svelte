<script lang="ts">
  import SmoothImage from "$lib/components/SmoothImage.svelte";
  import { chooseImageFit, type ImageFit } from "$lib/utils/image-fit";
  import { cn } from "$lib/utils.js";

  export type FeaturedImageFit = ImageFit | "auto";

  type Props = {
    src?: string | null;
    alt?: string;
    /** Classes for the box. The box's size is the caller's business. */
    class?: string;
    /** Extra classes for the sharp image (hover transforms, and so on). */
    imgClass?: string;
    loading?: "lazy" | "eager";
    fetchpriority?: "high" | "low" | "auto";
    sizes?: string;
    showStatus?: boolean;
    /**
     * Fit policy. `auto` preserves the surface-specific heuristic; use
     * `contain` when the caller's contract is never to crop the upload.
     */
    fit?: FeaturedImageFit;
    /** Color-rich blur for small thumbnails; larger images use muted padding. */
    padding?: "muted" | "vivid";
  };

  let {
    src,
    alt = "",
    class: className,
    imgClass,
    loading = "lazy",
    fetchpriority,
    sizes,
    showStatus = false,
    fit: requestedFit = "auto",
    padding = "muted",
  }: Props = $props();

  // `contain` is both the doctrine and what the server renders, so the common
  // case never swaps fit after hydration. See `chooseImageFit`.
  let resolvedFit = $state<ImageFit>("contain");
  let frame = $state<HTMLElement | null>(null);
  let padImage = $state<HTMLImageElement | null>(null);

  function measureFit() {
    if (requestedFit !== "auto") {
      resolvedFit = requestedFit;
      return;
    }
    const image = padImage;
    const box = frame;
    if (!image || !box || !image.naturalWidth || !image.naturalHeight) return;
    resolvedFit = chooseImageFit(
      { width: image.naturalWidth, height: image.naturalHeight },
      { width: box.clientWidth, height: box.clientHeight },
    );
  }

  // A cached image can finish decoding before hydration attaches `onload`, in
  // which case the event never fires and the fit would stay at its default.
  $effect(() => {
    if (requestedFit !== "auto") {
      resolvedFit = requestedFit;
      return;
    }
    if (padImage?.complete) measureFit();
  });

  function trackBox(node: HTMLElement) {
    frame = node;
    const observer =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => measureFit())
        : null;
    observer?.observe(node);
    return {
      destroy() {
        observer?.disconnect();
        if (frame === node) frame = null;
      },
    };
  }
</script>

<!--
  A featured image, whole. Two layers:

    pad     a heavily blurred enlargement of the same bytes, covering the box,
            pulled toward the page background so it reads as padding rather
            than as a second picture
    plate   the image itself, `scale-down` so every pixel the creator uploaded
            is on screen and none of it is enlarged past 1:1

  The pad is the *same URL* as the plate, not a smaller derivative: one URL is
  one network request, so the pad can never become a second, later-arriving LCP
  candidate — the failure mode of "just use the thumbnail for the blurred copy".
  It is removed from the layout entirely when the fit resolves to `cover`, so
  the cropping path costs nothing at all.

  Callers pass `imgClass` for styling, and one thing must never go in it: a
  hover *scale*. A contained image touches at least one pair of the frame's
  edges, and the frame clips — so `group-hover:scale-105` crops back off
  precisely the edge content this component exists to keep. Three call sites
  had one; they were removed rather than exempted, and the cards still signal
  hover through their border and title colour.
-->
<div
  class={cn("featured-image", className)}
  data-featured-fit={resolvedFit}
  data-featured-padding={padding}
  use:trackBox
>
  <div class="featured-image__pad" aria-hidden="true">
    <div class="featured-image__pad-inner">
      {#if src}
        <img
          bind:this={padImage}
          {src}
          alt=""
          {loading}
          decoding="async"
          onload={measureFit}
        />
      {/if}
    </div>
  </div>

  <SmoothImage
    {src}
    {alt}
    {loading}
    {fetchpriority}
    {sizes}
    {showStatus}
    class="featured-image__plate bg-transparent"
    imgClass={cn(
      resolvedFit === "contain" ? "object-scale-down" : "object-cover",
      imgClass,
    )}
  />
</div>

<style>
  .featured-image {
    position: relative;
    overflow: hidden;
    /*
     * The two layers are ordered `z-index: 0` / `1`, and `position: absolute`
     * alone does not create a stacking context — without this those indices
     * would resolve against an ancestor's context and the pad could paint over
     * a card's badges. Same reasoning as `.hero-media`.
     */
    isolation: isolate;
  }

  .featured-image__pad {
    position: absolute;
    inset: 0;
    z-index: 0;
    overflow: hidden;
    background: var(--muted, transparent);
  }

  /* Nothing to pad: drop the whole layer so a cropping surface pays no blur,
     no extra raster and no extra compositor layer. */
  .featured-image[data-featured-fit="cover"] .featured-image__pad {
    display: none;
  }

  .featured-image__pad-inner {
    position: absolute;
    top: -10%;
    left: -10%;
    width: 30%;
    height: 30%;
    /*
     * The filter is applied to this element's own rendering and only then is
     * the result transformed, so the blur rasterises at 30% scale: ~9% of the
     * pixels — and ~9% of the GPU memory — a full-size blur of the same
     * apparent radius would need. That is what makes this affordable once per
     * card in an infinite feed. 8px at 30% reads as ~27px, and scaling to 120%
     * leaves 10% of over-scan on every side so the blur's own transparent edge
     * never enters the frame.
     *
     * `will-change` is deliberately absent: nothing here animates, so promoting
     * every card in the feed to its own permanent layer would buy nothing and
     * cost megabytes.
     */
    transform: scale(4);
    transform-origin: 0 0;
    filter: blur(8px) saturate(0.9);
  }

  .featured-image__pad-inner img {
    display: block;
    height: 100%;
    width: 100%;
    object-fit: cover;
  }

  /*
   * A scrim built from `--background`, which is what makes this correct in both
   * themes by construction rather than by a media query: it *lightens* the pad
   * in the light theme and *darkens* it in the dark one, always toward the
   * colour the surrounding card is already painted. The sharp image reads as
   * foreground either way, and any badge overlaid on the box keeps the contrast
   * it was designed with.
   *
   * Declared twice. The first form uses nothing newer than `rgba` and is what a
   * browser without `color-mix()` keeps; it is theme-neutral rather than wrong.
   */
  .featured-image__pad::after {
    content: "";
    position: absolute;
    inset: 0;
    background: rgb(0 0 0 / 0.18);
    background: color-mix(in oklab, var(--background) 34%, transparent);
  }

  /* Small thumbnails need enough overscan to keep the blur's transparent
     edges outside the frame. Keep the reduced-resolution raster and the
     sharp plate, but let the image's own colors fill the padding. This opt-in
     belongs to fixed small frames, not heroes or editor previews. */
  .featured-image[data-featured-padding="vivid"] .featured-image__pad-inner {
    top: -75%;
    left: -75%;
    width: 62.5%;
    height: 62.5%;
    filter: blur(6px) saturate(3) brightness(1.15);
  }

  /* Only the abstract backdrop spreads across both axes. The foreground keeps
     its original aspect ratio and fit policy. */
  .featured-image[data-featured-padding="vivid"]
    .featured-image__pad-inner
    img {
    object-fit: fill;
  }

  .featured-image[data-featured-padding="vivid"] .featured-image__pad::after {
    background: transparent;
  }

  .featured-image :global(.featured-image__plate) {
    position: absolute;
    inset: 0;
    z-index: 1;
  }
</style>
