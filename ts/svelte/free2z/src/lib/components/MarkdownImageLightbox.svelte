<script module lang="ts">
  export type MarkdownImageLightboxImage = {
    url: string;
    alt: string;
    title: string;
    trigger: HTMLButtonElement;
  };
</script>

<script lang="ts">
  import XIcon from "@lucide/svelte/icons/x";
  import * as Dialog from "$lib/components/ui/dialog";
  import { tStore as t } from "$lib/i18n";

  type Props = {
    image?: MarkdownImageLightboxImage | null;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  };

  let { image = null, open = false, onOpenChange = () => {} }: Props = $props();

  const fallbackTitle = () => $t("common.expandedImage", "Expanded image");

  function dialogName() {
    return image?.alt.trim() || image?.title.trim() || fallbackTitle();
  }

  function handleOpenChange(nextOpen: boolean) {
    onOpenChange(nextOpen);
  }

  function closeFromBackdrop(event: MouseEvent) {
    const target = event.target;
    if (
      target instanceof Element &&
      !target.closest(".markdown-image-lightbox__image")
    ) {
      onOpenChange(false);
    }
  }

  function preventDefaultFocus(event: Event) {
    // MarkdownContent owns the exact live trigger to restore. Letting bits-ui
    // guess after a rerender could focus a different image or a dead node.
    event.preventDefault();
  }
</script>

<Dialog.Root {open} onOpenChange={handleOpenChange}>
  {#if image}
    <Dialog.Content
      showCloseButton={false}
      data-testid="markdown-image-lightbox"
      aria-describedby={undefined}
      class="markdown-image-lightbox fixed inset-0 z-[100] h-[100dvh] w-screen max-w-none gap-0 overflow-hidden rounded-none border-0 bg-transparent p-0 shadow-none"
      onCloseAutoFocus={preventDefaultFocus}
    >
      <Dialog.Title class="sr-only">{dialogName()}</Dialog.Title>

      <div class="markdown-image-lightbox__backdrop" aria-hidden="true"></div>

      <figure
        class="markdown-image-lightbox__stage"
        role="presentation"
        onclick={closeFromBackdrop}
      >
        <div class="markdown-image-lightbox__pad" aria-hidden="true">
          <div class="markdown-image-lightbox__pad-inner">
            <img src={image.url} alt="" loading="lazy" decoding="async" />
          </div>
        </div>

        <img
          class="markdown-image-lightbox__image"
          src={image.url}
          alt={image.alt}
          loading="eager"
          decoding="async"
        />

        {#if image.title || image.alt}
          <figcaption class="markdown-image-lightbox__caption">
            {image.title || image.alt}
          </figcaption>
        {/if}
      </figure>

      <Dialog.Close
        class="markdown-image-lightbox__close"
        aria-label={$t("common.close", "Close")}
      >
        <XIcon aria-hidden="true" />
        <span class="sr-only">{$t("common.close", "Close")}</span>
      </Dialog.Close>
    </Dialog.Content>
  {/if}
</Dialog.Root>

<style>
  :global([data-testid="markdown-image-lightbox"]) {
    top: 0 !important;
    left: 0 !important;
    translate: none !important;
    transform: none !important;
    width: 100vw !important;
    max-width: none !important;
    height: 100dvh !important;
    animation: none !important;
  }

  :global([data-testid="markdown-image-lightbox"][data-state="closed"]) {
    pointer-events: none;
  }

  .markdown-image-lightbox__backdrop,
  .markdown-image-lightbox__pad {
    position: absolute;
    inset: 0;
  }

  .markdown-image-lightbox__backdrop {
    z-index: 0;
    cursor: zoom-out;
    background: rgb(0 0 0 / 0.48);
  }

  .markdown-image-lightbox__pad {
    overflow: hidden;
    background: var(--background, #111111);
    pointer-events: none;
    z-index: 0;
  }

  .markdown-image-lightbox__pad-inner {
    position: absolute;
    top: -10%;
    left: -10%;
    width: 30%;
    height: 30%;
    transform: scale(4);
    transform-origin: 0 0;
    filter: blur(8px) saturate(0.9);
  }

  .markdown-image-lightbox__pad-inner img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .markdown-image-lightbox__pad::after {
    position: absolute;
    inset: 0;
    background: color-mix(in oklab, var(--background) 50%, transparent);
    content: "";
  }

  .markdown-image-lightbox__stage {
    --lightbox-safe-bottom: max(4.5rem, env(safe-area-inset-bottom));
    --lightbox-caption-space: 5rem;
    --lightbox-safe-left: max(1rem, env(safe-area-inset-left));
    --lightbox-safe-right: max(1rem, env(safe-area-inset-right));
    --lightbox-safe-top: max(4.5rem, env(safe-area-inset-top));
    position: relative;
    z-index: 1;
    display: grid;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    place-items: center;
    margin: 0;
    padding: var(--lightbox-safe-top) var(--lightbox-safe-right)
      calc(var(--lightbox-safe-bottom) + var(--lightbox-caption-space))
      var(--lightbox-safe-left);
    overflow: hidden;
    cursor: zoom-out;
  }

  .markdown-image-lightbox__image {
    position: relative;
    z-index: 1;
    display: block;
    cursor: default;
    width: auto;
    max-width: calc(
      100vw - var(--lightbox-safe-left) - var(--lightbox-safe-right)
    );
    height: auto;
    max-height: calc(
      100dvh - var(--lightbox-safe-top) - var(--lightbox-safe-bottom) -
        var(--lightbox-caption-space)
    );
    object-fit: contain;
    border-radius: 0.25rem;
    box-shadow: 0 1rem 3rem rgb(0 0 0 / 0.3);
  }

  .markdown-image-lightbox__caption {
    position: absolute;
    z-index: 2;
    right: max(1rem, env(safe-area-inset-right));
    bottom: max(1rem, env(safe-area-inset-bottom));
    left: max(1rem, env(safe-area-inset-left));
    max-width: 48rem;
    max-height: calc(3 * 1.35em + 1rem);
    margin-inline: auto;
    padding: 0.5rem 3.5rem;
    overflow: hidden;
    color: white;
    background: rgb(0 0 0 / 0.62);
    border-radius: 0.5rem;
    font-size: 0.875rem;
    line-height: 1.35;
    text-align: center;
    text-shadow: 0 1px 0 rgb(0 0 0 / 0.75);
    display: -webkit-box;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    pointer-events: auto;
  }

  :global(.markdown-image-lightbox__close) {
    position: absolute;
    z-index: 3;
    top: max(0.75rem, env(safe-area-inset-top));
    right: max(0.75rem, env(safe-area-inset-right));
    display: grid;
    width: 2.75rem;
    height: 2.75rem;
    place-items: center;
    border: 1px solid rgb(255 255 255 / 0.4);
    border-radius: 999px;
    color: white;
    background: rgb(0 0 0 / 0.55);
    cursor: pointer;
    transition: background-color 120ms ease;
  }

  :global(.markdown-image-lightbox__close:hover) {
    background: rgb(0 0 0 / 0.75);
  }

  :global(.markdown-image-lightbox__close:focus-visible) {
    outline: 2px solid white;
    outline-offset: 3px;
  }

  @media (prefers-reduced-motion: reduce) {
    :global(.markdown-image-lightbox__close) {
      transition: none;
    }
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
