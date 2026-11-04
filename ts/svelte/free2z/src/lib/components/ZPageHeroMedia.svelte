<script lang="ts">
  import type { HeroFit } from "$lib/utils/hero-parallax";

  type Props = {
    src: string;
    mobileSrc?: string | null;
    alt?: string;
    fit?: HeroFit;
    compact?: boolean;
  };

  let {
    src,
    mobileSrc = null,
    alt = "",
    fit = $bindable<HeroFit>("contain"),
    compact = $bindable(false),
  }: Props = $props();

  let image = $state<HTMLImageElement | null>(null);
  let frame = $state<HTMLElement | null>(null);
  let bloom = $state<HTMLCanvasElement | null>(null);
  let settledSource = $state<string | null>(null);
  let failedSource = $state<string | null>(null);
  const awaitingImage = $derived(settledSource !== src && failedSource !== src);
  const failed = $derived(failedSource === src);

  function paintBloom() {
    const canvas = bloom;
    const img = image;
    const box = frame;
    if (!canvas || !box || !img?.naturalWidth || !img.naturalHeight) return;
    const width = Math.max(1, Math.round(box.clientWidth));
    const height = Math.max(1, Math.round(box.clientHeight));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return;
    // Draw past the frame so the blur's transparent fringe is clipped off.
    const scale =
      Math.max(width / img.naturalWidth, height / img.naturalHeight) * 1.35;
    const drawnWidth = img.naturalWidth * scale;
    const drawnHeight = img.naturalHeight * scale;
    context.clearRect(0, 0, width, height);
    context.filter = "blur(16px)";
    context.drawImage(
      img,
      (width - drawnWidth) / 2,
      (height - drawnHeight) / 2,
      drawnWidth,
      drawnHeight,
    );
  }

  function measureImage() {
    if (!image?.complete || image.getAttribute("src") !== src) return;
    if (image.naturalWidth && image.naturalHeight) {
      compact = image.naturalWidth / image.naturalHeight <= 1.1;
      settledSource = src;
      failedSource = null;
      paintBloom();
    } else {
      failedSource = src;
      compact = false;
    }
    fit = "contain";
  }

  // A cached image may finish before hydration attaches its load listener.
  $effect(() => {
    void mobileSrc;
    void src;
    measureImage();
  });

  $effect(() => {
    const box = frame;
    if (!box || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => paintBloom());
    observer.observe(box);
    paintBloom();
    return () => observer.disconnect();
  });
</script>

<div
  bind:this={frame}
  class="hero-media"
  data-hero-fit="contain"
  data-compact={compact ? "" : undefined}
  data-loading={awaitingImage ? "" : undefined}
  data-failed={failed ? "" : undefined}
>
  <canvas class="hero-media__bloom" aria-hidden="true" bind:this={bloom}
  ></canvas>
  <div class="hero-media__plate">
    {#key src}
      <picture>
        {#if mobileSrc}
          <source media="(max-width: 767px)" srcset={mobileSrc} />
        {/if}
        <img
          bind:this={image}
          {src}
          {alt}
          class="hero-media__img"
          sizes="(min-width: 1024px) 960px, 100vw"
          fetchpriority="high"
          loading="eager"
          decoding="async"
          onload={measureImage}
          onerror={measureImage}
        />
      </picture>
    {/key}
  </div>
</div>

<style>
  .hero-media {
    position: relative;
    width: 100%;
    max-width: 100%;
    margin-inline: auto;
    overflow: hidden;
    border-radius: 0.75rem;
    isolation: isolate;
    background: var(--muted, #111);
  }

  /* Same bytes as the sharp plate, painted from the decoded image so the
     letterbox does not start a second cover request. The title stays outside
     this frame. */
  .hero-media__bloom {
    position: absolute;
    inset: 0;
    z-index: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
  }

  .hero-media__bloom::after {
    content: "";
    position: absolute;
    inset: 0;
    background: rgb(0 0 0 / 0.18);
    background: color-mix(in oklab, var(--background) 34%, transparent);
  }

  .hero-media[data-loading] .hero-media__bloom,
  .hero-media[data-failed] .hero-media__bloom {
    display: none;
  }

  .hero-media__plate,
  .hero-media__plate picture {
    position: relative;
    z-index: 1;
    display: flex;
    justify-content: center;
    max-width: 100%;
  }

  .hero-media__img {
    display: block;
    width: auto;
    height: auto;
    max-width: 100%;
    max-height: 24rem;
    object-fit: scale-down;
  }

  @supports (height: 1svh) {
    .hero-media__img {
      max-height: min(24rem, 48svh);
    }
  }

  .hero-media[data-compact] .hero-media__img {
    max-height: 32rem;
  }

  @supports (height: 1svh) {
    .hero-media[data-compact] .hero-media__img {
      max-height: min(32rem, 65svh);
    }
  }

  /* Reserve the most common production ratio until the image is decoded. */
  .hero-media[data-loading] {
    width: 100%;
    aspect-ratio: 16 / 9;
    max-height: 24rem;
    background: var(--muted);
  }

  .hero-media[data-loading] .hero-media__plate {
    position: absolute;
    inset: 0;
  }

  .hero-media[data-loading] picture {
    width: 100%;
    height: 100%;
  }

  .hero-media[data-loading] .hero-media__img {
    width: 100%;
    height: 100%;
    max-height: 100%;
  }

  .hero-media[data-failed] {
    width: 100%;
    min-height: 4rem;
    background: var(--muted);
  }

  .hero-media[data-failed] .hero-media__plate {
    display: none;
  }
</style>
