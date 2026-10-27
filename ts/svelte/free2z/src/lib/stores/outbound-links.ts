import { browser } from "$app/env";
import { get, writable } from "svelte/store";
import {
  normalizeOutboundHostname,
  OUTBOUND_GLOBAL_WARNING_KEY,
  OUTBOUND_TRUSTED_DOMAINS_KEY,
} from "$lib/utils/outbound-link";

export interface OutboundLinkState {
  trustedDomains: string[];
  globalWarningDisabled: boolean;
}

type OutboundLinkStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type OutboundLinkEventTarget = Pick<
  Window,
  "addEventListener" | "removeEventListener"
>;

function getOutboundStorage(
  isBrowser = browser,
  storageGetter: () => OutboundLinkStorage = () => localStorage,
): OutboundLinkStorage | null {
  if (!isBrowser) return null;

  try {
    return storageGetter();
  } catch {
    return null;
  }
}

function getOutboundEventTarget(
  isBrowser = browser,
  targetGetter: () => OutboundLinkEventTarget = () => window,
): OutboundLinkEventTarget | null {
  if (!isBrowser) return null;

  try {
    return targetGetter();
  } catch {
    return null;
  }
}

function readTrustedDomains(storage: OutboundLinkStorage | null): string[] {
  if (!storage) return [];

  try {
    const value = storage.getItem(OUTBOUND_TRUSTED_DOMAINS_KEY);
    if (value === null) return [];

    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      throw new Error("Trusted outbound domains must be an array");
    }

    const normalized: string[] = [];
    for (const domain of parsed) {
      const hostname = normalizeOutboundHostname(domain);
      // One malformed entry invalidates the whole grant set. Discarding only
      // the bad entry could turn corrupt data into a partially authorized
      // policy that the user never explicitly reviewed.
      if (!hostname) {
        throw new Error("Invalid trusted outbound domain");
      }
      if (!normalized.includes(hostname)) normalized.push(hostname);
    }
    return normalized;
  } catch {
    // Corrupt or unreadable storage must never authorize an outbound link.
    return [];
  }
}

function readGlobalWarningPreference(
  storage: OutboundLinkStorage | null,
): boolean {
  if (!storage) return false;

  try {
    return storage.getItem(OUTBOUND_GLOBAL_WARNING_KEY) === "true";
  } catch {
    return false;
  }
}

function loadState(storage: OutboundLinkStorage | null): OutboundLinkState {
  return {
    trustedDomains: readTrustedDomains(storage),
    globalWarningDisabled: readGlobalWarningPreference(storage),
  };
}

function writeStorage(
  storage: OutboundLinkStorage | null,
  key: string,
  value: string,
) {
  try {
    storage?.setItem(key, value);
    return Boolean(storage);
  } catch {
    return false;
  }
}

function removeStorage(storage: OutboundLinkStorage | null, key: string) {
  try {
    storage?.removeItem(key);
    return Boolean(storage);
  } catch {
    return false;
  }
}

/**
 * Store for Markdown outbound-link warnings.
 *
 * This is intentionally a different policy boundary from `privacyStore`:
 * trusting a navigation destination must never grant permission to load an
 * iframe, image, audio file, or any other external embed.
 */
export function createOutboundLinkStore(
  initialState?: OutboundLinkState,
  storage?: OutboundLinkStorage | null,
  eventTarget?: OutboundLinkEventTarget | null,
) {
  const resolvedStorage =
    storage === undefined ? getOutboundStorage() : storage;
  const resolvedEventTarget =
    eventTarget === undefined ? getOutboundEventTarget() : eventTarget;
  const { subscribe, set, update } = writable<OutboundLinkState>(
    initialState ?? loadState(resolvedStorage),
  );
  let storageSyncSubscribers = 0;
  let storageSyncListening = false;

  const reload = () => set(loadState(resolvedStorage));

  const handleStorage = (event: StorageEvent) => {
    if (
      resolvedStorage &&
      event.storageArea &&
      event.storageArea !== resolvedStorage
    ) {
      return;
    }

    if (
      event.key === null ||
      event.key === OUTBOUND_TRUSTED_DOMAINS_KEY ||
      event.key === OUTBOUND_GLOBAL_WARNING_KEY
    ) {
      reload();
    }
  };

  const stopStorageSync = () => {
    if (!storageSyncListening || !resolvedEventTarget) return;

    try {
      resolvedEventTarget.removeEventListener("storage", handleStorage);
    } finally {
      storageSyncListening = false;
    }
  };

  return {
    subscribe,

    startStorageSync: (): (() => void) => {
      storageSyncSubscribers += 1;
      if (
        storageSyncSubscribers === 1 &&
        resolvedEventTarget &&
        resolvedStorage
      ) {
        try {
          resolvedEventTarget.addEventListener("storage", handleStorage);
          storageSyncListening = true;
          reload();
        } catch {
          storageSyncListening = false;
        }
      }

      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        storageSyncSubscribers = Math.max(0, storageSyncSubscribers - 1);
        if (storageSyncSubscribers === 0) stopStorageSync();
      };
    },

    isDomainTrusted: (domain: string): boolean => {
      const hostname = normalizeOutboundHostname(domain);
      if (!hostname) return false;
      return get({ subscribe }).trustedDomains.includes(hostname);
    },

    isGlobalWarningDisabled: (): boolean =>
      get({ subscribe }).globalWarningDisabled,

    shouldWarn: (domain: string): boolean => {
      const hostname = normalizeOutboundHostname(domain);
      if (!hostname) return true;
      const state = get({ subscribe });
      return !(
        state.globalWarningDisabled || state.trustedDomains.includes(hostname)
      );
    },

    trustDomain: (domain: string) => {
      const hostname = normalizeOutboundHostname(domain);
      if (!hostname) return;

      update((state) => {
        if (state.trustedDomains.includes(hostname)) return state;

        const trustedDomains = [...state.trustedDomains, hostname];
        writeStorage(
          resolvedStorage,
          OUTBOUND_TRUSTED_DOMAINS_KEY,
          JSON.stringify(trustedDomains),
        );
        return { ...state, trustedDomains };
      });
    },

    revokeDomain: (domain: string) => {
      const hostname = normalizeOutboundHostname(domain);
      if (!hostname) return;

      update((state) => {
        const trustedDomains = state.trustedDomains.filter(
          (trustedDomain) => trustedDomain !== hostname,
        );
        writeStorage(
          resolvedStorage,
          OUTBOUND_TRUSTED_DOMAINS_KEY,
          JSON.stringify(trustedDomains),
        );
        return trustedDomains.length === state.trustedDomains.length
          ? state
          : { ...state, trustedDomains };
      });
    },

    setGlobalWarningDisabled: (disabled: boolean) => {
      const nextValue = Boolean(disabled);
      if (nextValue) {
        writeStorage(resolvedStorage, OUTBOUND_GLOBAL_WARNING_KEY, "true");
      } else {
        removeStorage(resolvedStorage, OUTBOUND_GLOBAL_WARNING_KEY);
      }
      update((state) =>
        state.globalWarningDisabled === nextValue
          ? state
          : { ...state, globalWarningDisabled: nextValue },
      );
    },

    disableWarnings: () => {
      // Keep a named method for the dialog action and for settings callers.
      const store = get({ subscribe });
      if (!store.globalWarningDisabled) {
        writeStorage(resolvedStorage, OUTBOUND_GLOBAL_WARNING_KEY, "true");
      }
      update((state) => ({ ...state, globalWarningDisabled: true }));
    },

    enableWarnings: () => {
      removeStorage(resolvedStorage, OUTBOUND_GLOBAL_WARNING_KEY);
      update((state) => ({ ...state, globalWarningDisabled: false }));
    },

    clearAll: () => {
      removeStorage(resolvedStorage, OUTBOUND_TRUSTED_DOMAINS_KEY);
      removeStorage(resolvedStorage, OUTBOUND_GLOBAL_WARNING_KEY);
      set({ trustedDomains: [], globalWarningDisabled: false });
    },

    getTrustedDomains: (): string[] => get({ subscribe }).trustedDomains,
    hasGlobalWarningDisabled: (): boolean =>
      get({ subscribe }).globalWarningDisabled,
  };
}

export const outboundLinkStore = createOutboundLinkStore();
