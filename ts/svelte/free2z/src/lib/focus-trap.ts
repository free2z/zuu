/**
 * Keep keyboard focus inside a modal surface while it is open, and give it
 * back to whatever had it when the surface closes (: the bulk translate
 * dialog and the translations tray).
 *
 * Deliberately small: Tab and Shift+Tab wrap between the first and last
 * focusable element, focus moves in on mount unless something inside already
 * has it, and the element focused before mount is refocused on destroy — if it
 * is still in the document.
 */
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function focusables(node: HTMLElement): HTMLElement[] {
  return [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) => !element.closest("[inert]") && element.offsetParent !== null,
  );
}

export function focusTrap(node: HTMLElement) {
  const previous =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

  queueMicrotask(() => {
    if (!node.contains(document.activeElement)) {
      (focusables(node)[0] ?? node).focus();
    }
  });

  function onKeydown(event: KeyboardEvent) {
    if (event.key !== "Tab") return;
    const items = focusables(node);
    if (!items.length) {
      event.preventDefault();
      node.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !node.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !node.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }

  node.addEventListener("keydown", onKeydown);
  return {
    destroy() {
      node.removeEventListener("keydown", onKeydown);
      if (previous && previous.isConnected) previous.focus();
    },
  };
}
