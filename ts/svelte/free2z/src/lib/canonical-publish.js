/**
 * Existing canonical metadata should be visible when the publish sheet opens;
 * a blank article starts with the compact disclosure.
 *
 * @param {unknown} value
 */
export function shouldExpandCanonicalDisclosure(value) {
  return typeof value === "string" && Boolean(value.trim());
}

/**
 * Disclosure is presentation only. Collapsing must never clear the URL.
 *
 * @param {{expanded: boolean, value: string}} state
 * @param {boolean} expanded
 */
export function setCanonicalDisclosureExpanded(state, expanded) {
  return { ...state, expanded };
}

/**
 * Focus the first invalid control after a failed publish-sheet action.
 * Scrolling first keeps the focused control visible above mobile keyboards.
 *
 * @param {{querySelector: (selector: string) => any} | null | undefined} root
 */
export function focusFirstInvalidField(root) {
  const field = root?.querySelector(
    '[aria-invalid="true"], [data-invalid="true"]',
  );

  if (!field || typeof field.focus !== "function") {
    return false;
  }

  field.scrollIntoView?.({ behavior: "smooth", block: "center" });
  field.focus({ preventScroll: true });
  return true;
}
