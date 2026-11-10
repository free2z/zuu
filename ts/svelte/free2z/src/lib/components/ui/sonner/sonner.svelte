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
  // Sonner writes attributes when `position` changes, and this observer
  // watches those attributes. Re-assigning an unchanged flag loops the toast
  // between anchors.
  let coversBottomAnchor = $state(false);
  onMount(() => {
    const dialogCoversBottomAnchor = () => {
      // Bottom-center slot: one toast row, Sonner's 24px offset, and the
      // published dock. The toast itself is the center 356px. A centered
      // receipt misses this rectangle; a full-height dialog or a bottom
      // drawer that reaches the viewport bottom does not, so consent
      // controls there stay reachable.
      const raw = getComputedStyle(document.documentElement)
        .getPropertyValue("--f2z-bottom-dock-height")
        .trim();
      const dockMatch = /^(\d+(?:\.\d+)?)px$/.exec(raw);
      const dock = dockMatch ? Number(dockMatch[1]) : 0;
      const bandTop = window.innerHeight - (96 + dock + 24);
      const bandLeft = (window.innerWidth - 356) / 2;
      const bandRight = bandLeft + 356;
      return [
        ...document.querySelectorAll('[role="dialog"], [role="alertdialog"]'),
      ].some((dialog) => {
        if (dialog.getClientRects().length === 0) return false;
        const rect = dialog.getBoundingClientRect();
        return (
          rect.left < bandRight &&
          rect.right > bandLeft &&
          rect.top < window.innerHeight &&
          rect.bottom > bandTop
        );
      });
    };
    const update = () => {
      const next = dialogCoversBottomAnchor();
      if (next !== coversBottomAnchor) coversBottomAnchor = next;
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
  position={coversBottomAnchor ? "top-center" : position}
  {offset}
  {mobileOffset}
  closeButton
  style="--normal-bg: var(--color-popover); --normal-text: var(--color-popover-foreground); --normal-border: var(--color-border); z-index: 60;"
  {...restProps}
/>
