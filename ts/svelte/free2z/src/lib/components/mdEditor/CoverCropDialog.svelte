<script lang="ts">
  import { onDestroy } from "svelte";
  import { Button } from "$lib/components/ui/button";
  import * as Dialog from "$lib/components/ui/dialog";
  import FeaturedImageFrame from "$lib/components/FeaturedImageFrame.svelte";
  import { tStore as t } from "$lib/i18n";
  import { toast, captureAccountToast } from "$lib/toast.js";
  import { Check, Crop, Loader2, RotateCcw } from "@lucide/svelte";
  import {
    MAX_COVER_EDGE,
    MAX_ENCODED_COVER_BYTES,
    boundedCoverSize,
    canUseSourceFileDirectly,
  } from "$lib/utils/cover-image";

  /*
    This dialog used to be a toll gate: every upload was forced through a
    locked 4:1 selection and written out at exactly 1600 x 400.  showed
    that shape matches no surface on the site,  stopped every surface
    cropping at all, and what was left was a dialog that destroyed ~90% of a
    poster and then promised, one sentence later, never to crop it again.

    So the default here is **no crop**. Cropping is a thing a creator opts into
    when they want to change the composition, it is free-form when they do, and
    the only thing we still impose is a bound on the longest edge — see
    `$lib/utils/cover-image` for why that bound is 2048 and why it is the one
    part of 1600 x 400 worth keeping.
  */

  interface Props {
    open: boolean;
    sourceUrl: string;
    /**
     * The creator's own bytes. Present so an uncropped, in-bounds upload can be
     * sent through untouched — no generational JPEG loss, no alpha flattened to
     * black, no animated GIF reduced to its first frame.
     */
    sourceFile?: File | null;
    uploading: boolean;
    /** Longest stored edge, in pixels. Overridable so tests can shrink it. */
    maxEdge?: number;
    onOpenChange: (open: boolean) => void;
    onConfirm: (blob: Blob) => void | Promise<void>;
  }

  let {
    open = $bindable(),
    sourceUrl,
    sourceFile = null,
    uploading,
    maxEdge = MAX_COVER_EDGE,
    onOpenChange,
    onConfirm,
  }: Props = $props();

  // Smallest selection size we allow, measured in on-screen pixels.
  const MIN_SCREEN = 44;
  // Longest edge of the live preview raster. Small enough to re-render on every
  // drag settle, large enough that `chooseImageFit` in `FeaturedImageFrame`
  // reaches the same verdict it will reach for the real upload.
  const PREVIEW_EDGE = 640;

  let viewportRef = $state<HTMLDivElement | null>(null);
  let imageRef = $state<HTMLImageElement | null>(null);

  let naturalWidth = $state(0);
  let naturalHeight = $state(0);
  let viewportWidth = $state(0);
  let viewportHeight = $state(0);

  /** Off by default: the primary action is to use the whole image. */
  let cropping = $state(false);
  /** `null` is free-form, and free-form is the default when cropping starts. */
  let lockedRatio = $state<number | null>(null);
  let activePreset = $state<string>("free");

  // Selection rectangle expressed in natural image pixels.
  let selX = $state(0);
  let selY = $state(0);
  let selW = $state(0);
  let selH = $state(0);

  type DragMode = "move" | "nw" | "ne" | "sw" | "se";
  let dragMode = $state<DragMode | null>(null);
  let pointerId = $state<number | null>(null);
  let originClientX = $state(0);
  let originClientY = $state(0);
  let originSel = $state({ x: 0, y: 0, w: 0, h: 0 });
  let resizeAnchorX = $state(0);
  let resizeAnchorY = $state(0);
  let vpRectLeft = $state(0);
  let vpRectTop = $state(0);

  let previewUrl = $state("");
  let previewObjectUrl: string | null = null;

  // Scale that fits the natural image inside the viewport (object-contain).
  const fitScale = $derived(
    naturalWidth && naturalHeight && viewportWidth && viewportHeight
      ? Math.min(viewportWidth / naturalWidth, viewportHeight / naturalHeight)
      : 1,
  );
  const renderedWidth = $derived(naturalWidth * fitScale);
  const renderedHeight = $derived(naturalHeight * fitScale);
  const imageLeft = $derived((viewportWidth - renderedWidth) / 2);
  const imageTop = $derived((viewportHeight - renderedHeight) / 2);

  // Selection mapped from natural pixels to on-screen viewport pixels.
  const screenSel = $derived({
    left: imageLeft + selX * fitScale,
    top: imageTop + selY * fitScale,
    width: selW * fitScale,
    height: selH * fitScale,
  });

  const loaded = $derived(naturalWidth > 0 && naturalHeight > 0);
  const ready = $derived(loaded && (!cropping || selW > 0));

  /** The region of the source that will be stored, in natural pixels. */
  const region = $derived(
    cropping && selW > 0 && selH > 0
      ? { x: selX, y: selY, width: selW, height: selH }
      : { x: 0, y: 0, width: naturalWidth, height: naturalHeight },
  );

  /** What the stored file's dimensions will be, shown to the creator. */
  const storedSize = $derived(
    boundedCoverSize({ width: region.width, height: region.height }, maxEdge),
  );

  /**
   * Measured against the running site at a 1614px viewport. These are
   * the real boxes, not approximations, which is the whole point: the previews
   * replace a sentence describing what will happen with the thing happening.
   */
  const SURFACES = [
    { id: "thumbnail", style: "w-16 sm:w-20 aspect-square" },
    { id: "card", style: "w-28 sm:w-40 aspect-[382/176]" },
    { id: "hero", style: "w-36 sm:w-56 aspect-[1614/658]" },
  ] as const;

  /**
   * What the previews render. Uncropped, that is the creator's file itself, so
   * the preview is byte-identical to the upload. Cropped, it is a small raster
   * of the selection — falling back to the source until the first one lands, so
   * the row never blinks empty mid-drag.
   */
  const previewSrc = $derived(
    cropping && previewUrl ? previewUrl : sourceUrl || "",
  );

  function measureViewport() {
    if (!viewportRef) {
      return;
    }
    viewportWidth = viewportRef.clientWidth;
    viewportHeight = viewportRef.clientHeight;
  }

  function minSelSize() {
    return Math.max(16, MIN_SCREEN / (fitScale || 1));
  }

  /** The whole image, which is where every crop session starts. */
  function selectEverything() {
    selX = 0;
    selY = 0;
    selW = naturalWidth;
    selH = naturalHeight;
  }

  function handleImageLoad() {
    if (!imageRef) {
      return;
    }
    naturalWidth = imageRef.naturalWidth;
    naturalHeight = imageRef.naturalHeight;
    measureViewport();
    selectEverything();
  }

  /**
   * The largest box of `ratio` that fits inside the image, centred. Used only
   * when a preset is chosen — never on open, because on open there is no crop.
   */
  function applyRatio(ratio: number | null) {
    lockedRatio = ratio;
    if (!loaded || ratio === null) {
      return;
    }

    let w = naturalWidth;
    let h = w / ratio;
    if (h > naturalHeight) {
      h = naturalHeight;
      w = h * ratio;
    }

    selW = w;
    selH = h;
    selX = (naturalWidth - w) / 2;
    selY = (naturalHeight - h) / 2;
  }

  function choosePreset(id: string) {
    activePreset = id;
    if (id === "free") {
      applyRatio(null);
      return;
    }
    if (id === "original") {
      applyRatio(naturalHeight > 0 ? naturalWidth / naturalHeight : null);
      return;
    }
    if (id === "square") {
      applyRatio(1);
      return;
    }
    if (id === "wide") {
      applyRatio(16 / 9);
      return;
    }
    applyRatio(2);
  }

  function startCropping() {
    cropping = true;
    activePreset = "free";
    lockedRatio = null;
    selectEverything();
  }

  function stopCropping() {
    cropping = false;
    activePreset = "free";
    lockedRatio = null;
    selectEverything();
    releasePreviewUrl();
  }

  function startDrag(event: PointerEvent, mode: DragMode) {
    event.preventDefault();
    event.stopPropagation();
    if (!viewportRef || !cropping || !loaded) {
      return;
    }

    const rect = viewportRef.getBoundingClientRect();
    vpRectLeft = rect.left;
    vpRectTop = rect.top;
    dragMode = mode;
    pointerId = event.pointerId;
    originClientX = event.clientX;
    originClientY = event.clientY;
    originSel = { x: selX, y: selY, w: selW, h: selH };

    // The anchor is the corner that stays put: the one opposite the handle.
    if (mode === "se") {
      resizeAnchorX = selX;
      resizeAnchorY = selY;
    } else if (mode === "sw") {
      resizeAnchorX = selX + selW;
      resizeAnchorY = selY;
    } else if (mode === "ne") {
      resizeAnchorX = selX;
      resizeAnchorY = selY + selH;
    } else if (mode === "nw") {
      resizeAnchorX = selX + selW;
      resizeAnchorY = selY + selH;
    }

    viewportRef.setPointerCapture(event.pointerId);
  }

  /**
   * Free-form resize: each axis follows the pointer independently, stopping at
   * the image edge and at the minimum size. The moving corner is never allowed
   * past the anchor, so the rectangle cannot invert.
   */
  function applyFreeResize(natX: number, natY: number) {
    const min = minSelSize();
    const px = Math.min(Math.max(natX, 0), naturalWidth);
    const py = Math.min(Math.max(natY, 0), naturalHeight);
    const east = dragMode === "se" || dragMode === "ne";
    const south = dragMode === "se" || dragMode === "sw";

    if (east) {
      const lo = Math.min(resizeAnchorX + min, naturalWidth);
      selX = resizeAnchorX;
      selW = Math.max(Math.min(Math.max(px, lo), naturalWidth) - selX, 1);
    } else {
      const hi = Math.max(resizeAnchorX - min, 0);
      selX = Math.min(Math.max(px, 0), hi);
      selW = Math.max(resizeAnchorX - selX, 1);
    }

    if (south) {
      const lo = Math.min(resizeAnchorY + min, naturalHeight);
      selY = resizeAnchorY;
      selH = Math.max(Math.min(Math.max(py, lo), naturalHeight) - selY, 1);
    } else {
      const hi = Math.max(resizeAnchorY - min, 0);
      selY = Math.min(Math.max(py, 0), hi);
      selH = Math.max(resizeAnchorY - selY, 1);
    }
  }

  /** Locked-ratio resize: one degree of freedom, bounded by the image edges. */
  function applyRatioResize(natX: number, natY: number, aspect: number) {
    const fromX = Math.abs(natX - resizeAnchorX);
    const fromY = Math.abs(natY - resizeAnchorY) * aspect;
    let maxW: number;

    if (dragMode === "se") {
      maxW = Math.min(
        naturalWidth - resizeAnchorX,
        (naturalHeight - resizeAnchorY) * aspect,
      );
    } else if (dragMode === "sw") {
      maxW = Math.min(resizeAnchorX, (naturalHeight - resizeAnchorY) * aspect);
    } else if (dragMode === "ne") {
      maxW = Math.min(naturalWidth - resizeAnchorX, resizeAnchorY * aspect);
    } else {
      maxW = Math.min(resizeAnchorX, resizeAnchorY * aspect);
    }

    const minW = Math.min(maxW, minSelSize());
    const w = Math.max(minW, Math.min(Math.max(fromX, fromY), maxW));
    const h = w / aspect;

    selW = w;
    selH = h;

    if (dragMode === "se") {
      selX = resizeAnchorX;
      selY = resizeAnchorY;
    } else if (dragMode === "sw") {
      selX = resizeAnchorX - w;
      selY = resizeAnchorY;
    } else if (dragMode === "ne") {
      selX = resizeAnchorX;
      selY = resizeAnchorY - h;
    } else {
      selX = resizeAnchorX - w;
      selY = resizeAnchorY - h;
    }
  }

  function moveDrag(event: PointerEvent) {
    if (pointerId !== event.pointerId || !dragMode) {
      return;
    }

    if (dragMode === "move") {
      const dxNat = (event.clientX - originClientX) / (fitScale || 1);
      const dyNat = (event.clientY - originClientY) / (fitScale || 1);
      selX = Math.min(Math.max(0, originSel.x + dxNat), naturalWidth - selW);
      selY = Math.min(Math.max(0, originSel.y + dyNat), naturalHeight - selH);
      return;
    }

    const natX = (event.clientX - vpRectLeft - imageLeft) / (fitScale || 1);
    const natY = (event.clientY - vpRectTop - imageTop) / (fitScale || 1);
    if (lockedRatio === null) {
      applyFreeResize(natX, natY);
    } else {
      applyRatioResize(natX, natY, lockedRatio);
    }
  }

  function endDrag(event: PointerEvent) {
    if (pointerId !== event.pointerId) {
      return;
    }
    viewportRef?.releasePointerCapture(event.pointerId);
    pointerId = null;
    dragMode = null;
  }

  /**
   * Encode a canvas.
   *
   * PNG and JPEG only, never WebP — even though WebP is smaller and on the
   * server allowlist. `single_public_upload_handle` calls `create_thumbnail`
   * for `image/jpeg` and `image/png` and nothing else, and `get_thumbnail()`
   * falls back to **the original** when there is no thumbnail row. `ZpageCard`
   * reads `featured_image.thumbnail || featured_image.url`, so a WebP cover
   * would put the full 2048px original on every card in the feed. The format
   * that saves 30% on the stored file costs 10x on the one that is actually
   * fetched.
   */
  function encode(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(
              new Error(
                $t(
                  "editor.cropExportFailed",
                  "Unable to export the cover image.",
                ),
              ),
            );
            return;
          }
          resolve(blob);
        },
        type,
        0.92,
      );
    });
  }

  async function renderRegion(edge: number): Promise<Blob> {
    if (!imageRef || !region.width || !region.height) {
      throw new Error(
        $t("editor.coverNotReady", "The cover image is not ready yet."),
      );
    }

    const target = boundedCoverSize(
      { width: region.width, height: region.height },
      edge,
    );

    const canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;

    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error(
        $t(
          "editor.cropPreparationFailed",
          "Unable to prepare the cover image.",
        ),
      );
    }

    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(
      imageRef,
      region.x,
      region.y,
      region.width,
      region.height,
      0,
      0,
      target.width,
      target.height,
    );

    // Alpha decides the container. JPEG has none, so a transparent cover would
    // be flattened to black; PNG keeps it but is far larger, so it is only used
    // when there is something to keep — and only while it stays inside the
    // upload ceiling.
    if (hasTransparency(context, target.width, target.height)) {
      const png = await encode(canvas, "image/png");
      if (png.size <= MAX_ENCODED_COVER_BYTES) {
        return png;
      }
    }
    return encode(canvas, "image/jpeg");
  }

  /**
   * Whether anything on the canvas is not fully opaque.
   *
   * A full scan: sampling every Nth pixel would miss a one-pixel-wide
   * antialiased edge, which is the commonest form transparency actually takes
   * in a cover. It runs once per confirm and once per settled drag, on at most
   * `maxEdge` squared pixels.
   */
  function hasTransparency(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
  ): boolean {
    let data: Uint8ClampedArray;
    try {
      data = context.getImageData(0, 0, width, height).data;
    } catch {
      // A tainted canvas cannot be read. It also cannot be exported, so this
      // path ends in the same error either way; answer conservatively.
      return false;
    }
    for (let index = 3; index < data.length; index += 4) {
      if (data[index] !== 255) {
        return true;
      }
    }
    return false;
  }

  function releasePreviewUrl() {
    if (previewObjectUrl) {
      URL.revokeObjectURL(previewObjectUrl);
      previewObjectUrl = null;
    }
    previewUrl = "";
  }

  async function handleApply() {
    const operationNotice = captureAccountToast();
    try {
      // Nothing was cropped and nothing needs shrinking: send the creator's own
      // file, untouched. This is what "use full image" should mean literally.
      if (
        sourceFile &&
        canUseSourceFileDirectly({
          cropped: cropping,
          natural: { width: naturalWidth, height: naturalHeight },
          mimeType: sourceFile.type,
          byteLength: sourceFile.size,
          maxEdge,
        })
      ) {
        await onConfirm(sourceFile);
        return;
      }

      await onConfirm(await renderRegion(maxEdge));
    } catch (error: any) {
      console.error("Failed to prepare cover image:", error);
      operationNotice.error(
        $t(
          "editor.coverPreparationFailed",
          "Failed to prepare the cover image.",
        ),
      );
    }
  }

  $effect(() => {
    const viewport = viewportRef;
    if (!viewport || typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(() => {
      viewportWidth = viewport.clientWidth;
      viewportHeight = viewport.clientHeight;
    });

    viewportWidth = viewport.clientWidth;
    viewportHeight = viewport.clientHeight;
    observer.observe(viewport);

    return () => {
      observer.disconnect();
    };
  });

  // Re-raster the preview once a drag settles. Debounced rather than
  // per-pointermove: a 2048px `drawImage` on every move event would fight the
  // drag it is illustrating.
  $effect(() => {
    const active = cropping;
    const bounds = { x: selX, y: selY, w: selW, h: selH };
    const src = sourceUrl;

    if (!active || !src || !loaded || bounds.w <= 0 || bounds.h <= 0) {
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      void renderRegion(PREVIEW_EDGE)
        .then((blob) => {
          if (cancelled) {
            return;
          }
          if (previewObjectUrl) {
            URL.revokeObjectURL(previewObjectUrl);
          }
          previewObjectUrl = URL.createObjectURL(blob);
          previewUrl = previewObjectUrl;
        })
        .catch(() => {
          // The previews are an illustration; a failed raster leaves the last
          // good one on screen rather than interrupting the crop.
        });
    }, 150);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  });

  // A new source image is a new session: drop any crop and any stale preview.
  $effect(() => {
    void sourceUrl;
    naturalWidth = 0;
    naturalHeight = 0;
    cropping = false;
    activePreset = "free";
    lockedRatio = null;
    releasePreviewUrl();
  });

  // The preview raster is our own object URL, and the dialog can be destroyed
  // mid-crop (route change, editor unmount) without ever reaching `stopCropping`.
  onDestroy(() => {
    releasePreviewUrl();
  });
</script>

<Dialog.Root bind:open {onOpenChange}>
  <Dialog.Content
    class="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden sm:max-w-[880px]"
  >
    <Dialog.Header class="shrink-0">
      <Dialog.Title>
        {$t("editor.coverFramingTitle", "Cover image")}
      </Dialog.Title>
      <!--
        The old copy here promised a 1600 x 400 output in one sentence and
        promised never to crop in the next. Both were true and together they
        were absurd. This says the one thing that is now true of every surface.
      -->
      <Dialog.Description>
        {$t(
          "editor.coverFramingDescription",
          "Your whole image is used. Cards, search and the page itself pad it to fit instead of cropping it — the previews below are the real thing.",
        )}
      </Dialog.Description>
    </Dialog.Header>

    <div class="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain">
      <div
        bind:this={viewportRef}
        class="relative h-[clamp(200px,38vh,420px)] touch-none overflow-hidden rounded-2xl border bg-muted select-none"
        onpointermove={moveDrag}
        onpointerup={endDrag}
        onpointercancel={endDrag}
        onpointerleave={endDrag}
      >
        {#if sourceUrl}
          <img
            bind:this={imageRef}
            src={sourceUrl}
            alt={$t(
              "editor.cropCoverPreviewAlt",
              "Preview of the cover image being framed",
            )}
            class="pointer-events-none absolute max-w-none select-none"
            style={`left:${imageLeft}px; top:${imageTop}px; width:${renderedWidth}px; height:${renderedHeight}px;`}
            draggable="false"
            onload={handleImageLoad}
          />

          {#if cropping && loaded && selW > 0}
            <!-- Selection box; its large box-shadow dims everything outside it. -->
            <div
              class="absolute cursor-move"
              style={`left:${screenSel.left}px; top:${screenSel.top}px; width:${screenSel.width}px; height:${screenSel.height}px; box-shadow: 0 0 0 9999px rgba(0,0,0,0.55);`}
              onpointerdown={(event) => startDrag(event, "move")}
              role="presentation"
              data-testid="cover-crop-selection"
            >
              <div class="absolute inset-0 border-2 border-white/90"></div>

              <!-- Rule-of-thirds guides -->
              <div
                class="pointer-events-none absolute inset-y-0 left-1/3 w-px bg-white/30"
              ></div>
              <div
                class="pointer-events-none absolute inset-y-0 left-2/3 w-px bg-white/30"
              ></div>
              <div
                class="pointer-events-none absolute inset-x-0 top-1/3 h-px bg-white/30"
              ></div>
              <div
                class="pointer-events-none absolute inset-x-0 top-2/3 h-px bg-white/30"
              ></div>

              <!-- Corner resize handles -->
              <div
                class="absolute -top-1.5 -left-1.5 h-3.5 w-3.5 cursor-nwse-resize rounded-sm border-2 border-white bg-primary"
                onpointerdown={(event) => startDrag(event, "nw")}
                role="presentation"
              ></div>
              <div
                class="absolute -top-1.5 -right-1.5 h-3.5 w-3.5 cursor-nesw-resize rounded-sm border-2 border-white bg-primary"
                onpointerdown={(event) => startDrag(event, "ne")}
                role="presentation"
              ></div>
              <div
                class="absolute -bottom-1.5 -left-1.5 h-3.5 w-3.5 cursor-nesw-resize rounded-sm border-2 border-white bg-primary"
                onpointerdown={(event) => startDrag(event, "sw")}
                role="presentation"
              ></div>
              <div
                class="absolute -right-1.5 -bottom-1.5 h-3.5 w-3.5 cursor-nwse-resize rounded-sm border-2 border-white bg-primary"
                onpointerdown={(event) => startDrag(event, "se")}
                role="presentation"
              ></div>
            </div>
          {/if}
        {/if}
      </div>

      {#if cropping}
        <div class="space-y-2" data-testid="cover-ratio-presets">
          <div class="flex flex-wrap items-center gap-2">
            <span class="text-xs text-muted-foreground">
              {$t("editor.coverRatioLabel", "Shape")}
            </span>
            {#each [["free", $t("editor.coverRatioFree", "Free")], ["original", $t("editor.coverRatioOriginal", "Original")], ["square", $t("editor.coverRatioSquare", "Square")], ["wide", $t("editor.coverRatioWide", "16:9")], ["banner", $t("editor.coverRatioBanner", "Wide")]] as [id, label] (id)}
              <Button
                variant={activePreset === id ? "default" : "outline"}
                size="sm"
                class="h-7 rounded-full px-3 text-xs"
                aria-pressed={activePreset === id}
                onclick={() => choosePreset(id)}
              >
                {label}
              </Button>
            {/each}
          </div>
          <p class="text-xs text-muted-foreground">
            {$t(
              "editor.coverCropTip",
              "Drag inside the box to reposition it, or grab a corner to resize. No shape is required — pick a preset only if you want one.",
            )}
          </p>
        </div>
      {/if}

      <div class="space-y-2">
        <p class="text-xs font-medium text-muted-foreground">
          {$t("editor.coverPreviewHeading", "How it will look")}
        </p>
        <!--
          One row on a phone, scrolled sideways rather than wrapped: wrapping
          drops the third tile onto its own line, which pushes its label under
          the footer and costs the cropper vertical space it needs more.
        -->
        <div
          class="-mx-1 flex items-end gap-3 overflow-x-auto px-1 pb-1 sm:mx-0 sm:flex-wrap sm:gap-4 sm:overflow-visible sm:px-0"
          data-testid="cover-previews"
        >
          {#each SURFACES as surface (surface.id)}
            <div class="shrink-0 space-y-1">
              <FeaturedImageFrame
                src={previewSrc}
                alt=""
                loading="eager"
                class={`overflow-hidden rounded-lg border bg-muted ${surface.style}`}
              />
              <p class="text-[11px] text-muted-foreground">
                {surface.id === "thumbnail"
                  ? $t("editor.coverPreviewThumbnail", "Thumbnail")
                  : surface.id === "card"
                    ? $t("editor.coverPreviewCard", "Card")
                    : $t("editor.coverPreviewHero", "Article hero")}
              </p>
            </div>
          {/each}
        </div>
      </div>

      <p class="text-xs text-muted-foreground">
        {#if storedSize.width > 0}
          {$t(
            "editor.coverStoredSizeNote",
            "Saved at {width} × {height}. Anything bigger is scaled down so the longest edge is at most {max} pixels — the shape is never changed.",
            {
              width: storedSize.width,
              height: storedSize.height,
              max: maxEdge,
            },
          )}
        {:else}
          {$t(
            "editor.coverSizeCapNote",
            "Large images are scaled down so the longest edge is at most {max} pixels. The shape is never changed.",
            { max: maxEdge },
          )}
        {/if}
      </p>
    </div>

    <Dialog.Footer class="shrink-0">
      <Button
        variant="ghost"
        onclick={() => onOpenChange(false)}
        disabled={uploading}
      >
        {$t("common.cancel", "Cancel")}
      </Button>

      {#if cropping}
        <Button variant="outline" onclick={stopCropping} disabled={uploading}>
          <RotateCcw class="h-4 w-4" />
          {$t("editor.coverClearCrop", "Clear crop")}
        </Button>
      {:else}
        <Button
          variant="outline"
          onclick={startCropping}
          disabled={uploading || !loaded}
        >
          <Crop class="h-4 w-4" />
          {$t("editor.coverAdjustFraming", "Adjust framing")}
        </Button>
      {/if}

      <Button
        onclick={() => void handleApply()}
        disabled={uploading || !ready}
        data-testid="cover-confirm"
      >
        {#if uploading}
          <Loader2 class="h-4 w-4 animate-spin" />
        {:else}
          <Check class="h-4 w-4" />
        {/if}
        {cropping
          ? $t("editor.coverUseThisCrop", "Use this crop")
          : $t("editor.coverUseFullImage", "Use full image")}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
