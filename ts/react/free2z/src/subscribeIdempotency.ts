// Per-purchase `Idempotency-Key` for the classic (React) subscribe dialog.
//
// WHY THIS EXISTS HERE AS WELL AS IN THE SVELTE APP.
// Classic is not dead code. nginx routes `^~ /classic-ui/` to it, and
// `@classic_fallback` serves it from `location /` whenever the SSR app is
// unavailable -- which is a real state, not a hypothetical one, given the
// documented SSR heap-OOM baseline. So the classic dialog is a live purchase
// path, and 's failure (the fan is charged a price the dialog never
// showed) reproduces through it exactly as the issue describes.
//
// The confirmed route REQUIRES a UUIDv4 `Idempotency-Key` -- it answers 400
// `idempotency_key_required` without one -- so moving classic onto the
// price-bound route means classic has to mint and persist keys too. It never
// sent the header at all before this.
//
// THE STORAGE PREFIXES ARE DELIBERATELY THE SAME AS THE SVELTE APP'S.
// Both bundles are served from the same origin, so they share `localStorage`,
// and a fan bounced from new-ui to classic by `@classic_fallback` mid-purchase
// is ONE purchase intent. Sharing the slot is what makes the server's
// cross-route receipt lookup reachable from either bundle; two different
// prefixes would mint two keys for one intent and buy two months.
//
// The key is retired on RESOLUTION (a confirmed success), never on a clock: a
// TTL can only ever turn an unresolved purchase back into a chargeable one.

const STORAGE_PREFIX = "f2z:subscribe-idempotency:";
const SUPERSEDED_STORAGE_PREFIX = "f2z:subscribe-idempotency-superseded:";
// The account that MINTED a legacy username-keyed slot. Stable subscription
// slots include the payer directly; this marker remains for old callers.
const PAYER_STORAGE_PREFIX = "f2z:subscribe-idempotency-payer:";

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const memoryStore = new Map<string, string>();

export type SubscribeIdentity = {
  creatorId: string | number;
  payerId: string | number;
  username?: string;
  payerUsername?: string;
};

export class SubscriptionIdempotencyStorageError extends Error {
  code = "idempotency_storage_unavailable";

  constructor(message: string) {
    super(message);
    this.name = "SubscriptionIdempotencyStorageError";
  }
}

const STABLE_SUBSCRIBE_PREFIX = `${STORAGE_PREFIX}v2:`;
const STABLE_SUBSCRIBE_ADOPTION_PREFIX = "f2z:subscribe-idempotency-adoption:";
const LEGACY_ADOPTION_OWNER_PREFIX =
  "f2z:subscribe-idempotency-adoption-owner:";

function stableId(value: string | number, label: string): string {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    String(value).length === 0
  ) {
    throw new TypeError(`idempotency key: ${label} id is required`);
  }
  return String(value);
}

function isStableSubscribeIdentity(value: unknown): value is SubscribeIdentity {
  return (
    value !== null &&
    typeof value === "object" &&
    "creatorId" in value &&
    "payerId" in value
  );
}

function stableSubscribeStorageKey(identity: SubscribeIdentity): string {
  return `${STABLE_SUBSCRIBE_PREFIX}${encodeURIComponent(
    JSON.stringify({
      creator: stableId(identity.creatorId, "creator"),
      payer: stableId(identity.payerId, "payer"),
    })
  )}`;
}

function stableSubscribeAdoptionKey(destination: string): string {
  return `${STABLE_SUBSCRIBE_ADOPTION_PREFIX}${encodeURIComponent(
    destination
  )}`;
}

function stableSubscribeSupersededKey(destination: string): string {
  return `${destination}:superseded`;
}

type StableAdoptionState = {
  key: string;
  keys: string[];
  settled: boolean;
  abandoned: boolean;
};

function stableSubscribeAdoptionState(
  storage: Storage | null,
  name: string
): StableAdoptionState | null {
  const raw = durableGet(storage, name);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.key === "string") {
      return {
        key: parsed.key,
        keys: Array.isArray(parsed.keys)
          ? parsed.keys.filter(
              (key: unknown): key is string => typeof key === "string"
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

function writeStableSubscribeAdoption(
  storage: Storage | null,
  name: string,
  keys: string[],
  settled = false,
  abandoned = false
): void {
  const unique = Array.from(new Set(keys));
  durableSet(
    storage,
    name,
    JSON.stringify({
      key: unique[0],
      keys: unique,
      settled,
      abandoned,
    })
  );
}

function durableGet(storage: Storage | null, name: string): string | null {
  if (!storage) {
    throw new SubscriptionIdempotencyStorageError(
      "A durable browser storage area is required before subscribing"
    );
  }
  try {
    return storage.getItem(name);
  } catch {
    throw new SubscriptionIdempotencyStorageError(
      "The subscription retry key could not be read from durable storage"
    );
  }
}

function durableSet(
  storage: Storage | null,
  name: string,
  value: string
): void {
  if (!storage) {
    throw new SubscriptionIdempotencyStorageError(
      "The subscription retry key could not be persisted; this attempt was not sent"
    );
  }
  try {
    storage.setItem(name, value);
  } catch {
    throw new SubscriptionIdempotencyStorageError(
      "The subscription retry key could not be persisted; this attempt was not sent"
    );
  }
}

function durableRemove(storage: Storage | null, name: string): boolean {
  if (!storage) return false;
  try {
    storage.removeItem(name);
    return true;
  } catch {
    return false;
  }
}

function legacyAdoptionOwnerKey(key: string): string {
  return `${LEGACY_ADOPTION_OWNER_PREFIX}${encodeURIComponent(key)}`;
}

function adoptionConflict(
  message: string
): SubscriptionIdempotencyStorageError {
  const error = new SubscriptionIdempotencyStorageError(message);
  error.code = "idempotency_adoption_conflict";
  return error;
}

function ensureLegacyOwnership(
  storage: Storage | null,
  identity: SubscribeIdentity,
  key: string
): boolean {
  const ownerName = legacyAdoptionOwnerKey(key);
  const rawOwner = durableGet(storage, ownerName);
  if (rawOwner) {
    try {
      const owner = JSON.parse(rawOwner);
      stableId(owner.creatorId, "recorded creator");
      stableId(owner.payerId, "recorded payer");
      if (owner.abandoned === true) return false;
      if (owner.settled === true) {
        // Old bundles may reuse this key for another immutable
        // identity; the recorded settlement does not resolve that.
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
          "This legacy subscription intent belongs to another account or creator"
        );
      }
      return true;
    } catch (error) {
      if (error instanceof SubscriptionIdempotencyStorageError) throw error;
      throw adoptionConflict(
        "The legacy subscription intent ownership is invalid"
      );
    }
  }
  // Without immutable owner evidence, a changed payer username is ambiguous:
  // it may be a rename or a different account. Keep the unresolved key and
  // refuse adoption; guessing here could transfer another payer's intent.
  if (identity.username) {
    const legacyPayer = durableGet(
      storage,
      `${PAYER_STORAGE_PREFIX}${identity.username}`
    );
    if (
      legacyPayer &&
      (!identity.payerUsername || legacyPayer !== identity.payerUsername)
    ) {
      throw adoptionConflict(
        "This legacy subscription intent belongs to another payer"
      );
    }
  }
  return true;
}

function legacyEvidence(
  storage: Storage | null,
  identity: SubscribeIdentity
): string[] {
  if (!identity.username) return [];
  return [
    durableGet(storage, `${STORAGE_PREFIX}${identity.username}`),
    durableGet(storage, `${SUPERSEDED_STORAGE_PREFIX}${identity.username}`),
  ].filter((key): key is string => Boolean(key));
}

function hasKnownForeignPayer(
  storage: Storage | null,
  identity: SubscribeIdentity,
  key: string
): boolean {
  try {
    const owner = JSON.parse(
      durableGet(storage, legacyAdoptionOwnerKey(key)) || "null"
    );
    return Boolean(
      owner &&
        stableId(owner.creatorId, "recorded creator") &&
        stableId(owner.payerId, "recorded payer") &&
        String(owner.creatorId) === stableId(identity.creatorId, "creator") &&
        String(owner.payerId) !== stableId(identity.payerId, "payer")
    );
  } catch {
    return false;
  }
}

function hasUnresolvedForeignPayer(
  storage: Storage | null,
  identity: SubscribeIdentity,
  key: string
): boolean {
  if (!hasKnownForeignPayer(storage, identity, key)) return false;
  try {
    const owner = JSON.parse(
      durableGet(storage, legacyAdoptionOwnerKey(key)) || "null"
    );
    return owner?.settled !== true && owner?.abandoned !== true;
  } catch {
    return false;
  }
}

function legacyEvidenceForIdentity(
  storage: Storage | null,
  identity: SubscribeIdentity
): string[] {
  return legacyEvidence(storage, identity).filter((key) => {
    try {
      return ensureLegacyOwnership(storage, identity, key);
    } catch (error: any) {
      // A known immutable owner belongs to another payer/creator. It is
      // not this identity's receipt and must neither block its stable
      // slot nor be sent as a superseded lookup header. Unknown or
      // malformed ownership remains a hard refusal.
      if (
        error?.code === "idempotency_adoption_conflict" &&
        hasKnownForeignPayer(storage, identity, key)
      )
        return false;
      throw error;
    }
  });
}

function rejectForeignLegacyEvidence(
  storage: Storage | null,
  identity: SubscribeIdentity
): void {
  for (const key of legacyEvidence(storage, identity)) {
    if (hasUnresolvedForeignPayer(storage, identity, key)) {
      throw adoptionConflict(
        "This legacy subscription intent belongs to another account"
      );
    }
  }
}

function uniqueKeys(keys: string[]): string[] {
  return Array.from(new Set(keys));
}

function publishStableSubscribeKey(
  storage: Storage | null,
  identity: SubscribeIdentity,
  destination: string,
  adoption: string,
  key: string,
  evidence: string[]
): string {
  const legacyName = identity.username
    ? `${STORAGE_PREFIX}${identity.username}`
    : null;
  const legacy = legacyName ? durableGet(storage, legacyName) : null;
  const oldSupersededName = identity.username
    ? `${SUPERSEDED_STORAGE_PREFIX}${identity.username}`
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
        "A different subscription intent still occupies the legacy slot"
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
      "A different superseded subscription intent is still unresolved"
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
      })
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
        "Settled subscription evidence could not be retired"
      );
    }
  }
  if (
    !superseded &&
    durableGet(storage, stableSubscribeSupersededKey(destination))
  ) {
    if (!durableRemove(storage, stableSubscribeSupersededKey(destination))) {
      throw new SubscriptionIdempotencyStorageError(
        "Settled subscription evidence could not be retired"
      );
    }
  }
  if (legacyName && !foreignLegacy) {
    if (identity.payerUsername)
      durableSet(
        storage,
        `${PAYER_STORAGE_PREFIX}${identity.username}`,
        identity.payerUsername
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
        // The ownership checks above reject malformed provenance.
      }
    }
    if (!preserveAbandonedLegacy) durableSet(storage, legacyName, key);
  }
  return key;
}

function stableSubscribeKey(
  identity: SubscribeIdentity,
  deps: { storage?: Storage | null; mint?: () => string } = {}
): string {
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
    stableSubscribeSupersededKey(destination)
  );
  const usableExisting =
    existing &&
    (() => {
      try {
        const owner = JSON.parse(
          durableGet(storage, legacyAdoptionOwnerKey(existing)) || "null"
        );
        if (!owner) return true;
        if (
          String(owner.creatorId) !== stableId(identity.creatorId, "creator") ||
          String(owner.payerId) !== stableId(identity.payerId, "payer")
        )
          throw adoptionConflict(
            "This subscription intent belongs to another account or creator"
          );
        return owner.settled !== true && owner.abandoned !== true;
      } catch (error) {
        if (error instanceof SubscriptionIdempotencyStorageError) throw error;
        throw adoptionConflict("The subscription intent ownership is invalid");
      }
    })();
  if (!usableExisting && adopted?.keys.length) {
    throw adoptionConflict(
      "Resolve the other outstanding subscription attempt before starting a new one"
    );
  }
  const evidence = uniqueKeys([
    ...(adopted?.keys ?? []),
    ...legacyEvidenceForIdentity(storage, identity),
    ...(pendingSuperseded ? [pendingSuperseded] : []),
    ...(existing && !isUuidV4(existing) ? [existing] : []),
  ]).filter((value) => ensureLegacyOwnership(storage, identity, value));
  const key =
    usableExisting && isUuidV4(existing)
      ? existing
      : evidence.find(isUuidV4) || (deps.mint ?? mintKey)();
  return publishStableSubscribeKey(
    storage,
    identity,
    destination,
    adoption,
    key,
    evidence
  );
}

function stableSubscribeHeaders(
  identity: SubscribeIdentity,
  deps: { storage?: Storage | null; mint?: () => string } = {}
): Record<string, string> {
  const storage = deps.storage === undefined ? getKeyStorage() : deps.storage;
  const key = stableSubscribeKey(identity, deps);
  const destination = stableSubscribeStorageKey(identity);
  const headers: Record<string, string> = { "Idempotency-Key": key };
  const adopted = stableSubscribeAdoptionState(
    storage,
    stableSubscribeAdoptionKey(destination)
  );
  const legacy = legacyEvidenceForIdentity(storage, identity);
  const superseded = uniqueKeys(
    [
      durableGet(storage, stableSubscribeSupersededKey(destination)),
      ...(adopted?.settled ? [] : adopted?.keys ?? []),
      ...(adopted?.settled ? [] : legacy),
    ].filter((value): value is string => Boolean(value))
  ).find((value) => value !== key && !isUuidV4(value));
  if (superseded && !isUuidV4(superseded)) {
    headers["X-Superseded-Idempotency-Key"] = superseded;
  }
  return headers;
}

function stableClearSubscribeKey(
  identity: SubscribeIdentity,
  deps: { storage?: Storage | null; key?: string; expectedKey?: string } = {}
): void {
  const storage = deps.storage === undefined ? getKeyStorage() : deps.storage;
  if (!storage) return;
  const destination = stableSubscribeStorageKey(identity);
  const adoption = stableSubscribeAdoptionKey(destination);
  let current: string | null;
  let adopted: StableAdoptionState | null;
  try {
    current = durableGet(storage, destination);
    adopted = stableSubscribeAdoptionState(storage, adoption);
  } catch {
    // A cleanup read failure must retain every receipt reference.
    return;
  }
  // `expectedKey`  and `key` both name the exact key a response
  // answered for; either one scopes cleanup to that key.
  const exactKey = deps.key ?? deps.expectedKey;
  const key = exactKey ?? current;
  // A response for the current key settles the whole adoption transaction,
  // including any legacy handle folded into it. A delayed response for an
  // older key must only retire that key and leave the newer current attempt
  // available for recovery.
  const clearAllAdopted = exactKey === undefined || current === key;
  if (!key) return;
  const creatorId = stableId(identity.creatorId, "creator");
  const payerId = stableId(identity.payerId, "payer");
  let owner: Record<string, unknown> | null = null;
  try {
    owner = JSON.parse(
      durableGet(storage, legacyAdoptionOwnerKey(key)) || "null"
    );
  } catch {
    return;
  }
  if (
    owner &&
    (String(owner.creatorId) !== creatorId || String(owner.payerId) !== payerId)
  )
    return;
  // A delayed response for an older key must not retire the current key or
  // any newer adoption recorded beside it.
  const retiredKeys = uniqueKeys([
    key,
    ...(clearAllAdopted ? adopted?.keys ?? [] : []),
  ]);
  const retiredOwners: Array<[string, Record<string, unknown> | null]> = [];
  for (const candidate of retiredKeys) {
    let candidateOwner: Record<string, unknown> | null;
    try {
      candidateOwner = JSON.parse(
        durableGet(storage, legacyAdoptionOwnerKey(candidate)) || "null"
      );
    } catch {
      return;
    }
    if (
      candidateOwner &&
      (String(candidateOwner.creatorId) !== creatorId ||
        String(candidateOwner.payerId) !== payerId)
    ) {
      return;
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
        })
      );
    }
  } catch {
    return;
  }
  if (identity.username) {
    try {
      for (const name of [
        `${SUPERSEDED_STORAGE_PREFIX}${identity.username}`,
        `${STORAGE_PREFIX}${identity.username}`,
      ]) {
        const legacyKey = durableGet(storage, name);
        if (legacyKey && retiredKeys.includes(legacyKey)) {
          if (!durableRemove(storage, name)) return;
        }
      }
    } catch {
      // Retain evidence when cleanup cannot verify its settled owner.
    }
  }
  if (current === key && !durableRemove(storage, destination)) return;
  const stableSuperseded = durableGet(
    storage,
    stableSubscribeSupersededKey(destination)
  );
  if (stableSuperseded && retiredKeys.includes(stableSuperseded)) {
    if (!durableRemove(storage, stableSubscribeSupersededKey(destination))) {
      return;
    }
  }
  if (adopted) {
    const remaining = clearAllAdopted
      ? []
      : adopted.keys.filter((candidate) => candidate !== key);
    if (remaining.length) {
      writeStableSubscribeAdoption(
        storage,
        adoption,
        remaining,
        adopted.settled,
        adopted.abandoned
      );
    } else if (!durableRemove(storage, adoption)) {
      return;
    }
  }
}

/** Return durable handles without adopting or clearing another account's key. */
export function subscribeRecoveryKeys(
  identity: SubscribeIdentity,
  deps: { storage?: Storage | null } = {}
): string[] {
  const storage = deps.storage === undefined ? getKeyStorage() : deps.storage;
  const destination = stableSubscribeStorageKey(identity);
  const adopted = stableSubscribeAdoptionState(
    storage,
    stableSubscribeAdoptionKey(destination)
  );
  return uniqueKeys(
    [
      durableGet(storage, destination),
      ...(adopted?.keys ?? []),
      durableGet(storage, stableSubscribeSupersededKey(destination)),
      ...legacyEvidenceForIdentity(storage, identity),
    ].filter((key): key is string => Boolean(key))
  ).filter((key) => {
    try {
      const owner = JSON.parse(
        durableGet(storage, legacyAdoptionOwnerKey(key)) || "null"
      );
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

/** Mark local evidence abandoned only after the server committed that fact. */
export function markSubscribeIdempotencyAbandoned(
  identity: SubscribeIdentity,
  key: string,
  deps: { storage?: Storage | null } = {}
): void {
  const storage = deps.storage === undefined ? getKeyStorage() : deps.storage;
  const creatorId = stableId(identity.creatorId, "creator");
  const payerId = stableId(identity.payerId, "payer");
  const keys = subscribeRecoveryKeys(identity, deps);
  if (!keys.includes(key)) return;
  const ownerName = legacyAdoptionOwnerKey(key);
  let owner: { creatorId?: string | number; payerId?: string | number } | null;
  try {
    owner = JSON.parse(durableGet(storage, ownerName) || "null");
  } catch {
    owner = null;
  }
  if (
    owner &&
    (String(owner.creatorId) !== creatorId || String(owner.payerId) !== payerId)
  )
    return;
  durableSet(
    storage,
    ownerName,
    JSON.stringify({
      ...(owner ?? {}),
      creatorId,
      payerId,
      abandoned: true,
      settled: false,
    })
  );
  const destination = stableSubscribeStorageKey(identity);
  const adoption = stableSubscribeAdoptionKey(destination);
  const state = stableSubscribeAdoptionState(storage, adoption);
  // Abandoning the replacement UUID also retires any historical non-UUID
  // handle adopted into the same recovery attempt. Keep this set scoped to
  // the handles proven to belong to this identity and attempt.
  const retiredKeys = uniqueKeys([key, ...(state?.keys ?? keys)]);
  const remaining = (state?.keys ?? keys).filter(
    (candidate) => candidate !== key
  );
  if (remaining.length)
    writeStableSubscribeAdoption(storage, adoption, remaining);
  else durableRemove(storage, adoption);
  if (durableGet(storage, destination) === key)
    durableRemove(storage, destination);
  const stableSuperseded = durableGet(
    storage,
    stableSubscribeSupersededKey(destination)
  );
  if (stableSuperseded && retiredKeys.includes(stableSuperseded)) {
    durableRemove(storage, stableSubscribeSupersededKey(destination));
  }
}

function isUuidV4(value: unknown): boolean {
  return typeof value === "string" && UUID_V4.test(value);
}

function getKeyStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // Accessing the property itself throws when storage is blocked.
    return null;
  }
}

/** A UUIDv4, including in browsers without `crypto.randomUUID`. */
export function mintKey(): string {
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
  // Version 4, variant 1 -- the server parses and REQUIRES v4.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10).join(""),
  ].join("-");
}

function read(storage: Storage | null, name: string): string | undefined {
  if (storage) {
    try {
      const stored = storage.getItem(name);
      if (stored) return stored;
    } catch {
      // Fall through to the memory fallback.
    }
  }
  return memoryStore.get(name);
}

/**
 * Returns whether the value reached DURABLE storage. Memory does not survive a
 * reload, and `supersede` must not destroy the durable copy of a key when its
 * own copy is only in memory.
 */
function write(storage: Storage | null, name: string, value: string): boolean {
  if (storage) {
    try {
      storage.setItem(name, value);
      return true;
    } catch {
      // Quota, or a store that reads and refuses writes (private mode).
    }
  }
  memoryStore.set(name, value);
  return false;
}

function forget(storage: Storage | null, name: string): void {
  memoryStore.delete(name);
  if (!storage) return;
  try {
    storage.removeItem(name);
  } catch {
    // A retained key can only replay the original charge; that is safe.
  }
}

/**
 * Set aside a key that can no longer be SENT, so the server can still be
 * asked whether it already paid for this membership. Never overwrites an
 * existing superseded key: the older one is the unresolved purchase.
 *
 * Returns whether the retired key now survives a reload. With localStorage at
 * quota `setItem` throws and the value lands in MEMORY while `removeItem`
 * still succeeds -- so deleting the original would destroy the only durable
 * reference to a receipt the fan has already paid for, and the reload the
 * abort copy asks for would then send no superseded header and buy a second
 * month (codex adversarial review, round 6).
 */
function supersede(
  storage: Storage | null,
  username: string,
  unusable: string
): boolean {
  const name = `${SUPERSEDED_STORAGE_PREFIX}${username}`;
  if (storage) {
    try {
      if (storage.getItem(name)) return true;
    } catch {
      // Unreadable store; the memory check below still applies.
    }
  } else if (memoryStore.get(name)) {
    // Memory only: no better than leaving the original where it is.
    return false;
  }
  return write(storage, name, unusable);
}

/**
 * The key to claim under for `username`.
 *
 * The ordering of the two stores is load-bearing, and an arrangement that
 * looked equivalent was not (codex adversarial review). A store that READS an
 * old non-UUID value but refuses writes and removals keeps handing that value
 * back forever; if the memory replacement is ranked below it, or cleared on
 * the way past, every call mints a NEW UUID -- "a fresh key per click", which
 * sends the header and protects nothing, so the retry after an ambiguous
 * answer charges a second month. Here the memory fallback is consulted only
 * AFTER an unusable stored value has been set aside, and the replacement it
 * holds is never deleted, so it survives a store that cannot be written to.
 */
function claimKey(
  storage: Storage | null,
  username: string,
  actor?: string | null
): string {
  const name = `${STORAGE_PREFIX}${username}`;
  // True once a retired key could not be copied anywhere durable. A nearly
  // full localStorage can refuse a NEW entry (the superseded slot) and
  // still accept replacing an EXISTING one of similar size (this slot), so
  // vetoing the delete alone left the write below free to destroy the same
  // value one line later (codex adversarial review, round 7).
  let retiredKeyIsStranded = false;
  if (storage) {
    try {
      const stored = storage.getItem(name);
      if (stored && isUuidV4(stored)) return stored;
      if (stored) {
        // NOT discarded. A pre- `f2z-...` key cannot be sent any
        // more, but the server can still look up the receipt it may
        // have -- and throwing it away destroys the only evidence the
        // earlier charge happened. Only removed once the copy
        // set aside is DURABLE; otherwise this slot holds the last
        // reference and keeps it.
        if (supersede(storage, username, stored)) {
          storage.removeItem(name);
        } else {
          // The main slot is now the last reference to a paid
          // receipt: neither delete it NOR overwrite it below.
          retiredKeyIsStranded = true;
        }
      }
    } catch {
      // Unreadable or unwritable store: the memory fallback decides.
    }
  }
  const cached = memoryStore.get(name);
  if (cached && isUuidV4(cached)) return cached;
  if (cached) {
    supersede(storage, username, cached);
    memoryStore.delete(name);
  }
  const fresh = mintKey();
  if (retiredKeyIsStranded) {
    // Memory only. The reload then finds the retired key still in place
    // and sends it as the superseded header, which is why it was kept.
    memoryStore.set(name, fresh);
  } else {
    write(storage, name, fresh);
  }
  // Stamped only at MINT. Stamping a key that was already there would be a
  // guess about who left it, and guessing "me" is exactly what lets one
  // account retire another account's outstanding purchase.
  if (typeof actor === "string" && actor) {
    write(storage, `${PAYER_STORAGE_PREFIX}${username}`, actor);
  }
  return fresh;
}

/**
 * Headers for one subscribe POST: the key to claim under, plus any key this
 * browser had to retire because the server no longer accepts its format.
 *
 * Both together in one call so a caller cannot send the fresh key and silently
 * drop the retired one, which is the  double charge.
 */
export function subscribeIdempotencyHeaders(
  username: string | SubscribeIdentity,
  actor?: string | null | { storage?: Storage | null; mint?: () => string }
): Record<string, string> {
  if (isStableSubscribeIdentity(username)) {
    return stableSubscribeHeaders(
      username,
      actor && typeof actor === "object" ? actor : {}
    );
  }
  const storage = getKeyStorage();
  const legacyActor = typeof actor === "string" ? actor : null;
  const headers: Record<string, string> = {
    "Idempotency-Key": claimKey(storage, username, legacyActor),
  };
  let superseded = read(storage, `${SUPERSEDED_STORAGE_PREFIX}${username}`);
  if (!superseded) {
    // The case `supersede` refuses a removal for: the retired key is
    // still in the MAIN slot because setting it aside could not be made
    // durable. It is a receipt reference wherever it sits.
    const stranded = read(storage, `${STORAGE_PREFIX}${username}`);
    if (stranded && !isUuidV4(stranded)) superseded = stranded;
  }
  if (superseded) headers["X-Superseded-Idempotency-Key"] = superseded;
  return headers;
}

/**
 * Retire the key for `username`. ONLY once the purchase has RESOLVED -- a
 * confirmed success. Never on an abort, a 409 or a network failure: those are
 * exactly the cases the key exists for.
 */
export function clearSubscribeIdempotencyKey(
  username: string | SubscribeIdentity,
  deps: { storage?: Storage | null; key?: string; expectedKey?: string } = {}
): void {
  if (isStableSubscribeIdentity(username)) {
    stableClearSubscribeKey(username, deps);
    return;
  }
  const storage = deps.storage === undefined ? getKeyStorage() : deps.storage;
  const exactKey = deps.key ?? deps.expectedKey;
  if (exactKey !== undefined) {
    // A response owns only the key it sent.
    let current: string | undefined;
    try {
      current = read(storage, `${STORAGE_PREFIX}${username}`);
    } catch {
      return;
    }
    if (current !== exactKey) return;
  }
  forget(storage, `${STORAGE_PREFIX}${username}`);
  forget(storage, `${SUPERSEDED_STORAGE_PREFIX}${username}`);
  forget(storage, `${PAYER_STORAGE_PREFIX}${username}`);
}

/**
 * Retire the key for `username` because THIS fan's membership is active.
 *
 * An observed membership is proof the purchase RESOLVED; it is not proof of
 * WHO paid. localStorage is per browser, not per account, and this store is
 * still named by the creator alone -- the donation and intent stores put the
 * payer in the NAME; migrating this one needs an adoption protocol in
 * both bundles and is tracked on.
 *
 * Without the check below (codex adversarial review, round 5): account A's
 * purchase loses its response and strands its key; account B logs in already
 * subscribed to that creator; the sweep below deletes A's key; A's retry
 * mints a fresh one and, past the 60-second debounce, buys a second month.
 * A key with no payer marker -- one minted by an earlier build -- is KEPT,
 * which is always the safe direction: a stranded key can no longer wedge a
 * fan, because the server answers `key_resolved: true` and the dialog retires
 * it on the next attempt.
 */
function retireSubscribeKeyResolvedByMembership(
  username: string | SubscribeIdentity,
  actor: string | number | null | undefined
): void {
  if (isStableSubscribeIdentity(username)) {
    // Old auth caches cannot authorize cleanup by equating missing ids.
    try {
      const payerId = stableId(username.payerId, "payer");
      const creatorId = stableId(username.creatorId, "creator");
      if (actor == null || actor === "" || payerId !== String(actor)) return;
      const storage = getKeyStorage();
      if (!storage) return;
      const candidates = subscribeRecoveryKeys(username, { storage });
      const owned = candidates.filter((key) => {
        const ownerName = legacyAdoptionOwnerKey(key);
        const rawOwner = durableGet(storage, ownerName);
        if (rawOwner) {
          const owner = JSON.parse(rawOwner);
          if (
            String(owner?.payerId) !== payerId ||
            String(owner?.creatorId) !== creatorId
          )
            return false;
        } else if (
          !username.username ||
          !username.payerUsername ||
          durableGet(storage, `${PAYER_STORAGE_PREFIX}${username.username}`) !==
            username.payerUsername
        ) {
          return false;
        }
        return true;
      });
      // An observed membership cannot identify which of several
      // unresolved browser intents paid for it. Retain all evidence in
      // that case; a server response for one exact key can reconcile it.
      if (owned.length === 1)
        stableClearSubscribeKey(username, { storage, key: owned[0] });
    } catch {
      // Unavailable identity or provenance cannot authorize retirement.
    }
    return;
  }
  if (typeof actor !== "string" || !actor) return;
  const storage = getKeyStorage();
  if (read(storage, `${PAYER_STORAGE_PREFIX}${username}`) !== actor) return;
  clearSubscribeIdempotencyKey(username);
}

/**
 * Retire the key for every creator this fan is CURRENTLY subscribed to.
 *
 * The other half of retirement, and the half a success handler cannot do: a
 * purchase whose response was lost never reaches that handler, so its key
 * stays. An observed active membership is the same resolution arriving by the
 * route the "check your subscriptions" copy points at, and it is authoritative
 * -- the server told us.
 *
 * Without it the stranded key is not merely untidy, it is a dead end (codex
 * adversarial review, round 2): the completed receipt binds that key to the
 * price paid, so once the membership expires and the creator has moved their
 * price, every new attempt sends the same key with a different
 * `expected_price` and is answered 409 `idempotency_mismatch` -- forever, for
 * that browser, with no reload able to clear it.
 *
 * Called from `state/GlobalCreator`, which is mounted for the whole app: the
 * subscribe dialog is NOT mounted while the fan is subscribed, so an effect
 * there could never observe the membership it is waiting for.
 */
export function retireResolvedSubscribeIdempotencyKeys(
  stars: readonly (string | number)[] | undefined | null,
  actor?: string | number | null,
  starIds?: readonly (string | number)[] | undefined | null,
  payerUsername?: string | null
): void {
  if (!stars) return;
  for (let index = 0; index < stars.length; index += 1) {
    const username = stars[index];
    if (typeof username === "string" && username) {
      const creatorId = starIds?.[index];
      if (creatorId !== undefined) {
        retireSubscribeKeyResolvedByMembership(
          {
            creatorId,
            payerId: actor ?? "",
            username,
            payerUsername: payerUsername ?? undefined,
          },
          actor
        );
      } else {
        // Old auth responses have no immutable id. Keep the legacy
        // guarded path compatible until the next auth refresh.
        retireSubscribeKeyResolvedByMembership(username, actor);
      }
    }
  }
}
