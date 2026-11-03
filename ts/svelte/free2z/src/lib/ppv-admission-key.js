const ppvJoinKeys = new Map();

/** @param {string} owner @param {number} actorId @param {string} meetingType */
function storageKey(owner, actorId, meetingType) {
  return `f2z:ppv-join:${owner.toLowerCase()}:${meetingType}:${actorId}`;
}

/** @param {string} owner @param {number} actorId */
function legacyStorageKey(owner, actorId) {
  return `f2z:ppv-join:${owner.toLowerCase()}:${actorId}`;
}

/** Reuse the key for retries to one creator's PPV meeting. */
/** @param {string} owner @param {number} actorId @param {string} [meetingType] */
export function ppvJoinKey(owner, actorId, meetingType = "ppv") {
  const scope = storageKey(owner, actorId, meetingType);
  let existing = ppvJoinKeys.get(scope) ?? null;
  try {
    if (!existing && typeof sessionStorage !== "undefined") {
      existing = sessionStorage.getItem(scope);
      // Older bundles used this owner/viewer-only name for PPV joins. Adopt it
      // so a cached old client cannot turn an ambiguous retry into a new charge.
      if (!existing && meetingType === "ppv")
        existing = sessionStorage.getItem(legacyStorageKey(owner, actorId));
    }
  } catch {
    // The in-memory key still keeps retries in this page idempotent.
  }
  if (existing) {
    ppvJoinKeys.set(scope, existing);
    try {
      if (typeof sessionStorage !== "undefined")
        sessionStorage.setItem(scope, existing);
    } catch {
      // The in-memory copy still preserves this retry identity in-page.
    }
    return existing;
  }

  const key = crypto.randomUUID();
  ppvJoinKeys.set(scope, key);
  try {
    if (typeof sessionStorage !== "undefined")
      sessionStorage.setItem(scope, key);
  } catch {
    // Do not prevent a paid join when browser storage is unavailable.
  }
  return key;
}

/** Clear only the exact completed admission key, never its successor. */
/** @param {string} owner @param {number} actorId @param {string} expectedKey @param {string} [meetingType] */
export function clearPpvJoinKey(
  owner,
  actorId,
  expectedKey,
  meetingType = "ppv",
) {
  const scope = storageKey(owner, actorId, meetingType);
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
    const legacyScope = legacyStorageKey(owner, actorId);
    if (
      typeof sessionStorage !== "undefined" &&
      sessionStorage.getItem(legacyScope) === expectedKey
    )
      sessionStorage.removeItem(legacyScope);
  } catch {
    // Keeping a completed key can only replay this same admission safely.
  }
}
