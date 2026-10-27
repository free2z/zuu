<script lang="ts">
  import {
    Toaster as Sonner,
    type ToasterProps as SonnerProps,
  } from "svelte-sonner";
  import { mode } from "mode-watcher";
  import { onMount } from "svelte";

  // Sonner has separate desktop/mobile offsets, so both must consume the
  // classic-UI banner's measured dock height. Keep the package's existing
  // 24px/16px viewport spacing and add safe-area clearance at the same time.
  const offset: SonnerProps["offset"] = {
    bottom:
      "calc(max(1.5rem, calc(env(safe-area-inset-bottom) + 1rem)) + var(--f2z-bottom-dock-height, 0px))",
  };
  const mobileOffset: SonnerProps["mobileOffset"] = {
    bottom:
      "calc(max(1rem, calc(env(safe-area-inset-bottom) + 1rem)) + var(--f2z-bottom-dock-height, 0px))",
  };

  let { position = "bottom-center", ...restProps }: SonnerProps = $props();
  let modalOpen = $state(false);
  onMount(() => {
    const update = () => {
      // Keep acknowledgements visible while leaving mobile consent controls
      // at the bottom of a dialog reachable without first closing a snackbar.
      modalOpen = [
        ...document.querySelectorAll('[role="dialog"], [role="alertdialog"]'),
      ].some((dialog) => dialog.getClientRects().length > 0);
    };
    const observer = new MutationObserver(update);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class", "data-state", "hidden"],
    });
    update();
    return () => observer.disconnect();
  });
</script>

<Sonner
  theme={mode.current}
  class="toaster group"
  position={modalOpen ? "top-center" : position}
  {offset}
  {mobileOffset}
  closeButton
  style="--normal-bg: var(--color-popover); --normal-text: var(--color-popover-foreground); --normal-border: var(--color-border); z-index: 60;"
  {...restProps}
/>
