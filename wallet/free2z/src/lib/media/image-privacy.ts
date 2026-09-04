import { useSyncExternalStore } from "react";

export const STRICT_IMAGE_PRIVACY_KEY = "zuuli.strict-image-privacy";

function readStoredPreference(): boolean {
  try {
    return globalThis.localStorage?.getItem(STRICT_IMAGE_PRIVACY_KEY) === "1";
  } catch {
    return false;
  }
}

let strictImagePrivacy = readStoredPreference();
const listeners = new Set<() => void>();

export function getStrictImagePrivacy(): boolean {
  return strictImagePrivacy;
}

export function setStrictImagePrivacy(enabled: boolean): void {
  if (strictImagePrivacy === enabled) return;
  strictImagePrivacy = enabled;
  try {
    if (enabled) globalThis.localStorage?.setItem(STRICT_IMAGE_PRIVACY_KEY, "1");
    else globalThis.localStorage?.removeItem(STRICT_IMAGE_PRIVACY_KEY);
  } catch {
    // The in-memory preference still applies in storage-restricted contexts.
  }
  for (const listener of [...listeners]) listener();
}

export function useStrictImagePrivacy(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getStrictImagePrivacy,
    getStrictImagePrivacy,
  );
}
