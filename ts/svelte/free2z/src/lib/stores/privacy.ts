/**
 * Privacy store for managing external embed consent
 * Persists user preferences in localStorage
 */

import { writable, get } from "svelte/store";
import { browser } from "$app/env";
import { isExternalEmbedDomain } from "$lib/utils/embed-domains";
import { classifyFirstPartyEmbed } from "$lib/utils/first-party-embed";

const TRUSTED_DOMAINS_KEY = "trustedEmbedDomains";
const TRUSTED_DOMAINS_SNAPSHOT_KEY = "trustedEmbedDomainsSnapshot";
const GLOBAL_CONSENT_KEY = "globalEmbedConsent";
const CLEARED_DOMAINS_KEY = "clearedEmbedDomains";
const TRUSTED_DOMAIN_KEY_PREFIX = "trustedEmbedDomain:";
const REVOKED_DOMAIN_KEY_PREFIX = "revokedEmbedDomain:";
const PRIVACY_SYNC_CHANNEL_NAME = "external-embed-consent";

export interface PrivacyState {
  trustedDomains: string[];
  transientDomains: string[];
  transientConsentScope: string | null;
  globalConsent: boolean;
}

type PrivacyStorage = Pick<Storage, "getItem" | "setItem" | "removeItem"> &
  Partial<Pick<Storage, "key" | "length">>;
type PrivacyStorageEventTarget = Pick<
  Window,
  "addEventListener" | "removeEventListener"
>;

type PrivacySyncMessage =
  | { type: "clear-all" }
  | { type: "disable-global" }
  | { type: "revoke-domain"; domain: string };

type PrivacySyncChannel = {
  postMessage: (message: PrivacySyncMessage) => void;
  addEventListener: (
    type: "message",
    listener: (event: MessageEvent<PrivacySyncMessage>) => void,
  ) => void;
  removeEventListener: (
    type: "message",
    listener: (event: MessageEvent<PrivacySyncMessage>) => void,
  ) => void;
  close: () => void;
};

interface PersistentPrivacyState {
  trustedDomains: string[];
  globalConsent: boolean;
}

function revokedDomainKey(domain: string): string {
  return `${REVOKED_DOMAIN_KEY_PREFIX}${domain}`;
}

function trustedDomainKey(domain: string): string {
  return `${TRUSTED_DOMAIN_KEY_PREFIX}${domain}`;
}

function parseStoredDomains(value: string | null): string[] {
  if (value === null) return [];

  const parsed = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    !parsed.every((domain) => typeof domain === "string")
  ) {
    throw new Error("Invalid stored embed domains");
  }

  return parsed;
}

function loadStoredDomains(storage: PrivacyStorage, key: string): string[] {
  return parseStoredDomains(storage.getItem(key));
}

function loadIndividuallyTrustedDomains(storage: PrivacyStorage): string[] {
  if (typeof storage.length !== "number" || typeof storage.key !== "function") {
    return [];
  }

  const domains: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (
      key?.startsWith(TRUSTED_DOMAIN_KEY_PREFIX) &&
      storage.getItem(key) === "true"
    ) {
      domains.push(key.slice(TRUSTED_DOMAIN_KEY_PREFIX.length));
    }
  }
  return domains;
}

function persistTrustedDomainsSnapshot(
  storage: PrivacyStorage | null,
  domains: string[],
): boolean {
  const value = JSON.stringify(domains);
  if (!setStorageItem(storage, TRUSTED_DOMAINS_KEY, value)) return false;

  if (setStorageItem(storage, TRUSTED_DOMAINS_SNAPSHOT_KEY, value)) return true;

  // A stale snapshot could make a later legacy aggregate mutation look like a
  // current-version write. Removing it makes the aggregate authoritative.
  removeStorageItem(storage, TRUSTED_DOMAINS_SNAPSHOT_KEY);
  return true;
}

/**
 * Current versions write an exact snapshot beside the legacy aggregate. If an
 * older already-open tab later changes only the aggregate, the mismatch makes
 * that legacy mutation authoritative. This deliberately fails closed if two
 * writers are interrupted between their aggregate and snapshot writes.
 */
function loadManagedTrustedDomains(
  storage: PrivacyStorage,
  /** Collects domains this call converted from a legacy removal to a tombstone. */
  revokedDomains: string[] = [],
): string[] {
  const aggregateValue = storage.getItem(TRUSTED_DOMAINS_KEY);
  const aggregateDomains = parseStoredDomains(aggregateValue);
  const snapshotValue = storage.getItem(TRUSTED_DOMAINS_SNAPSHOT_KEY);
  const individualDomains = loadIndividuallyTrustedDomains(storage);

  if (snapshotValue === null) {
    if (aggregateValue === null) return individualDomains;

    // Adopt a legacy aggregate. Individual records can only be trusted when
    // the aggregate was written by a current version with a matching snapshot.
    setStorageItem(
      storage,
      TRUSTED_DOMAINS_SNAPSHOT_KEY,
      JSON.stringify(aggregateDomains),
    );
    return aggregateDomains;
  }

  if (snapshotValue === aggregateValue) {
    return [...new Set([...aggregateDomains, ...individualDomains])];
  }

  let previousManagedDomains: string[] = [];
  let snapshotValid = true;
  try {
    previousManagedDomains = parseStoredDomains(snapshotValue);
  } catch {
    // A malformed snapshot is not evidence that an individual grant is valid.
    snapshotValid = false;
  }

  const aggregateSet = new Set(aggregateDomains);
  const domainsPreviouslyManaged =
    aggregateValue === null || !snapshotValid
      ? [...new Set([...previousManagedDomains, ...individualDomains])]
      : previousManagedDomains;
  for (const domain of domainsPreviouslyManaged) {
    if (aggregateSet.has(domain)) continue;

    // An older tab removed this domain from the aggregate. Convert that legacy
    // revocation into the durable format before adopting the new snapshot.
    removeStorageItem(storage, trustedDomainKey(domain));
    setStorageItem(storage, revokedDomainKey(domain), "true");
    revokedDomains.push(domain);
  }

  setStorageItem(
    storage,
    TRUSTED_DOMAINS_SNAPSHOT_KEY,
    JSON.stringify(aggregateDomains),
  );
  return aggregateDomains;
}

/**
 * Transient grants die with their scope, so an emptied list must also drop the
 * scope. Leaving a scope behind with no domains would let a later grant for a
 * *different* page attach itself to the stale scope key.
 */
function withTransientDomains(
  state: PrivacyState,
  transientDomains: string[],
): PrivacyState {
  if (transientDomains.length === state.transientDomains.length) return state;

  return {
    ...state,
    transientDomains,
    transientConsentScope:
      transientDomains.length === 0 ? null : state.transientConsentScope,
  };
}

/** End every current-page grant without touching persistent preferences. */
function withoutTransientConsent(state: PrivacyState): PrivacyState {
  if (
    state.transientDomains.length === 0 &&
    state.transientConsentScope === null
  ) {
    return state;
  }

  return {
    ...state,
    transientDomains: [],
    transientConsentScope: null,
  };
}

function hasSameDomains(first: string[], second: string[]): boolean {
  return (
    first.length === second.length &&
    first.every((domain, index) => domain === second[index])
  );
}

/**
 * null means storage was unreadable, so an explicit in-memory grant should be
 * preserved. Malformed denial data returns true and fails closed.
 */
function isDomainPersistentlyRevoked(
  storage: PrivacyStorage,
  domain: string,
): boolean | null {
  let clearedValue: string | null;
  try {
    clearedValue = storage.getItem(CLEARED_DOMAINS_KEY);
  } catch {
    return null;
  }

  let clearedDomains: string[];
  try {
    clearedDomains = parseStoredDomains(clearedValue);
  } catch {
    return true;
  }
  if (clearedDomains.includes(domain)) return true;

  try {
    return storage.getItem(revokedDomainKey(domain)) !== null;
  } catch {
    return null;
  }
}

/**
 * Browsers can expose window while denying access to the localStorage getter.
 */
export function getPrivacyStorage(
  isBrowser = browser,
  storageGetter: () => PrivacyStorage = () => localStorage,
): PrivacyStorage | null {
  if (!isBrowser) return null;

  try {
    return storageGetter();
  } catch {
    return null;
  }
}

/**
 * Access to window can also be unavailable in non-browser and restricted
 * environments. Keep event registration behind the same defensive boundary.
 */
export function getPrivacyStorageEventTarget(
  isBrowser = browser,
  eventTargetGetter: () => PrivacyStorageEventTarget = () => window,
): PrivacyStorageEventTarget | null {
  if (!isBrowser) return null;

  try {
    return eventTargetGetter();
  } catch {
    return null;
  }
}

export function getPrivacySyncChannel(
  isBrowser = browser,
  channelGetter: () => PrivacySyncChannel = () =>
    new BroadcastChannel(PRIVACY_SYNC_CHANNEL_NAME),
): PrivacySyncChannel | null {
  if (!isBrowser) return null;

  try {
    return channelGetter();
  } catch {
    return null;
  }
}

/**
 * Extract domain from URL
 */
export function extractDomain(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname;
  } catch {
    return "";
  }
}

/**
 * Check if a URL is an external embed (YouTube, Twitter, etc.)
 * Uses the centralized domain list from embed-domains.ts
 *
 * Our OWN content is not external: a reader must not be warned about
 * the site they are already on. "Our own" is decided by the exact, parse-based
 * classifier in `first-party-embed.ts` and nothing looser — a URL it refuses
 * (lookalike host, userinfo, non-canonical spelling, `http:`) stays external
 * and keeps the consent gate.
 */
export function isExternalEmbed(url: string): boolean {
  if (classifyFirstPartyEmbed(url)) return false;
  if (isExternalEmbedDomain(url)) return true;

  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function loadPersistentPrivacyState(
  storage: PrivacyStorage | null,
  /** Collects legacy removals this load converted into durable tombstones. */
  revokedDomains: string[] = [],
): PersistentPrivacyState {
  if (!storage) {
    return {
      trustedDomains: [],
      globalConsent: false,
    };
  }

  let trustedDomains: string[] = [];
  let globalConsent = false;

  try {
    const storedTrustedDomains = loadManagedTrustedDomains(
      storage,
      revokedDomains,
    );
    const clearedDomains = new Set(
      loadStoredDomains(storage, CLEARED_DOMAINS_KEY),
    );
    trustedDomains = storedTrustedDomains.filter(
      (domain) =>
        !clearedDomains.has(domain) &&
        storage.getItem(revokedDomainKey(domain)) === null,
    );
  } catch {
    // An unreadable or corrupt grant/denial must not authorize embeds.
  }

  try {
    globalConsent = storage.getItem(GLOBAL_CONSENT_KEY) === "true";
  } catch {
    // An unreadable global grant must not authorize embeds.
  }

  return {
    trustedDomains,
    globalConsent,
  };
}

/**
 * Load privacy state from localStorage.
 */
function loadPrivacyState(storage: PrivacyStorage | null): PrivacyState {
  return {
    ...loadPersistentPrivacyState(storage),
    transientDomains: [],
    transientConsentScope: null,
  };
}

function setStorageItem(
  storage: PrivacyStorage | null,
  key: string,
  value: string,
): boolean {
  if (!storage) return false;

  try {
    storage.setItem(key, value);
    return true;
  } catch {
    // The caller keeps in-memory state and may retry after freeing capacity.
    return false;
  }
}

function removeStorageItem(
  storage: PrivacyStorage | null,
  key: string,
): boolean {
  if (!storage) return false;

  try {
    storage.removeItem(key);
    return true;
  } catch {
    // Clearing the in-memory store remains useful when storage is unavailable.
    return false;
  }
}

function clearStoredGlobalConsent(storage: PrivacyStorage | null): boolean {
  if (removeStorageItem(storage, GLOBAL_CONSENT_KEY)) return true;

  // Some restricted implementations may reject removal independently. The
  // loader treats every value except exact "true" as denied.
  return setStorageItem(storage, GLOBAL_CONSENT_KEY, "false");
}

function clearStoredDomainRevocation(
  storage: PrivacyStorage | null,
  domain: string,
): boolean {
  if (!storage) return false;

  const individualCleared = removeStorageItem(
    storage,
    revokedDomainKey(domain),
  );

  try {
    const clearedDomains = loadStoredDomains(storage, CLEARED_DOMAINS_KEY);
    const remainingClearedDomains = clearedDomains.filter(
      (clearedDomain) => clearedDomain !== domain,
    );

    if (remainingClearedDomains.length === clearedDomains.length) {
      return individualCleared;
    }

    return remainingClearedDomains.length === 0
      ? removeStorageItem(storage, CLEARED_DOMAINS_KEY)
      : setStorageItem(
          storage,
          CLEARED_DOMAINS_KEY,
          JSON.stringify(remainingClearedDomains),
        );
  } catch {
    // A malformed denial stays fail-closed until storage can be repaired.
    return false;
  }
}

/**
 * The lifetime of a transient ("Load once") grant, in one sentence: it covers
 * one domain, on one logical page, in one tab, until the page is left or any
 * revocation happens anywhere.
 *
 * This is the scope half of that rule. A logical page is the path *and* the
 * query string, because the query selects which content — and therefore which
 * embeds — the page renders: consenting on `/alice?page=1` says nothing about
 * the third-party URLs on `/alice?page=2`.
 *
 * The hash is deliberately excluded, and that is a policy call rather than a
 * presentational detail: `#comment-<id>` expands threaded replies, which can
 * mount embeds that were not on screen when the user consented. Those replies
 * belong to the page that was consented on — the same expansion happens by
 * clicking "show replies", with no URL change at all — and the grant is still
 * per-domain, so a provider that receives a hash-expanded embed already
 * received this visitor's IP and referer from the embed that was consented to.
 * Scoping by hash would instead unload a running video on every anchor click.
 * The origin is excluded because SvelteKit routing never leaves it.
 *
 * Query parameters are compared as written, so a reordered query string counts
 * as a different page and re-prompts. That errs toward asking again, which is
 * the safe direction for a boundary that leaks the visitor's IP and referer.
 */
export function embedConsentScope(url: {
  pathname: string;
  search: string;
}): string {
  return `${url.pathname}${url.search}`;
}

/**
 * Check whether a URL is covered by persistent or current-page consent.
 */
export function canLoadUrlFromState(
  state: PrivacyState,
  url: string,
  consentScope?: string,
): boolean {
  const domain = extractDomain(url);
  if (!domain) return false;

  return (
    state.globalConsent ||
    state.trustedDomains.includes(domain) ||
    (consentScope !== undefined &&
      state.transientConsentScope === consentScope &&
      state.transientDomains.includes(domain))
  );
}

/**
 * Create the privacy store
 */
export function createPrivacyStore(
  initialState?: PrivacyState,
  storage?: PrivacyStorage | null,
  storageEventTarget?: PrivacyStorageEventTarget | null,
  syncChannelFactory?: (() => PrivacySyncChannel | null) | null,
) {
  const resolvedStorage = storage === undefined ? getPrivacyStorage() : storage;
  const resolvedStorageEventTarget =
    storageEventTarget === undefined
      ? getPrivacyStorageEventTarget()
      : storageEventTarget;
  const resolvedSyncChannelFactory =
    syncChannelFactory === undefined
      ? () => getPrivacySyncChannel()
      : syncChannelFactory;
  const { subscribe, set, update } = writable<PrivacyState>(
    initialState ?? loadPrivacyState(resolvedStorage),
  );
  const volatileTrustedDomains = new Set(initialState?.trustedDomains ?? []);
  let volatileGlobalConsent = Boolean(initialState?.globalConsent);
  let storageSyncSubscribers = 0;
  let storageSyncListening = false;
  let syncChannel: PrivacySyncChannel | null = null;

  const getActiveTrustedDomains = (
    persistentDomains = loadPersistentPrivacyState(resolvedStorage)
      .trustedDomains,
  ): string[] => {
    const activeDomains = [...persistentDomains];

    for (const domain of volatileTrustedDomains) {
      const revoked = resolvedStorage
        ? isDomainPersistentlyRevoked(resolvedStorage, domain)
        : null;
      if (revoked) {
        volatileTrustedDomains.delete(domain);
      } else if (!activeDomains.includes(domain)) {
        activeDomains.push(domain);
      }
    }

    return activeDomains;
  };

  /**
   * Drop a one-time grant because a revocation for that domain just arrived.
   *
   * Callers must pass only revocations they have just observed. A tombstone is
   * permanent, so re-reading storage cannot distinguish a denial that landed a
   * moment ago from one the user deliberately overrode later by clicking
   * "Load once" again; revoking on the mere presence of a tombstone would
   * unload that embed on the next unrelated cross-tab write.
   */
  const revokeTransientDomain = (domain: string) => {
    update((state) =>
      withTransientDomains(
        state,
        state.transientDomains.filter(
          (transientDomain) => transientDomain !== domain,
        ),
      ),
    );
  };

  const reconcilePersistentState = () => {
    // A pre-upgrade tab revokes by removing the domain from the legacy
    // aggregate, and this load is where that removal becomes a tombstone. The
    // write happens in this tab, so no storage event announces it — the loader
    // has to hand the domains back for the transient grants to be dropped.
    const revokedDomains: string[] = [];
    const persistentState = loadPersistentPrivacyState(
      resolvedStorage,
      revokedDomains,
    );
    persistentState.trustedDomains = getActiveTrustedDomains(
      persistentState.trustedDomains,
    );
    persistentState.globalConsent =
      persistentState.globalConsent || volatileGlobalConsent;
    for (const domain of revokedDomains) revokeTransientDomain(domain);
    update((state) => {
      const trustedDomainsUnchanged = hasSameDomains(
        state.trustedDomains,
        persistentState.trustedDomains,
      );

      if (
        trustedDomainsUnchanged &&
        state.globalConsent === persistentState.globalConsent
      ) {
        return state;
      }

      return {
        ...state,
        ...persistentState,
      };
    });
  };

  const handleStorage = (event: StorageEvent) => {
    if (
      event.storageArea !== resolvedStorage ||
      (event.key !== null &&
        event.key !== TRUSTED_DOMAINS_KEY &&
        event.key !== TRUSTED_DOMAINS_SNAPSHOT_KEY &&
        event.key !== GLOBAL_CONSENT_KEY &&
        event.key !== CLEARED_DOMAINS_KEY &&
        !event.key.startsWith(TRUSTED_DOMAIN_KEY_PREFIX) &&
        !event.key.startsWith(REVOKED_DOMAIN_KEY_PREFIX))
    ) {
      return;
    }

    if (event.key === null || event.key === CLEARED_DOMAINS_KEY) {
      // Clear markers can cover grants this tab never persisted. Clearing on
      // every marker change may prompt again after a re-trust, but it cannot
      // preserve stale authorization.
      volatileTrustedDomains.clear();
      if (event.key === null) volatileGlobalConsent = false;
      // "Clear all" in another tab must also unload embeds this tab is showing
      // under a one-time grant, which no persistent marker can describe.
      update(withoutTransientConsent);
    } else if (event.key === GLOBAL_CONSENT_KEY) {
      // A real cross-tab global mutation overrides this tab's memory-only grant.
      volatileGlobalConsent = false;
    } else if (event.key.startsWith(REVOKED_DOMAIN_KEY_PREFIX)) {
      // Another tab revoked this domain. Read back rather than trusting the
      // event: the same key also fires when a re-trust removes the tombstone,
      // which must not unload anything.
      const domain = event.key.slice(REVOKED_DOMAIN_KEY_PREFIX.length);
      if (
        resolvedStorage &&
        isDomainPersistentlyRevoked(resolvedStorage, domain)
      ) {
        revokeTransientDomain(domain);
      }
    }

    reconcilePersistentState();
  };

  const handleSyncMessage = (event: MessageEvent<PrivacySyncMessage>) => {
    const message = event.data;
    if (!message || typeof message !== "object" || !("type" in message)) return;

    if (message.type === "disable-global") {
      volatileGlobalConsent = false;
      update((state) =>
        state.globalConsent ? { ...state, globalConsent: false } : state,
      );
      return;
    }

    if (message.type === "revoke-domain") {
      volatileTrustedDomains.delete(message.domain);
      update((state) => {
        // Mirror the local revokeDomain, which drops the domain's one-time
        // grant too. A revocation the user made in another tab means the same
        // thing as one made here.
        const withLiveTransientDomains = withTransientDomains(
          state,
          state.transientDomains.filter((domain) => domain !== message.domain),
        );
        const trustedDomains = withLiveTransientDomains.trustedDomains.filter(
          (domain) => domain !== message.domain,
        );
        return trustedDomains.length ===
          withLiveTransientDomains.trustedDomains.length
          ? withLiveTransientDomains
          : { ...withLiveTransientDomains, trustedDomains };
      });
      return;
    }

    if (message.type === "clear-all") {
      volatileTrustedDomains.clear();
      volatileGlobalConsent = false;
      update((state) => {
        // "Clear all" is the user asking for no third-party embeds anywhere.
        // A live one-time grant in this tab is exactly what they mean.
        const cleared = withoutTransientConsent(state);
        if (cleared.trustedDomains.length === 0 && !cleared.globalConsent) {
          return cleared;
        }
        return {
          ...cleared,
          trustedDomains: [],
          globalConsent: false,
        };
      });
    }
  };

  const broadcastSyncMessage = (message: PrivacySyncMessage) => {
    try {
      syncChannel?.postMessage(message);
    } catch {
      // localStorage remains the primary synchronization transport.
    }
  };

  const stopStorageSync = () => {
    if (storageSyncListening && resolvedStorageEventTarget) {
      try {
        resolvedStorageEventTarget.removeEventListener(
          "storage",
          handleStorage,
        );
        storageSyncListening = false;
      } catch {
        // Assume a listener that could not be removed is still registered.
      }
    }

    if (syncChannel) {
      try {
        syncChannel.removeEventListener("message", handleSyncMessage);
        syncChannel.close();
      } catch {
        // Cleanup failures must not interrupt route teardown.
      } finally {
        syncChannel = null;
      }
    }
  };

  return {
    subscribe,

    /**
     * Reconcile persistent consent written by other tabs. Callers receive an
     * idempotent cleanup function; overlapping callers share one listener.
     */
    startStorageSync: (): (() => void) => {
      storageSyncSubscribers += 1;

      if (
        !storageSyncListening &&
        resolvedStorage &&
        resolvedStorageEventTarget
      ) {
        try {
          resolvedStorageEventTarget.addEventListener("storage", handleStorage);
          storageSyncListening = true;
        } catch {
          // BroadcastChannel may still be available.
        }
      }

      if (!syncChannel && resolvedSyncChannelFactory) {
        try {
          syncChannel = resolvedSyncChannelFactory();
          syncChannel?.addEventListener("message", handleSyncMessage);
        } catch {
          syncChannel = null;
        }
      }

      if (!storageSyncListening && !syncChannel) {
        storageSyncSubscribers -= 1;
        return () => {};
      }

      if (storageSyncSubscribers === 1 && resolvedStorage) {
        try {
          // Register transports first so a cross-tab write cannot land between
          // this read and listener setup. This also catches pre-mount changes.
          reconcilePersistentState();
        } catch (error) {
          storageSyncSubscribers -= 1;
          stopStorageSync();
          throw error;
        }
      }

      let stopped = false;
      return () => {
        if (stopped) return;

        stopped = true;
        storageSyncSubscribers -= 1;
        if (storageSyncSubscribers === 0) stopStorageSync();
      };
    },

    /**
     * Check if a domain is trusted
     */
    isDomainTrusted: (domain: string, consentScope?: string): boolean => {
      const state = get({ subscribe });
      return (
        state.globalConsent ||
        state.trustedDomains.includes(domain) ||
        (consentScope !== undefined &&
          state.transientConsentScope === consentScope &&
          state.transientDomains.includes(domain))
      );
    },

    /**
     * Check if a URL should be loaded (global consent or domain trusted)
     */
    canLoadUrl: (url: string, consentScope?: string): boolean => {
      const state = get({ subscribe });
      return canLoadUrlFromState(state, url, consentScope);
    },

    /**
     * Allow a domain within one route scope. This deliberately does not write
     * to localStorage, and another route cannot reuse the transient consent.
     */
    allowDomainOnce: (domain: string, consentScope: string) => {
      update((state) => {
        if (state.trustedDomains.includes(domain)) return state;

        if (state.transientConsentScope !== consentScope) {
          return {
            ...state,
            transientDomains: [domain],
            transientConsentScope: consentScope,
          };
        }

        if (state.transientDomains.includes(domain)) {
          return state;
        }

        return {
          ...state,
          transientDomains: [...state.transientDomains, domain],
        };
      });
    },

    /**
     * End all current-page grants without changing persistent preferences.
     */
    clearTransientConsent: () => {
      update(withoutTransientConsent);
    },

    /**
     * Drop a stale grant only when revisiting the scope that created it.
     */
    clearTransientConsentForScope: (consentScope: string) => {
      update((state) =>
        state.transientConsentScope === consentScope
          ? withoutTransientConsent(state)
          : state,
      );
    },

    /**
     * Trust a specific domain
     */
    trustDomain: (domain: string) => {
      update((state) => {
        // Persistent state is authoritative here: composing from an in-memory
        // snapshot can restore grants cleared in another tab. Explicit grants
        // that failed to persist remain in a separately tracked volatile set.
        const activeTrustedDomains = getActiveTrustedDomains();

        if (activeTrustedDomains.includes(domain)) {
          return hasSameDomains(activeTrustedDomains, state.trustedDomains)
            ? state
            : { ...state, trustedDomains: activeTrustedDomains };
        }

        const revocationCleared = clearStoredDomainRevocation(
          resolvedStorage,
          domain,
        );
        const newTrustedDomains = [...activeTrustedDomains, domain];
        const individualGrantStored = setStorageItem(
          resolvedStorage,
          trustedDomainKey(domain),
          "true",
        );
        const aggregateGrantStored = persistTrustedDomainsSnapshot(
          resolvedStorage,
          newTrustedDomains,
        );
        if (revocationCleared && aggregateGrantStored) {
          volatileTrustedDomains.clear();
        } else if (revocationCleared && individualGrantStored) {
          volatileTrustedDomains.delete(domain);
        } else {
          volatileTrustedDomains.add(domain);
        }

        return { ...state, trustedDomains: newTrustedDomains };
      });
    },

    /**
     * Revoke trust for a specific domain
     */
    revokeDomain: (domain: string) => {
      update((state) => {
        const activeTrustedDomains = getActiveTrustedDomains();
        volatileTrustedDomains.delete(domain);
        const newTrustedDomains = activeTrustedDomains.filter(
          (trustedDomain) => trustedDomain !== domain,
        );

        // Write the domain-specific denial first. If another tab subsequently
        // writes an aggregate list from stale state, this marker still wins.
        let revocationStored = setStorageItem(
          resolvedStorage,
          revokedDomainKey(domain),
          "true",
        );
        const withLiveTransientDomains = withTransientDomains(
          state,
          state.transientDomains.filter((d) => d !== domain),
        );
        removeStorageItem(resolvedStorage, trustedDomainKey(domain));

        if (revocationStored) {
          persistTrustedDomainsSnapshot(resolvedStorage, newTrustedDomains);
        } else {
          // Quota can reject the new tombstone while storage is full. Remove
          // the stale aggregate first, retry the denial with the freed space,
          // then best-effort restore the remaining grants. Losing grants fails
          // closed; losing the denial would resurrect consent.
          removeStorageItem(resolvedStorage, TRUSTED_DOMAINS_KEY);
          revocationStored = setStorageItem(
            resolvedStorage,
            revokedDomainKey(domain),
            "true",
          );
          if (revocationStored) {
            persistTrustedDomainsSnapshot(resolvedStorage, newTrustedDomains);
          }
        }
        broadcastSyncMessage({ type: "revoke-domain", domain });

        return {
          ...withLiveTransientDomains,
          trustedDomains: newTrustedDomains,
        };
      });
    },

    /**
     * Enable global consent for all embeds
     */
    enableGlobalConsent: () => {
      update((state) => {
        volatileGlobalConsent = !setStorageItem(
          resolvedStorage,
          GLOBAL_CONSENT_KEY,
          "true",
        );
        return { ...state, globalConsent: true };
      });
    },

    /**
     * Disable global consent
     */
    disableGlobalConsent: () => {
      update((state) => {
        // Removing is both canonical false and cannot fail merely because the
        // storage quota is full (unlike replacing "true" with longer "false").
        clearStoredGlobalConsent(resolvedStorage);
        volatileGlobalConsent = false;
        broadcastSyncMessage({ type: "disable-global" });
        return { ...state, globalConsent: false };
      });
    },

    /**
     * Clear all privacy settings
     */
    clearAll: () => {
      const state = get({ subscribe });
      const persistentState = loadPersistentPrivacyState(resolvedStorage);
      let storedTrustedDomains: string[] = [];
      let individuallyStoredDomains: string[] = [];
      let previouslyClearedDomains: string[] = [];
      if (resolvedStorage) {
        try {
          storedTrustedDomains = loadStoredDomains(
            resolvedStorage,
            TRUSTED_DOMAINS_KEY,
          );
        } catch {
          // Invalid grants are already denied.
        }
        try {
          individuallyStoredDomains =
            loadIndividuallyTrustedDomains(resolvedStorage);
        } catch {
          // Unreadable individual grants cannot authorize embeds.
        }
        try {
          previouslyClearedDomains = loadStoredDomains(
            resolvedStorage,
            CLEARED_DOMAINS_KEY,
          );
        } catch {
          // Replace malformed denial data with the complete known grant set.
        }
      }
      const domainsToRevoke = new Set([
        ...state.trustedDomains,
        ...persistentState.trustedDomains,
        ...storedTrustedDomains,
        ...individuallyStoredDomains,
        ...previouslyClearedDomains,
      ]);

      const clearedDomainsValue = JSON.stringify([...domainsToRevoke]);
      let clearStored = setStorageItem(
        resolvedStorage,
        CLEARED_DOMAINS_KEY,
        clearedDomainsValue,
      );
      removeStorageItem(resolvedStorage, TRUSTED_DOMAINS_KEY);
      removeStorageItem(resolvedStorage, TRUSTED_DOMAINS_SNAPSHOT_KEY);
      clearStoredGlobalConsent(resolvedStorage);
      for (const domain of domainsToRevoke) {
        removeStorageItem(resolvedStorage, trustedDomainKey(domain));
      }
      if (!clearStored) {
        // Removing aggregate, snapshot, global, and individual grant keys frees
        // quota before retrying the durable denial.
        clearStored = setStorageItem(
          resolvedStorage,
          CLEARED_DOMAINS_KEY,
          clearedDomainsValue,
        );
      }
      if (!clearStored) {
        // Restricted storage can still reject all writes. Individual markers
        // are a final best-effort fail-closed fallback.
        for (const domain of domainsToRevoke) {
          setStorageItem(resolvedStorage, revokedDomainKey(domain), "true");
        }
      }
      volatileTrustedDomains.clear();
      volatileGlobalConsent = false;
      broadcastSyncMessage({ type: "clear-all" });
      set({
        trustedDomains: [],
        transientDomains: [],
        transientConsentScope: null,
        globalConsent: false,
      });
    },

    /**
     * Get all trusted domains
     */
    getTrustedDomains: (): string[] => {
      const state = get({ subscribe });
      return state.trustedDomains;
    },

    /**
     * Check if global consent is enabled
     */
    hasGlobalConsent: (): boolean => {
      const state = get({ subscribe });
      return state.globalConsent;
    },
  };
}

export const privacyStore = createPrivacyStore();
