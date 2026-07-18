<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import * as Dialog from "$lib/components/ui/dialog";
  import { t } from "$lib/i18n";
  import { toast } from "svelte-sonner";
  import { Crop, Loader2 } from "@lucide/svelte";

  interface Props {
    open: boolean;
    sourceUrl: string;
    uploading: boolean;
    coverWidth: number;
    coverHeight: number;
    onOpenChange: (open: boolean) => void;
    onConfirm: (blob: Blob) => void | Promise<void>;
  }

  let {
    open = $bindable(),
    sourceUrl,
    uploading,
    coverWidth,
    coverHeight,
    onOpenChange,
    onConfirm,
  }: Props = $props();

  const aspect = $derived(coverWidth / coverHeight);

  // Smallest selection size we allow, measured in on-screen pixels.
  const MIN_SCREEN = 44;

  let viewportRef = $state<HTMLDivElement | null>(null);
  let imageRef = $state<HTMLImageElement | null>(null);

  let naturalWidth = $state(0);
  let naturalHeight = $state(0);
  let viewportWidth = $state(0);
  let viewportHeight = $state(0);

  // Selection rectangle expressed in natural image pixels (w / h === aspect).
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

  const ready = $derived(naturalWidth > 0 && naturalHeight > 0 && selW > 0);

  function measureViewport() {
    if (!viewportRef) {
      return;
    }
    viewportWidth = viewportRef.clientWidth;
    viewportHeight = viewportRef.clientHeight;
  }

  function initSelection() {
    if (!naturalWidth || !naturalHeight) {
      return;
    }

    // Start with the largest aspect-correct box that fits, centered.
    let w = naturalWidth;
    let h = w / aspect;
    if (h > naturalHeight) {
      h = naturalHeight;
      w = h * aspect;
    }

    selW = w;
    selH = h;
    selX = (naturalWidth - w) / 2;
    selY = (naturalHeight - h) / 2;
  }

  function handleImageLoad() {
    if (!imageRef) {
      return;
    }
    naturalWidth = imageRef.naturalWidth;
    naturalHeight = imageRef.naturalHeight;
    measureViewport();
    initSelection();
  }

  function minSelWidth() {
    return Math.min(naturalWidth, Math.max(16, MIN_SCREEN / (fitScale || 1)));
  }

  function startDrag(event: PointerEvent, mode: DragMode) {
    event.preventDefault();
    event.stopPropagation();
    if (!viewportRef || !ready) {
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

  function applyResize(natX: number, natY: number) {
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

    const minW = Math.min(maxW, minSelWidth());
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
    applyResize(natX, natY);
  }

  function endDrag(event: PointerEvent) {
    if (pointerId !== event.pointerId) {
      return;
    }
    viewportRef?.releasePointerCapture(event.pointerId);
    pointerId = null;
    dragMode = null;
  }

  async function renderBlob() {
    if (!imageRef || !selW || !selH) {
      throw new Error("The cover image is not ready yet.");
    }

    const canvas = document.createElement("canvas");
    canvas.width = coverWidth;
    canvas.height = coverHeight;

    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Unable to prepare the cropped cover.");
    }

    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(
      imageRef,
      selX,
      selY,
      selW,
      selH,
      0,
      0,
      coverWidth,
      coverHeight,
    );

    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error("Unable to export the cropped cover."));
            return;
          }
          resolve(blob);
        },
        "image/jpeg",
        0.92,
      );
    });
  }

  async function handleApply() {
    try {
      const blob = await renderBlob();
      await onConfirm(blob);
    } catch (error: any) {
      toast.error(error?.message || "Failed to prepare the cover image.");
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
</script>

<Dialog.Root bind:open {onOpenChange}>
  <Dialog.Content class="sm:max-w-[820px]">
    <Dialog.Header>
      <Dialog.Title>
        {t("editor.cropCoverTitle", "Crop cover image")}
      </Dialog.Title>
      <Dialog.Description>
        {t(
          "editor.cropCoverDescription",
          "Drag the box to choose the part of your image to feature. Drag a corner to resize. The saved cover will be 1600 × 400.",
        )}
      </Dialog.Description>
    </Dialog.Header>

    <div class="space-y-4">
      <div
        bind:this={viewportRef}
        class="relative h-[clamp(240px,52vh,520px)] touch-none overflow-hidden rounded-2xl border bg-muted select-none"
        onpointermove={moveDrag}
        onpointerup={endDrag}
        onpointercancel={endDrag}
        onpointerleave={endDrag}
      >
        {#if sourceUrl}
          <img
            bind:this={imageRef}
            src={sourceUrl}
            alt="Crop cover preview"
            class="pointer-events-none absolute max-w-none select-none"
            style={`left:${imageLeft}px; top:${imageTop}px; width:${renderedWidth}px; height:${renderedHeight}px;`}
            draggable="false"
            onload={handleImageLoad}
          />

          {#if ready}
            <!-- Selection box; its large box-shadow dims everything outside it. -->
            <div
              class="absolute cursor-move"
              style={`left:${screenSel.left}px; top:${screenSel.top}px; width:${screenSel.width}px; height:${screenSel.height}px; box-shadow: 0 0 0 9999px rgba(0,0,0,0.55);`}
              onpointerdown={(event) => startDrag(event, "move")}
              role="presentation"
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

      <p class="text-xs text-muted-foreground">
        {t(
          "editor.cropCoverTip",
          "Drag inside the box to reposition it, or grab a corner to change how much of the image is included.",
        )}
      </p>
    </div>

    <Dialog.Footer>
      <Button
        variant="outline"
        onclick={() => onOpenChange(false)}
        disabled={uploading}
      >
        {t("common.cancel", "Cancel")}
      </Button>
      <Button onclick={() => void handleApply()} disabled={uploading || !ready}>
        {#if uploading}
          <Loader2 class="h-4 w-4 animate-spin" />
        {:else}
          <Crop class="h-4 w-4" />
        {/if}
        {t("editor.applyCoverCrop", "Apply Cover")}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
