// Per-purchase `Idempotency-Key` for POST /api/tuzis/subscribe/{username}/
// (issues,, ).
//
// WHY THIS EXISTS AT ALL, AND WHY IT IS NOT GENERATED.
// The header is in `f2z.yaml` as an `in: header` parameter, but orval emits
// NOTHING for header parameters — it models path and query parameters only.
// Regenerating the client therefore does not, and cannot, make the browser
// send this header; the call site has to pass it through the request options
// (`SecondParameter<typeof customInstance>`), which `mergeRequestHeaders`
// merges over the generated descriptor. That is the whole user-visible half of
//the backend protection and the CORS allowance both exist, and until
// this module the only client that matters still never sent the header.
//
// WHY A STABLE KEY, NOT A FRESH UUID PER CLICK.
// A fresh UUID per attempt is indistinguishable from no header at all — every
// retry is a new key, so every retry is a new charge. The protection only
// works if the SAME key is reused for every retry of ONE purchase intent.
//
// WHY localStorage AND NOT sessionStorage (adversarial review of ).
// The retry in  is not a function call away; it is whatever the user does
// next, and the abort copy literally tells them to "close and reload this page
// to check". sessionStorage dies with the tab and is not shared between tabs,
// so it would have missed the instruction we ourselves give: close the stuck
// tab, or retry from the tab already open next to it, and a sessionStorage key
// is gone — a fresh UUID, a second charge, the exact  bug.
//
// The cost of localStorage is that an unresolved key outlives the session.
// That is the safe direction (an extra replay never moves money; a missing key
// does), and retirement below closes it in practice: any render that observes
// an active membership drops the key, which happens on the creator's profile
// and stream pages throughout the 30 days a committed purchase bought.
//
// WHY THERE IS NO TIME-BASED EXPIRY (adversarial review of  caught this).
// An earlier draft aged keys out after 30 minutes. That is exactly backwards
// for money: the server replays a completed key verbatim "for any amount of
// time afterwards", so the ONLY thing a clock can do is turn an unresolved
// purchase back into a chargeable one. Concretely — abort at 15s, the server
// commits anyway, the auth refresh that would have revealed it fails, the user
// comes back later and clicks again: with a TTL that is a second month of 2Z
// off the fan's balance, which is the very bug the key exists to prevent.
//
// So the key is retired on RESOLUTION, never on elapsed time:
//   - a confirmed success (`clearSubscribeIdempotencyKey` in the happy path), or
//   - the app observing an active membership for that creator, which is the
//     same fact arriving by a different route (the reconciliation the abort
//     copy tells the user to perform).
// Both call sites do both. Anything unresolved keeps its key, which is the
// safe direction: worst case a later attempt replays a charge that really did
// happen instead of making a second one.
//
// Stable keys are scoped by creator AND payer because localStorage is shared by
// accounts in one browser. Legacy username-keyed slots remain readable only as
// adoption input, so old bundles can still finish an outstanding purchase.

const STORAGE_PREFIX = "f2z:subscribe-idempotency:";

// WHERE A KEY WE CAN NO LONGER SEND GOES.
//
// The stored key is validated as a UUIDv4 because  made that the server's
// enforced rule: anything else is `400 invalid_idempotency_key`, so sending it
// is not an option. But the key shipped by  was `f2z-<base36>-<random>`
// in any browser without `crypto.randomUUID` (Chrome <92, Firefox <95, Safari
// <15.4, or any non-secure context), and those really are outstanding — with
// real receipts behind them, for the server's published 365-day replay
// horizon.
//
// Deleting such a key and minting a fresh UUID, which is what this module did,
// is the WORST available answer on a money path: it destroys the only evidence
// that the earlier charge happened and turns "did my subscribe land?" into a
// second month off the fan's balance. Deleting it is also unnecessary — the
// server cannot accept it as `Idempotency-Key`, but it can still look a
// receipt up under it. So the key is moved here and sent as
// `X-Superseded-Idempotency-Key` alongside its replacement, and it is retired
// on RESOLUTION exactly like the key it replaces, never on a clock.
const SUPERSEDED_STORAGE_PREFIX = "f2z:subscribe-idempotency-superseded:";
const PAYER_STORAGE_PREFIX = "f2z:subscribe-idempotency-payer:";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** @param {unknown} value @returns {boolean} */
function isUuidV4(value) {
  return typeof value === "string" && UUID_V4.test(value);
}

/**
 * A paid action cannot safely proceed without a durable retry handle. A
 * page-local fallback used to make the first click look successful, then lose
 * the key on reload and permit a second debit or a misleading old receipt.
 */
export class IdempotencyStorageUnavailable extends Error {
  constructor(message = "Durable browser storage is unavailable") {
    super(message);
    this.name = "IdempotencyStorageUnavailable";
    this.code = "idempotency_storage_unavailable";
  }
}

/**
 * The paid request has already reached the server, but durable retry evidence
 * could not be settled. Callers must report the request outcome and cleanup
 * problem separately; this is never a pre-request storage failure.
 */
export class IdempotencyStorageCleanupFailed extends IdempotencyStorageUnavailable {
  constructor(message = "Durable payment cleanup failed after success") {
    super(message);
    this.name = "IdempotencyStorageCleanupFailed";
    this.code = "idempotency_storage_cleanup_failed";
  }
}

/** @param {unknown} error @returns {boolean} */
export function isIdempotencyStorageUnavailable(error) {
  const code =
    error !== null && typeof error === "object" && "code" in error
      ? /** @type {{ code?: unknown }} */ (error).code
      : undefined;
  return (
    error instanceof IdempotencyStorageUnavailable ||
    code === "idempotency_storage_unavailable" ||
    code === "idempotency_storage_cleanup_failed"
  );
}

/** @param {unknown} error @returns {boolean} */
export function isIdempotencyStorageCleanupFailure(error) {
  const code =
    error !== null && typeof error === "object" && "code" in error
      ? /** @type {{ code?: unknown }} */ (error).code
      : undefined;
  return (
    error instanceof IdempotencyStorageCleanupFailed ||
    code === "idempotency_storage_cleanup_failed"
  );
}

/** @param {Storage | null} storage @returns {Storage} */
function requireStorage(storage) {
  if (!storage) {
    throw new IdempotencyStorageUnavailable();
  }
  return storage;
}

/**
 * @returns {Storage | null} `localStorage` when it exists, else null.
 *
 * Deliberately NOT write-probed. An earlier version wrote and deleted a probe
 * entry under `${STORAGE_PREFIX}probe` — which is byte-for-byte the storage key
 * of the creator named `probe`, a perfectly legal username. Every call would
 * have destroyed that creator's outstanding key and re-enabled double charges
 * for them specifically. Storage failures are surfaced to the caller; a paid
 * action must not continue with an in-memory retry handle.
 */
function getKeyStorage() {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // Accessing the property itself can throw when storage is blocked.
    return null;
  }
}

/** @param {Storage | null} storage @param {string} name @returns {string | null} */
function readDurable(storage, name) {
  try {
    return requireStorage(storage).getItem(name);
  } catch (error) {
    if (isIdempotencyStorageUnavailable(error)) throw error;
    throw new IdempotencyStorageUnavailable(
      "Durable browser storage could not read the payment retry handle",
    );
  }
}

/** @param {Storage | null} storage @param {string} name @returns {string | null} */
function readSettlement(storage, name) {
  try {
    return requireStorage(storage).getItem(name);
  } catch {
    throw new IdempotencyStorageCleanupFailed(
      "The request reached the server, but durable browser storage could not be read to settle its retry handle",
    );
  }
}

/** @param {Storage | null} storage @param {string} name @param {string} value */
function writeSettlement(storage, name, value) {
  try {
    requireStorage(storage).setItem(name, value);
  } catch {
    throw new IdempotencyStorageCleanupFailed(
      "The request reached the server, but durable browser storage could not record its settlement",
    );
  }
}

/** @param {Storage | null} storage @param {string} name */
function removeSettlement(storage, name) {
  try {
    requireStorage(storage).removeItem(name);
  } catch {
    throw new IdempotencyStorageCleanupFailed(
      "The request reached the server, but durable browser storage could not clear its retry handle",
    );
  }
}

/**
 * @returns {string} A fresh UUIDv4, including browsers without `randomUUID`.
 */
function mintKey() {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof cryptoApi?.getRandomValues === "function") {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

/** A UUIDv4 for one non-subscription paid request intent. */
export function newIdempotencyKey() {
  return mintKey();
}

/**
 * @param {string} username
 * @returns {string}
 */
function storageKey(username) {
  return `${STORAGE_PREFIX}${username}`;
}

/**
 * @param {string} username
 * @returns {string}
 */
function supersededStorageKey(username) {
  return `${SUPERSEDED_STORAGE_PREFIX}${username}`;
}

const STABLE_SUBSCRIBE_PREFIX = `${STORAGE_PREFIX}v2:`;
const STABLE_SUBSCRIBE_ADOPTION_PREFIX = "f2z:subscribe-idempotency-adoption:";
const LEGACY_ADOPTION_OWNER_PREFIX =
  "f2z:subscribe-idempotency-adoption-owner:";

/**
 * A stable subscription identity. Numeric ids are serialized as strings so
 * the Svelte and React bundles address exactly the same localStorage slot.
 * `username` is migration input only; it is never part of the new slot name.
 * @typedef {{ creatorId: string | number, payerId: string | number, username?: string, payerUsername?: string }} SubscribeIdentity
 * @typedef {{ storage?: Storage | null, mint?: () => string }} StableDeps
 */

export class SubscriptionIdempotencyStorageError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "SubscriptionIdempotencyStorageError";
    this.code = "idempotency_storage_unavailable";
  }
}

/** @param {string | number} value @param {string} label */
function stableId(value, label) {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    String(value).length === 0
  ) {
    throw new TypeError(`idempotency key: ${label} id is required`);
  }
  return String(value);
}

/** @param {unknown} value @returns {value is SubscribeIdentity} */
function isStableSubscribeIdentity(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    "creatorId" in value &&
    "payerId" in value
  );
}

/** @param {SubscribeIdentity} identity */
function stableSubscribeStorageKey(identity) {
  return `${STABLE_SUBSCRIBE_PREFIX}${encodeURIComponent(
    JSON.stringify({
      creator: stableId(identity.creatorId, "creator"),
      payer: stableId(identity.payerId, "payer"),
    }),
  )}`;
}

/** @param {string} destination */
function stableSubscribeAdoptionKey(destination) {
  return `${STABLE_SUBSCRIBE_ADOPTION_PREFIX}${encodeURIComponent(destination)}`;
}

/** @param {string} destination */
function stableSubscribeSupersededKey(destination) {
  return `${destination}:superseded`;
}

/** @param {Storage | null} storage @param {string} name */
function stableSubscribeAdoptionState(storage, name) {
  const raw = durableGet(storage, name);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.key === "string") {
      return {
        key: parsed.key,
        keys: Array.isArray(parsed.keys)
          ? parsed.keys.filter(
              /** @param {unknown} key */ (key) => typeof key === "string",
            )
          : [parsed.key],
        settled: parsed.settled === true,
        abandoned: parsed.abandoned === true,
      };
    }
  } catch {
    // Raw markers from the first rollout are pending markers.
  }
  return { key: raw, keys: [raw], settled: false, abandoned: false };
}

/** @param {Storage | null} storage @param {string} name @param {string[]} keys @param {boolean} [settled] */
function writeStableSubscribeAdoption(
  storage,
  name,
  keys,
  settled = false,
  abandoned = false,
) {
  const unique = [...new Set(keys)];
  durableSet(
    storage,
    name,
    JSON.stringify({ key: unique[0], keys: unique, settled, abandoned }),
  );
}

/** @param {Storage | null} storage @param {string} name */
function durableGet(storage, name) {
  if (!storage) {
    throw new SubscriptionIdempotencyStorageError(
      "A durable browser storage area is required before subscribing",
    );
  }
  try {
    return storage.getItem(name);
  } catch {
    throw new SubscriptionIdempotencyStorageError(
      "The subscription retry key could not be read from durable storage",
    );
  }
}

/** @param {Storage | null} storage @param {string} name @param {string} value */
function durableSet(storage, name, value) {
  if (!storage) {
    throw new SubscriptionIdempotencyStorageError(
      "The subscription retry key could not be persisted; this attempt was not sent",
    );
  }
  try {
    storage.setItem(name, value);
  } catch {
    throw new SubscriptionIdempotencyStorageError(
      "The subscription retry key could not be persisted; this attempt was not sent",
    );
  }
}

/** @param {Storage | null} storage @param {string} name */
function durableRemove(storage, name) {
  if (!storage) return false;
  try {
    storage.removeItem(name);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} key */
function legacyAdoptionOwnerKey(key) {
  return `${LEGACY_ADOPTION_OWNER_PREFIX}${encodeURIComponent(key)}`;
}

/** @param {string} message */
function adoptionConflict(message) {
  const error = new SubscriptionIdempotencyStorageError(message);
  error.code = "idempotency_adoption_conflict";
  return error;
}

/** @param {Storage | null} storage @param {SubscribeIdentity} identity @param {string} key */
function ensureLegacyOwnership(storage, identity, key) {
  const ownerName = legacyAdoptionOwnerKey(key);
  const rawOwner = durableGet(storage, ownerName);
  if (rawOwner) {
    try {
      const owner = JSON.parse(rawOwner);
      stableId(owner.creatorId, "recorded creator");
      stableId(owner.payerId, "recorded payer");
      if (owner.abandoned === true) return false;
      if (owner.settled === true) {
        // An old bundle can reuse this still-visible key for another payer
        // or creator. Settlement only resolves the recorded identity.
        return (
          String(owner.creatorId) !== stableId(identity.creatorId, "creator") ||
          String(owner.payerId) !== stableId(identity.payerId, "payer")
        );
      }
      if (
        String(owner.creatorId) !== stableId(identity.creatorId, "creator") ||
        String(owner.payerId) !== stableId(identity.payerId, "payer")
      ) {
        throw adoptionConflict(
          "This legacy subscription intent belongs to another account or creator",
        );
      }
      return true;
    } catch (error) {
      if (error instanceof SubscriptionIdempotencyStorageError) throw error;
      throw adoptionConflict(
        "The legacy subscription intent ownership is invalid",
      );
    }
  }
  // Without immutable owner evidence, a changed payer username is ambiguous:
  // it may be a rename or a different account. Keep the unresolved key and
  // refuse adoption; guessing here could transfer another payer's intent.
  if (identity.username) {
    const legacyPayer = durableGet(
      storage,
      `${PAYER_STORAGE_PREFIX}${identity.username}`,
    );
    if (
      legacyPayer &&
      (!identity.payerUsername || legacyPayer !== identity.payerUsername)
    ) {
      throw adoptionConflict(
        "This legacy subscription intent belongs to another payer",
      );
    }
  }
  return true;
}

/** @param {Storage | null} storage @param {SubscribeIdentity} identity @returns {string[]} */
function legacyEvidence(storage, identity) {
  if (!identity.username) return [];
  const values = [
    durableGet(storage, storageKey(identity.username)),
    durableGet(storage, supersededStorageKey(identity.username)),
  ];
  return /** @type {string[]} */ (
    values.filter((key) => typeof key === "string")
  );
}

/** @param {Storage | null} storage @param {SubscribeIdentity} identity @param {string} key */
function hasKnownForeignPayer(storage, identity, key) {
  try {
    const owner = JSON.parse(
      durableGet(storage, legacyAdoptionOwnerKey(key)) || "null",
    );
    return Boolean(
      owner &&
      stableId(owner.creatorId, "recorded creator") &&
      stableId(owner.payerId, "recorded payer") &&
      String(owner.creatorId) === stableId(identity.creatorId, "creator") &&
      String(owner.payerId) !== stableId(identity.payerId, "payer"),
    );
  } catch {
    return false;
  }
}

/** @param {Storage | null} storage @param {SubscribeIdentity} identity @param {string} key */
function hasUnresolvedForeignPayer(storage, identity, key) {
  if (!hasKnownForeignPayer(storage, identity, key)) return false;
  try {
    const owner = JSON.parse(
      durableGet(storage, legacyAdoptionOwnerKey(key)) || "null",
    );
    return owner?.settled !== true && owner?.abandoned !== true;
  } catch {
    return false;
  }
}

/** @param {Storage | null} storage @param {SubscribeIdentity} identity */
function legacyEvidenceForIdentity(storage, identity) {
  return legacyEvidence(storage, identity).filter((key) => {
    try {
      return ensureLegacyOwnership(storage, identity, key);
    } catch (error) {
      // A known immutable owner belongs to another payer/creator. It is not
      // this identity's receipt and must neither block its stable slot nor be
      // sent as a superseded lookup header. Unknown or malformed ownership
      // remains a hard refusal.
      const code =
        error && typeof error === "object" && "code" in error
          ? error.code
          : undefined;
      if (
        code === "idempotency_adoption_conflict" &&
        hasKnownForeignPayer(storage, identity, key)
      ) {
        return false;
      }
      throw error;
    }
  });
}

/** @param {Storage | null} storage @param {SubscribeIdentity} identity */
function rejectForeignLegacyEvidence(storage, identity) {
  for (const key of legacyEvidence(storage, identity)) {
    if (hasUnresolvedForeignPayer(storage, identity, key)) {
      throw adoptionConflict(
        "This legacy subscription intent belongs to another account",
      );
    }
  }
}

/** @param {string[]} keys */
function uniqueKeys(keys) {
  return [...new Set(keys)];
}

/**
 * Publish one UUID to both generations before any caller may send it.
 * One legacy username slot cannot represent different unresolved owners:
 * refuse that collision until its durable settlement evidence permits reuse.
 * @param {Storage | null} storage
 * @param {SubscribeIdentity} identity
 * @param {string} destination
 * @param {string} adoption
 * @param {string} key
 * @param {string[]} evidence
 */
function publishStableSubscribeKey(
  storage,
  identity,
  destination,
  adoption,
  key,
  evidence,
) {
  const legacyName = identity.username ? storageKey(identity.username) : null;
  const legacy = legacyName ? durableGet(storage, legacyName) : null;
  const oldSupersededName = identity.username
    ? supersededStorageKey(identity.username)
    : null;
  const oldSuperseded = oldSupersededName
    ? durableGet(storage, oldSupersededName)
    : null;
  const superseded = evidence.find((value) => !isUuidV4(value));
  const foreignLegacy =
    legacy && hasKnownForeignPayer(storage, identity, legacy);
  if (
    legacy &&
    legacy !== key &&
    !foreignLegacy &&
    ensureLegacyOwnership(storage, identity, legacy)
  ) {
    if (isUuidV4(legacy) || legacy !== superseded) {
      throw adoptionConflict(
        "A different subscription intent still occupies the legacy slot",
      );
    }
  }
  if (
    oldSuperseded &&
    oldSuperseded !== superseded &&
    !hasKnownForeignPayer(storage, identity, oldSuperseded) &&
    ensureLegacyOwnership(storage, identity, oldSuperseded)
  ) {
    throw adoptionConflict(
      "A different superseded subscription intent is still unresolved",
    );
  }
  const pending = uniqueKeys([...evidence, key]);
  // Persist the chosen UUID FIRST. Any later failed write must recover this
  // identity on retry, even though no request was sent by the failed call.
  durableSet(storage, destination, key);
  for (const value of pending) {
    const owner = durableGet(storage, legacyAdoptionOwnerKey(value));
    if (owner) ensureLegacyOwnership(storage, identity, value);
    durableSet(
      storage,
      legacyAdoptionOwnerKey(value),
      JSON.stringify({
        creatorId: stableId(identity.creatorId, "creator"),
        payerId: stableId(identity.payerId, "payer"),
        settled: false,
      }),
    );
  }
  writeStableSubscribeAdoption(storage, adoption, pending);
  if (superseded) {
    durableSet(storage, stableSubscribeSupersededKey(destination), superseded);
    if (oldSupersededName) durableSet(storage, oldSupersededName, superseded);
  } else if (oldSupersededName && oldSuperseded) {
    // Only positively settled evidence reaches this branch. Old bundles do
    // not understand our marker, so remove their stale forwarding header.
    if (!durableRemove(storage, oldSupersededName)) {
      throw new SubscriptionIdempotencyStorageError(
        "Settled subscription evidence could not be retired",
      );
    }
  }
  if (
    !superseded &&
    durableGet(storage, stableSubscribeSupersededKey(destination))
  ) {
    if (!durableRemove(storage, stableSubscribeSupersededKey(destination))) {
      throw new SubscriptionIdempotencyStorageError(
        "Settled subscription evidence could not be retired",
      );
    }
  }
  if (legacyName && !foreignLegacy) {
    if (identity.username && identity.payerUsername)
      durableSet(
        storage,
        payerStorageKey(identity.username),
        identity.payerUsername,
      );
    const legacyOwner = legacy
      ? durableGet(storage, legacyAdoptionOwnerKey(legacy))
      : null;
    let preserveAbandonedLegacy = false;
    if (legacyOwner) {
      try {
        const parsed = JSON.parse(legacyOwner);
        preserveAbandonedLegacy =
          parsed.abandoned === true &&
          (String(parsed.creatorId) !==
            stableId(identity.creatorId, "creator") ||
            String(parsed.payerId) !== stableId(identity.payerId, "payer"));
      } catch {
        // The ownership checks above already reject malformed provenance.
      }
    }
    if (!preserveAbandonedLegacy) durableSet(storage, legacyName, key);
  }
  return key;
}

/** @param {SubscribeIdentity} identity @param {StableDeps} [deps] */
function stableSubscribeKey(identity, deps = {}) {
  const storage = deps.storage === undefined ? getKeyStorage() : deps.storage;
  // A UUID in the shared pre-adoption slot may be a purchase made by another
  // payer. Filtering it out and minting here would lose the only retry handle
  // and let that payer be charged again after the debounce. Refuse before any
  // new key is published; recovery may still keep foreign evidence private.
  rejectForeignLegacyEvidence(storage, identity);
  const destination = stableSubscribeStorageKey(identity);
  const existing = durableGet(storage, destination);
  const adoption = stableSubscribeAdoptionKey(destination);
  const adopted = stableSubscribeAdoptionState(storage, adoption);
  const pendingSuperseded = durableGet(
    storage,
    stableSubscribeSupersededKey(destination),
  );
  let usableExisting = existing;
  if (existing) {
    const owner = JSON.parse(
      durableGet(storage, legacyAdoptionOwnerKey(existing)) || "null",
    );
    if (owner) {
      if (
        String(owner.creatorId) !== stableId(identity.creatorId, "creator") ||
        String(owner.payerId) !== stableId(identity.payerId, "payer")
      )
        throw adoptionConflict(
          "This subscription intent belongs to another account or creator",
        );
      usableExisting =
        owner.settled !== true && owner.abandoned !== true ? existing : null;
    }
  }
  if (!usableExisting && adopted?.keys?.length) {
    throw adoptionConflict(
      "Resolve the other outstanding subscription attempt before starting a new one",
    );
  }
  const evidence = uniqueKeys([
    ...(adopted?.keys ?? []),
    ...legacyEvidenceForIdentity(storage, identity),
    ...(pendingSuperseded ? [pendingSuperseded] : []),
    ...(existing && !isUuidV4(existing) ? [existing] : []),
  ]).filter((value) => ensureLegacyOwnership(storage, identity, value));
  const key =
    usableExisting && isUuidV4(usableExisting)
      ? usableExisting
      : evidence.find(isUuidV4) || (deps.mint ?? mintKey)();
  return publishStableSubscribeKey(
    storage,
    identity,
    destination,
    adoption,
    key,
    evidence,
  );
}

/** @param {SubscribeIdentity} identity @param {StableDeps} [deps] */
function stableSubscribeHeaders(identity, deps = {}) {
  const storage = deps.storage === undefined ? getKeyStorage() : deps.storage;
  const key = stableSubscribeKey(identity, deps);
  const destination = stableSubscribeStorageKey(identity);
  /** @type {Record<string, string>} */
  const headers = { "Idempotency-Key": key };
  const adopted = stableSubscribeAdoptionState(
    storage,
    stableSubscribeAdoptionKey(destination),
  );
  const legacy = legacyEvidenceForIdentity(storage, identity);
  const superseded = uniqueKeys(
    [
      durableGet(storage, stableSubscribeSupersededKey(destination)),
      ...(adopted?.settled ? [] : (adopted?.keys ?? [])),
      ...(adopted?.settled ? [] : legacy),
    ].filter(Boolean),
  ).find((value) => value !== key && !isUuidV4(value));
  if (superseded && !isUuidV4(superseded)) {
    headers["X-Superseded-Idempotency-Key"] = superseded;
  }
  return headers;
}

/** @param {SubscribeIdentity} identity @param {{ storage?: Storage | null, key?: string, expectedKey?: string }} [deps] */
function stableClearSubscribeKey(identity, deps = {}) {
  const storage = deps.storage === undefined ? getKeyStorage() : deps.storage;
  if (!storage) return false;
  const destination = stableSubscribeStorageKey(identity);
  const adoption = stableSubscribeAdoptionKey(destination);
  let current;
  let adopted;
  try {
    current = durableGet(storage, destination);
    adopted = stableSubscribeAdoptionState(storage, adoption);
  } catch {
    // A cleanup read failure must retain every receipt reference.
    return false;
  }
  const exactKey = deps.key ?? deps.expectedKey;
  const key = exactKey ?? current;
  const clearAllAdopted = exactKey === undefined || current === key;
  if (!key) return true;
  const creatorId = stableId(identity.creatorId, "creator");
  const payerId = stableId(identity.payerId, "payer");
  let owner = null;
  try {
    owner = JSON.parse(
      durableGet(storage, legacyAdoptionOwnerKey(key)) || "null",
    );
  } catch {
    return false;
  }
  if (
    owner &&
    (String(owner.creatorId) !== creatorId || String(owner.payerId) !== payerId)
  )
    return false;
  // A delayed response for an older key may retire that exact key while
  // preserving the current key and every newer adoption entry.
  const retiredKeys = uniqueKeys([
    key,
    ...(clearAllAdopted ? (adopted?.keys ?? []) : []),
  ]);
  const retiredOwners = [];
  for (const candidate of retiredKeys) {
    let candidateOwner;
    try {
      candidateOwner = JSON.parse(
        durableGet(storage, legacyAdoptionOwnerKey(candidate)) || "null",
      );
    } catch {
      return false;
    }
    if (
      candidateOwner &&
      (String(candidateOwner.creatorId) !== creatorId ||
        String(candidateOwner.payerId) !== payerId)
    ) {
      return false;
    }
    retiredOwners.push([candidate, candidateOwner]);
  }
  try {
    for (const [candidate, candidateOwner] of retiredOwners) {
      durableSet(
        storage,
        legacyAdoptionOwnerKey(candidate),
        JSON.stringify({
          ...(candidateOwner ?? {}),
          creatorId,
          payerId,
          settled: true,
          abandoned: false,
        }),
      );
    }
  } catch {
    return false;
  }
  let cleanupComplete = true;
  if (identity.username) {
    try {
      for (const name of [
        supersededStorageKey(identity.username),
        storageKey(identity.username),
      ]) {
        const legacyKey = durableGet(storage, name);
        if (legacyKey && retiredKeys.includes(legacyKey)) {
          if (!durableRemove(storage, name)) return false;
        }
      }
    } catch {
      // Retain evidence when cleanup cannot verify its settled owner.
      cleanupComplete = false;
    }
  }
  if (current === key && !durableRemove(storage, destination)) return false;
  const stableSuperseded = durableGet(
    storage,
    stableSubscribeSupersededKey(destination),
  );
  if (stableSuperseded && retiredKeys.includes(stableSuperseded)) {
    if (!durableRemove(storage, stableSubscribeSupersededKey(destination))) {
      return false;
    }
  }
  if (adopted) {
    const remaining = clearAllAdopted
      ? []
      : adopted.keys.filter(
          /** @param {string} candidate */ (candidate) => candidate !== key,
        );
    if (remaining.length) {
      writeStableSubscribeAdoption(
        storage,
        adoption,
        remaining,
        adopted.settled,
        adopted.abandoned,
      );
    } else if (!durableRemove(storage, adoption)) {
      return false;
    }
  }
  return cleanupComplete;
}

/**
 * Return every durable handle that may belong to this immutable intent.
 * Reading does not adopt or clear anything, so an account switch cannot
 * transfer another payer's receipt into the current account.
 * @param {SubscribeIdentity | string} identity
 * @param {{ storage?: Storage | null, key?: string }} [deps]
 * @returns {string[]}
 */
export function subscribeRecoveryKeys(identity, deps = {}) {
  const storage = deps.storage === undefined ? getKeyStorage() : deps.storage;
  if (!isStableSubscribeIdentity(identity)) {
    return uniqueKeys(
      [
        durableGet(storage, storageKey(identity)),
        durableGet(storage, supersededStorageKey(identity)),
      ].filter((key) => typeof key === "string"),
    );
  }
  const destination = stableSubscribeStorageKey(identity);
  const adoption = stableSubscribeAdoptionState(
    storage,
    stableSubscribeAdoptionKey(destination),
  );
  return uniqueKeys(
    [
      durableGet(storage, destination),
      ...(adoption?.keys ?? []),
      durableGet(storage, stableSubscribeSupersededKey(destination)),
      ...legacyEvidenceForIdentity(storage, identity),
    ].filter((key) => typeof key === "string"),
  ).filter((key) => {
    try {
      const owner = JSON.parse(
        durableGet(storage, legacyAdoptionOwnerKey(key)) || "null",
      );
      if (
        owner &&
        (String(owner.creatorId) !== stableId(identity.creatorId, "creator") ||
          String(owner.payerId) !== stableId(identity.payerId, "payer"))
      ) {
        // Keep foreign evidence durably available for its owning identity, but
        // never send it as a recovery candidate for this payer/creator.
        return false;
      }
      return !(
        owner &&
        String(owner.creatorId) === stableId(identity.creatorId, "creator") &&
        String(owner.payerId) === stableId(identity.payerId, "payer") &&
        (owner.settled === true || owner.abandoned === true)
      );
    } catch {
      return true;
    }
  });
}

/**
 * Record that the server accepted an authenticated abandonment. This is the
 * only local transition that permits another payer to use the shared browser:
 * the server tombstone is durable before this function is called.
 * @param {SubscribeIdentity} identity
 * @param {string} key
 * @param {{ storage?: Storage | null }} [deps]
 */
export function markSubscribeIdempotencyAbandoned(identity, key, deps = {}) {
  const storage = deps.storage === undefined ? getKeyStorage() : deps.storage;
  if (!isStableSubscribeIdentity(identity)) {
    return;
  }
  const keys = subscribeRecoveryKeys(identity, deps);
  if (!keys.includes(key)) return;
  const ownerName = legacyAdoptionOwnerKey(key);
  let owner;
  try {
    owner = JSON.parse(durableGet(storage, ownerName) || "null");
  } catch {
    owner = null;
  }
  if (
    owner &&
    (String(owner.creatorId) !== stableId(identity.creatorId, "creator") ||
      String(owner.payerId) !== stableId(identity.payerId, "payer"))
  )
    return;
  durableSet(
    storage,
    ownerName,
    JSON.stringify({
      ...(owner ?? {}),
      creatorId: stableId(identity.creatorId, "creator"),
      payerId: stableId(identity.payerId, "payer"),
      abandoned: true,
      settled: false,
    }),
  );
  const destination = stableSubscribeStorageKey(identity);
  const adoption = stableSubscribeAdoptionKey(destination);
  const state = stableSubscribeAdoptionState(storage, adoption);
  const remaining = (state?.keys ?? keys).filter(
    /** @param {string} candidate */ (candidate) => candidate !== key,
  );
  if (remaining.length)
    writeStableSubscribeAdoption(storage, adoption, remaining);
  else durableRemove(storage, adoption);
  if (durableGet(storage, destination) === key)
    durableRemove(storage, destination);
  if (durableGet(storage, stableSubscribeSupersededKey(destination)) === key)
    durableRemove(storage, stableSubscribeSupersededKey(destination));
  if (
    identity.username &&
    durableGet(storage, `${STORAGE_PREFIX}${identity.username}`) === key
  )
    durableRemove(storage, `${STORAGE_PREFIX}${identity.username}`);
}

/**
 * The account that MINTED the outstanding key for `username`.
 *
 * localStorage is per browser, not per account, and the subscribe slot is
 * named by the creator alone — so two accounts on one browser share it. The
 * donation and intent stores fixed that by putting the actor in the NAME
 * (see `donationStorageKey`); this store has not been migrated, and
 * doing so needs an adoption protocol in both bundles, tracked on.
 *
 * What this marker closes is the half the migration is not needed for, and
 * the half an app-wide sweep makes reachable without any deliberate act by
 * the payer (codex adversarial review, round 5): account A's purchase loses
 * its response and strands its key; account B logs in already subscribed to
 * that creator; the observed-membership retirement deletes A's key; A's retry
 * mints a fresh one and, past the 60-second debounce, is charged a second
 * month. Retirement BY AN OBSERVED MEMBERSHIP therefore requires proof that
 * the observer is the payer, and absence of proof keeps the key — which is
 * always the safe direction, since a stranded key can no longer wedge a fan
 * (the server's `key_resolved: true` retires it on the next attempt).
 *
 * @param {string} username
 * @returns {string}
 */
function payerStorageKey(username) {
  return `${PAYER_STORAGE_PREFIX}${username}`;
}

/**
 * Set `name` in durable storage. A paid action must stop when this is not
 * possible; remembering the key only in this page is not retry protection.
 *
 * @param {Storage | null} storage
 * @param {string} name
 * @param {string} value
 * @returns {boolean} true when it reached `storage`
 */
function persist(storage, name, value) {
  try {
    requireStorage(storage).setItem(name, value);
    return true;
  } catch (error) {
    if (isIdempotencyStorageUnavailable(error)) throw error;
    throw new IdempotencyStorageUnavailable(
      "Durable browser storage rejected the payment retry handle",
    );
  }
}

/**
 * Set aside a key that can no longer be SENT, so the server can still be
 * asked whether it already paid for this membership. Never overwrites an
 * existing superseded key: the older one is the unresolved purchase.
 *
 * The legacy receipt is copied to durable storage before the original is
 * removed. If that copy cannot be made, this throws and the paid request is
 * stopped; a page-local copy is not a retry guarantee.
 *
 * @param {Storage | null} storage
 * @param {string} username
 * @param {string} unusable
 * @returns {boolean} true when the retired key survives a reload
 */
function supersede(storage, username, unusable) {
  const durableStorage = requireStorage(storage);
  const name = supersededStorageKey(username);
  try {
    if (durableStorage.getItem(name)) return true;
  } catch {
    throw new IdempotencyStorageUnavailable(
      "Durable browser storage cannot read the payment retry handle",
    );
  }
  return persist(durableStorage, name, unusable);
}

/**
 * The `X-Superseded-Idempotency-Key` to send for a subscribe POST, or
 * undefined when there is nothing outstanding.
 *
 * This is a key `subscribeIdempotencyKey` had to replace because the server
 * no longer accepts its format. Sending it costs nothing and can only ever
 * cause a replay of a charge that really happened; NOT sending it is the
 * second charge.
 *
 * @param {string} username creator being subscribed to
 * @param {{ storage?: Storage | null }} [deps] test seam
 * @returns {string | undefined}
 */
export function supersededSubscribeIdempotencyKey(username, deps = {}) {
  const storage = deps.storage === undefined ? getKeyStorage() : deps.storage;
  const durableStorage = requireStorage(storage);
  const name = supersededStorageKey(username);
  try {
    const stored = durableStorage.getItem(name);
    if (stored) return stored;
  } catch {
    throw new IdempotencyStorageUnavailable(
      "Durable browser storage cannot read the payment retry handle",
    );
  }
  // Last resort, and the case `supersede` vetoes a removal for: the retired
  // key is still sitting in the MAIN slot because setting it aside could not
  // be made durable. It is a receipt reference either way, so send it from
  // wherever it actually is rather than not at all.
  try {
    const stranded = durableStorage.getItem(storageKey(username));
    if (stranded && !isUuidV4(stranded)) return stranded;
  } catch {
    throw new IdempotencyStorageUnavailable(
      "Durable browser storage cannot read the payment retry handle",
    );
  }
  return undefined;
}

/**
 * Request headers for one subscribe POST: the key to claim under, plus the
 * retired key to look a receipt up under when one is outstanding.
 *
 * One helper so a call site cannot send the fresh key and silently drop the
 * retired one — which is exactly the double charge  describes.
 *
 * @param {string | SubscribeIdentity} username creator being subscribed to
 * @param {{ storage?: Storage | null, mint?: () => string, actor?: string }} [deps]
 *   test seams, plus the authenticated payer to stamp on a newly minted key
 * @returns {Record<string, string>}
 */
export function subscribeIdempotencyHeaders(username, deps = {}) {
  if (isStableSubscribeIdentity(username)) {
    return stableSubscribeHeaders(username, deps);
  }
  /** @type {Record<string, string>} */
  const headers = {
    "Idempotency-Key": subscribeIdempotencyKey(username, deps),
  };
  const superseded = supersededSubscribeIdempotencyKey(username, deps);
  if (superseded) headers["X-Superseded-Idempotency-Key"] = superseded;
  return headers;
}

/**
 * The `Idempotency-Key` to send for a subscribe POST to `username`.
 *
 * Returns the key already outstanding for that creator when one exists, so a
 * retry replays instead of charging again. Mints and persists a new one
 * otherwise.
 *
 * `deps.actor` is the authenticated payer. It is not part of the storage
 * name (see `payerStorageKey` for why not, and what tracks that), and it is
 * OPTIONAL rather than required as it is for donations: a caller that omits
 * it still gets a working key, it simply cannot later be retired by an
 * observed membership. Refusing to mint would turn a missing actor into a
 * broken purchase, which is worse than a key that lives slightly too long.
 *
 * @param {string | SubscribeIdentity} username creator being subscribed to
 * @param {{ storage?: Storage | null, mint?: () => string, actor?: string }} [deps]
 *   test seams and the authenticated payer; production callers pass the actor
 * @returns {string}
 */
export function subscribeIdempotencyKey(username, deps = {}) {
  if (isStableSubscribeIdentity(username)) {
    return stableSubscribeKey(username, deps);
  }
  const mint = deps.mint ?? mintKey;
  const storage = deps.storage === undefined ? getKeyStorage() : deps.storage;
  const name = storageKey(username);
  // A stored value the server will no longer accept is SET ASIDE, never
  // dropped -- see SUPERSEDED_STORAGE_PREFIX. It is the only evidence the
  // earlier charge happened, and only this store has a use for it.
  const existing = readUsableKey(storage, name, (unusable) =>
    supersede(storage, username, unusable),
  );
  if (existing) return existing;
  const fresh = mintAndStore(storage, name, mint);
  // Stamped only at MINT. Stamping a key that was already there would be a
  // guess about who left it, and guessing "me" is precisely what lets one
  // account retire another's purchase.
  if (typeof deps.actor === "string" && deps.actor) {
    persist(storage, payerStorageKey(username), deps.actor);
  }
  return fresh;
}

/**
 * Retire the key for `username` because THIS fan's membership is active.
 *
 * The other half of retirement, and the half a success handler cannot do: a
 * purchase whose response was lost never reaches it. An observed active
 * membership is the same resolution arriving by the route the "check your
 * subscriptions" copy points at.
 *
 * Unlike a confirmed success, an observed membership is not proof of WHO
 * paid — see `payerStorageKey`. So this retires the key only when the key
 * says it was minted by this actor. No marker (a key from a build before
 * this one) means it is kept.
 *
 * @param {string | SubscribeIdentity} username creator whose membership was observed
 * @param {unknown} actor the authenticated account that observed it
 * @param {{ storage?: Storage | null }} [deps]
 */
export function retireSubscribeKeyResolvedByMembership(
  username,
  actor,
  deps = {},
) {
  if (isStableSubscribeIdentity(username)) {
    // Pre-upgrade auth caches have no immutable payer id. Missing values
    // cannot establish ownership and must not throw during hydration.
    try {
      const payerId = stableId(username.payerId, "payer");
      const creatorId = stableId(username.creatorId, "creator");
      if (actor == null || actor === "" || payerId !== String(actor)) return;
      const storage =
        deps.storage === undefined ? getKeyStorage() : deps.storage;
      if (!storage) return;
      for (const key of new Set(legacyEvidence(storage, username))) {
        if (!key) continue;
        const ownerName = legacyAdoptionOwnerKey(key);
        const rawOwner = durableGet(storage, ownerName);
        if (rawOwner) {
          const owner = JSON.parse(rawOwner);
          if (
            String(owner?.payerId) !== payerId ||
            String(owner?.creatorId) !== creatorId
          )
            continue;
        } else if (
          !username.username ||
          !username.payerUsername ||
          durableGet(storage, payerStorageKey(username.username)) !==
            username.payerUsername
        ) {
          continue;
        }
        // Preserve the legacy receipt, but record verified resolution so a
        // later payer need not adopt it. Immutable ownership wins over names.
        durableSet(
          storage,
          ownerName,
          JSON.stringify({ creatorId, payerId, settled: true }),
        );
      }
      stableClearSubscribeKey(username, deps);
    } catch {
      // Missing identity or unavailable/corrupt provenance never retires it.
    }
    return;
  }
  if (typeof actor !== "string" || !actor) return;
  const storage = deps.storage === undefined ? getKeyStorage() : deps.storage;
  const name = payerStorageKey(username);
  let payer;
  if (!storage) return;
  try {
    payer = storage.getItem(name) ?? undefined;
  } catch {
    // An unreadable store cannot prove who minted the key.
    return;
  }
  if (payer !== actor) return;
  clearSubscribeIdempotencyKey(username, deps);
}

/**
 * Retire the key for `username`. Call ONLY once the purchase is known to have
 * RESOLVED — a confirmed success, or an observed active membership. The next
 * subscribe is then a genuinely new purchase and must not replay this one.
 *
 * Deliberately NOT called on failure: an aborted, 409, network-failed or
 * insufficient-funds attempt is exactly the case the key exists for.
 *
 * @param {string | SubscribeIdentity} username
 * @param {KeyDeps} [deps]
 */
export function clearSubscribeIdempotencyKey(username, deps = {}) {
  if (isStableSubscribeIdentity(username)) {
    return stableClearSubscribeKey(username, deps);
  }
  const storage = deps.storage === undefined ? getKeyStorage() : deps.storage;
  if (deps.expectedKey !== undefined) {
    let current;
    try {
      current = storage?.getItem(storageKey(username));
    } catch {
      return;
    }
    if (current !== deps.expectedKey) return;
  }
  // Both slots, and for the same reason: the superseded key is retired on
  // RESOLUTION too. Leaving it behind would keep asking the server to replay
  // a purchase that is finished — harmless, but it would outlive the receipt
  // and eventually mean nothing. Nothing useful to do if a store throws; a
  // stale key only means the next subscribe replays, the safe direction.
  forget(storage, storageKey(username));
  forget(storage, supersededStorageKey(username));
  forget(storage, payerStorageKey(username));
}

/**
 * Retire stable subscription intents whose active membership was returned by
 * the authenticated-user endpoint. The username list remains for the old
 * bundle contract; new callers pair it with immutable creator ids.
 * @param {readonly string[] | undefined | null} usernames
 * @param {string | number | undefined | null} payerId
 * @param {readonly (string | number)[] | undefined | null} creatorIds
 * @param {string | undefined | null} payerUsername legacy provenance only
 */
export function retireResolvedSubscribeIdempotencyKeys(
  usernames,
  payerId,
  creatorIds,
  payerUsername,
) {
  if (!usernames) return;
  for (const [index, username] of usernames.entries()) {
    if (typeof username !== "string" || !username) continue;
    const creatorId = creatorIds?.[index];
    if (creatorId !== undefined) {
      retireSubscribeKeyResolvedByMembership(
        {
          creatorId,
          payerId: payerId ?? "",
          username,
          payerUsername: payerUsername ?? undefined,
        },
        payerId,
      );
    } else {
      retireSubscribeKeyResolvedByMembership(username, payerId);
    }
  }
}

const DONATION_STORAGE_PREFIX = "f2z:donation-idempotency:";
const INTENT_STORAGE_PREFIX = "f2z:intent:";

/** @typedef {{ storage?: Storage | null, key?: string, expectedKey?: string }} KeyDeps */
/**
 * The complete identity of one paid UI intent. `actor` is the AUTHENTICATED
 * payer — required, never defaulted: localStorage is per
 * browser, not per account, and a key minted under a placeholder actor is a
 * different retry bucket from the one the hydrated retry will look in.
 * @typedef {{ actor: string, action?: string, resource?: string, amount?: string | number | bigint, intent?: string }} IntentIdentity
 */
/**
 * One donation or pay-per-view payment: who pays, to whom, how much, whether
 * their name is shown, and which product (`donation` | `ppv`) it is.
 * @typedef {{ actor: string, creator: string, amount: string | number, anonymous?: boolean, intent?: string }} DonationIdentity
 */

/**
 * The payer's username, or a throw. A paid retry bucket without an actor is
 * the  defect (two accounts on one browser sharing a key, one clearing
 * the other's only proof of a charge) and a bucket keyed on a fallback like
 * "unknown"/"anonymous" is the  defect (the pre-hydration click and the
 * hydrated retry mint different UUIDs, so the retry is a second charge).
 * Refusing here turns a call made before `ensureAuthenticated()` resolved
 * into a loud failure instead of a silent double debit.
 *
 * @param {unknown} actor
 * @returns {string}
 */
function requireActor(actor) {
  if (typeof actor !== "string" || actor.length === 0) {
    throw new TypeError(
      "idempotency key: the authenticated actor is required; derive the key only after ensureAuthenticated() resolved to a user",
    );
  }
  return actor;
}

/**
 * The stored key for `name` when it is one the server will accept, else
 * nothing — and the junk is dropped so it cannot be sent again.
 *
 * `subscribeIdempotencyKey` has done this round four; the donation
 * and intent stores did not (third finding): a malformed value left by
 * storage corruption, an extension or an older build was sent on every
 * attempt, the server answered 400 `invalid_idempotency_key` every time, and
 * nothing ever cleared it — that exact purchase was wedged until the user
 * cleared site data by hand.
 *
 * `onUnusable` is handed that junk BEFORE it is removed, for the one store
 * where "junk" can still be worth something: a subscribe key predating the
 * UUIDv4 rule names a receipt the server can still look up, so the subscribe
 * path sets it aside instead of destroying it. Donation and PPV keys
 * have no such cross-format receipt and pass nothing. Returning `false` from
 * it VETOES the removal -- "I could not put this anywhere that survives a
 * reload, so do not delete the copy that does".
 *
 * @param {Storage | null} storage
 * @param {string} name
 * @param {(unusable: string) => boolean | void} [onUnusable]
 * @returns {string | undefined}
 */
function readUsableKey(storage, name, onUnusable) {
  const durableStorage = requireStorage(storage);
  let stored;
  try {
    stored = durableStorage.getItem(name);
  } catch {
    throw new IdempotencyStorageUnavailable(
      "Durable browser storage cannot read the payment retry handle",
    );
  }
  if (stored && isUuidV4(stored)) return stored;
  if (stored) {
    // A callback may first preserve a legacy receipt in another durable slot.
    // If it cannot do that, it throws instead of allowing this value to be
    // deleted or replaced by a page-local key.
    if (onUnusable?.(stored) !== false) {
      try {
        durableStorage.removeItem(name);
      } catch {
        throw new IdempotencyStorageUnavailable(
          "Durable browser storage cannot retire the payment retry handle",
        );
      }
    }
  }
  return undefined;
}

/**
 * Mint, persist (or remember) and return a fresh key for `name`.
 * @param {Storage | null} storage
 * @param {string} name
 * @param {() => string} [mint] test seam
 * @returns {string}
 */
function mintAndStore(storage, name, mint = mintKey) {
  const fresh = mint();
  persist(storage, name, fresh);
  return fresh;
}

/**
 * @param {Storage | null} storage
 * @param {string} name
 */
function forget(storage, name) {
  try {
    storage?.removeItem(name);
  } catch {
    // Retaining the key is safe; it can only replay the original payment.
  }
}

/**
 * The storage bucket of one donation/PPV intent. Every field is part of the
 * name, the ACTOR included: the server scopes idempotency to
 * `(scope, user, key)`, so a key that two accounts on one browser can both
 * read is one that account B's success will clear and account A's retry will
 * then re-mint — a second charge for A.
 *
 * @param {DonationIdentity} identity
 * @returns {string}
 */
function donationStorageKey(identity) {
  const actor = requireActor(identity.actor);
  return `${DONATION_STORAGE_PREFIX}${encodeURIComponent(
    JSON.stringify({
      actor,
      creator: identity.creator,
      amount: String(identity.amount),
      anonymous: Boolean(identity.anonymous),
      intent: identity.intent ?? "donation",
    }),
  )}`;
}

/**
 * The name this same payment used BEFORE the payer joined it — the shape
 * `${intent}:${creator}:${amount}:${named|anonymous}` that  replaced.
 *
 * @param {DonationIdentity} identity
 * @returns {string}
 */
function legacyDonationStorageKey(identity) {
  const intent = identity.intent ?? "donation";
  const anonymity = identity.anonymous ? "anonymous" : "named";
  return `${DONATION_STORAGE_PREFIX}${intent}:${identity.creator}:${String(identity.amount)}:${anonymity}`;
}

/**
 * Where ONE ACTOR records the older build's key they have already taken from
 * `from`. Scoped to the source and the payer, never to the destination: the
 * same actor must not adopt one pre-upgrade key into two different buckets,
 * or settling one leaves the other holding a spent UUID that the server
 * answers with the wrong receipt.
 *
 * No real bucket name ends this way — the legacy donation name has a fixed
 * four-segment shape and `encodeURIComponent` escapes `:` everywhere else.
 *
 * @param {string} from
 * @param {string} actor
 * @returns {string}
 */
function adoptionMarkerName(from, actor) {
  return `${from}:adopted:${encodeURIComponent(actor)}`;
}

/**
 * Where ONE BUCKET records a key the server has told it does not belong here
 * a 409 `idempotency_mismatch` on an adopted key.
 *
 * The adoption record and this one answer different questions and both are
 * needed. Releasing the adoption is what lets the revision the key was really
 * bought for replay it; without this second record the refused bucket simply
 * adopts it again on the next click and collects the same 409 forever (codex
 * adversarial review, MEDIUM). Scoped to the destination, so it blocks that
 * bucket only.
 *
 * @param {string} to
 * @returns {string}
 */
function refusalMarkerName(to) {
  return `${to}:refused`;
}

/** @param {Storage | null} storage @param {string} name */
function rawRead(storage, name) {
  return readDurable(storage, name) || null;
}

/**
 * COPY a key an OLDER BUILD left behind into the bucket this build reads,
 * at most once for this bucket.
 *
 * Renaming a bucket abandons every unresolved payment in the old one: the
 * fan whose 5 2Z committed and whose response was lost reloads into a build
 * that cannot see their handle, retries, is minted a fresh UUID, and is
 * charged again. That is the exact failure the key exists to prevent, and
 * shipping the rename without this is what causes it (codex adversarial
 * review, HIGH).
 *
 * Three properties, each of which a simpler version got wrong:
 *
 * 1. It is a **copy**. A move deletes retry protection out from under a tab
 *    that is still running the OLD build — mid-deploy that tab is still
 *    reading the old name, and its own retry would then mint a fresh UUID
 *    for a payment that may already have committed.
 * 2. The destination is **persisted before anything else happens**. A write
 *    can fail (quota) after a delete succeeded, and a key that exists only in
 *    memory is gone on the reload that the retry actually happens on.
 * 3. It happens **once per payer**, recorded by value. Without that, the
 *    settled payment's UUID sits in the old name forever and the SAME payer's
 *    next identical donation adopts it, is answered with the old receipt, and
 *    reports a success that never took any money. Per payer rather than per
 *    bucket, so one payer cannot end up with the same spent UUID in two
 *    buckets either.
 *
 * Copying across accounts is safe even though the old name has no payer in
 * it: the server scopes idempotency to `(scope, user, key)`, so the same UUID
 * in two accounts' buckets is two independent keys.
 *
 * @param {Storage | null} storage
 * @param {string} from
 * @param {string} to
 * @param {string} actor the payer, for the one-shot mark
 * @returns {string | undefined}
 */
function adoptKey(storage, from, to, actor) {
  if (from === to) return undefined;
  const inherited = readUsableKey(storage, from);
  if (inherited === undefined) return undefined;
  const marker = adoptionMarkerName(from, actor);
  // Already taken and settled once. Adopting it again would replay a receipt.
  if (rawRead(storage, marker) === inherited) return undefined;
  // The server has already said this key is not this bucket's. Taking it
  // again only collects the same 409.
  if (rawRead(storage, refusalMarkerName(to)) === inherited) return undefined;

  // Adoption itself writes NO marker, deliberately. An earlier version did,
  // and it meant a bucket whose own outcome was never learned — the 409
  // response lost, or the request never sent — permanently blocked the
  // revision the key was actually bought for from replaying it, so that
  // already-paid purchase was charged a second time (codex adversarial
  // review, HIGH). The residual is the other direction and is the safe one:
  // two buckets can hold the same outstanding key, and if one settles, the
  // other's next attempt is answered with that receipt — a success message
  // for money that did not move a second time, never a second debit. This
  // module's whole premise is that an extra replay is free and a missing key
  // is not.
  persist(storage, to, inherited);
  return inherited;
}

/**
 * Record ONE SETTLED KEY as spent for this payer, without deleting the older
 * build's entry — another tab may still be running that build and need it.
 *
 * Two rules, each from a codex adversarial round that broke the simpler
 * version, and together they are what make one marker slot enough:
 *
 * - `settled` is passed in, never read from the old bucket. The old-build tab
 *   keeps writing there: settle K1, that tab then mints K2 for a second
 *   donation whose response is lost, and marking "whatever is there" would
 *   mark K2 — the reload then skips a genuinely unresolved payment and
 *   charges it again.
 * - It writes ONLY when `settled` is exactly what the old name holds, i.e.
 *   only for a key that came FROM there. Otherwise settling an ordinary,
 *   never-adopted payment overwrites the record of a spent legacy key with
 *   its own UUID, and the donation after that adopts the spent one again and
 *   is answered with its receipt — a receipt shown for money that never
 *   moved. (Observed as K1, K2, K1, K3 over four settled purchases.)
 *
 * Settlement writes the marker before removing the adopted destination. This
 * also covers an adoption whose marker write failed while the key itself
 * persisted.
 *
 * @param {Storage | null} storage
 * @param {string} from
 * @param {string} actor
 * @param {string} settled the key that resolved
 */
function markAdopted(storage, from, actor, settled) {
  const value = settled;
  if (!value) return;
  if (readSettlement(storage, from) !== value) return;
  const marker = adoptionMarkerName(from, actor);
  if (readSettlement(storage, marker) === value) return;
  writeSettlement(storage, marker, value);
}

/**
 * Record that `refused` is not this bucket's key before removing the adopted
 * destination. A failed write leaves that destination in place, so reloads
 * keep the evidence and cannot silently adopt the same key again.
 *
 * @param {Storage | null} storage
 * @param {string} to
 * @param {string} refused
 */
function rememberRefusal(storage, to, refused) {
  const marker = refusalMarkerName(to);
  writeSettlement(storage, marker, refused);
}

/**
 * Keep a donation/PPV key stable across an ambiguous response and reload.
 *
 * Call this only AFTER `ensureAuthenticated()` has resolved to a user and
 * pass that user as `actor`; it throws otherwise. See `requireActor`.
 *
 * @param {DonationIdentity} identity
 * @param {KeyDeps} [deps] test seams; production callers pass nothing
 * @returns {string}
 */
export function donationIdempotencyKey(identity, deps = {}) {
  const storage = deps.storage === undefined ? getKeyStorage() : deps.storage;
  const name = donationStorageKey(identity);
  return (
    readUsableKey(storage, name) ??
    adoptKey(
      storage,
      legacyDonationStorageKey(identity),
      name,
      identity.actor,
    ) ??
    mintAndStore(storage, name)
  );
}

/**
 * Retire one donation/PPV key. Call ONLY once the payment is known to have
 * RESOLVED (a confirmed success or a replayed receipt). Pass the SAME identity
 * object the key was minted with.
 *
 * A missing actor is a no-op rather than a throw: nothing can have been
 * minted under that name, and this runs on the success path.
 *
 * @param {DonationIdentity} identity
 * @param {KeyDeps} [deps]
 */
export function clearDonationIdempotencyKey(identity, deps = {}) {
  if (typeof identity?.actor !== "string" || identity.actor.length === 0) {
    return;
  }
  const storage = deps.storage === undefined ? getKeyStorage() : deps.storage;
  const name = donationStorageKey(identity);
  // Read the key that is settling BEFORE dropping it: that exact value is
  // what must never be adopted again. If this payment adopted a legacy key,
  // record the durable spent marker FIRST. Losing that marker while deleting
  // the destination would let the next reload adopt the old receipt again.
  const settled = readSettlement(storage, name);
  if (deps.expectedKey !== undefined && settled !== deps.expectedKey) return;
  if (settled) {
    markAdopted(
      storage,
      legacyDonationStorageKey(identity),
      identity.actor,
      settled,
    );
  }
  removeSettlement(storage, name);
}

/**
 * @param {IntentIdentity} identity
 * @returns {string}
 */
function intentStorageKey(identity) {
  const actor = requireActor(identity.actor);
  return `${INTENT_STORAGE_PREFIX}${encodeURIComponent(
    JSON.stringify({
      actor,
      action: identity.action,
      resource: identity.resource,
      amount: String(identity.amount),
      intent: identity.intent ?? "charge",
    }),
  )}`;
}

/**
 * Read an already-stored intent key without minting or adopting one.
 *
 * @param {IntentIdentity} identity
 * @param {KeyDeps} [deps]
 * @returns {string | undefined}
 */
export function storedIntentIdempotencyKey(identity, deps = {}) {
  const storage = deps.storage === undefined ? getKeyStorage() : deps.storage;
  return readUsableKey(storage, intentStorageKey(identity));
}

/**
 * Archive an explicitly acknowledged provider-unknown outcome so a user can
 * start a distinct paid attempt without deleting the original retry evidence.
 * The archive is durable before the active slot is cleared.
 *
 * @param {IntentIdentity} identity
 * @param {KeyDeps & { supersedes?: IntentIdentity, expectedKey?: string }} [deps]
 * @returns {string}
 */
export function archiveUnknownIntentIdempotencyKey(identity, deps = {}) {
  const storage = deps.storage === undefined ? getKeyStorage() : deps.storage;
  const name = intentStorageKey(identity);
  const key = readUsableKey(storage, name);
  if (key === undefined) {
    throw new IdempotencyStorageUnavailable(
      "The unresolved paid intent key is no longer available",
    );
  }
  if (deps.expectedKey !== undefined && key !== deps.expectedKey) {
    throw new IdempotencyStorageUnavailable(
      "The active paid intent changed after this outcome was reported",
    );
  }
  const names = [name];
  if (deps.supersedes) {
    const supersededName = intentStorageKey(deps.supersedes);
    // An older tab can already own a different paid request in this slot.
    if (readUsableKey(storage, supersededName) === key)
      names.push(supersededName);
  }
  for (const source of names) {
    const sourceKey = readUsableKey(storage, source);
    if (sourceKey === undefined) continue;
    const archiveName = `${source}:unknown:${sourceKey}`;
    persist(storage, archiveName, sourceKey);
    if (readDurable(storage, archiveName) !== sourceKey) {
      throw new IdempotencyStorageUnavailable(
        "The unresolved paid intent could not be archived",
      );
    }
  }
  for (const source of names) {
    if (readUsableKey(storage, source) !== key) continue;
    forget(storage, `${source}:disclosure`);
    forget(storage, source);
    if (readDurable(storage, source) !== null) {
      throw new IdempotencyStorageUnavailable(
        "The unresolved paid intent could not be released for a new attempt",
      );
    }
  }
  return key;
}

/**
 * Persist any paid UI intent across remounts/reloads. The complete semantic
 * identity is part of the storage key, so changing actor, action, resource,
 * amount, or intent can never inherit a receipt for another charge.
 *
 * The actor is REQUIRED and must be the authenticated user, read after
 * `ensureAuthenticated()` resolved. There is deliberately no default:
 * a placeholder actor is a different bucket from the one the hydrated retry
 * reads, and a different bucket is a different UUID, which is a second charge.
 *
 * `deps.supersedes` names an identity an OLDER BUILD used for this same
 * decision. Its unresolved key is moved into this bucket once, so widening an
 * identity does not abandon a payment that may already have committed. See
 * `adoptKey`.
 *
 * @param {IntentIdentity} identity
 * @param {KeyDeps & { supersedes?: IntentIdentity }} [deps]
 * @returns {string}
 */
export function intentIdempotencyKey(identity, deps = {}) {
  const storage = deps.storage === undefined ? getKeyStorage() : deps.storage;
  const name = intentStorageKey(identity);
  const stored = readUsableKey(storage, name);
  if (stored !== undefined) return stored;
  if (deps.supersedes) {
    const inherited = adoptKey(
      storage,
      intentStorageKey(deps.supersedes),
      name,
      identity.actor,
    );
    if (inherited !== undefined) return inherited;
  }
  return mintAndStore(storage, name);
}

/**
 * Keep the submitted disclosure snapshot paired with a stable paid intent.
 * A refreshed catalogue must not replace the body of an ambiguous retry.
 * Only opaque server snapshot tokens should be stored here, never prompts.
 *
 * @param {IntentIdentity} identity
 * @param {string} key the key returned by intentIdempotencyKey
 * @param {string} initialSnapshot the snapshot token shown for a new intent
 * @param {KeyDeps} [deps]
 * @returns {string}
 */
export function intentIdempotencySnapshot(
  identity,
  key,
  initialSnapshot,
  deps = {},
) {
  const storage = deps.storage === undefined ? getKeyStorage() : deps.storage;
  const name = intentStorageKey(identity);
  if (readUsableKey(storage, name) !== key) {
    throw new IdempotencyStorageUnavailable(
      "The disclosure snapshot has no matching paid intent key",
    );
  }
  const snapshotName = `${name}:disclosure`;
  const existing = readDurable(storage, snapshotName);
  if (existing !== null) return existing;
  persist(storage, snapshotName, initialSnapshot);
  return initialSnapshot;
}

/**
 * Retire one paid intent's key once it has resolved. Pass the SAME identity
 * object the key was minted with. A missing actor is a no-op: nothing can
 * have been minted under that name.
 *
 * `deps.supersedes` also settles the older build's name for the same
 * decision, so a settled purchase cannot leave a used UUID behind for the
 * next one to adopt and be answered with the wrong receipt.
 *
 * `deps.unresolved` says the key is being dropped because the SERVER REFUSED
 * TO ASSOCIATE IT with this request — a 409 `idempotency_mismatch` — not
 * because a payment resolved. That distinction is load-bearing (codex
 * adversarial review, HIGH): an old build bought revision A with key K and
 * lost the response; the article moves to B; this build adopts K into B's
 * bucket and the server answers 409 because K belongs to A. Treating that as
 * a settlement would retire K for good, so restoring A and retrying would
 * mint a fresh key and charge the original purchase a second time. Instead
 * the adoption is RELEASED and K goes back to being the outstanding
 * pre-upgrade purchase it is.
 *
 * @param {IntentIdentity} identity
 * @param {KeyDeps & { supersedes?: IntentIdentity, unresolved?: boolean, expectedKey?: string }} [deps]
 */
export function clearIntentIdempotencyKey(identity, deps = {}) {
  if (typeof identity?.actor !== "string" || identity.actor.length === 0) {
    return;
  }
  const storage = deps.storage === undefined ? getKeyStorage() : deps.storage;
  const name = intentStorageKey(identity);
  if (
    deps.expectedKey !== undefined &&
    readDurable(storage, name) !== deps.expectedKey
  ) {
    return false;
  }
  forget(storage, `${name}:disclosure`);
  const settled = readSettlement(storage, name);
  if (deps.supersedes) {
    const from = intentStorageKey(deps.supersedes);
    if (deps.unresolved) {
      // Not a settlement: record only that THIS bucket has been told the key
      // is not its own. It deliberately does NOT touch the settlement record
      // adoption writes nothing, so there is no reservation to release, and
      // deleting it would erase the evidence that ANOTHER revision already
      // settled that key, letting a later purchase adopt it and be handed the
      // old completed job instead of a new translation (codex adversarial
      // review, MEDIUM).
      if (settled) {
        // Write the refusal marker before deleting the adopted destination.
        // If the write fails, retaining the destination is safer than
        // re-adopting the same rejected key after a reload.
        rememberRefusal(storage, name, settled);
      }
    } else if (settled) {
      // Marked, not deleted — see `markAdopted`.
      markAdopted(storage, from, identity.actor, settled);
    }
  }
  removeSettlement(storage, name);
  return true;
}
