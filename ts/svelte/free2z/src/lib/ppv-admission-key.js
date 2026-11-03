const ppvJoinKeys = new Map();

export class PpvAdmissionStorageError extends Error {
  constructor() {
    super("PPV admission retry key could not be persisted");
    this.name = "PpvAdmissionStorageError";
  }
}

/** @param {string} owner @param {number} actorId @param {string} meetingType @param {string} sessionId */
function storageKey(owner, actorId, meetingType, sessionId) {
  return `f2z:ppv-join:${owner.toLowerCase()}:${meetingType}:${sessionId}:${actorId}`;
}

/** Reuse the key for retries to one provider session. */
/** @param {string} owner @param {number} actorId @param {string} sessionId @param {string} [meetingType] */
export function ppvJoinKey(owner, actorId, sessionId, meetingType = "ppv") {
  if (!sessionId) throw new Error("PPV admission requires a meeting session");
  const scope = storageKey(owner, actorId, meetingType, sessionId);
  const inMemory = ppvJoinKeys.get(scope) ?? null;
  let existing = null;
  let storage;
  try {
    if (typeof sessionStorage === "undefined")
      throw new PpvAdmissionStorageError();
    storage = sessionStorage;
    existing = storage.getItem(scope);
  } catch {
    throw new PpvAdmissionStorageError();
  }

  // A page-local key may survive a transient storage removal, but it must be
  // restored and verified before another request can use it.
  if (inMemory) {
    if (existing && existing !== inMemory) throw new PpvAdmissionStorageError();
    try {
      if (!existing) storage.setItem(scope, inMemory);
      if (storage.getItem(scope) !== inMemory)
        throw new PpvAdmissionStorageError();
    } catch {
      throw new PpvAdmissionStorageError();
    }
    return inMemory;
  }

  if (existing) {
    ppvJoinKeys.set(scope, existing);
    return existing;
  }

  const key = crypto.randomUUID();
  ppvJoinKeys.set(scope, key);
  try {
    storage.setItem(scope, key);
    if (storage.getItem(scope) !== key) throw new PpvAdmissionStorageError();
  } catch {
    // Keep the in-page value so a later attempt can persist this same identity.
    throw new PpvAdmissionStorageError();
  }
  return key;
}

/** Clear only the exact completed admission key, never its successor. */
/** @param {string} owner @param {number} actorId @param {string} expectedKey @param {string} sessionId @param {string} [meetingType] */
export function clearPpvJoinKey(
  owner,
  actorId,
  expectedKey,
  sessionId,
  meetingType = "ppv",
) {
  if (!sessionId) return;
  const scope = storageKey(owner, actorId, meetingType, sessionId);
  let current = ppvJoinKeys.get(scope) ?? null;
  try {
    if (!current && typeof sessionStorage !== "undefined")
      current = sessionStorage.getItem(scope);
  } catch {
    // The in-memory value remains authoritative when storage is unavailable.
  }
  if (current !== expectedKey) return;
  ppvJoinKeys.delete(scope);
  try {
    if (typeof sessionStorage !== "undefined") sessionStorage.removeItem(scope);
  } catch {
    // Keeping a completed key can only replay this same admission safely.
  }
}
