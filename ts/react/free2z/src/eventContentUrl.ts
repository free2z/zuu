/**
 * Where an event's `content_url` should be opened.
 *
 * Most events point at a page on this site (`/alice/zpage/...`), which the
 * router handles. An ENCRYPTED_CHAT_REQUEST points at an absolute e2e2z App
 * Link (`https://free2z.com/bridge/e2e2z/chat/#peer=<handle>`), which must be a
 * real browser navigation: handed to the router it would become the in-app
 * path `/https://free2z.com/...` and 404, and a phone would never get the
 * chance to open e2e2z.
 */
export function isExternalContentUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

export function openEventContentUrl(
  url: string | null | undefined,
  navigate: (to: string) => void,
  assign: (to: string) => void = (to) => window.location.assign(to),
): void {
  if (!url) return;
  if (isExternalContentUrl(url)) {
    assign(url);
    return;
  }
  navigate(url);
}
