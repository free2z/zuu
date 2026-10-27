<script lang="ts">
  import { onMount } from "svelte";

  import { chooseHeroFit, type HeroFit } from "$lib/utils/hero-parallax";

  type Props = {
    src: string;
    /** Optional narrow-viewport source, used verbatim as today's `<source>`. */
    mobileSrc?: string | null;
    alt?: string;
    /**
     * Which way the plate is fitted; SSR renders "contain", which is both the
     * doctrine and what measurement most often confirms. Two-way bound
     *the decision can only be made here, where the image is
     * measurable, but the headline that must react to it lives in the page,
     * OUTSIDE this component's subtree — so the page binds the fit up and
     * mirrors it onto its own `.zhero` section as `data-hero-fit`, keeping
     * every rule on both sides plain scoped CSS.
     */
    fit?: HeroFit;
  };

  let {
    src,
    mobileSrc = null,
    alt = "",
    fit = $bindable<HeroFit>("contain"),
  }: Props = $props();

  let frame = $state<HTMLElement | null>(null);
  let plateImage = $state<HTMLImageElement | null>(null);
  let fitFrame: number | null = null;
  let followupFitFrame: number | null = null;
  // True while a plate this instance mounted has no pixels yet: the
  // frame then shows a flat placeholder instead of an empty hole. Only ever
  // set after mount, so server markup — and a crawler with no JavaScript — is
  // unchanged. An image that is already complete never sets it.
  let awaitingImage = $state(false);

  // `contain` is both the doctrine — the whole featured image, always — and
  // the SSR default, so the common case never swaps crop after hydration.
  // `cover` is only reached by an image that would look *broken* letterboxed:
  // a near-exact ratio match, or a ribbon. See `chooseHeroFit`.
  function measureFit() {
    const image = plateImage;
    // The media element is absolute, so its offset parent is the box its
    // `inset: 0` is resolved against. Keep the frame as the fallback for
    // isolated/component tests where there is no positioning ancestor.
    const box = frame?.offsetParent ?? frame;
    if (!image || !box || !image.naturalWidth || !image.naturalHeight) return;
    fit = chooseHeroFit(
      { width: image.naturalWidth, height: image.naturalHeight },
      { width: box.clientWidth, height: box.clientHeight },
    );
  }

  function handlePlateSettled() {
    awaitingImage = false;
    scheduleFitMeasurement();
  }

  function cancelScheduledFitMeasurement() {
    if (fitFrame !== null && typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(fitFrame);
    }
    if (
      followupFitFrame !== null &&
      typeof cancelAnimationFrame !== "undefined"
    ) {
      cancelAnimationFrame(followupFitFrame);
    }
    fitFrame = null;
    followupFitFrame = null;
  }

  /**
   * A load event and a ResizeObserver callback can both arrive in the middle
   * of a layout transition. Measure once on the next frame, then once more on
   * the frame after it: the first read sees the browser's current layout and
   * the second catches a Svelte update or a late font reflow triggered by that
   * layout. The server-rendered `contain` state remains the safe answer while
   * those reads are pending.
   */
  function scheduleFitMeasurement() {
    if (typeof requestAnimationFrame === "undefined") {
      measureFit();
      return;
    }

    cancelScheduledFitMeasurement();
    fitFrame = requestAnimationFrame(() => {
      fitFrame = null;
      measureFit();
      followupFitFrame = requestAnimationFrame(() => {
        followupFitFrame = null;
        measureFit();
      });
    });
  }

  // A cached image can finish decoding before hydration attaches `onload`, in
  // which case the event never fires and the fit would stay at its default.
  $effect(() => {
    const image = plateImage;
    const source = src;
    const narrowSource = mobileSrc;
    if (image?.complete && (source || narrowSource)) {
      awaitingImage = false;
      scheduleFitMeasurement();
    }
  });

  // Fonts can change the height of the bottom-anchored headline after the
  // image has loaded. That reflow is not guaranteed to change the absolute
  // media frame itself, so explicitly sample after the document's font set is
  // ready as well as observing geometry below.
  onMount(() => {
    if (plateImage && !plateImage.complete) awaitingImage = true;
    scheduleFitMeasurement();
    let disposed = false;
    const fontsReady = document.fonts?.ready;
    if (fontsReady) {
      void fontsReady.then(() => {
        if (!disposed) scheduleFitMeasurement();
      });
    }

    return () => {
      disposed = true;
      cancelScheduledFitMeasurement();
    };
  });

  function trackBox(node: HTMLElement) {
    frame = node;
    const observer =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => scheduleFitMeasurement())
        : null;
    observer?.observe(node);
    // The media frame is absolute, so its positioning containing block can
    // settle after the frame's first observer notification. Observe that
    // exact box rather than assuming it is the immediate parent: a wrapper
    // around this component must not silently change what gets measured.
    const positioningBox = node.offsetParent ?? node;
    if (positioningBox !== node) observer?.observe(positioningBox);
    return {
      destroy() {
        observer?.disconnect();
        cancelScheduledFitMeasurement();
        if (frame === node) frame = null;
      },
    };
  }
</script>

<!--
  The hero's photographic layers, in paint order:

    plate   the photograph, with the existing cover framing
    bloom   a heavily blurred enlargement of the same bytes, masked to the band
            the headline sits in (or, in `contain` mode, the full backdrop
            behind a letterboxed image)
    veil    a transparent legacy layer
    scrim   the static contrast guarantee: a ramp to the page background
    crown   the same, at the top, for the back button and the badge

  the last three render in `cover` mode ONLY: there the text truly
  sits on the photograph (the phone-panorama case) and needs them to stay
  legible. In `contain` mode the whole image stays visible and the headline
  carries its contrast on the glyphs themselves — a `drop-shadow` pad on
  `.zhero__content` in the vanity page, which backs every word without laying
  a rectangle over the picture — so a dimming layer would only haze the image
  we just promised not to touch; they are display:none'd below.

  The hero is static, including when JavaScript is disabled.
-->
<div
  class="hero-media"
  data-hero-fit={fit}
  data-loading={awaitingImage ? "" : undefined}
  use:trackBox
>
  <div class="hero-media__plate">
    <picture>
      {#if mobileSrc}
        <source media="(max-width: 767px)" srcset={mobileSrc} />
      {/if}
      <img
        bind:this={plateImage}
        {src}
        {alt}
        class="hero-media__img"
        sizes="100vw"
        fetchpriority="high"
        loading="eager"
        decoding="async"
        onload={handlePlateSettled}
        onerror={handlePlateSettled}
      />
    </picture>
  </div>

  <div class="hero-media__bloom" aria-hidden="true">
    <div class="hero-media__bloom-inner">
      <picture>
        {#if mobileSrc}
          <source media="(max-width: 767px)" srcset={mobileSrc} />
        {/if}
        <!--
          Deliberately the *same* sources as the plate, not a smaller variant.
          Same URL means the same single network request, so the bloom can never
          become a second, later-arriving LCP candidate — the failure mode of
          "just use the thumbnail for the blurred copy".
        -->
        <img {src} alt="" sizes="100vw" decoding="async" />
      </picture>
    </div>
  </div>

  <div class="hero-media__veil" aria-hidden="true"></div>
  <div class="hero-media__scrim" aria-hidden="true"></div>
  <div class="hero-media__crown" aria-hidden="true"></div>
</div>

<style>
  .hero-media {
    position: absolute;
    inset: 0;
    overflow: hidden;
    /* Decoration behind the headline: it must never eat a tap meant for the
       back button, the byline links or the subscribe control. */
    pointer-events: none;

    /*
     * Load-bearing, and the subtlest thing in this file. The five layers below
     * are ordered with `z-index: 1..5`, and `position: absolute` alone does NOT
     * create a stacking context — so without this those indices would be
     * resolved against an ancestor's context and paint *above* the headline,
     * which is a positioned element at `z-index: auto`. The result is a hero
     * whose scrim covers its own title: the text is in the DOM, it is in the
     * accessibility tree, a contrast probe of the region reads a perfect ratio,
     * and a human sees a black rectangle.
     *
     * `z-index: 0` (with `isolation` for belt and braces) confines 1..5 to this
     * subtree. `.hero-media` then sits in the same paint layer as the headline
     * and loses to it on document order, which is exactly right.
     * `tests/browser/zpage-hero.spec.ts` asserts the headline actually changes
     * pixels, because every other kind of assertion passes when it does not.
     */
    z-index: 0;
    isolation: isolate;
  }

  /* The placeholder while the plate's bytes are on the wire. Painted
     by the isolated frame itself, so every layer above covers it the moment
     it has pixels; static, like the rest of the hero. */
  .hero-media[data-loading] {
    background: var(--muted);
  }

  /* ---------------------------------------------------------------- plate */

  .hero-media__plate {
    position: absolute;
    inset: -18% 0;
    z-index: 1;
  }

  .hero-media[data-hero-fit="contain"] .hero-media__plate {
    inset: 0;
  }

  .hero-media__plate picture {
    display: block;
    height: 100%;
    width: 100%;
  }

  .hero-media__img {
    display: block;
    height: 100%;
    width: 100%;
    object-fit: cover;
    /* Slightly above centre: on a wide crop of a normal photograph the subject
       is almost never in the bottom third, and the bottom third is where the
       scrim is strongest anyway. */
    object-position: 50% 42%;
  }

  /* `scale-down`, not `contain`: a 96x64 upload renders at 96x64 and stays
     crisp instead of being stretched to touch an edge. See `chooseHeroFit`. */
  .hero-media[data-hero-fit="contain"] .hero-media__img {
    object-fit: scale-down;
    object-position: 50% 50%;
  }

  /* ---------------------------------------------------------------- bloom */

  .hero-media__bloom {
    position: absolute;
    inset: 0;
    z-index: 2;
    overflow: hidden;
    opacity: 0.92;
    /* Only the band the headline occupies. Fogging the whole picture to make
       text legible is the lazy version of this; softening just the area under
       the text keeps the photograph a photograph. */
    -webkit-mask-image: linear-gradient(
      to top,
      #000 0%,
      #000 34%,
      transparent 78%
    );
    mask-image: linear-gradient(to top, #000 0%, #000 34%, transparent 78%);
  }

  /* In `contain` mode the blurred enlargement stops being an overlay and
     becomes the backdrop the letterboxed image sits on. */
  .hero-media[data-hero-fit="contain"] .hero-media__bloom {
    z-index: 0;
    opacity: 1;
    -webkit-mask-image: none;
    mask-image: none;
  }

  .hero-media__bloom-inner {
    position: absolute;
    top: -10%;
    left: -10%;
    width: 30%;
    height: 30%;
    /*
     * The filter is applied to this element's own rendering and only then is
     * the result transformed, so the blur rasterises at 30% scale: ~9% of the
     * pixels — and ~9% of the GPU memory — a full-size blur of the same
     * apparent radius would need. On a phone that is the difference between a
     * couple of megabytes and tens of them. 8px at 30% reads as ~27px, and
     * scaling to 120% leaves 10% of over-scan on every side so the blur's own
     * transparent edge never enters the frame.
     */
    transform: scale(4);
    transform-origin: 0 0;
    filter: blur(8px) saturate(0.9);
  }

  .hero-media__bloom-inner picture,
  .hero-media__bloom-inner img {
    display: block;
    height: 100%;
    width: 100%;
    object-fit: cover;
  }

  /* ------------------------------------------------------- veil and scrim */

  /*
   * Each gradient is declared twice. The first form uses nothing newer than
   * `linear-gradient` and is what a browser without `color-mix()` keeps; it is
   * deliberately the *more* opaque of the two, because the failure mode being
   * guarded against is white text on a bright photograph. The second form is
   * the one that actually ships to current browsers.
   *
   * Both are built from `--background`, so the hero is correct in light and
   * dark by construction: the region behind the headline is pulled toward the
   * exact colour `--foreground` is designed to be read against.
   */

  .hero-media__veil {
    position: absolute;
    inset: 0;
    z-index: 3;
    opacity: 0;
    background: linear-gradient(
      to top,
      var(--background) 0%,
      var(--background) 30%,
      transparent 90%
    );
    background: linear-gradient(
      to top,
      var(--background) 0%,
      color-mix(in oklab, var(--background) 60%, transparent) 48%,
      transparent 88%
    );
  }

  .hero-media__scrim {
    position: absolute;
    inset: 0;
    z-index: 4;
    background: linear-gradient(
      to top,
      var(--background) 0%,
      var(--background) 20%,
      transparent 95%
    );
    /*
     * Deliberately gentler through the middle than the contrast requirement
     * alone would need. The headline carries its own, text-anchored scrim, so
     * this one's job is the *transition*, and an aggressive mid-range reads as
     * "photograph, then a dead black band, then a title" instead of a
     * photograph dissolving into the words.
     */
    background: linear-gradient(
      to top,
      var(--background) 0%,
      color-mix(in oklab, var(--background) 88%, transparent) 20%,
      color-mix(in oklab, var(--background) 52%, transparent) 46%,
      color-mix(in oklab, var(--background) 16%, transparent) 74%,
      transparent 100%
    );
  }

  .hero-media__crown {
    position: absolute;
    inset: 0 0 auto 0;
    height: 9rem;
    z-index: 5;
    background: linear-gradient(to bottom, var(--background), transparent);
    background: linear-gradient(
      to bottom,
      color-mix(in oklab, var(--background) 62%, transparent),
      transparent
    );
  }

  /*
   *, the contain half of the doctrine. Veil, scrim and crown exist to
   * keep text legible where text sits ON a cropped photograph — `cover` mode.
   * In `contain` mode the headline carries its own glyph-shaped pad in the
   * page and the letterbox bars are already filled by the bloom backdrop
   * above, so each of these would only dim the fully visible cover.
   * Removed from rendering entirely rather than faded: they must not cost
   * paint, and the veil's scroll animation has no surface to animate on.
   */
  .hero-media[data-hero-fit="contain"] .hero-media__veil,
  .hero-media[data-hero-fit="contain"] .hero-media__scrim,
  .hero-media[data-hero-fit="contain"] .hero-media__crown {
    display: none;
  }
</style>
