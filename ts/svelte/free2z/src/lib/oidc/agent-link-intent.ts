const STORAGE_KEY = "free2z:agent-link-intent:v1";
const MAX_AGE_MS = 15 * 60 * 1000;
const VALID_INTENT = /^[A-Za-z0-9_-]{20,256}$/;

/** The fragment never goes to HTTP servers; only this tab retains the return state. */
export function takeAgentLinkIntent(
  url: URL,
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  cleanUrl: () => void,
  now = Date.now(),
): string | null {
  const fragment = new URLSearchParams(url.hash.slice(1));
  const incoming = fragment.get("intent");
  // Drop the fragment before any API call or navigation. Never copy it into `next`.
  if (url.hash || url.search) cleanUrl();
  try {
    if (incoming !== null) {
      storage.removeItem(STORAGE_KEY);
      if (!VALID_INTENT.test(incoming)) return null;
      storage.setItem(
        STORAGE_KEY,
        JSON.stringify({ intent: incoming, received: now }),
      );
      return incoming;
    }
    const value = JSON.parse(storage.getItem(STORAGE_KEY) || "null");
    if (
      value &&
      typeof value.intent === "string" &&
      VALID_INTENT.test(value.intent) &&
      typeof value.received === "number" &&
      now >= value.received &&
      now - value.received < MAX_AGE_MS
    )
      return value.intent;
    storage.removeItem(STORAGE_KEY);
  } catch {
    // A tab with unavailable storage cannot carry a secret safely through sign-in.
  }
  return null;
}

export function clearAgentLinkIntent(storage: Pick<Storage, "removeItem">) {
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    /* Nothing can be retained. */
  }
}
