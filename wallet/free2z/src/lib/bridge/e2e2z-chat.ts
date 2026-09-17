/**
 * Contract B of #1022: opening e2e2z on a first-contact screen.
 *
 * ```
 * https://free2z.com/bridge/e2e2z/chat/#peer=<handle>    handle ∈ ^[a-z0-9_]{1,30}$
 * ```
 *
 * - The handle goes in the FRAGMENT only, never the query
 *   (CALLER-AUTHENTICATION §4.1): a fragment is not sent to the web server
 *   when e2e2z is not installed and the link falls through to the browser.
 * - The link carries no authority. It is not an intent-bridge message, and
 *   e2e2z never sends anything on its own when it opens.
 * - With e2e2z installed the verified App Link opens it. Without it, the same
 *   URL is the "Install e2e2z" landing page, so one link is both actions.
 *
 * This is the free2z surface's only reach into another app, and it goes
 * through `@tauri-apps/plugin-opener` (already granted as `opener:default`).
 * No `invoke_handler`, no privileged plugin.
 */

import { openUrl } from "@tauri-apps/plugin-opener";
import { isMessagingHandle } from "@/lib/api/chat-request";
import { isTauri } from "@/lib/platform";

export const E2E2Z_CHAT_ORIGIN = "https://free2z.com";
export const E2E2Z_CHAT_PATH = "/bridge/e2e2z/chat/";

/**
 * The install landing page, with no peer. Contract B serves it at the chat
 * path. It is also inside the App Link prefix, so on a device that already has
 * e2e2z this opens e2e2z with no fragment, which Contract B requires e2e2z to
 * refuse harmlessly.
 */
export const E2E2Z_INSTALL_URL = `${E2E2Z_CHAT_ORIGIN}${E2E2Z_CHAT_PATH}`;

/**
 * Build the first-contact link, or `null` when the handle is not one Contract B
 * allows. Nothing unvalidated is ever interpolated into the URL.
 */
export function e2e2zChatLink(handle: unknown): string | null {
  if (!isMessagingHandle(handle)) return null;
  return `${E2E2Z_CHAT_ORIGIN}${E2E2Z_CHAT_PATH}#peer=${handle}`;
}

/**
 * Hand a Contract B URL to the operating system. Only the two URLs this module
 * builds are accepted, so a caller cannot turn this into a general opener.
 * Returns whether the hand-off was made.
 */
export async function openE2e2z(url: string): Promise<boolean> {
  const allowed =
    url === E2E2Z_INSTALL_URL ||
    (url.startsWith(`${E2E2Z_INSTALL_URL}#peer=`) &&
      e2e2zChatLink(url.slice(`${E2E2Z_INSTALL_URL}#peer=`.length)) === url);
  if (!allowed) return false;
  if (isTauri()) {
    try {
      await openUrl(url);
      return true;
    } catch {
      return false;
    }
  }
  // A plain browser (dev, mock screenshots): never navigate this SPA away.
  // `noopener` makes `window.open` return null even on success, so only an
  // exception is a failure here.
  try {
    window.open(url, "_blank", "noopener,noreferrer");
    return true;
  } catch {
    return false;
  }
}
