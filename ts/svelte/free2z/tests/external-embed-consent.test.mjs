import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { createServer } from "vite";

let server;
let createPrivacyStore;
let canLoadUrlFromState;
let embedConsentScope;
let getPrivacyStorage;
let getPrivacyStorageEventTarget;

before(async () => {
  server = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  ({
    createPrivacyStore,
    canLoadUrlFromState,
    embedConsentScope,
    getPrivacyStorage,
    getPrivacyStorageEventTarget,
  } = await server.ssrLoadModule("/src/lib/stores/privacy.ts"));
});

after(async () => {
  await server?.close();
});

function emptyState() {
  return {
    trustedDomains: [],
    transientDomains: [],
    transientConsentScope: null,
    globalConsent: false,
  };
}

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    get length() {
      return map.size;
    },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
    clear: () => void map.clear(),
  };
}

function quotaStorage(initial = {}) {
  const storage = fakeStorage(initial);
  let quota = [...storage.map].reduce(
    (total, [key, value]) => total + key.length + String(value).length,
    0,
  );
  const failures = new Map();

  return {
    ...storage,
    get length() {
      return storage.map.size;
    },
    key: (index) => [...storage.map.keys()][index] ?? null,
    failures,
    setItem(key, value) {
      const stringValue = String(value);
      const oldValue = storage.map.get(key);
      const oldSize =
        oldValue === undefined ? 0 : key.length + String(oldValue).length;
      const currentSize = [...storage.map].reduce(
        (total, [storedKey, storedValue]) =>
          total + storedKey.length + String(storedValue).length,
        0,
      );
      const nextSize = currentSize - oldSize + key.length + stringValue.length;

      if (nextSize > quota) {
        failures.set(key, (failures.get(key) || 0) + 1);
        throw new DOMException("quota exceeded", "QuotaExceededError");
      }
      storage.map.set(key, stringValue);
    },
    increaseQuota(bytes) {
      quota += bytes;
    },
  };
}

function fakeSyncChannelHub() {
  const channels = new Set();

  return {
    create() {
      const listeners = new Set();
      const channel = {
        postMessage(message) {
          for (const peer of channels) {
            if (peer !== channel) peer.dispatch(message);
          }
        },
        addEventListener(type, listener) {
          assert.equal(type, "message");
          listeners.add(listener);
        },
        removeEventListener(type, listener) {
          assert.equal(type, "message");
          listeners.delete(listener);
        },
        dispatch(message) {
          for (const listener of listeners) listener({ data: message });
        },
        close() {
          channels.delete(channel);
          listeners.clear();
        },
      };
      channels.add(channel);
      return channel;
    },
    size: () => channels.size,
  };
}

function clearedDomains(storage) {
  return JSON.parse(storage.map.get("clearedEmbedDomains") || "[]");
}

function fakeStorageEventTarget() {
  const listeners = new Set();
  let addCount = 0;
  let removeCount = 0;

  return {
    addEventListener(type, listener) {
      assert.equal(type, "storage");
      addCount += 1;
      listeners.add(listener);
    },
    removeEventListener(type, listener) {
      assert.equal(type, "storage");
      removeCount += 1;
      listeners.delete(listener);
    },
    dispatch(event) {
      for (const listener of listeners) listener(event);
    },
    listenerCount: () => listeners.size,
    addCount: () => addCount,
    removeCount: () => removeCount,
  };
}

function currentState(store) {
  let current;
  const unsubscribe = store.subscribe((state) => {
    current = state;
  });
  unsubscribe();
  return current;
}

test("one-time consent notifies every subscriber for the matching domain only", () => {
  const storage = fakeStorage();
  const store = createPrivacyStore(emptyState(), storage);
  const firstEmbedStates = [];
  const secondEmbedStates = [];
  const otherDomainStates = [];
  const otherPageStates = [];
  const currentPage = "/alice/article";

  const unsubscribeFirst = store.subscribe((state) => {
    firstEmbedStates.push(
      canLoadUrlFromState(state, "https://video.example/first", currentPage),
    );
  });
  const unsubscribeSecond = store.subscribe((state) => {
    secondEmbedStates.push(
      canLoadUrlFromState(state, "https://video.example/second", currentPage),
    );
  });
  const unsubscribeOther = store.subscribe((state) => {
    otherDomainStates.push(
      canLoadUrlFromState(state, "https://other.example/embed", currentPage),
    );
  });
  const unsubscribeOtherPage = store.subscribe((state) => {
    otherPageStates.push(
      canLoadUrlFromState(
        state,
        "https://video.example/another-creator",
        "/bob/article",
      ),
    );
  });

  store.allowDomainOnce("video.example", currentPage);

  assert.deepEqual(firstEmbedStates, [false, true]);
  assert.deepEqual(secondEmbedStates, [false, true]);
  assert.deepEqual(otherDomainStates, [false, false]);
  assert.deepEqual(
    otherPageStates,
    [false, false],
    "SPA navigation must not inherit one-time consent",
  );
  assert.equal(storage.map.size, 0, "Load Once must not persist consent");

  unsubscribeFirst();
  unsubscribeSecond();
  unsubscribeOther();
  unsubscribeOtherPage();
});

test("persistent consent notifies matching subscribers and survives reload", () => {
  const storage = fakeStorage();
  const store = createPrivacyStore(emptyState(), storage);
  const observed = [];
  const unsubscribe = store.subscribe((state) => {
    observed.push(canLoadUrlFromState(state, "https://video.example/first"));
  });

  store.trustDomain("video.example");

  assert.deepEqual(observed, [false, true]);
  assert.equal(storage.map.get("trustedEmbedDomains"), '["video.example"]');

  const reloadedStore = createPrivacyStore(undefined, storage);
  assert.equal(
    reloadedStore.canLoadUrl("https://video.example/after-reload"),
    true,
  );
  assert.equal(reloadedStore.canLoadUrl("https://other.example/embed"), false);
  unsubscribe();
});

test("per-domain grant keys survive a concurrent aggregate overwrite", () => {
  const storage = fakeStorage();
  const tabA = createPrivacyStore(emptyState(), storage, null);
  const tabB = createPrivacyStore(emptyState(), storage, null);

  tabA.trustDomain("first.example");
  tabB.trustDomain("second.example");

  assert.equal(storage.map.get("trustedEmbedDomain:first.example"), "true");
  assert.equal(storage.map.get("trustedEmbedDomain:second.example"), "true");

  // Reproduce the last-writer-wins aggregate left by two interleaved tabs.
  storage.setItem("trustedEmbedDomains", '["second.example"]');
  storage.setItem("trustedEmbedDomainsSnapshot", '["second.example"]');
  const reloaded = createPrivacyStore(undefined, storage, null);

  assert.deepEqual(reloaded.getTrustedDomains(), [
    "second.example",
    "first.example",
  ]);
  assert.equal(reloaded.canLoadUrl("https://first.example/embed"), true);
  assert.equal(reloaded.canLoadUrl("https://second.example/embed"), true);
});

test("a legacy tab aggregate removal revokes current-version domain keys", () => {
  const storage = fakeStorage();
  const events = fakeStorageEventTarget();
  const currentTab = createPrivacyStore(undefined, storage, events, null);
  const stopSync = currentTab.startStorageSync();

  currentTab.trustDomain("video.example");
  assert.equal(storage.map.get("trustedEmbedDomain:video.example"), "true");

  // The pre-upgrade implementation knows only the aggregate key.
  storage.setItem("trustedEmbedDomains", "[]");
  events.dispatch({
    key: "trustedEmbedDomains",
    storageArea: storage,
  });

  assert.equal(currentTab.canLoadUrl("https://video.example/embed"), false);
  assert.equal(storage.map.has("trustedEmbedDomain:video.example"), false);
  assert.equal(storage.map.get("revokedEmbedDomain:video.example"), "true");
  assert.equal(
    createPrivacyStore(undefined, storage, null).canLoadUrl(
      "https://video.example/embed",
    ),
    false,
  );

  currentTab.trustDomain("other.example");
  const afterAnotherGrant = createPrivacyStore(undefined, storage, null, null);
  assert.equal(
    afterAnotherGrant.canLoadUrl("https://video.example/embed"),
    false,
    "a later current-version grant must not resurrect the legacy revocation",
  );
  assert.equal(
    afterAnotherGrant.canLoadUrl("https://other.example/embed"),
    true,
  );
  stopSync();
});

test("successive grants survive in memory when persistence is unavailable", () => {
  const hostileStorage = {
    getItem() {
      throw new DOMException("denied", "SecurityError");
    },
    setItem() {
      throw new DOMException("denied", "SecurityError");
    },
    removeItem() {
      throw new DOMException("denied", "SecurityError");
    },
  };
  const store = createPrivacyStore(emptyState(), hostileStorage, null);

  store.trustDomain("first.example");
  store.trustDomain("second.example");

  assert.deepEqual(store.getTrustedDomains(), [
    "first.example",
    "second.example",
  ]);
  assert.equal(store.canLoadUrl("https://first.example/embed"), true);
  assert.equal(store.canLoadUrl("https://second.example/embed"), true);
});

test("persistent domain grants and revocations synchronize across tabs", () => {
  const storage = fakeStorage();
  const tabBEvents = fakeStorageEventTarget();
  const tabA = createPrivacyStore(emptyState(), storage, null);
  const tabB = createPrivacyStore(emptyState(), storage, tabBEvents);
  const stopSync = tabB.startStorageSync();

  tabB.allowDomainOnce("one-time.example", "/current-page");
  tabA.trustDomain("video.example");
  tabBEvents.dispatch({
    key: "trustedEmbedDomains",
    storageArea: storage,
  });

  assert.equal(tabB.canLoadUrl("https://video.example/embed"), true);
  assert.deepEqual(currentState(tabB).transientDomains, ["one-time.example"]);
  assert.equal(currentState(tabB).transientConsentScope, "/current-page");

  tabA.revokeDomain("video.example");
  tabBEvents.dispatch({
    key: "trustedEmbedDomains",
    storageArea: storage,
  });

  assert.equal(tabB.canLoadUrl("https://video.example/embed"), false);
  assert.equal(
    tabB.canLoadUrl("https://one-time.example/embed", "/current-page"),
    true,
    "persistent reconciliation must preserve current-tab one-time consent",
  );
  stopSync();
});

test("a stale tab cannot resurrect a concurrently revoked domain", () => {
  const storage = fakeStorage({
    trustedEmbedDomains: '["tracker.example"]',
  });
  const tabBEvents = fakeStorageEventTarget();
  const tabA = createPrivacyStore(undefined, storage, null);
  const tabB = createPrivacyStore(undefined, storage, tabBEvents);
  const stopSync = tabB.startStorageSync();

  tabA.revokeDomain("tracker.example");
  // Tab B has deliberately not processed A's storage event yet.
  tabB.trustDomain("video.example");
  tabBEvents.dispatch({
    key: "trustedEmbedDomains",
    storageArea: storage,
  });

  assert.deepEqual(tabB.getTrustedDomains(), ["video.example"]);
  assert.equal(
    tabB.canLoadUrl("https://tracker.example/embed"),
    false,
    "adding another domain must not resurrect an unseen revocation",
  );

  const reloaded = createPrivacyStore(undefined, storage, null);
  assert.deepEqual(reloaded.getTrustedDomains(), ["video.example"]);
  assert.equal(reloaded.canLoadUrl("https://tracker.example/embed"), false);
  stopSync();
});

test("a legacy stale aggregate cannot clear a current-version tombstone", () => {
  const storage = fakeStorage();
  const events = fakeStorageEventTarget();
  const currentTab = createPrivacyStore(undefined, storage, events, null);
  const stopSync = currentTab.startStorageSync();

  currentTab.trustDomain("tracker.example");
  currentTab.revokeDomain("tracker.example");

  // A pre-upgrade tab still has tracker.example in memory while granting a
  // different domain through the legacy aggregate-only implementation.
  storage.setItem("trustedEmbedDomains", '["tracker.example","video.example"]');
  events.dispatch({
    key: "trustedEmbedDomains",
    storageArea: storage,
  });

  assert.equal(currentTab.canLoadUrl("https://tracker.example/embed"), false);
  assert.equal(currentTab.canLoadUrl("https://video.example/embed"), true);

  const reloaded = createPrivacyStore(undefined, storage, null, null);
  assert.equal(reloaded.canLoadUrl("https://tracker.example/embed"), false);
  assert.equal(reloaded.canLoadUrl("https://video.example/embed"), true);
  stopSync();
});

test("trusting a persisted domain replaces an equal-length stale snapshot", () => {
  const storage = fakeStorage({
    trustedEmbedDomains: '["tracker.example"]',
  });
  const store = createPrivacyStore(undefined, storage, null);

  storage.setItem("revokedEmbedDomain:tracker.example", "true");
  storage.setItem("trustedEmbedDomains", '["video.example"]');
  store.trustDomain("video.example");

  assert.deepEqual(store.getTrustedDomains(), ["video.example"]);
  assert.equal(store.canLoadUrl("https://tracker.example/embed"), false);
  assert.equal(store.canLoadUrl("https://video.example/embed"), true);
});

test("a stale tab cannot restore domains revoked by clearAll", () => {
  const storage = fakeStorage({
    trustedEmbedDomains: '["tracker.example"]',
    globalEmbedConsent: "true",
  });
  const tabBEvents = fakeStorageEventTarget();
  const tabA = createPrivacyStore(undefined, storage, null);
  const tabB = createPrivacyStore(undefined, storage, tabBEvents);
  const stopSync = tabB.startStorageSync();

  tabA.clearAll();
  assert.deepEqual(clearedDomains(storage), ["tracker.example"]);

  // Tab B still holds tracker.example in memory when it grants another site.
  tabB.trustDomain("video.example");
  tabBEvents.dispatch({
    key: "trustedEmbedDomains",
    storageArea: storage,
  });

  assert.deepEqual(tabB.getTrustedDomains(), ["video.example"]);
  assert.equal(tabB.canLoadUrl("https://tracker.example/embed"), false);

  const reloaded = createPrivacyStore(undefined, storage, null);
  assert.deepEqual(reloaded.getTrustedDomains(), ["video.example"]);
  assert.equal(reloaded.canLoadUrl("https://tracker.example/embed"), false);
  assert.equal(reloaded.hasGlobalConsent(), false);
  stopSync();
});

test("clearAll retries its denial after aggregate removal frees quota", () => {
  const storage = quotaStorage({
    trustedEmbedDomains: '["tracker.example"]',
    globalEmbedConsent: "true",
  });
  const tabBEvents = fakeStorageEventTarget();
  const tabA = createPrivacyStore(undefined, storage, null);
  const tabB = createPrivacyStore(undefined, storage, tabBEvents);
  const stopSync = tabB.startStorageSync();

  tabA.clearAll();

  assert.equal(
    storage.failures.get("clearedEmbedDomains"),
    1,
    "the first tombstone write must reproduce a full-quota failure",
  );
  assert.equal(
    storage.map.has("clearedEmbedDomains"),
    true,
    "clearAll must retry after removing the larger aggregate/global state",
  );
  assert.deepEqual(clearedDomains(storage), ["tracker.example"]);

  // Tab B has not processed the clear and attempts a different grant.
  storage.increaseQuota(100);
  tabB.trustDomain("video.example");
  tabBEvents.dispatch({
    key: "trustedEmbedDomains",
    storageArea: storage,
  });

  assert.deepEqual(tabB.getTrustedDomains(), ["video.example"]);
  const reloaded = createPrivacyStore(undefined, storage, null);
  assert.equal(reloaded.canLoadUrl("https://tracker.example/embed"), false);
  assert.equal(reloaded.canLoadUrl("https://video.example/embed"), true);
  assert.equal(reloaded.hasGlobalConsent(), false);
  stopSync();
});

test("clearAll is quota-neutral with only an exactly-full trusted aggregate", () => {
  const storage = quotaStorage({
    trustedEmbedDomains: '["tracker.example"]',
  });
  const tabBEvents = fakeStorageEventTarget();
  const tabA = createPrivacyStore(undefined, storage, null);
  const tabB = createPrivacyStore(undefined, storage, tabBEvents);
  const stopSync = tabB.startStorageSync();

  tabA.clearAll();

  assert.equal(storage.failures.get("clearedEmbedDomains"), 1);
  assert.equal(storage.map.has("trustedEmbedDomains"), false);
  assert.deepEqual(clearedDomains(storage), ["tracker.example"]);

  // A stale writer later restores its old snapshot after capacity changes.
  storage.increaseQuota(100);
  storage.setItem("trustedEmbedDomains", '["tracker.example","video.example"]');
  tabBEvents.dispatch({
    key: "trustedEmbedDomains",
    storageArea: storage,
  });

  assert.deepEqual(tabB.getTrustedDomains(), ["video.example"]);
  assert.equal(tabB.canLoadUrl("https://tracker.example/embed"), false);
  const reloaded = createPrivacyStore(undefined, storage, null);
  assert.equal(reloaded.canLoadUrl("https://tracker.example/embed"), false);
  assert.equal(reloaded.canLoadUrl("https://video.example/embed"), true);
  stopSync();
});

test("clearAll retries after removing an exactly-full individual grant", () => {
  const storage = quotaStorage({
    "trustedEmbedDomain:tracker.example": "true",
  });
  const store = createPrivacyStore(undefined, storage, null, null);

  store.clearAll();

  assert.equal(storage.failures.get("clearedEmbedDomains"), 1);
  assert.deepEqual(clearedDomains(storage), ["tracker.example"]);
  assert.equal(storage.map.has("trustedEmbedDomain:tracker.example"), false);

  storage.increaseQuota(100);
  storage.setItem("trustedEmbedDomains", '["tracker.example","video.example"]');
  const reloaded = createPrivacyStore(undefined, storage, null, null);
  assert.equal(reloaded.canLoadUrl("https://tracker.example/embed"), false);
  assert.equal(reloaded.canLoadUrl("https://video.example/embed"), true);
});

test("a cross-tab clear revokes grants held only in volatile memory", () => {
  const storage = quotaStorage({
    filler: "full",
  });
  // Enough room for an empty clear marker, but not a domain aggregate.
  storage.increaseQuota(30);
  const tabAEvents = fakeStorageEventTarget();
  const tabA = createPrivacyStore(emptyState(), storage, tabAEvents);
  const tabB = createPrivacyStore(emptyState(), storage, null);
  const stopSync = tabA.startStorageSync();

  tabA.trustDomain("tracker.example");
  assert.equal(storage.map.has("trustedEmbedDomains"), false);
  assert.equal(tabA.canLoadUrl("https://tracker.example/embed"), true);

  tabB.clearAll();
  tabAEvents.dispatch({
    key: "clearedEmbedDomains",
    storageArea: storage,
  });

  assert.equal(tabA.canLoadUrl("https://tracker.example/embed"), false);
  assert.deepEqual(tabA.getTrustedDomains(), []);
  stopSync();
});

test("BroadcastChannel delivers repeated mutation-free clearAll revocation", () => {
  const storage = quotaStorage({
    clearedEmbedDomains: "[]",
    filler: "full",
  });
  const hub = fakeSyncChannelHub();
  const tabA = createPrivacyStore(emptyState(), storage, null, () =>
    hub.create(),
  );
  const tabB = createPrivacyStore(emptyState(), storage, null, () =>
    hub.create(),
  );
  const stopA = tabA.startStorageSync();
  const stopB = tabB.startStorageSync();

  tabA.trustDomain("memory-only.example");
  assert.equal(
    storage.map.has("trustedEmbedDomain:memory-only.example"),
    false,
  );
  assert.equal(storage.map.has("trustedEmbedDomains"), false);
  assert.equal(tabA.canLoadUrl("https://memory-only.example/embed"), true);

  // Writing the existing [] value emits no native storage event.
  tabB.clearAll();
  assert.equal(tabA.canLoadUrl("https://memory-only.example/embed"), false);

  stopA();
  stopB();
  assert.equal(hub.size(), 0);
});

test("revokeDomain retries its tombstone after freeing full storage", () => {
  const storage = quotaStorage({
    trustedEmbedDomains: '["tracker.example"]',
  });
  const store = createPrivacyStore(undefined, storage, null);

  store.revokeDomain("tracker.example");

  assert.equal(storage.failures.get("revokedEmbedDomain:tracker.example"), 1);
  assert.equal(storage.map.get("revokedEmbedDomain:tracker.example"), "true");

  // Once capacity later becomes available, even a stale aggregate cannot
  // override the durable domain denial.
  storage.increaseQuota(100);
  storage.setItem("trustedEmbedDomains", '["tracker.example","video.example"]');
  const reloaded = createPrivacyStore(undefined, storage, null);
  assert.deepEqual(reloaded.getTrustedDomains(), ["video.example"]);
  assert.equal(reloaded.canLoadUrl("https://tracker.example/embed"), false);
});

test("global consent enable and disable synchronize across tabs", () => {
  const storage = fakeStorage();
  const tabBEvents = fakeStorageEventTarget();
  const tabA = createPrivacyStore(emptyState(), storage, null);
  const tabB = createPrivacyStore(emptyState(), storage, tabBEvents);
  const stopSync = tabB.startStorageSync();

  tabA.enableGlobalConsent();
  tabBEvents.dispatch({
    key: "globalEmbedConsent",
    storageArea: storage,
  });
  assert.equal(tabB.hasGlobalConsent(), true);
  assert.equal(tabB.canLoadUrl("https://unlisted.example/embed"), true);

  tabA.disableGlobalConsent();
  tabBEvents.dispatch({
    key: "globalEmbedConsent",
    storageArea: storage,
  });
  assert.equal(tabB.hasGlobalConsent(), false);
  assert.equal(tabB.canLoadUrl("https://unlisted.example/embed"), false);
  stopSync();
});

test("global disable succeeds when full quota rejects a longer false value", () => {
  const storage = quotaStorage({
    globalEmbedConsent: "true",
  });
  const tabBEvents = fakeStorageEventTarget();
  const tabA = createPrivacyStore(undefined, storage, null);
  const tabB = createPrivacyStore(undefined, storage, tabBEvents);
  const stopSync = tabB.startStorageSync();

  assert.throws(
    () => storage.setItem("globalEmbedConsent", "false"),
    /quota exceeded/,
  );

  tabA.disableGlobalConsent();
  assert.equal(storage.map.has("globalEmbedConsent"), false);
  tabBEvents.dispatch({
    key: "globalEmbedConsent",
    storageArea: storage,
  });

  assert.equal(tabB.hasGlobalConsent(), false);
  assert.equal(
    createPrivacyStore(undefined, storage, null).hasGlobalConsent(),
    false,
  );
  stopSync();
});

test("BroadcastChannel revokes memory-only global consent across tabs", () => {
  const storage = quotaStorage({ filler: "full" });
  const hub = fakeSyncChannelHub();
  const tabA = createPrivacyStore(emptyState(), storage, null, () =>
    hub.create(),
  );
  const tabB = createPrivacyStore(emptyState(), storage, null, () =>
    hub.create(),
  );
  const stopA = tabA.startStorageSync();
  const stopB = tabB.startStorageSync();

  tabA.enableGlobalConsent();
  assert.equal(storage.map.has("globalEmbedConsent"), false);
  assert.equal(tabA.hasGlobalConsent(), true);

  // Removing an absent key emits no native storage event.
  tabB.disableGlobalConsent();
  assert.equal(tabA.hasGlobalConsent(), false);

  stopA();
  stopB();
  assert.equal(hub.size(), 0);
});

test("unrelated storage events preserve memory-only global consent", () => {
  const backing = fakeStorage();
  const storage = {
    ...backing,
    get length() {
      return backing.map.size;
    },
    key: (index) => [...backing.map.keys()][index] ?? null,
    setItem(key, value) {
      if (key === "globalEmbedConsent") {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      }
      backing.setItem(key, value);
    },
  };
  const events = fakeStorageEventTarget();
  const store = createPrivacyStore(undefined, storage, events, null);
  const stopSync = store.startStorageSync();

  store.enableGlobalConsent();
  assert.equal(store.hasGlobalConsent(), true);

  storage.setItem("trustedEmbedDomains", '["video.example"]');
  events.dispatch({
    key: "trustedEmbedDomains",
    storageArea: storage,
  });

  assert.equal(
    store.hasGlobalConsent(),
    true,
    "a domain-only event must not erase an explicit in-memory global grant",
  );
  stopSync();
});

test("starting synchronization catches persistent changes made before mount", () => {
  const storage = fakeStorage();
  const events = fakeStorageEventTarget();
  const store = createPrivacyStore(emptyState(), storage, events);

  storage.setItem("trustedEmbedDomains", '["before-mount.example"]');
  storage.setItem("globalEmbedConsent", "true");
  const stopSync = store.startStorageSync();

  assert.deepEqual(store.getTrustedDomains(), ["before-mount.example"]);
  assert.equal(store.hasGlobalConsent(), true);
  stopSync();
});

test("storage synchronization ignores unrelated keys and other storage areas", () => {
  const storage = fakeStorage({
    trustedEmbedDomains: '["initial.example"]',
  });
  const otherStorage = fakeStorage();
  const events = fakeStorageEventTarget();
  const store = createPrivacyStore(undefined, storage, events);
  const stopSync = store.startStorageSync();

  storage.setItem("trustedEmbedDomains", '["changed.example"]');
  events.dispatch({ key: "unrelated", storageArea: storage });
  events.dispatch({ key: "trustedEmbedDomains", storageArea: otherStorage });

  assert.deepEqual(store.getTrustedDomains(), ["initial.example"]);
  stopSync();
});

test("removed, cleared, and corrupt persistent values fail closed", () => {
  const storage = fakeStorage({
    trustedEmbedDomains: '["video.example"]',
    globalEmbedConsent: "true",
  });
  const events = fakeStorageEventTarget();
  const store = createPrivacyStore(undefined, storage, events);
  const stopSync = store.startStorageSync();

  store.allowDomainOnce("one-time.example", "/current-page");
  storage.setItem("trustedEmbedDomains", '{"video.example":true}');
  events.dispatch({ key: "trustedEmbedDomains", storageArea: storage });

  assert.deepEqual(store.getTrustedDomains(), []);
  assert.equal(
    store.hasGlobalConsent(),
    true,
    "a corrupt domain list must not discard an independently valid global grant",
  );
  assert.equal(
    store.canLoadUrl("https://one-time.example/embed", "/current-page"),
    true,
  );

  storage.setItem("trustedEmbedDomains", '["restored.example"]');
  storage.setItem("globalEmbedConsent", "true");
  events.dispatch({ key: "trustedEmbedDomains", storageArea: storage });
  assert.equal(store.canLoadUrl("https://restored.example/embed"), true);
  assert.equal(store.hasGlobalConsent(), true);

  storage.removeItem("trustedEmbedDomains");
  events.dispatch({ key: "trustedEmbedDomains", storageArea: storage });
  assert.deepEqual(store.getTrustedDomains(), []);

  storage.setItem("globalEmbedConsent", "not-true");
  events.dispatch({ key: "globalEmbedConsent", storageArea: storage });
  assert.equal(store.hasGlobalConsent(), false);

  storage.setItem("globalEmbedConsent", "true");
  events.dispatch({ key: "globalEmbedConsent", storageArea: storage });
  assert.equal(store.hasGlobalConsent(), true);

  storage.setItem("trustedEmbedDomains", '["clear.example"]');
  storage.clear();
  events.dispatch({ key: null, storageArea: storage });
  assert.deepEqual(store.getTrustedDomains(), []);
  assert.equal(store.hasGlobalConsent(), false);
  stopSync();
});

test("any non-null domain tombstone and malformed clear tombstones fail closed", () => {
  const malformedIndividual = fakeStorage({
    trustedEmbedDomains: '["tracker.example"]',
    "revokedEmbedDomain:tracker.example": "corrupt",
  });
  const malformedCleared = fakeStorage({
    trustedEmbedDomains: '["tracker.example"]',
    clearedEmbedDomains: '{"tracker.example":true}',
  });

  assert.equal(
    createPrivacyStore(undefined, malformedIndividual, null).canLoadUrl(
      "https://tracker.example/embed",
    ),
    false,
  );
  assert.equal(
    createPrivacyStore(undefined, malformedCleared, null).canLoadUrl(
      "https://tracker.example/embed",
    ),
    false,
  );
});

test("a malformed managed snapshot cannot erase a domain revocation", () => {
  const storage = fakeStorage({
    trustedEmbedDomains: '["tracker.example"]',
    trustedEmbedDomainsSnapshot: '{"broken":true}',
    "trustedEmbedDomain:tracker.example": "true",
    "revokedEmbedDomain:tracker.example": "true",
  });

  const store = createPrivacyStore(undefined, storage, null, null);
  assert.equal(store.canLoadUrl("https://tracker.example/embed"), false);
  assert.equal(storage.map.get("revokedEmbedDomain:tracker.example"), "true");
});

test("clearAll revokes individual grants even when the aggregate is malformed", () => {
  const storage = fakeStorage({
    trustedEmbedDomains: '{"broken":true}',
    "trustedEmbedDomain:tracker.example": "true",
  });
  const store = createPrivacyStore(undefined, storage, null);

  store.clearAll();

  assert.equal(storage.map.has("trustedEmbedDomain:tracker.example"), false);
  assert.deepEqual(clearedDomains(storage), ["tracker.example"]);
  assert.equal(
    createPrivacyStore(undefined, storage, null).canLoadUrl(
      "https://tracker.example/embed",
    ),
    false,
  );
});

test("storage listener registration is shared and cleanup is idempotent", () => {
  const storage = fakeStorage();
  const events = fakeStorageEventTarget();
  const store = createPrivacyStore(emptyState(), storage, events);

  const stopFirst = store.startStorageSync();
  const stopSecond = store.startStorageSync();
  assert.equal(events.listenerCount(), 1);
  assert.equal(events.addCount(), 1);

  stopFirst();
  stopFirst();
  assert.equal(events.listenerCount(), 1);
  assert.equal(events.removeCount(), 0);

  stopSecond();
  stopSecond();
  assert.equal(events.listenerCount(), 0);
  assert.equal(events.removeCount(), 1);

  storage.setItem("globalEmbedConsent", "true");
  events.dispatch({ key: "globalEmbedConsent", storageArea: storage });
  assert.equal(store.hasGlobalConsent(), false);
});

test("one-time consent is discarded when the in-memory page store is recreated", () => {
  const storage = fakeStorage();
  const store = createPrivacyStore(emptyState(), storage);

  store.allowDomainOnce("video.example", "/alice/article");
  assert.equal(
    store.canLoadUrl("https://video.example/first", "/alice/article"),
    true,
  );
  assert.equal(
    store.canLoadUrl("https://video.example/first", "/bob/article"),
    false,
  );

  const reloadedStore = createPrivacyStore(undefined, storage);
  assert.equal(reloadedStore.canLoadUrl("https://video.example/first"), false);
});

test("leaving and revisiting a route cannot reuse one-time consent", () => {
  const store = createPrivacyStore(emptyState(), fakeStorage());
  const route = "/alice/article";

  store.allowDomainOnce("video.example", route);
  assert.equal(store.canLoadUrl("https://video.example/first", route), true);

  store.clearTransientConsentForScope("/other/article");
  assert.equal(
    store.canLoadUrl("https://video.example/first", route),
    true,
    "a canceled navigation to another route must not revoke current consent",
  );

  store.clearTransientConsentForScope(route);

  assert.equal(store.canLoadUrl("https://video.example/first", route), false);
});

test("a redirect back to the granting page cannot reuse its one-time grant", () => {
  const store = createPrivacyStore(emptyState(), fakeStorage());
  const article = "/alice/article";

  store.allowDomainOnce("video.example", article);

  // Leaving the page spends the grant (root layout afterNavigate).
  store.clearTransientConsent();

  // Returning through /alice/zpage/article, which 301s to /alice/article. The
  // beforeNavigate pre-clear only ever sees the pre-redirect destination.
  store.clearTransientConsentForScope("/alice/zpage/article");

  assert.equal(
    store.canLoadUrl("https://video.example/one", article),
    false,
    "a redirect must not deliver the visitor back onto a stale grant",
  );
});

test("the consent scope covers the query string but not the hash", () => {
  assert.equal(
    embedConsentScope(new URL("https://free2z.cash/alice?page=1")),
    "/alice?page=1",
    "a different query renders different content and must not share a grant",
  );
  assert.notEqual(
    embedConsentScope(new URL("https://free2z.cash/alice?page=1")),
    embedConsentScope(new URL("https://free2z.cash/alice?page=2")),
  );
  assert.equal(
    embedConsentScope(new URL("https://free2z.cash/alice#comments")),
    embedConsentScope(new URL("https://free2z.cash/alice")),
    "an in-page anchor is the same page and must not re-prompt",
  );
  assert.notEqual(
    embedConsentScope(new URL("https://free2z.cash/alice?a=1&b=2")),
    embedConsentScope(new URL("https://free2z.cash/alice?b=2&a=1")),
    "a reordered query errs toward prompting again",
  );
});

test("one-time consent does not survive a query-string change", () => {
  const store = createPrivacyStore(emptyState(), fakeStorage());
  const firstPage = embedConsentScope(new URL("https://free2z.cash/alice?p=1"));
  const secondPage = embedConsentScope(
    new URL("https://free2z.cash/alice?p=2"),
  );

  store.allowDomainOnce("video.example", firstPage);

  assert.equal(store.canLoadUrl("https://video.example/one", firstPage), true);
  assert.equal(
    store.canLoadUrl("https://video.example/two", secondPage),
    false,
    "paging within a creator's route must re-prompt for the next page's embeds",
  );

  // Paging back re-enters the granting scope, which must prompt again rather
  // than reuse the earlier grant.
  store.clearTransientConsentForScope(firstPage);
  assert.equal(store.canLoadUrl("https://video.example/one", firstPage), false);
});

test("an in-page anchor keeps one-time consent alive", () => {
  const store = createPrivacyStore(emptyState(), fakeStorage());
  const article = embedConsentScope(new URL("https://free2z.cash/alice/post"));
  const anchored = embedConsentScope(
    new URL("https://free2z.cash/alice/post#comments"),
  );

  store.allowDomainOnce("video.example", article);

  assert.equal(
    store.canLoadUrl("https://video.example/one", anchored),
    true,
    "scrolling to an anchor must not unload an embed the user just allowed",
  );

  // Deliberate consequence: `#comment-<id>` expands threaded replies, so a
  // reply embed from the same already-consented domain loads without a second
  // prompt — exactly as it would from the "show replies" button, which changes
  // no URL at all. A different domain in that reply still prompts.
  assert.equal(store.canLoadUrl("https://other.example/one", anchored), false);
});

test("a cross-tab domain revocation ends a one-time grant in every tab", () => {
  const storage = fakeStorage();
  const hub = fakeSyncChannelHub();
  const tabA = createPrivacyStore(emptyState(), storage, null, () =>
    hub.create(),
  );
  const tabB = createPrivacyStore(emptyState(), storage, null, () =>
    hub.create(),
  );
  const stopA = tabA.startStorageSync();
  const stopB = tabB.startStorageSync();

  tabB.allowDomainOnce("video.example", "/alice?p=1");
  tabB.allowDomainOnce("audio.example", "/alice?p=1");
  assert.equal(
    tabB.canLoadUrl("https://video.example/one", "/alice?p=1"),
    true,
  );

  tabA.revokeDomain("video.example");

  assert.equal(
    tabB.canLoadUrl("https://video.example/one", "/alice?p=1"),
    false,
    "a revocation in another tab must unload the one-time embed here",
  );
  assert.equal(
    tabB.canLoadUrl("https://audio.example/one", "/alice?p=1"),
    true,
    "revoking one domain must not revoke unrelated one-time grants",
  );
  assert.equal(currentState(tabB).transientConsentScope, "/alice?p=1");

  stopA();
  stopB();
});

test("a cross-tab clear-all ends every one-time grant", () => {
  const storage = fakeStorage();
  const hub = fakeSyncChannelHub();
  const tabA = createPrivacyStore(emptyState(), storage, null, () =>
    hub.create(),
  );
  const tabB = createPrivacyStore(emptyState(), storage, null, () =>
    hub.create(),
  );
  const stopA = tabA.startStorageSync();
  const stopB = tabB.startStorageSync();

  tabB.allowDomainOnce("video.example", "/alice?p=1");
  assert.equal(
    tabB.canLoadUrl("https://video.example/one", "/alice?p=1"),
    true,
  );

  tabA.clearAll();

  assert.equal(
    tabB.canLoadUrl("https://video.example/one", "/alice?p=1"),
    false,
    '"Clear all" must not leave a live one-time embed in another tab',
  );
  assert.deepEqual(currentState(tabB).transientDomains, []);
  assert.equal(currentState(tabB).transientConsentScope, null);

  stopA();
  stopB();
});

test("a storage-only clear-all ends one-time grants without BroadcastChannel", () => {
  const storage = fakeStorage();
  const tabBEvents = fakeStorageEventTarget();
  const tabA = createPrivacyStore(emptyState(), storage, null, null);
  const tabB = createPrivacyStore(emptyState(), storage, tabBEvents, null);
  const stopSync = tabB.startStorageSync();

  tabB.allowDomainOnce("video.example", "/alice?p=1");
  tabA.trustDomain("other.example");
  tabA.clearAll();
  tabBEvents.dispatch({ key: "clearedEmbedDomains", storageArea: storage });

  assert.equal(
    tabB.canLoadUrl("https://video.example/one", "/alice?p=1"),
    false,
    "the clear marker is the only cross-tab signal when BroadcastChannel is absent",
  );

  tabB.allowDomainOnce("video.example", "/alice?p=1");
  storage.clear();
  tabBEvents.dispatch({ key: null, storageArea: storage });
  assert.equal(
    tabB.canLoadUrl("https://video.example/one", "/alice?p=1"),
    false,
  );
  stopSync();
});

test("an arriving domain tombstone drops the one-time grant", () => {
  const storage = fakeStorage();
  const events = fakeStorageEventTarget();
  const store = createPrivacyStore(emptyState(), storage, events, null);
  const stopSync = store.startStorageSync();

  store.allowDomainOnce("video.example", "/alice?p=1");
  store.allowDomainOnce("audio.example", "/alice?p=1");

  // Another tab writes only the durable per-domain tombstone, which is the
  // sole cross-tab signal when BroadcastChannel is unavailable.
  storage.setItem("revokedEmbedDomain:video.example", "true");
  events.dispatch({
    key: "revokedEmbedDomain:video.example",
    storageArea: storage,
  });

  assert.equal(
    store.canLoadUrl("https://video.example/one", "/alice?p=1"),
    false,
    "a tombstone written elsewhere must revoke this tab's one-time grant",
  );
  assert.equal(
    store.canLoadUrl("https://audio.example/one", "/alice?p=1"),
    true,
  );
  stopSync();
});

test("a legacy aggregate removal also drops the one-time grant", () => {
  const storage = fakeStorage();
  const events = fakeStorageEventTarget();
  const store = createPrivacyStore(emptyState(), storage, events, null);
  const stopSync = store.startStorageSync();

  store.allowDomainOnce("video.example", "/alice?p=1");

  // A pre-upgrade tab knows only the aggregate key: it trusts the domain...
  storage.setItem("trustedEmbedDomains", '["video.example"]');
  events.dispatch({ key: "trustedEmbedDomains", storageArea: storage });
  assert.deepEqual(store.getTrustedDomains(), ["video.example"]);

  //...and then revokes it the same way. This tab converts that removal into a
  // tombstone itself, so no storage event ever announces the revocation.
  storage.setItem("trustedEmbedDomains", "[]");
  events.dispatch({ key: "trustedEmbedDomains", storageArea: storage });

  assert.deepEqual(store.getTrustedDomains(), []);
  assert.equal(storage.map.get("revokedEmbedDomain:video.example"), "true");
  assert.equal(
    store.canLoadUrl("https://video.example/one", "/alice?p=1"),
    false,
    "a legacy revocation must unload the embed, not just untrust the domain",
  );
  stopSync();
});

test("an old tombstone does not revoke a later one-time grant", () => {
  // The user revoked this domain at some point in the past. "Load once" is a
  // fresh, narrower consent that deliberately overrides that history, and no
  // amount of unrelated cross-tab churn may quietly take it back.
  const storage = fakeStorage({
    "revokedEmbedDomain:video.example": "true",
  });
  const events = fakeStorageEventTarget();
  const store = createPrivacyStore(undefined, storage, events, null);
  const stopSync = store.startStorageSync();

  store.allowDomainOnce("video.example", "/alice?p=1");
  assert.equal(
    store.canLoadUrl("https://video.example/one", "/alice?p=1"),
    true,
  );

  storage.setItem("trustedEmbedDomains", '["unrelated.example"]');
  events.dispatch({ key: "trustedEmbedDomains", storageArea: storage });

  assert.equal(
    store.canLoadUrl("https://video.example/one", "/alice?p=1"),
    true,
    "an unrelated cross-tab write must not unload a running one-time embed",
  );

  // Removing the tombstone (a re-trust elsewhere) fires the same key and must
  // not be mistaken for a revocation.
  storage.removeItem("revokedEmbedDomain:video.example");
  events.dispatch({
    key: "revokedEmbedDomain:video.example",
    storageArea: storage,
  });
  assert.equal(
    store.canLoadUrl("https://video.example/one", "/alice?p=1"),
    true,
  );
  stopSync();
});

test("storage denial falls back to memory without aborting initialization", () => {
  const unavailable = getPrivacyStorage(true, () => {
    throw new DOMException("denied", "SecurityError");
  });

  assert.equal(unavailable, null);

  const hostileStorage = {
    getItem() {
      throw new DOMException("denied", "SecurityError");
    },
    setItem() {
      throw new DOMException("denied", "SecurityError");
    },
    removeItem() {
      throw new DOMException("denied", "SecurityError");
    },
  };
  const store = createPrivacyStore(undefined, hostileStorage);
  store.trustDomain("video.example");
  assert.equal(store.canLoadUrl("https://video.example/embed"), true);

  const unavailableEvents = getPrivacyStorageEventTarget(true, () => {
    throw new DOMException("denied", "SecurityError");
  });
  assert.equal(unavailableEvents, null);

  const hostileEvents = {
    addEventListener() {
      throw new DOMException("denied", "SecurityError");
    },
    removeEventListener() {
      throw new DOMException("denied", "SecurityError");
    },
  };
  const eventDeniedStore = createPrivacyStore(
    emptyState(),
    fakeStorage(),
    hostileEvents,
  );
  assert.doesNotThrow(() => eventDeniedStore.startStorageSync());
});

test("ExternalEmbed reacts to shared consent and keeps canceled URLs dismissed", async () => {
  const source = await readFile(
    new URL("../src/lib/components/ExternalEmbed.svelte", import.meta.url),
    "utf8",
  );

  // `safeUrl`, not `url`: every URL sink in the component reads the
  // scheme-validated value, and the consent decision must be made about the
  // same string that will actually be loaded.
  assert.match(
    source,
    /canLoadUrlFromState\(\$privacyStore, safeUrl, consentScope\)/,
    "the component must subscribe to privacyStore rather than take a snapshot",
  );
  assert.match(
    source,
    /\$: safeUrl = getSafeHttpUrl\(url\)/,
    "the url prop must be scheme-validated before any use",
  );
  assert.doesNotMatch(
    source,
    /href=\{url\}|src=\{url\}/,
    "no live URL sink may read the raw url prop",
  );
  assert.match(source, /privacyStore\.allowDomainOnce\(domain, consentScope\)/);
  assert.match(source, /dismissedConsentKey !== consentKey/);
  assert.match(source, /dismissedConsentKey = consentKey/);
  assert.match(source, /consentKey = `\$\{consentScope\}\\n\$\{safeUrl\}`/);
  assert.match(
    source,
    /consentScope = embedConsentScope\(\$page\.url\)/,
    "the embed and the layout must derive the scope the same way",
  );
  assert.match(
    source,
    /if \(!hasConsent\) \{[\s\S]*?iframelyLoadKey = "";/,
    "revocation must reset Iframely request state for a later re-grant",
  );
  assert.match(source, /getTweetEmbedUrl\(safeUrl, tweetTheme\)/);
  assert.match(
    source,
    /<iframe[\s\S]*?src=\{tweetEmbedUrl\}[\s\S]*?sandbox=/,
    "tweets must use the consent-gated iframe path with a sandbox",
  );
  assert.doesNotMatch(
    source,
    /platform\.twitter\.com\/widgets\.js|ensureTwitterWidgets|createTweet\(/,
    "tweet embeds must not load third-party script into the parent page",
  );
});

test("the root layout ends one-time consent on logical page navigation", async () => {
  const source = await readFile(
    new URL("../src/routes/+layout.svelte", import.meta.url),
    "utf8",
  );

  assert.match(source, /beforeNavigate\(/);
  assert.match(
    source,
    /privacyStore\.clearTransientConsentForScope\(toScope\)/,
  );
  assert.match(source, /fromScope !== toScope/);
  // `from?.url` / `to?.url`: a redirect thrown by a client-side load during
  // the initial navigation reports a navigation with a null `url`.
  assert.match(
    source,
    /const fromScope = from\?\.url \? embedConsentScope\(from\.url\) : ""/,
  );
  assert.match(
    source,
    /const toScope = to\?\.url \? embedConsentScope\(to\.url\) : ""/,
  );
  assert.match(
    source,
    /afterNavigate\(\({ from, to }\) => \{[\s\S]*?privacyStore\.clearTransientConsent\(\)/,
    "a completed navigation away from the granting page must spend the grant",
  );
  assert.match(source, /addEventListener\("pagehide"/);
  assert.match(source, /privacyStore\.startStorageSync\(\)/);
  assert.match(source, /stopPrivacyStorageSync\(\)/);
});
