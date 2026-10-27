// The user-visible half of, tracked as: the 2Z subscribe POST must
// actually send `Idempotency-Key` from the browser, with a key that is STABLE
// across the retry  describes (15s abort -> reload -> click again). A fresh
// UUID per click would satisfy "the header is sent" and protect nothing.
//
// Two layers are asserted here:
//   1. the key policy itself (real behaviour, exercised directly), and
//   2. that both subscribe call sites pass it into the request options --
//      a source assertion, because these are Svelte components whose click
//      path needs an authenticated session and a real dialog to reach.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  clearSubscribeIdempotencyKey,
  retireSubscribeKeyResolvedByMembership,
  clearDonationIdempotencyKey,
  donationIdempotencyKey,
  clearIntentIdempotencyKey,
  archiveUnknownIntentIdempotencyKey,
  intentIdempotencyKey,
  intentIdempotencySnapshot,
  storedIntentIdempotencyKey,
  IdempotencyStorageCleanupFailed,
  IdempotencyStorageUnavailable,
  subscribeIdempotencyKey,
  subscribeIdempotencyHeaders,
  subscribeRecoveryKeys,
  markSubscribeIdempotencyAbandoned,
  SubscriptionIdempotencyStorageError,
  supersededSubscribeIdempotencyKey,
} from "../src/lib/subscribe-idempotency.js";
import { mergeRequestHeaders } from "../src/lib/api/request.js";

const root = new URL("../", import.meta.url);
const read = (relative) =>
  readFileSync(fileURLToPath(new URL(relative, root)), "utf8");

const CALL_SITES = [
  "src/lib/components/profile/ProfileSubscribe.svelte",
  "src/lib/components/stream/SubscribeToCreator.svelte",
];

/** Minimal in-memory stand-in for `sessionStorage`. */
function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    entries: () => map.entries(),
    get size() {
      return map.size;
    },
  };
}

function faultStorage(
  map,
  { failRead = () => false, failWrite = () => false } = {},
) {
  return {
    getItem: (key) => {
      if (failRead(key)) throw new Error("storage read failed");
      return map.has(key) ? map.get(key) : null;
    },
    setItem: (key, value) => {
      if (failWrite(key)) throw new Error("storage write failed");
      map.set(key, String(value));
    },
    removeItem: (key) => map.delete(key),
  };
}

test("a retry for the same creator reuses the same key", () => {
  const storage = fakeStorage();
  const first = subscribeIdempotencyKey("alice", { storage });
  const second = subscribeIdempotencyKey("alice", { storage });
  assert.equal(second, first);
});

test("the key survives a reload, which is where the #556 retry happens", () => {
  // Same backing store, fresh call: exactly what a page reload looks like to
  // web storage.
  const storage = fakeStorage();
  const beforeReload = subscribeIdempotencyKey("alice", { storage });
  const afterReload = subscribeIdempotencyKey("alice", { storage });
  assert.equal(afterReload, beforeReload);
});

// Adversarial review of, round two: the abort copy tells the user to
// CLOSE the page, and sessionStorage dies with the tab and is not shared
// between tabs. Following our own instructions would have discarded the key.
// localStorage is one store per origin, which is what these two model.
test("the key survives closing the tab and retrying from a new one", (t) => {
  const shared = fakeStorage();
  const originalWindow = globalThis.window;
  const originalLocal = globalThis.localStorage;
  globalThis.window = /** @type {any} */ ({});
  globalThis.localStorage = /** @type {any} */ (shared);
  t.after(() => {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    if (originalLocal === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = originalLocal;
  });

  // No injected storage: this exercises the real storage selection, so a
  // regression back to sessionStorage fails here.
  const inFirstTab = subscribeIdempotencyKey("alice");
  const inSecondTab = subscribeIdempotencyKey("alice");
  assert.equal(inSecondTab, inFirstTab);
  clearSubscribeIdempotencyKey("alice");
  assert.notEqual(subscribeIdempotencyKey("alice"), inFirstTab);
});

// Adversarial review of, round two: an earlier version write-probed the
// store under `<prefix>probe`, which is byte-for-byte the storage key of the
// creator named `probe` — a legal username. Every call wiped that creator's
// outstanding key, silently re-enabling double charges for them alone.
test("a creator named `probe` is not special", () => {
  const storage = fakeStorage();
  const first = subscribeIdempotencyKey("probe", { storage });
  const second = subscribeIdempotencyKey("probe", { storage });
  assert.equal(second, first);
});

test("each creator gets its own key", () => {
  const storage = fakeStorage();
  const alice = subscribeIdempotencyKey("alice", { storage });
  const bob = subscribeIdempotencyKey("bob", { storage });
  assert.notEqual(alice, bob);
});

test("a confirmed success retires the key so the next purchase charges", () => {
  const storage = fakeStorage();
  const first = subscribeIdempotencyKey("alice", { storage });
  clearSubscribeIdempotencyKey("alice", { storage });
  const next = subscribeIdempotencyKey("alice", { storage });
  assert.notEqual(next, first);
});

const stableIdentity = (overrides = {}) => ({
  creatorId: 42,
  payerId: 7,
  username: "alice",
  ...overrides,
});

test("server-confirmed abandonment releases a shared browser without deleting evidence first", () => {
  const storage = fakeStorage();
  const alice = stableIdentity({ payerId: 7, payerUsername: "alice" });
  const bob = stableIdentity({ payerId: 8, payerUsername: "bob" });
  const oldKey = subscribeIdempotencyHeaders(alice, { storage })[
    "Idempotency-Key"
  ];
  assert.deepEqual(
    subscribeRecoveryKeys(alice, { storage }).includes(oldKey),
    true,
  );

  // This helper is called only after the authenticated recovery endpoint has
  // committed its terminal server state.
  markSubscribeIdempotencyAbandoned(alice, oldKey, { storage });
  assert.deepEqual(
    subscribeRecoveryKeys(alice, { storage }).includes(oldKey),
    false,
  );
  const nextAlice = subscribeIdempotencyHeaders(alice, { storage })[
    "Idempotency-Key"
  ];
  assert.notEqual(nextAlice, oldKey);
  assert.throws(
    () => subscribeIdempotencyHeaders(bob, { storage }),
    (error) => error.code === "idempotency_adoption_conflict",
  );
});

test("abandonment reconciles exactly one key and preserves a second uncertain key", () => {
  const storage = fakeStorage();
  const identity = stableIdentity({ payerId: 7, payerUsername: "alice" });
  storage.setItem("f2z:subscribe-idempotency:alice", "legacy-purchase");
  const current = subscribeIdempotencyHeaders(identity, {
    storage,
    mint: () => "77777777-7777-4777-8777-777777777777",
  })["Idempotency-Key"];
  const recovery = subscribeRecoveryKeys(identity, { storage });
  assert.deepEqual(recovery.sort(), [current, "legacy-purchase"].sort());

  markSubscribeIdempotencyAbandoned(identity, current, { storage });

  assert.deepEqual(subscribeRecoveryKeys(identity, { storage }), [
    "legacy-purchase",
  ]);
  assert.throws(
    () => subscribeIdempotencyHeaders(identity, { storage }),
    (error) => error.code === "idempotency_adoption_conflict",
  );
  markSubscribeIdempotencyAbandoned(identity, "legacy-purchase", { storage });
  assert.deepEqual(subscribeRecoveryKeys(identity, { storage }), []);
});

test("recovery keeps foreign superseded evidence stored but out of this payer's lookup", () => {
  const storage = fakeStorage();
  const identity = stableIdentity({ username: "fan", payerUsername: "fan" });
  const foreignKey = "foreign-receipt";
  subscribeIdempotencyHeaders(identity, { storage });
  const stableDestination = `f2z:subscribe-idempotency:v2:${encodeURIComponent(
    JSON.stringify({ creator: "42", payer: "7" }),
  )}`;
  storage.setItem(`${stableDestination}:superseded`, foreignKey);
  storage.setItem(
    `f2z:subscribe-idempotency-adoption-owner:${encodeURIComponent(foreignKey)}`,
    JSON.stringify({ creatorId: 42, payerId: 8, settled: false }),
  );

  assert.equal(
    subscribeRecoveryKeys(identity, { storage }).includes(foreignKey),
    false,
  );
  assert.equal(
    storage.getItem(`${stableDestination}:superseded`),
    foreignKey,
    "foreign evidence remains available to its owning identity",
  );
});

test("new subscription intents remain retryable by already-loaded legacy callers", () => {
  const storage = fakeStorage();
  const identity = stableIdentity({ payerUsername: "fan" });
  const current = subscribeIdempotencyHeaders(identity, { storage });
  const legacy = subscribeIdempotencyHeaders(identity.username, {
    storage,
    actor: "fan",
  });
  assert.equal(legacy["Idempotency-Key"], current["Idempotency-Key"]);
});

test("a delayed subscription cleanup cannot retire a newer key", () => {
  const storage = fakeStorage();
  const identity = stableIdentity({ payerUsername: "fan" });
  const first = subscribeIdempotencyHeaders(identity, { storage })[
    "Idempotency-Key"
  ];
  clearSubscribeIdempotencyKey(identity, { storage });
  const second = subscribeIdempotencyHeaders(identity, {
    storage,
    mint: () => "99999999-9999-4999-8999-999999999999",
  })["Idempotency-Key"];
  clearSubscribeIdempotencyKey(identity, { storage, expectedKey: first });

  assert.equal(
    subscribeIdempotencyHeaders(identity, { storage })["Idempotency-Key"],
    second,
    "an older response must not clear the newer purchase intent",
  );
});

test("a delayed response cannot settle a newer adopted subscription key", () => {
  const storage = fakeStorage();
  const identity = stableIdentity({ payerUsername: "fan" });
  const keyA = subscribeIdempotencyHeaders(identity, { storage })[
    "Idempotency-Key"
  ];
  const keyAFromSecondTab = subscribeIdempotencyHeaders(identity, { storage })[
    "Idempotency-Key"
  ];
  assert.equal(keyAFromSecondTab, keyA);

  // Both tabs sent A. One response settles it, then an old bundle leaves a
  // legacy receipt that the next purchase adopts as B's superseded evidence.
  clearSubscribeIdempotencyKey(identity, { storage, expectedKey: keyA });
  storage.setItem("f2z:subscribe-idempotency:alice", "f2z-late-legacy-key");
  const keyBHeaders = subscribeIdempotencyHeaders(identity, {
    storage,
    mint: () => "99999999-9999-4999-8999-999999999999",
  });
  const adoptionName = [...storage.entries()].find(([name]) =>
    name.startsWith("f2z:subscribe-idempotency-adoption:"),
  )?.[0];
  assert.ok(adoptionName);
  const adoptionBeforeLateResponse = storage.getItem(adoptionName);

  // The second tab's delayed result for A must not clear B or settle the
  // adopted legacy receipt (which is sent as B's superseded key).
  clearSubscribeIdempotencyKey(identity, { storage, expectedKey: keyA });

  assert.deepEqual(
    subscribeIdempotencyHeaders(identity, { storage }),
    keyBHeaders,
  );
  assert.equal(storage.getItem(adoptionName), adoptionBeforeLateResponse);
  assert.equal(JSON.parse(adoptionBeforeLateResponse).settled, false);
  assert.equal(
    storage.getItem("f2z:subscribe-idempotency-superseded:alice"),
    "f2z-late-legacy-key",
  );
});

test("settled legacy ownership allows a different payer or creator to buy", () => {
  for (const change of [{ payerId: 8 }, { creatorId: 99 }]) {
    const storage = fakeStorage();
    storage.setItem(
      "f2z:subscribe-idempotency:alice",
      "77777777-7777-4777-8777-777777777777",
    );
    const first = subscribeIdempotencyHeaders(stableIdentity(), { storage });
    clearSubscribeIdempotencyKey(stableIdentity(), { storage });
    const next = subscribeIdempotencyHeaders(stableIdentity(change), {
      storage,
    });
    assert.notEqual(next["Idempotency-Key"], first["Idempotency-Key"]);
    assert.equal(
      subscribeIdempotencyHeaders("alice", { storage })["Idempotency-Key"],
      next["Idempotency-Key"],
    );
  }
});

test("a partial compatibility write preserves the first UUID for the retry", () => {
  for (const failureWrite of [2, 3, 4, 5]) {
    const storage = fakeStorage();
    let writes = 0;
    let failed = false;
    const partial = {
      ...storage,
      setItem(name, value) {
        writes += 1;
        if (writes === failureWrite) {
          failed = true;
          throw new Error("quota");
        }
        storage.setItem(name, value);
      },
    };
    const first = "88888888-8888-4888-8888-888888888888";
    assert.throws(() =>
      subscribeIdempotencyHeaders(stableIdentity({ payerUsername: "fan" }), {
        storage: partial,
        mint: () => first,
      }),
    );
    assert.equal(failed, true);
    const retried = subscribeIdempotencyHeaders(
      stableIdentity({ payerUsername: "fan" }),
      {
        storage,
        mint: () => {
          throw new Error("must recover the persisted UUID");
        },
      },
    );
    assert.equal(retried["Idempotency-Key"], first);
    assert.equal(
      subscribeIdempotencyHeaders("alice", { storage })["Idempotency-Key"],
      first,
    );
  }
});

test("failed settled superseded cleanup cannot forward an old purchase as a new one", () => {
  const storage = fakeStorage();
  storage.setItem("f2z:subscribe-idempotency:alice", "f2z-settled-purchase");
  const identity = stableIdentity();
  subscribeIdempotencyHeaders(identity, { storage });
  const blocked = {
    ...storage,
    removeItem(name) {
      if (name.endsWith(":superseded")) throw new Error("remove blocked");
      storage.removeItem(name);
    },
  };
  clearSubscribeIdempotencyKey(identity, { storage: blocked });
  assert.throws(
    () => subscribeIdempotencyHeaders(identity, { storage: blocked }),
    SubscriptionIdempotencyStorageError,
  );
  assert.throws(
    () => subscribeIdempotencyHeaders(identity, { storage }),
    (error) => error.code === "idempotency_adoption_conflict",
  );
  assert.throws(
    () => subscribeIdempotencyHeaders(identity, { storage: blocked }),
    SubscriptionIdempotencyStorageError,
  );
});

test("stable subscription identity survives creator rename and reuse", () => {
  const storage = fakeStorage();
  const beforeRename = subscribeIdempotencyHeaders(stableIdentity(), {
    storage,
    mint: () => "11111111-1111-4111-8111-111111111111",
  });
  const afterRename = subscribeIdempotencyHeaders(
    stableIdentity({ username: "renamed" }),
    { storage },
  );
  assert.throws(
    () =>
      subscribeIdempotencyHeaders(stableIdentity({ creatorId: 99 }), {
        storage,
      }),
    (error) => error.code === "idempotency_adoption_conflict",
  );
  clearSubscribeIdempotencyKey(stableIdentity({ username: "renamed" }), {
    storage,
  });
  const reusedUsername = subscribeIdempotencyHeaders(
    stableIdentity({ creatorId: 99, username: "alice" }),
    { storage, mint: () => "22222222-2222-4222-8222-222222222222" },
  );

  assert.equal(afterRename["Idempotency-Key"], beforeRename["Idempotency-Key"]);
  assert.equal(
    reusedUsername["Idempotency-Key"],
    beforeRename["Idempotency-Key"],
  );
});

test("a foreign payer cannot mint while another stable intent is unresolved", () => {
  const storage = fakeStorage();
  const alice = stableIdentity({ payerId: 7 });
  const bob = stableIdentity({ payerId: 8 });
  const aliceKey = subscribeIdempotencyHeaders(alice, { storage })[
    "Idempotency-Key"
  ];
  assert.throws(
    () => subscribeIdempotencyHeaders(bob, { storage }),
    (error) => error.code === "idempotency_adoption_conflict",
  );
  clearSubscribeIdempotencyKey(alice, { storage });
  const bobKey = subscribeIdempotencyHeaders(bob, { storage })[
    "Idempotency-Key"
  ];
  assert.equal(
    subscribeIdempotencyHeaders(bob, { storage })["Idempotency-Key"] ===
      aliceKey,
    false,
  );
});

test("settling an adopted legacy key retires the historical slot for renewal", () => {
  const storage = fakeStorage();
  const legacy = "f2z-legacy-loaded-key";
  storage.setItem("f2z:subscribe-idempotency:alice", legacy);

  const headers = subscribeIdempotencyHeaders(stableIdentity(), {
    storage,
    mint: () => "33333333-3333-4333-8333-333333333333",
  });

  assert.equal(
    headers["Idempotency-Key"],
    "33333333-3333-4333-8333-333333333333",
  );
  assert.equal(headers["X-Superseded-Idempotency-Key"], legacy);
  assert.deepEqual(subscribeIdempotencyHeaders("alice", { storage }), headers);
  assert.equal(
    [...storage.entries()].filter(([, value]) => value === legacy).length,
    2,
  );
  clearSubscribeIdempotencyKey(stableIdentity(), { storage });
  assert.deepEqual(subscribeRecoveryKeys(stableIdentity(), { storage }), []);
  const renewed = subscribeIdempotencyHeaders(stableIdentity(), { storage });
  assert.notEqual(renewed["Idempotency-Key"], headers["Idempotency-Key"]);
  assert.match(renewed["Idempotency-Key"], UUID_V4);
  assert.equal(renewed["X-Superseded-Idempotency-Key"], undefined);
  const ownerName = `f2z:subscribe-idempotency-adoption-owner:${encodeURIComponent(legacy)}`;
  assert.deepEqual(JSON.parse(storage.getItem(ownerName)), {
    creatorId: "42",
    payerId: "7",
    settled: true,
    abandoned: false,
  });
  assert.deepEqual(subscribeRecoveryKeys(stableIdentity(), { storage }), [
    renewed["Idempotency-Key"],
  ]);
});

test("a foreign UUID in the shared legacy slot fails closed", () => {
  const storage = fakeStorage();
  const identity = stableIdentity({ username: "fan", payerUsername: "fan" });
  const foreignKey = "77777777-7777-4777-8777-777777777777";
  storage.setItem("f2z:subscribe-idempotency:fan", foreignKey);
  storage.setItem(
    `f2z:subscribe-idempotency-adoption-owner:${encodeURIComponent(foreignKey)}`,
    JSON.stringify({ creatorId: 42, payerId: 8, settled: false }),
  );

  assert.throws(
    () => subscribeIdempotencyHeaders(identity, { storage }),
    (error) => error.code === "idempotency_adoption_conflict",
  );
  assert.equal(storage.getItem("f2z:subscribe-idempotency:fan"), foreignKey);
});

test("stable subscription refuses a new paid request when quota blocks persistence", () => {
  const storage = {
    getItem: () => null,
    setItem: () => {
      throw new Error("quota");
    },
    removeItem: () => {},
  };

  assert.throws(
    () => subscribeIdempotencyHeaders(stableIdentity(), { storage }),
    (error) =>
      error instanceof SubscriptionIdempotencyStorageError &&
      error.code === "idempotency_storage_unavailable",
  );
});

test("stable subscription fails closed on storage reads and preserves evidence on cleanup failure", () => {
  const unreadable = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {},
    removeItem: () => {},
  };
  assert.throws(
    () =>
      subscribeIdempotencyHeaders(stableIdentity(), { storage: unreadable }),
    (error) => error instanceof SubscriptionIdempotencyStorageError,
  );

  const key = "44444444-4444-4444-8444-444444444444";
  const retained = {
    values: new Map(),
    getItem(name) {
      return this.values.get(name) ?? null;
    },
    setItem(name, value) {
      this.values.set(name, String(value));
    },
    removeItem() {
      throw new Error("blocked remove");
    },
  };
  const identity = stableIdentity();
  subscribeIdempotencyHeaders(identity, { storage: retained, mint: () => key });
  assert.equal(
    clearSubscribeIdempotencyKey(identity, { storage: retained }),
    false,
  );
  assert.throws(
    () => subscribeIdempotencyHeaders(identity, { storage: retained }),
    (error) => error.code === "idempotency_adoption_conflict",
  );
  assert.equal(
    [...retained.values.keys()].some((name) =>
      name.startsWith("f2z:subscribe-idempotency:v2:"),
    ),
    true,
  );
});

test("an existing stable slot cannot hide legacy superseded evidence", () => {
  const storage = fakeStorage();
  const identity = stableIdentity();
  const first = subscribeIdempotencyHeaders(identity, {
    storage,
    mint: () => "66666666-6666-4666-8666-666666666666",
  });
  storage.setItem(
    "f2z:subscribe-idempotency-superseded:alice",
    "f2z-historical-paid",
  );

  const retry = subscribeIdempotencyHeaders(identity, { storage });
  assert.equal(retry["Idempotency-Key"], first["Idempotency-Key"]);
  assert.equal(retry["X-Superseded-Idempotency-Key"], "f2z-historical-paid");
});

test("legacy adoption is globally bound to creator and payer", () => {
  const storage = fakeStorage();
  storage.setItem("f2z:subscribe-idempotency:alice", "f2z-old-paid");
  const owner = stableIdentity({ payerUsername: "fan" });
  subscribeIdempotencyHeaders(owner, { storage });

  assert.throws(
    () =>
      subscribeIdempotencyHeaders(
        stableIdentity({ creatorId: 99, payerUsername: "fan" }),
        { storage },
      ),
    (error) => error.code === "idempotency_adoption_conflict",
  );
  assert.throws(
    () =>
      subscribeIdempotencyHeaders(
        stableIdentity({ payerId: 8, payerUsername: "other" }),
        { storage },
      ),
    (error) => error.code === "idempotency_adoption_conflict",
  );
});

test("legacy payer provenance blocks an ambiguous adoption", () => {
  const storage = fakeStorage();
  storage.setItem("f2z:subscribe-idempotency:alice", "f2z-old-paid");
  storage.setItem("f2z:subscribe-idempotency-payer:alice", "old-payer");

  assert.throws(
    () =>
      subscribeIdempotencyHeaders(
        stableIdentity({ payerUsername: "new-payer" }),
        { storage },
      ),
    (error) => error.code === "idempotency_adoption_conflict",
  );
});

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** One fan paying one creator 5 2Z under their own name. */
const gift = (overrides = {}) => ({
  actor: "fan",
  creator: "alice",
  amount: "5",
  anonymous: false,
  intent: "donation",
  ...overrides,
});

test("donations reuse a key for the exact amount and anonymity intent", () => {
  const storage = fakeStorage();
  const first = donationIdempotencyKey(gift(), { storage });
  const retry = donationIdempotencyKey(gift(), { storage });
  const changedAmount = donationIdempotencyKey(gift({ amount: "6" }), {
    storage,
  });
  const changedVisibility = donationIdempotencyKey(gift({ anonymous: true }), {
    storage,
  });

  assert.equal(retry, first);
  assert.notEqual(changedAmount, first);
  assert.notEqual(changedVisibility, first);
  clearDonationIdempotencyKey(gift(), { storage });
  assert.notEqual(donationIdempotencyKey(gift(), { storage }), first);
});

test("a delayed donation cleanup cannot retire a newer key", () => {
  const storage = fakeStorage();
  const first = donationIdempotencyKey(gift(), { storage });
  const destination = [...storage.entries()].find(
    ([, value]) => value === first,
  )?.[0];
  assert.ok(destination);

  const second = "99999999-9999-4999-8999-999999999999";
  storage.setItem(destination, second);
  clearDonationIdempotencyKey(gift(), { storage, expectedKey: first });

  assert.equal(
    donationIdempotencyKey(gift(), { storage }),
    second,
    "an older response must not clear the newer purchase intent",
  );
});

test("donation and PPV identities cannot cross-replay", () => {
  const storage = fakeStorage();
  const donation = donationIdempotencyKey(gift({ intent: "donation" }), {
    storage,
  });
  const ppv = donationIdempotencyKey(gift({ intent: "ppv" }), { storage });
  assert.notEqual(ppv, donation);
});

//. localStorage is per BROWSER, not per account, and the server scopes
// idempotency to (scope, user, key). Account A donates, the response is lost
// and the key stays as A's only proof a charge may have happened. Account B
// signs in on the same browser and makes the identical donation: with a
// payer-less bucket B reads A's UUID — brand new for B, so B's donation
// succeeds and the client clears the shared entry. A signs back in, retries,
// finds nothing, mints a fresh UUID, and is charged twice.
test("two accounts on one browser never share a donation key, and one's success cannot retire the other's", () => {
  const storage = fakeStorage();
  const alicesKey = donationIdempotencyKey(gift({ actor: "alice" }), {
    storage,
  });

  // Same creator, same amount, same visibility, same product. Different payer.
  const bobsKey = donationIdempotencyKey(gift({ actor: "bob" }), { storage });
  assert.notEqual(bobsKey, alicesKey, "Bob must not read Alice's key");

  // Bob's donation resolves. That retires BOB's handle only.
  clearDonationIdempotencyKey(gift({ actor: "bob" }), { storage });
  assert.equal(
    donationIdempotencyKey(gift({ actor: "alice" }), { storage }),
    alicesKey,
    "Alice's retry must still replay her original charge",
  );
  assert.notEqual(
    donationIdempotencyKey(gift({ actor: "bob" }), { storage }),
    bobsKey,
    "Bob's next donation is a genuinely new purchase",
  );
});

test("the same is true of every other paid intent", () => {
  const storage = fakeStorage();
  const intent = (actor) => ({
    actor,
    action: "comment_vote",
    resource: "comment-1",
    amount: "1",
    intent: "up",
  });
  const alice = intentIdempotencyKey(intent("alice"), { storage });
  const bob = intentIdempotencyKey(intent("bob"), { storage });
  assert.notEqual(bob, alice);
  clearIntentIdempotencyKey(intent("bob"), { storage });
  assert.equal(intentIdempotencyKey(intent("alice"), { storage }), alice);
});

//  /. A key minted before `ensureAuthenticated()` has resolved has
// no payer to name. Defaulting one in ("unknown", "anonymous", "") is exactly
// the double-charge: the pre-hydration click mints under the placeholder, the
// hydrated retry looks in the real user's bucket, finds nothing, and mints
// again. So a missing actor is a loud failure, not a silent bucket.
test("a paid key cannot be minted without the authenticated actor", () => {
  const storage = fakeStorage();
  for (const actor of [undefined, null, ""]) {
    assert.throws(
      () => donationIdempotencyKey(gift({ actor }), { storage }),
      TypeError,
      `donation actor=${JSON.stringify(actor)}`,
    );
    assert.throws(
      () =>
        intentIdempotencyKey(
          { actor, action: "comment_vote", resource: "c", amount: "1" },
          { storage },
        ),
      TypeError,
      `intent actor=${JSON.stringify(actor)}`,
    );
  }
  assert.equal(storage.size, 0, "a refused mint must not persist anything");
  // A key retired for a missing actor is a no-op, never a throw: this runs on
  // the success path, and nothing can exist under that name.
  assert.doesNotThrow(() =>
    clearDonationIdempotencyKey(gift({ actor: undefined }), { storage }),
  );
  assert.doesNotThrow(() =>
    clearIntentIdempotencyKey({ actor: "", action: "x" }, { storage }),
  );
});

//, third finding. `subscribeIdempotencyKey` has discarded a stored value
// the server would reject since; the donation and intent stores accepted
// anything non-empty. A malformed value — storage corruption, an extension, an
// older build — was sent on every attempt, the server answered 400
// `invalid_idempotency_key` every time, and nothing ever cleared it: that
// exact purchase was wedged until the user cleared site data by hand.
test("a stored donation or intent key the server would reject is replaced, not re-sent forever", () => {
  const storage = fakeStorage();
  // Learn the bucket names from a real mint, then poison them.
  const donation = donationIdempotencyKey(gift(), { storage });
  const intentIdentity = {
    actor: "fan",
    action: "comment",
    resource: "/api/comments/",
    amount: "1",
    intent: "x",
  };
  const intent = intentIdempotencyKey(intentIdentity, { storage });
  const names = [];
  for (const [name, value] of storage.entries()) {
    if (value === donation || value === intent) names.push(name);
  }
  assert.equal(names.length, 2, "precondition: both buckets found");

  for (const junk of ["f2z-legacy-key", "not a uuid", "   ", "\u0000"]) {
    for (const name of names) storage.setItem(name, junk);
    const nextDonation = donationIdempotencyKey(gift(), { storage });
    const nextIntent = intentIdempotencyKey(intentIdentity, { storage });
    assert.match(
      nextDonation,
      UUID_V4,
      `donation after ${JSON.stringify(junk)}`,
    );
    assert.match(nextIntent, UUID_V4, `intent after ${JSON.stringify(junk)}`);
    assert.notEqual(nextDonation, junk);
    assert.notEqual(nextIntent, junk);
    // And the replacement is what a retry will now find.
    assert.equal(donationIdempotencyKey(gift(), { storage }), nextDonation);
    assert.equal(intentIdempotencyKey(intentIdentity, { storage }), nextIntent);
  }
});

test("a good stored donation or intent key is kept, not churned", () => {
  const storage = fakeStorage();
  const donation = donationIdempotencyKey(gift(), { storage });
  const intentIdentity = {
    actor: "fan",
    action: "a",
    resource: "r",
    amount: 1,
  };
  const intent = intentIdempotencyKey(intentIdentity, { storage });
  assert.match(donation, UUID_V4);
  assert.match(intent, UUID_V4);
  assert.equal(donationIdempotencyKey(gift(), { storage }), donation);
  assert.equal(intentIdempotencyKey(intentIdentity, { storage }), intent);
});

test("paid intent keys survive remount/reload and clear only by exact identity", () => {
  const storage = fakeStorage();
  const identity = {
    actor: "alice",
    action: "comment",
    resource: "page-1",
    amount: "3",
    intent: "create",
  };
  const first = intentIdempotencyKey(identity, { storage });
  const afterRemount = intentIdempotencyKey({ ...identity }, { storage });
  assert.equal(afterRemount, first);
  assert.notEqual(
    intentIdempotencyKey({ ...identity, amount: "4" }, { storage }),
    first,
  );
  clearIntentIdempotencyKey({ ...identity, amount: "4" }, { storage });
  assert.equal(intentIdempotencyKey(identity, { storage }), first);
  clearIntentIdempotencyKey(identity, { storage });
  assert.notEqual(intentIdempotencyKey(identity, { storage }), first);
});

test("a late paid intent settlement cannot retire a newer key", () => {
  const storage = fakeStorage();
  const identity = {
    actor: "alice",
    action: "ai_image",
    resource: "/api/openai/image",
    amount: "creator-cover",
    intent: "same prompt",
  };
  const first = intentIdempotencyKey(identity, { storage });
  assert.equal(
    clearIntentIdempotencyKey(identity, { storage, expectedKey: first }),
    true,
  );

  const second = intentIdempotencyKey(identity, { storage });
  assert.notEqual(second, first);
  assert.equal(
    clearIntentIdempotencyKey(identity, { storage, expectedKey: first }),
    false,
  );
  assert.equal(storedIntentIdempotencyKey(identity, { storage }), second);
});

test("an ambiguous paid intent retains its original disclosure snapshot across refresh", () => {
  const storage = fakeStorage();
  const identity = {
    actor: "alice",
    action: "ai_image",
    resource: "/api/openai/image",
    amount: "creator-cover",
    intent: JSON.stringify({ choice: "openai-image", prompt: "p", size: "s" }),
  };
  const key = intentIdempotencyKey(identity, { storage });
  assert.equal(
    intentIdempotencySnapshot(identity, key, "snapshot-a", { storage }),
    "snapshot-a",
  );
  assert.equal(
    intentIdempotencySnapshot(identity, key, "snapshot-b", { storage }),
    "snapshot-a",
  );
  clearIntentIdempotencyKey(identity, { storage });
  const nextKey = intentIdempotencyKey(identity, { storage });
  assert.notEqual(nextKey, key);
  assert.equal(
    intentIdempotencySnapshot(identity, nextKey, "snapshot-b", { storage }),
    "snapshot-b",
  );
});

test("starting a new attempt archives the unknown outcome key before minting another", () => {
  const storage = fakeStorage();
  const legacyIdentity = {
    actor: "alice",
    action: "ai_image",
    resource: "/api/openai/image",
    amount: "6",
    intent: JSON.stringify({ prompt: "p", size: "s" }),
  };
  const identity = {
    actor: "alice",
    action: "ai_image",
    resource: "/api/openai/image",
    amount: "creator-cover",
    intent: JSON.stringify({ choice: "openai-image", prompt: "p", size: "s" }),
  };
  const legacyKey = intentIdempotencyKey(legacyIdentity, { storage });
  const unresolved = intentIdempotencyKey(identity, {
    storage,
    supersedes: legacyIdentity,
  });
  assert.equal(unresolved, legacyKey);

  assert.equal(
    archiveUnknownIntentIdempotencyKey(identity, {
      storage,
      supersedes: legacyIdentity,
    }),
    unresolved,
  );
  const next = intentIdempotencyKey(identity, {
    storage,
    supersedes: legacyIdentity,
  });
  assert.notEqual(next, unresolved);
  assert.ok(
    [...storage.entries()].some(
      ([key, value]) =>
        key.endsWith(`:unknown:${unresolved}`) && value === unresolved,
    ),
  );
  assert.equal(
    storedIntentIdempotencyKey(legacyIdentity, { storage }),
    undefined,
  );
});

test("a stale unknown-outcome acknowledgement cannot archive a newer paid key", () => {
  const storage = fakeStorage();
  const identity = {
    actor: "alice",
    action: "ai_image",
    resource: "/api/openai/image",
    amount: "creator-cover",
    intent: JSON.stringify({ choice: "openai-image", prompt: "p", size: "s" }),
  };
  const unknownKey = intentIdempotencyKey(identity, { storage });
  assert.equal(
    archiveUnknownIntentIdempotencyKey(identity, {
      storage,
      expectedKey: unknownKey,
    }),
    unknownKey,
  );

  const newerKey = intentIdempotencyKey(identity, { storage });
  assert.notEqual(newerKey, unknownKey);
  assert.throws(
    () =>
      archiveUnknownIntentIdempotencyKey(identity, {
        storage,
        expectedKey: unknownKey,
      }),
    /active paid intent changed/i,
  );
  assert.equal(storedIntentIdempotencyKey(identity, { storage }), newerKey);
  assert.equal(
    [...storage.entries()].some(([name]) =>
      name.endsWith(`:unknown:${newerKey}`),
    ),
    false,
  );
});

// The adversarial review of  called the earlier 30-minute TTL the riskiest
// line in the change, correctly: the server replays a completed key for any
// amount of time, so elapsed time can only ever turn an UNRESOLVED purchase
// back into a chargeable one. Abort at 15s -> the server commits anyway -> the
// auth refresh that would have revealed it fails -> the user comes back later
// and clicks again. Under a TTL that is a second month of 2Z off the fan.
test("an unresolved purchase keeps its key no matter how much time passes", () => {
  const storage = fakeStorage();
  const first = subscribeIdempotencyKey("alice", { storage });
  // A month later, same tab, nothing ever confirmed the outcome.
  const muchLater = subscribeIdempotencyKey("alice", { storage });
  assert.equal(muchLater, first);
});

test("an empty stored value mints a fresh key instead of sending nothing", () => {
  const storage = fakeStorage();
  storage.setItem("f2z:subscribe-idempotency:alice", "");
  const key = subscribeIdempotencyKey("alice", { storage });
  assert.ok(key.length > 0);
});

//. A key minted before  (`f2z-...`, from any browser without
// `crypto.randomUUID`) can no longer be SENT -- the server answers 400
// `invalid_idempotency_key`. Discarding it and minting a UUID, which is what
// this module used to do, destroys the only evidence that the original charge
// happened, and the retry then buys a second month. It is set aside instead
// and sent as `X-Superseded-Idempotency-Key`, which the server uses to look
// the receipt up (a lookup only -- it never claims and never charges).
test("a legacy stored key is superseded, never discarded", () => {
  const storage = fakeStorage();
  storage.setItem("f2z:subscribe-idempotency:alice", "f2z-legacy-key");
  const key = subscribeIdempotencyKey("alice", { storage });
  assert.match(
    key,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  assert.equal(storage.getItem("f2z:subscribe-idempotency:alice"), key);
  assert.equal(
    supersededSubscribeIdempotencyKey("alice", { storage }),
    "f2z-legacy-key",
    "the unusable key must survive so the server can be asked about it",
  );
});

test("the superseded key is sent alongside its replacement", () => {
  const storage = fakeStorage();
  storage.setItem("f2z:subscribe-idempotency:alice", "f2z-legacy-key");
  const headers = subscribeIdempotencyHeaders("alice", { storage });
  assert.equal(headers["X-Superseded-Idempotency-Key"], "f2z-legacy-key");
  assert.match(
    headers["Idempotency-Key"],
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  // Every retry carries the SAME pair, or the lookup would only work once.
  assert.deepEqual(subscribeIdempotencyHeaders("alice", { storage }), headers);
});

test("no superseded header when there is nothing outstanding", () => {
  const storage = fakeStorage();
  const headers = subscribeIdempotencyHeaders("alice", { storage });
  assert.deepEqual(Object.keys(headers), ["Idempotency-Key"]);
  assert.equal(
    supersededSubscribeIdempotencyKey("alice", { storage }),
    undefined,
  );
});

test("a second unusable key does not overwrite the outstanding one", () => {
  const storage = fakeStorage();
  storage.setItem("f2z:subscribe-idempotency:alice", "f2z-oldest");
  subscribeIdempotencyKey("alice", { storage });
  // Something writes another unusable value over the replacement (a rollback
  // to the pre- bundle in another tab). The FIRST one is the unresolved
  // purchase; losing it is the double charge.
  storage.setItem("f2z:subscribe-idempotency:alice", "f2z-newer");
  subscribeIdempotencyKey("alice", { storage });
  assert.equal(
    supersededSubscribeIdempotencyKey("alice", { storage }),
    "f2z-oldest",
  );
});

test("resolution retires the superseded key too", () => {
  const storage = fakeStorage();
  storage.setItem("f2z:subscribe-idempotency:alice", "f2z-legacy-key");
  subscribeIdempotencyKey("alice", { storage });
  clearSubscribeIdempotencyKey("alice", { storage });
  assert.equal(
    supersededSubscribeIdempotencyKey("alice", { storage }),
    undefined,
  );
  assert.deepEqual(
    Object.keys(subscribeIdempotencyHeaders("alice", { storage })),
    ["Idempotency-Key"],
  );
});

test("a store that refuses mutations stops the paid action", () => {
  const map = new Map([["f2z:subscribe-idempotency:alice", "f2z-stuck"]]);
  const storage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
    removeItem: () => {
      throw new Error("SecurityError");
    },
  };

  assert.throws(
    () => subscribeIdempotencyHeaders("alice", { storage }),
    IdempotencyStorageUnavailable,
  );
});

test("a superseded key is scoped per creator", () => {
  const storage = fakeStorage();
  storage.setItem("f2z:subscribe-idempotency:alice", "f2z-alice");
  subscribeIdempotencyKey("alice", { storage });
  assert.equal(
    supersededSubscribeIdempotencyKey("bob", { storage }),
    undefined,
  );
});

test("missing storage stops a paid action before it can mint a key", () => {
  assert.throws(
    () => subscribeIdempotencyKey("carol", { storage: null }),
    IdempotencyStorageUnavailable,
  );
});

test("an unavailable store is explicit for every paid identity", () => {
  assert.throws(
    () => donationIdempotencyKey(gift(), { storage: null }),
    IdempotencyStorageUnavailable,
  );
  assert.throws(
    () =>
      intentIdempotencyKey(
        { actor: "fan", action: "comment", resource: "c", amount: "1" },
        { storage: null },
      ),
    IdempotencyStorageUnavailable,
  );
});

test("the key is a canonical UUIDv4, the only shape either subscribe route accepts", () => {
  // Both POST /subscribe/ and POST /subscribe-confirmed/ answer 400
  // `invalid_idempotency_key` / `idempotency_key_required` for anything else
  // (contract fixed in ) -- there is no 1..200 character window
  // any more and nothing is truncated.
  const storage = fakeStorage();
  const key = subscribeIdempotencyKey("alice", { storage });
  assert.match(
    key,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(key.length, 36, `bad length: ${key.length}`);
});

test("the mutator's header merge actually puts Idempotency-Key on the request", () => {
  // The generated descriptor for tuzisSubscribeCreate carries no headers, so
  // the caller's options are the only path this header has.
  const headers = mergeRequestHeaders(undefined, {
    "Idempotency-Key": "11111111-2222-3333-4444-555555555555",
  });
  assert.equal(
    headers.get("Idempotency-Key"),
    "11111111-2222-3333-4444-555555555555",
  );
});

/** Whole-line `//` comments removed, so a source assertion is about code. */
function stripLineComments(text) {
  return text.replace(/^[ \t]*\/\/.*$/gm, "");
}

for (const relative of CALL_SITES) {
  test(`${relative} sends Idempotency-Key on the subscribe POST`, () => {
    const source = read(relative);
    assert.match(
      source,
      /subscribeIdempotencyHeaders\(\s*subscriptionIdentity/,
      "the call site must derive a per-purchase key",
    );
    // One helper produces BOTH headers, so a call site cannot send the fresh
    // key and silently drop the retired one -- which is the  double
    // charge. Deriving the key on its own here would reintroduce that.
    assert.doesNotMatch(
      source,
      /subscribeIdempotencyKey\(/,
      "the call site must not build the header pair by hand",
    );
    // The header has to reach tuzisSubscribeConfirmedCreate's THIRD argument
    // (the request options, after the body). Passing `undefined` there --
    // what both call sites did before  -- is the exact bug.
    assert.match(
      source,
      /tuzisSubscribeConfirmedCreate\(\s*(?:creator\.username|submittedCreatorUsername),\s*\{\s*expected_price:\s*expectedPrice,\s*creator_id:\s*(?:creator\.id|submittedCreatorId)\s*\},\s*\{\s*headers:\s*idempotencyHeaders\s*\},/,
      "the key must be passed as a request-options header, not dropped",
    );
    assert.doesNotMatch(
      source,
      /tuzisSubscribeConfirmedCreate\([^)]*\bundefined\b/,
      "no call site may pass undefined request options any more",
    );
    assert.match(
      source,
      /clearSubscribeIdempotencyKey\(subscriptionIdentity,\s*\{\s*expectedKey:\s*idempotencyKey/,
      "a confirmed success must retire the key",
    );
    //  round 3: a key the server PROVED is spent on a settled, different
    // request holds no evidence about this purchase, and keeping it answers
    // 409 to every attempt for the receipt's 365-day horizon. Retire it --
    // and ONLY on that proof, never on a bare mismatch, which may be a charge
    // still committing.
    // Matched with the COMMENTS STRIPPED: a bound on how much text sits
    // between the condition and the call is a bound on how much prose the
    // branch may carry, and this assertion went red once on a comment edit
    // that changed no behaviour at all. The contract is "that branch clears
    // the key", not "the branch is under N characters".
    assert.match(
      stripLineComments(source),
      /code === "idempotency_mismatch" &&[\s\S]{0,40}key_resolved[\s\S]{0,250}clearSubscribeIdempotencyKey\(subscriptionIdentity,\s*\{\s*expectedKey:\s*idempotencyKey/,
      "a proven-settled key must be retired so the fan is not stuck",
    );
    // Resolution, not a clock, is what retires a key. An observed active
    // membership is the same resolution arriving by the other route -- but it
    // proves the purchase RESOLVED, not WHO paid, and localStorage is per
    // browser. So that path goes through the payer-checked helper, never the
    // unconditional clear (codex adversarial review, round 5).
    assert.match(
      stripLineComments(source),
      /if \(isSubscribed\) \{[\s\S]*?retireSubscribeKeyResolvedByMembership\(\s*\{[\s\S]*?creatorId:\s*creator\.id,[\s\S]*?payerId:\s*user\?\.id/,
      "an observed membership must retire the key, and only this payer's",
    );
    // And the key has to carry the payer, or the check above can never pass.
    assert.match(
      source,
      /subscriptionIdentity\s*=\s*\{[\s\S]*?creatorId:\s*creator\.id,[\s\S]*?payerId:\s*user\.id/,
      "the minted key must record the authenticated payer",
    );
    // This is the actual component recovery path, not a helper-only escape
    // hatch: an undecided response captures the creator and price before any
    // await, then calls the authenticated recovery endpoint with those values.
    assert.match(source, /tuzisSubscribeRecoveryCreate\(recoveryCreatorId/);
    assert.match(source, /insufficientFunds = insufficientFundsFromError\(e\)/);
    assert.match(
      source,
      /\{#if isIntentConflict \|\| isUnconfirmed\}/,
      "the recovery action must not mislabel an ordinary insufficient-funds response",
    );
  });
}

//the legacy POST /subscribe/ carries no price, so a creator who
// raises theirs between the dialog rendering and the click is paid the new
// amount while the fan confirmed the old one. Both surfaces now use the
// confirmed route and send the price they RENDERED as `expected_price`; the
// server binds the debit to it under the creator row lock and answers
// 409 `price_changed` (with `current_price`) instead of charging anything
// else. These are source assertions for the same reason as above: the click
// path needs a session and a real dialog.
for (const relative of CALL_SITES) {
  test(`${relative} binds the debit to the price it rendered (#1584)`, () => {
    const source = read(relative);
    assert.doesNotMatch(
      source,
      /tuzisSubscribeCreate\b/,
      "the legacy price-less subscribe POST must not be called from the UI",
    );
    // `expectedPrice` is the rendered `price`, captured before the request;
    // a re-read at send time would be the very thing the issue describes.
    assert.match(
      source,
      /const expectedPrice = price;/,
      "expected_price must be the rendered price, captured before the call",
    );
    // A 409 price_changed must re-show the server's current price and ask
    // for a fresh confirmation, never retry on the fan's behalf.
    assert.match(source, /code === "price_changed"/);
    assert.match(source, /currentPrice = String\(e\.data\.current_price\)/);
    assert.match(source, /priceChangedFrom = expectedPrice/);
    assert.match(source, /profile\.subscribe\.priceChanged/);
    // The rendered price is what the dialog shows AND what gets sent, so the
    // server's current price has to flow back into the same binding.
    assert.match(source, /price = .*currentPrice \?\? creator\.member_price/);
    // Undecided outcomes get the abort-path treatment: "check, do not click".
    assert.match(source, /code === "request_in_progress"/);
    assert.match(source, /code === "idempotency_mismatch"/);
    // Closing the dialog drops the server-supplied price so a reopen starts
    // from the page's own data again.
    assert.match(
      source,
      /if \(!nextOpen\) \{[^}]*currentPrice = null;[^}]*priceChangedFrom = null;/,
    );
  });
}

test("every locale carries the price-changed copy, and none of it calls 2Z money", () => {
  for (const locale of ["en", "es", "fr", "pt-BR"]) {
    const messages = JSON.parse(read(`src/lib/locales/${locale}.json`));
    const copy = messages.profile.subscribe.priceChanged;
    assert.equal(typeof copy, "string", locale);
    assert.match(copy, /\{previous\}/, locale);
    assert.match(copy, /\{current\}/, locale);
    assert.match(copy, /2Z/, locale);
    // 2Z are platform credits. (money / dinero / argent / dinheiro)
    assert.doesNotMatch(copy, /money|dinero|argent|dinheiro/i, locale);
  }
});

test("orval still emits nothing for the Idempotency-Key header parameter", () => {
  // Guard against a false sense of safety: if a future orval learns to model
  // `in: header` parameters, this test fails and whoever bumps it should move
  // the header onto the generated signature and delete the manual plumbing.
  // Until then, regenerating the client provably does NOT send this header --
  // which is why  could land "complete" and still be unreachable.
  const generated = read("src/lib/api/tuzis/tuzis.ts");
  for (const fn of ["tuzisSubscribeCreate", "tuzisSubscribeConfirmedCreate"]) {
    const createFn = generated.slice(
      generated.indexOf(`export const ${fn} = (`),
    );
    const body = createFn.slice(
      0,
      createFn.indexOf(
        `export const get${fn[0].toUpperCase()}${fn.slice(1)}MutationOptions`,
      ),
    );
    assert.ok(body.length > 0, `${fn} not found in the generated client`);
    assert.doesNotMatch(
      body,
      /Idempotency/i,
      `orval now emits the header parameter for ${fn}; simplify the call sites`,
    );
  }
});

// Renaming a bucket abandons every unresolved payment in the old one (codex
// adversarial review of this branch, HIGH). The fan whose 5 2Z committed and
// whose response was lost reloads into the new build, retries, and — with no
// migration — is minted a fresh UUID the server has never seen, so it charges
// them a second time. The rename must carry those keys across.
//
// It is a COPY with a per-payer one-shot mark, not a move: a move takes retry
// protection away from a tab still running the OLD build (mid-deploy that tab
// reads the old name), and a mark keyed to the payer stops the same payer
// adopting a spent UUID a second time — which the server answers with the old
// receipt, i.e. a donation that reports success and takes no money.
const LEGACY_DONATION_NAME = "f2z:donation-idempotency:donation:alice:5:named";
const A_STORED_KEY = "6f0a1b2c-3d4e-4f50-8a9b-0c1d2e3f4a5b";

test("an unresolved payment minted by the pre-#1589 build is adopted, not abandoned", () => {
  const storage = fakeStorage();
  storage.setItem(LEGACY_DONATION_NAME, A_STORED_KEY);

  const key = donationIdempotencyKey(gift(), { storage });
  assert.equal(
    key,
    A_STORED_KEY,
    "the pre-upgrade handle must be the one the retry sends, or the retry is a second charge",
  );
  assert.equal(donationIdempotencyKey(gift(), { storage }), A_STORED_KEY);
  // The old entry SURVIVES: a tab still running the old build reads that name
  // and its own retry must still replay rather than mint.
  assert.equal(
    storage.getItem(LEGACY_DONATION_NAME),
    A_STORED_KEY,
    "a still-open older tab lost its only retry handle",
  );
});

test("a settled payment can never re-adopt the pre-#1589 key", () => {
  const storage = fakeStorage();
  storage.setItem(LEGACY_DONATION_NAME, A_STORED_KEY);
  donationIdempotencyKey(gift(), { storage });
  clearDonationIdempotencyKey(gift(), { storage });
  assert.notEqual(
    donationIdempotencyKey(gift(), { storage }),
    A_STORED_KEY,
    "a spent UUID must never be handed to the next payment",
  );
  // Still not deleted — the older build's tab keeps its handle.
  assert.equal(storage.getItem(LEGACY_DONATION_NAME), A_STORED_KEY);
});

test("settling marks the key that settled, not whatever the old name holds now", () => {
  // The old-build tab keeps writing to the payer-less name. Settle K1; that
  // tab then mints K2 for a SECOND donation whose response is lost. A mark
  // that recorded "whatever is in the old bucket" would record K2, so the
  // reload would skip a genuinely unresolved payment and charge it again
  // (codex adversarial review, HIGH).
  const storage = fakeStorage();
  storage.setItem(LEGACY_DONATION_NAME, A_STORED_KEY);
  assert.equal(donationIdempotencyKey(gift(), { storage }), A_STORED_KEY);

  const K2 = "11111111-2222-4333-8444-555555555555";
  storage.setItem(LEGACY_DONATION_NAME, K2);
  clearDonationIdempotencyKey(gift(), { storage });

  assert.equal(
    donationIdempotencyKey(gift(), { storage }),
    K2,
    "an unresolved payment from the older tab was marked spent by another payment's settlement",
  );
});

test("legacy settlement keeps the destination when its spent marker cannot be written", () => {
  const map = new Map([[LEGACY_DONATION_NAME, A_STORED_KEY]]);
  const currentName = `f2z:donation-idempotency:${encodeURIComponent(JSON.stringify({ actor: "fan", creator: "alice", amount: "5", anonymous: false, intent: "donation" }))}`;
  const marker = `${LEGACY_DONATION_NAME}:adopted:fan`;
  const storage = faultStorage(map, {
    failWrite: (key) => key === marker,
  });

  assert.equal(donationIdempotencyKey(gift(), { storage }), A_STORED_KEY);
  assert.throws(
    () => clearDonationIdempotencyKey(gift(), { storage }),
    IdempotencyStorageCleanupFailed,
  );
  assert.equal(
    map.get(currentName),
    A_STORED_KEY,
    "the active destination must remain the reload-safe receipt reference",
  );

  // Simulate a reload after storage recovers. The outstanding receipt is
  // still replayable; it is never replaced by a fresh key.
  const recovered = faultStorage(map);
  assert.equal(
    donationIdempotencyKey(gift(), { storage: recovered }),
    A_STORED_KEY,
  );
  clearDonationIdempotencyKey(gift(), { storage: recovered });
  assert.notEqual(
    donationIdempotencyKey(gift(), { storage: recovered }),
    A_STORED_KEY,
  );
});

test("legacy settlement surfaces selective marker reads and recovers without key reuse", () => {
  const map = new Map([[LEGACY_DONATION_NAME, A_STORED_KEY]]);
  const currentName = `f2z:donation-idempotency:${encodeURIComponent(JSON.stringify({ actor: "fan", creator: "alice", amount: "5", anonymous: false, intent: "donation" }))}`;
  const marker = `${LEGACY_DONATION_NAME}:adopted:fan`;
  let failRead = false;
  let failWrite = false;
  const storage = faultStorage(map, {
    failRead: (key) => failRead && key === marker,
    failWrite: (key) => failWrite && key === marker,
  });

  assert.equal(donationIdempotencyKey(gift(), { storage }), A_STORED_KEY);
  failRead = true;
  assert.throws(
    () => clearDonationIdempotencyKey(gift(), { storage }),
    IdempotencyStorageCleanupFailed,
  );
  assert.equal(map.get(currentName), A_STORED_KEY);

  failRead = false;
  failWrite = true;
  assert.throws(
    () => clearDonationIdempotencyKey(gift(), { storage }),
    IdempotencyStorageCleanupFailed,
  );
  assert.equal(map.get(currentName), A_STORED_KEY);

  failWrite = false;
  clearDonationIdempotencyKey(gift(), { storage });
  assert.notEqual(donationIdempotencyKey(gift(), { storage }), A_STORED_KEY);
});

test("adoption never inherits a value the server would reject", () => {
  const storage = fakeStorage();
  storage.setItem(LEGACY_DONATION_NAME, "f2z-legacy-shape");
  const key = donationIdempotencyKey(gift(), { storage });
  assert.match(key, UUID_V4);
  assert.notEqual(key, "f2z-legacy-shape");
});

test("the payer-less pre-#1589 key is adopted by BOTH accounts, independently", () => {
  const storage = fakeStorage();
  storage.setItem(LEGACY_DONATION_NAME, A_STORED_KEY);
  // The server scopes idempotency to (scope, user, key), so the same UUID in
  // two accounts' buckets is two independent keys — and each account's
  // unresolved pre-upgrade payment keeps a handle.
  assert.equal(
    donationIdempotencyKey(gift({ actor: "carol" }), { storage }),
    A_STORED_KEY,
  );
  assert.equal(
    donationIdempotencyKey(gift({ actor: "fan" }), { storage }),
    A_STORED_KEY,
  );
  // And Carol settling cannot touch the fan's.
  clearDonationIdempotencyKey(gift({ actor: "carol" }), { storage });
  assert.equal(
    donationIdempotencyKey(gift({ actor: "fan" }), { storage }),
    A_STORED_KEY,
    "one account's success retired another account's retry handle",
  );
  assert.notEqual(
    donationIdempotencyKey(gift({ actor: "carol" }), { storage }),
    A_STORED_KEY,
    "Carol's next donation must be a genuinely new purchase",
  );
});

test("a failed adoption write stops instead of falling back to memory", () => {
  const identity = gift({ creator: "quota-alice" });
  const legacyName = "f2z:donation-idempotency:donation:quota-alice:5:named";
  const map = new Map([[legacyName, A_STORED_KEY]]);
  const readOnly = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: () => {
      throw new DOMException("QuotaExceededError");
    },
    removeItem: (k) => map.delete(k),
  };
  const originalWindow = globalThis.window;
  globalThis.window = /** @type {any} */ ({});
  try {
    assert.throws(
      () => donationIdempotencyKey(identity, { storage: readOnly }),
      IdempotencyStorageUnavailable,
    );
    assert.deepEqual(
      [...map.keys()],
      [legacyName],
      "nothing durable may have been written",
    );
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test("a widened intent identity adopts the superseded one's unresolved key, once", () => {
  const storage = fakeStorage();
  const superseded = {
    actor: "owner",
    action: "translation",
    resource: "hello|es",
    amount: "3",
    intent: "ai_translation",
  };
  const widened = { ...superseded, resource: "hello|es|digest-a" };

  const before = intentIdempotencyKey(superseded, { storage });
  const after = intentIdempotencyKey(widened, {
    storage,
    supersedes: superseded,
  });
  assert.equal(
    after,
    before,
    "the pre-upgrade purchase must keep its handle across the rename",
  );
  assert.equal(
    intentIdempotencyKey(widened, { storage, supersedes: superseded }),
    before,
    "the adoption is stable",
  );
  // An outstanding pre-upgrade key stays adoptable by whichever revision asks
  // for it, deliberately. Blocking a second bucket meant a bucket whose own
  // outcome was never learned — the 409 lost, or the request never sent —
  // permanently stopped the revision the key was really bought for from
  // replaying it, and that already-paid purchase was charged again (codex
  // adversarial review, HIGH). The cost of allowing it is a replayed receipt,
  // never a second debit.
  assert.equal(
    intentIdempotencyKey(
      { ...widened, resource: "hello|es|digest-b" },
      { storage, supersedes: superseded },
    ),
    before,
    "an unresolved pre-upgrade key must stay available to the revision it was bought for",
  );
});

test("stored intent keys can be inspected without minting before legacy replay", () => {
  const storage = fakeStorage();
  const legacy = {
    actor: "alice",
    action: "ai_image",
    resource: "/api/openai/image",
    amount: "6",
    intent: JSON.stringify({ prompt: "fixture", size: "1536x1024" }),
  };
  const choiceAware = {
    ...legacy,
    amount: "creator-cover",
    intent: JSON.stringify({
      choice: "openai-image",
      prompt: "fixture",
      size: "1536x1024",
    }),
  };

  assert.equal(storedIntentIdempotencyKey(legacy, { storage }), undefined);
  const legacyKey = intentIdempotencyKey(legacy, { storage });
  assert.equal(storedIntentIdempotencyKey(legacy, { storage }), legacyKey);
  assert.equal(
    intentIdempotencyKey(choiceAware, { storage, supersedes: legacy }),
    legacyKey,
  );
  assert.equal(
    storedIntentIdempotencyKey(legacy, { storage }),
    legacyKey,
    "the old identity remains available to identify an adopted legacy retry",
  );
});

test("an unresolved adoption elsewhere cannot strand the revision that was paid for", () => {
  // The exact sequence: an older build bought revision A with K and lost the
  // response. After the upgrade the creator tries revision B, which adopts K,
  // and B's mismatch answer is ALSO lost — so nothing ever releases it. They
  // restore A and retry: K must still be theirs to replay.
  const storage = fakeStorage();
  const superseded = {
    actor: "owner",
    action: "translation",
    resource: "hello|es",
    amount: "3",
    intent: "ai_translation",
  };
  const forA = { ...superseded, resource: "hello|es|digest-a" };
  const forB = { ...superseded, resource: "hello|es|digest-b" };

  const K = intentIdempotencyKey(superseded, { storage });
  assert.equal(
    intentIdempotencyKey(forB, { storage, supersedes: superseded }),
    K,
  );
  // No clear of any kind: B's outcome was never learned.
  assert.equal(
    intentIdempotencyKey(forA, { storage, supersedes: superseded }),
    K,
    "the already-paid revision was made to mint a fresh key, i.e. charged twice",
  );
});

test("clearing a widened intent identity marks the superseded key spent", () => {
  const storage = fakeStorage();
  const superseded = {
    actor: "owner",
    action: "translation",
    resource: "hello|es",
    amount: "3",
    intent: "ai_translation",
  };
  const widened = { ...superseded, resource: "hello|es|digest-a" };
  // The real flow: an older build minted it, this build adopts it, the
  // purchase settles.
  const key = intentIdempotencyKey(superseded, { storage });
  assert.equal(
    intentIdempotencyKey(widened, { storage, supersedes: superseded }),
    key,
  );
  clearIntentIdempotencyKey(widened, { storage, supersedes: superseded });
  assert.notEqual(
    intentIdempotencyKey(widened, { storage, supersedes: superseded }),
    key,
    "a settled purchase must not leave its used UUID for the next one",
  );
  // The old name still holds it, for a tab still running that build.
  assert.equal(storage.getItem(intentNameOf(superseded)), key);
});

test("generic intent adoption keeps its destination through settlement storage failure", () => {
  const superseded = {
    actor: "owner",
    action: "translation",
    resource: "hello|es",
    amount: "3",
    intent: "ai_translation",
  };
  const widened = { ...superseded, resource: "hello|es|digest-a" };
  const source = intentNameOf(superseded);
  const marker = `${source}:adopted:owner`;
  const destination = intentNameOf(widened);
  const map = new Map();
  let failWrite = true;
  const storage = faultStorage(map, {
    failWrite: (key) => failWrite && key === marker,
  });

  const key = intentIdempotencyKey(superseded, { storage });
  assert.equal(
    intentIdempotencyKey(widened, { storage, supersedes: superseded }),
    key,
  );
  assert.throws(
    () =>
      clearIntentIdempotencyKey(widened, {
        storage,
        supersedes: superseded,
      }),
    IdempotencyStorageCleanupFailed,
  );
  assert.equal(map.get(destination), key);

  // A fresh module instance/reload still replays the adopted key. Once the
  // marker can be written, settlement removes only the destination bucket.
  failWrite = false;
  const recovered = faultStorage(map);
  assert.equal(
    intentIdempotencyKey(widened, {
      storage: recovered,
      supersedes: superseded,
    }),
    key,
  );
  clearIntentIdempotencyKey(widened, {
    storage: recovered,
    supersedes: superseded,
  });
  assert.notEqual(
    intentIdempotencyKey(widened, {
      storage: recovered,
      supersedes: superseded,
    }),
    key,
  );
});

/** The storage name this module gives an intent identity. */
function intentNameOf(identity) {
  return `f2z:intent:${encodeURIComponent(
    JSON.stringify({
      actor: identity.actor,
      action: identity.action,
      resource: identity.resource,
      amount: String(identity.amount),
      intent: identity.intent ?? "charge",
    }),
  )}`;
}

test("an ordinary settlement never resurrects a spent legacy key", () => {
  // Four successive settled donations of the same shape returned K1, K2, K1,
  // K3 before this (codex adversarial review, HIGH): settling K2 overwrote the
  // record that K1 had been consumed, so the third donation adopted K1 again
  // and was answered with its receipt — a receipt for money that never moved.
  const storage = fakeStorage();
  storage.setItem(LEGACY_DONATION_NAME, A_STORED_KEY);
  const settledKeys = [];
  for (let round = 0; round < 4; round += 1) {
    settledKeys.push(donationIdempotencyKey(gift(), { storage }));
    clearDonationIdempotencyKey(gift(), { storage });
  }
  assert.equal(settledKeys[0], A_STORED_KEY, "the first adopts, as it should");
  assert.equal(
    new Set(settledKeys).size,
    4,
    `a spent key was handed out twice: ${settledKeys.join(", ")}`,
  );
});

test("a 409 mismatch releases the adoption instead of retiring the key", () => {
  // An old build bought revision A with K and lost the response. The article
  // moves to B; this build adopts K into B's bucket; the server answers 409
  // because K belongs to A. Treating that as a settlement retires K for good,
  // so restoring A and retrying mints a fresh key and charges the original
  // purchase a second time (codex adversarial review, HIGH).
  const storage = fakeStorage();
  const superseded = {
    actor: "owner",
    action: "translation",
    resource: "hello|es",
    amount: "3",
    intent: "ai_translation",
  };
  const forA = { ...superseded, resource: "hello|es|digest-a" };
  const forB = { ...superseded, resource: "hello|es|digest-b" };

  const K = intentIdempotencyKey(superseded, { storage });
  assert.equal(
    intentIdempotencyKey(forB, { storage, supersedes: superseded }),
    K,
  );

  // 409: the server refused to associate K with revision B.
  clearIntentIdempotencyKey(forB, {
    storage,
    supersedes: superseded,
    unresolved: true,
  });

  assert.equal(
    intentIdempotencyKey(forA, { storage, supersedes: superseded }),
    K,
    "the revision this key was actually bought for must still be able to replay it",
  );
  // And once it really settles, it is spent for good.
  clearIntentIdempotencyKey(forA, { storage, supersedes: superseded });
  assert.notEqual(
    intentIdempotencyKey(forA, { storage, supersedes: superseded }),
    K,
  );
});

test("a released key is not re-adopted by the bucket the server refused it for", () => {
  // Releasing the adoption is what lets revision A replay K. Without a record
  // of the refusal, revision B simply adopts K again on the next click and
  // collects the same 409 forever (codex adversarial review, MEDIUM).
  const storage = fakeStorage();
  const superseded = {
    actor: "owner",
    action: "translation",
    resource: "hello|es",
    amount: "3",
    intent: "ai_translation",
  };
  const forB = { ...superseded, resource: "hello|es|digest-b" };

  const K = intentIdempotencyKey(superseded, { storage });
  assert.equal(
    intentIdempotencyKey(forB, { storage, supersedes: superseded }),
    K,
  );
  clearIntentIdempotencyKey(forB, {
    storage,
    supersedes: superseded,
    unresolved: true,
  });

  const retry = intentIdempotencyKey(forB, { storage, supersedes: superseded });
  assert.notEqual(retry, K, "B adopted the refused key again: another 409");
  assert.match(retry, UUID_V4);
  assert.equal(
    intentIdempotencyKey(forB, { storage, supersedes: superseded }),
    retry,
    "and B's own new key is stable",
  );
});

test("a refusal never erases another revision's settlement record", () => {
  // A and B both adopt the outstanding legacy key K. A replays its completed
  // purchase and marks K spent. B's 409 then arrives. If that refusal deleted
  // the settlement record, a genuinely new purchase for A would adopt K again
  // and be handed the old completed job (codex adversarial review, MEDIUM).
  const storage = fakeStorage();
  const superseded = {
    actor: "owner",
    action: "translation",
    resource: "hello|es",
    amount: "3",
    intent: "ai_translation",
  };
  const forA = { ...superseded, resource: "hello|es|digest-a" };
  const forB = { ...superseded, resource: "hello|es|digest-b" };

  const K = intentIdempotencyKey(superseded, { storage });
  assert.equal(
    intentIdempotencyKey(forB, { storage, supersedes: superseded }),
    K,
  );
  assert.equal(
    intentIdempotencyKey(forA, { storage, supersedes: superseded }),
    K,
  );

  clearIntentIdempotencyKey(forA, { storage, supersedes: superseded });
  clearIntentIdempotencyKey(forB, {
    storage,
    supersedes: superseded,
    unresolved: true,
  });

  assert.notEqual(
    intentIdempotencyKey(forA, { storage, supersedes: superseded }),
    K,
    "a spent key was adopted again: the next purchase gets the old job back",
  );
});

//  (owner decision 2026-10-06) replaced the  "no membership price"
// gate: `member_price` is NOT NULL and 0 is a FREE membership, which the
// confirmed route accepts (`expected_price` min_value=0) and settles with no
// 2Z moving. Both surfaces therefore offer a free follow at 0 instead of
// refusing to sell, and the dead "has not set a price" path is gone.
for (const relative of CALL_SITES) {
  test(`${relative} offers a free follow for a creator whose price is 0`, () => {
    const source = read(relative);
    // 0 is free, decided on the price itself.
    assert.match(
      source,
      /isFree\s*=\s*(\$derived\()?compareDecimalText\(price,\s*"0"\)\s*<=\s*0/,
      "a price of 0 must be recognised as a free membership",
    );
    // The purchase button is still gated on affordability (true at 0), so
    // the free follow reaches the confirmed route with expected_price "0".
    assert.match(
      source,
      /\{#if canAfford && !isIntentConflict && !isUnconfirmed\}/,
      "the follow/subscribe button must stay behind the affordability gate",
    );
    // The fan is told it is free, in their own language.
    assert.match(
      source,
      /profile\.subscribe\.followFree/,
      "a free membership must read as a free follow",
    );
    // An insufficient-funds notice for a price of 0 is nonsense.
    assert.match(
      source,
      /!isFree && \(!canAfford \|\| insufficientFunds\)/,
      "no insufficient-funds notice for a free membership",
    );
    // The dead no-price path is gone.
    assert.doesNotMatch(source, /profile\.subscribe\.noPrice|hasMemberPrice/);
  });
}

test("every locale explains a free membership", () => {
  for (const locale of ["en", "es", "fr", "pt-BR"]) {
    const messages = JSON.parse(read(`src/lib/locales/${locale}.json`));
    const subscribe = messages.profile.subscribe;
    for (const key of ["followFree", "free", "freeDescription"]) {
      assert.equal(typeof subscribe[key], "string", `${locale} ${key}`);
      // Not the serializer's field name.
      assert.doesNotMatch(subscribe[key], /expected_price/, locale);
      // 2Z are platform credits. (money / dinero / argent / dinheiro)
      assert.doesNotMatch(subscribe[key], /money|dinero|argent|dinheiro/i);
    }
    assert.equal(subscribe.noPrice, undefined, `${locale} dead noPrice key`);
  }
});

// Codex adversarial review, round 5. localStorage is per BROWSER, not per
// account, and this store is still named by the creator alone -- the donation
// and intent stores put the payer in the name; migrating this one
// needs an adoption protocol in both bundles and is tracked on. What
// the payer marker closes is the half an app-wide membership sweep makes
// reachable with no deliberate act by the payer at all.
test("another account's membership cannot retire this fan's outstanding key", () => {
  const storage = fakeStorage();
  const held = subscribeIdempotencyKey("astar", { storage, actor: "alice" });

  // Bob logs in on the same browser, already subscribed to astar.
  retireSubscribeKeyResolvedByMembership("astar", "bob", { storage });

  // Alice's unresolved purchase still has its key, so her retry REPLAYS.
  assert.equal(
    subscribeIdempotencyKey("astar", { storage, actor: "alice" }),
    held,
  );
});

test("the fan's own membership still retires their own key", () => {
  const storage = fakeStorage();
  const held = subscribeIdempotencyKey("astar", { storage, actor: "alice" });

  retireSubscribeKeyResolvedByMembership("astar", "alice", { storage });

  const next = subscribeIdempotencyKey("astar", { storage, actor: "alice" });
  assert.notEqual(next, held);
  // And the superseded slot went with it, as on any other resolution.
  assert.equal(
    supersededSubscribeIdempotencyKey("astar", { storage }),
    undefined,
  );
});

test("a key with no recorded payer is kept, never retired by a membership", () => {
  // What a key minted by an earlier build looks like. Keeping it is the safe
  // direction: it can only replay a charge that happened, and the server's
  // `key_resolved: true` retires it on the next attempt if it is spent.
  const storage = fakeStorage();
  const held = subscribeIdempotencyKey("astar", { storage });

  retireSubscribeKeyResolvedByMembership("astar", "alice", { storage });

  assert.equal(subscribeIdempotencyKey("astar", { storage }), held);
});

test("an anonymous observation retires nothing", () => {
  const storage = fakeStorage();
  const held = subscribeIdempotencyKey("astar", { storage, actor: "alice" });
  for (const actor of [undefined, null, ""]) {
    retireSubscribeKeyResolvedByMembership("astar", actor, { storage });
  }
  assert.equal(
    subscribeIdempotencyKey("astar", { storage, actor: "alice" }),
    held,
  );
});

test("the payer is stamped at mint, never onto a key that was already there", () => {
  // Stamping an existing key with whoever asks next is a guess about who left
  // it -- and guessing "me" is the cross-account deletion all over again.
  const storage = fakeStorage();
  const held = subscribeIdempotencyKey("astar", { storage });
  assert.equal(
    subscribeIdempotencyKey("astar", { storage, actor: "bob" }),
    held,
  );

  retireSubscribeKeyResolvedByMembership("astar", "bob", { storage });

  assert.equal(subscribeIdempotencyKey("astar", { storage }), held);
});

test("a confirmed success still retires the key whoever is watching", () => {
  // The success path IS proof of who paid: the POST carried this account's
  // session. It must stay unconditional.
  const storage = fakeStorage();
  const held = subscribeIdempotencyKey("astar", { storage, actor: "alice" });
  clearSubscribeIdempotencyKey("astar", { storage });
  assert.notEqual(
    subscribeIdempotencyKey("astar", { storage, actor: "alice" }),
    held,
  );
});

// Codex adversarial review, round 6. With localStorage at quota `setItem`
// throws and the value lands in MEMORY, while `removeItem` still succeeds --
// so setting a pre- key aside and then deleting it destroyed the only
// reference to a receipt the fan had already paid for, and the reload the
// abort copy asks for sent no superseded header at all: a second month.
test("a retired key cannot mint a replacement when storage is unavailable", () => {
  const map = new Map();
  const refusesWrites = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: () => {
      throw new DOMException("QuotaExceededError");
    },
    removeItem: (k) => map.delete(k),
  };
  const main = "f2z:subscribe-idempotency:quota-star";
  map.set(main, "f2z-legacy");

  assert.throws(
    () => subscribeIdempotencyKey("quota-star", { storage: refusesWrites }),
    IdempotencyStorageUnavailable,
  );
  // The last durable reference to the paid receipt is still there.
  assert.equal(map.get(main), "f2z-legacy");
  // No paid request was allowed to start, so no headers are produced.
});

test("after a reload, a retired key stranded in the main slot is still offered", () => {
  // A fresh process: the memory fallback is empty and the durable store still
  // holds the retired key where the veto above left it.
  const storage = fakeStorage();
  storage.setItem("f2z:subscribe-idempotency:reloaded-star", "f2z-legacy");

  assert.equal(
    supersededSubscribeIdempotencyKey("reloaded-star", { storage }),
    "f2z-legacy",
  );
  assert.equal(
    subscribeIdempotencyHeaders("reloaded-star", { storage })[
      "X-Superseded-Idempotency-Key"
    ],
    "f2z-legacy",
  );
});

test("a durably superseded key IS removed from the main slot, as before", () => {
  // The veto must not have become "never tidy up": a working store still
  // moves the retired key into its own slot.
  const storage = fakeStorage();
  storage.setItem("f2z:subscribe-idempotency:tidy-star", "f2z-legacy");

  subscribeIdempotencyKey("tidy-star", { storage });

  assert.equal(
    storage.getItem("f2z:subscribe-idempotency:tidy-star") !== "f2z-legacy",
    true,
  );
  assert.equal(
    storage.getItem("f2z:subscribe-idempotency-superseded:tidy-star"),
    "f2z-legacy",
  );
});

test("a nearly-full store cannot overwrite the retired key either", () => {
  // Codex adversarial review, round 7. Vetoing the DELETE is not enough: a
  // store at quota can refuse a NEW entry (the superseded slot) and still
  // accept REPLACING an existing one of similar size (the main slot), so the
  // freshly minted key overwrote the very value the veto had just saved.
  const map = new Map();
  const nearlyFull = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      // Room to replace what is already there, none for anything new.
      if (!map.has(k)) throw new DOMException("QuotaExceededError");
      map.set(k, String(v));
    },
    removeItem: (k) => map.delete(k),
  };
  const main = "f2z:subscribe-idempotency:nearly-full-star";
  map.set(main, "f2z-legacy");

  assert.throws(
    () => subscribeIdempotencyKey("nearly-full-star", { storage: nearlyFull }),
    IdempotencyStorageUnavailable,
  );
  // The paid receipt's key is still the durable value.
  assert.equal(map.get(main), "f2z-legacy");
});

test("a settled purchase does not suppress a later pending legacy UUID", () => {
  const storage = fakeStorage();
  const identity = {
    creatorId: 41,
    payerId: 7,
    username: "later-owner",
    payerUsername: "payer",
  };
  const settled = subscribeIdempotencyKey(identity, { storage });
  clearSubscribeIdempotencyKey(identity, { storage });
  clearSubscribeIdempotencyKey(identity.username, { storage });
  const later = subscribeIdempotencyKey(identity.username, { storage });
  assert.notEqual(later, settled);
  assert.equal(subscribeIdempotencyKey(identity, { storage }), later);
  assert.equal(
    subscribeIdempotencyHeaders(identity, { storage })["Idempotency-Key"],
    later,
  );
});

test("clearing an older subscription key preserves a newer adopted key", () => {
  const storage = fakeStorage();
  const identity = {
    creatorId: 41,
    payerId: 7,
    username: "delayed-owner",
    payerUsername: "payer",
  };
  const destination = `f2z:subscribe-idempotency:v2:${encodeURIComponent(
    JSON.stringify({ creator: "41", payer: "7" }),
  )}`;
  const adoption = `f2z:subscribe-idempotency-adoption:${encodeURIComponent(
    destination,
  )}`;
  const older = "11111111-2222-4333-8444-555555555555";
  const newer = "66666666-7777-4888-8999-000000000000";
  storage.setItem(destination, newer);
  storage.setItem(
    adoption,
    JSON.stringify({ key: newer, keys: [older, newer], settled: false }),
  );
  for (const key of [older, newer]) {
    storage.setItem(
      `f2z:subscribe-idempotency-adoption-owner:${encodeURIComponent(key)}`,
      JSON.stringify({ creatorId: "41", payerId: "7", settled: false }),
    );
  }

  clearSubscribeIdempotencyKey(identity, { storage, key: older });

  assert.equal(storage.getItem(destination), newer);
  assert.deepEqual(JSON.parse(storage.getItem(adoption)).keys, [newer]);
  assert.deepEqual(subscribeRecoveryKeys(identity, { storage }), [newer]);
});

test("clearing the current subscription key retires its adopted aliases", () => {
  const storage = fakeStorage();
  const identity = {
    creatorId: 41,
    payerId: 7,
    username: "current-owner",
    payerUsername: "payer",
  };
  const destination = `f2z:subscribe-idempotency:v2:${encodeURIComponent(
    JSON.stringify({ creator: "41", payer: "7" }),
  )}`;
  const adoption = `f2z:subscribe-idempotency-adoption:${encodeURIComponent(
    destination,
  )}`;
  const older = "11111111-2222-4333-8444-555555555555";
  const current = "66666666-7777-4888-8999-000000000000";
  storage.setItem(destination, current);
  storage.setItem(
    adoption,
    JSON.stringify({ key: current, keys: [older, current], settled: false }),
  );
  for (const key of [older, current]) {
    storage.setItem(
      `f2z:subscribe-idempotency-adoption-owner:${encodeURIComponent(key)}`,
      JSON.stringify({ creatorId: "41", payerId: "7", settled: false }),
    );
  }

  clearSubscribeIdempotencyKey(identity, { storage, key: current });

  assert.equal(storage.getItem(destination), null);
  assert.equal(storage.getItem(adoption), null);
  assert.equal(subscribeRecoveryKeys(identity, { storage }).length, 0);
});

test("old auth cache missing IDs cannot throw or retire a legacy intent", () => {
  const storage = fakeStorage();
  const held = subscribeIdempotencyKey("alice", { storage, actor: "fan" });
  for (const payerId of [undefined, null, ""]) {
    assert.doesNotThrow(() =>
      retireSubscribeKeyResolvedByMembership(
        { creatorId: 42, payerId, username: "alice" },
        undefined,
        { storage },
      ),
    );
  }
  assert.equal(storage.getItem("f2z:subscribe-idempotency:alice"), held);
});

test("verified membership settles a legacy-only intent for a later payer", () => {
  const storage = fakeStorage();
  const held = subscribeIdempotencyKey("alice", { storage, actor: "fan" });
  retireSubscribeKeyResolvedByMembership(
    stableIdentity({ payerUsername: "fan" }),
    7,
    { storage },
  );
  const next = subscribeIdempotencyHeaders(
    stableIdentity({ payerId: 8, payerUsername: "other" }),
    { storage },
  );
  assert.equal(next["Idempotency-Key"], held);
});

for (const scenario of [
  "missing payer",
  "renamed payer",
  "foreign immutable owner",
  "creator reused name",
]) {
  test(`membership preserves legacy evidence with ${scenario}`, () => {
    const storage = fakeStorage();
    const key = subscribeIdempotencyKey("alice", { storage, actor: "fan" });
    const identity = stableIdentity({ username: "fan", payerUsername: "fan" });
    if (scenario === "missing payer")
      storage.removeItem("f2z:subscribe-idempotency-payer:alice");
    if (scenario === "renamed payer") identity.payerUsername = "renamed";
    const ownerName = `f2z:subscribe-idempotency-adoption-owner:${encodeURIComponent(key)}`;
    if (
      scenario === "foreign immutable owner" ||
      scenario === "creator reused name"
    ) {
      storage.setItem(
        ownerName,
        JSON.stringify({
          payerId: scenario === "foreign immutable owner" ? "8" : "7",
          creatorId: scenario === "creator reused name" ? "99" : "42",
          settled: false,
        }),
      );
    }
    const before = [...storage.entries()];
    retireSubscribeKeyResolvedByMembership(identity, 7, { storage });
    assert.deepEqual([...storage.entries()], before);
  });
}

test("immutable ownership permits membership settlement after payer rename", () => {
  const storage = fakeStorage();
  const key = subscribeIdempotencyHeaders(
    stableIdentity({ payerUsername: "fan" }),
    { storage },
  )["Idempotency-Key"];
  retireSubscribeKeyResolvedByMembership(
    stableIdentity({ payerUsername: "renamed" }),
    7,
    { storage },
  );
  assert.equal(
    subscribeIdempotencyHeaders(
      stableIdentity({ payerId: 8, payerUsername: "other" }),
      { storage },
    )["Idempotency-Key"] !== key,
    true,
  );
});

test("another payer's old-tab purchase remains separate after the first payer settles", () => {
  const storage = fakeStorage();
  const alice = stableIdentity({ payerUsername: "alice" });
  const bob = stableIdentity({ payerId: 8, payerUsername: "bob" });
  const first = subscribeIdempotencyHeaders(alice, { storage });
  clearSubscribeIdempotencyKey(alice, { storage });
  // The old bundle reuses this visible UUID; backend receipts are per payer.
  const oldBob = subscribeIdempotencyHeaders("alice", {
    storage,
    actor: "bob",
  });
  assert.notEqual(oldBob["Idempotency-Key"], first["Idempotency-Key"]);
  // Bob's response was lost. Alice's settlement says nothing about Bob, and
  // Bob must not inherit Alice's durable receipt evidence.
  const retry = subscribeIdempotencyHeaders(bob, { storage });
  assert.notEqual(retry["Idempotency-Key"], first["Idempotency-Key"]);
});

test("a settled marker without immutable ownership cannot authorize adoption", () => {
  const storage = fakeStorage();
  const key = "11111111-1111-4111-8111-111111111111";
  storage.setItem("f2z:subscribe-idempotency:alice", key);
  storage.setItem(
    `f2z:subscribe-idempotency-adoption-owner:${key}`,
    JSON.stringify({ settled: true }),
  );
  const before = [...storage.entries()];
  assert.throws(
    () => subscribeIdempotencyHeaders(stableIdentity(), { storage }),
    (error) => error.code === "idempotency_adoption_conflict",
  );
  assert.deepEqual([...storage.entries()], before);
});

test("acknowledging an unknown outcome preserves another tab's legacy paid key", () => {
  const storage = fakeStorage();
  const legacy = {
    actor: "alice",
    action: "ai_image",
    resource: "/api/openai/image",
    amount: "6",
    intent: "legacy-cover",
  };
  const current = { ...legacy, amount: "creator-cover" };
  const currentKey = intentIdempotencyKey(current, { storage });
  const otherKey = intentIdempotencyKey(legacy, { storage });
  intentIdempotencySnapshot(legacy, otherKey, "other-disclosure", { storage });
  archiveUnknownIntentIdempotencyKey(current, {
    storage,
    supersedes: legacy,
    expectedKey: currentKey,
  });
  assert.equal(storedIntentIdempotencyKey(legacy, { storage }), otherKey);
  assert.equal(
    intentIdempotencySnapshot(legacy, otherKey, "new", { storage }),
    "other-disclosure",
  );
  assert.equal(
    [...storage.entries()].some(([name]) =>
      name.endsWith(`:unknown:${otherKey}`),
    ),
    false,
  );
});
