/**
 * Copy an exact string to the clipboard.
 *
 * The value is written verbatim — no trimming, no normalization, no added
 * whitespace. Callers use this for money-routing values (Zcash addresses),
 * where a single altered character sends funds somewhere unrecoverable.
 *
 * Falls back to a hidden textarea + `document.execCommand('copy')` when the
 * async Clipboard API is unavailable (non-secure contexts, older Safari,
 * permission denied).
 */
export async function copyToClipboard(value: string): Promise<boolean> {
  if (typeof document === "undefined") return false;

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall through to the execCommand path below.
  }

  const previouslyFocused = document.activeElement as HTMLElement | null;
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "-9999px";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);

  try {
    textarea.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
    previouslyFocused?.focus?.();
  }
}
