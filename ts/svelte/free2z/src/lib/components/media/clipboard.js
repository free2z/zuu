/**
 * Copy `text` to the clipboard, falling back to a hidden textarea when the
 * async Clipboard API is missing or permission-blocked (Safari without a
 * user gesture, insecure origins, some in-app browsers).
 *
 * Returns true only when the text actually made it to the clipboard, so
 * callers never show a "copied" confirmation for a copy that failed.
 *
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export async function copyTextToClipboard(text) {
  if (!text) return false;

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // The API can exist while clipboard permission is unavailable.
    }
  }

  if (typeof document === "undefined") return false;

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  try {
    textarea.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}
