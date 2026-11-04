/** Frame-batched, distance-based intent for document-scrolling topbars. */
export function scrollTopbar(
  node: HTMLElement,
  options: { pinned: boolean; resetKey?: number },
) {
  let pinned = options.pinned;
  let frame = 0;
  let hidden = false;
  let anchor = scrollPosition();

  function scrollPosition() {
    // Clamp rubber-band overscroll, which otherwise looks like a reversal.
    return Math.max(
      0,
      Math.min(
        window.scrollY,
        document.documentElement.scrollHeight - window.innerHeight,
      ),
    );
  }

  function show(nextHidden: boolean) {
    if (hidden === nextHidden) return;
    hidden = nextHidden;
    node.dataset.scrollHidden = String(hidden);
  }

  function update() {
    frame = 0;
    const y = scrollPosition();
    // Pointer focus restored after a menu closes should not make the header
    // permanently sticky. Keyboard focus keeps controls in view.
    if (pinned || node.querySelector(":focus-visible") || y <= 20) {
      show(false);
      anchor = y;
      return;
    }

    // Track the extreme in the current direction. Tiny reversals cannot
    // restart an animation, and gentle 1px trackpad deltas still accumulate.
    anchor = hidden ? Math.max(anchor, y) : Math.min(anchor, y);
    if (
      (!hidden && y > 64 && y - anchor >= 24) ||
      (hidden && anchor - y >= 12)
    ) {
      show(!hidden);
      anchor = y;
    }
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(update);
  }

  function focusIn() {
    show(false);
    anchor = scrollPosition();
  }

  window.addEventListener("scroll", schedule, { passive: true });
  node.addEventListener("focusin", focusIn);
  node.addEventListener("focusout", schedule);
  return {
    update(nextOptions: { pinned: boolean; resetKey?: number }) {
      pinned = nextOptions.pinned;
      // Overlay opening/closing resets intent at the current position.
      show(false);
      anchor = scrollPosition();
    },
    destroy() {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      node.removeEventListener("focusin", focusIn);
      node.removeEventListener("focusout", schedule);
    },
  };
}
