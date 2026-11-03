const ppvJoinKeys = new Map();

/** @param {string} owner @param {number} actorId @param {string} meetingType @param {string} sessionId */
function storageKey(owner, actorId, meetingType, sessionId) {
  return `f2z:ppv-join:${owner.toLowerCase()}:${meetingType}:${sessionId}:${actorId}`;
}

/** Reuse the key for retries to one provider session. */
/** @param {string} owner @param {number} actorId @param {string} sessionId @param {string} [meetingType] */
export function ppvJoinKey(owner, actorId, sessionId, meetingType = "ppv") {
  if (!sessionId) throw new Error("PPV admission requires a meeting session");
  const scope = storageKey(owner, actorId, meetingType, sessionId);
  let existing = ppvJoinKeys.get(scope) ?? null;
  try {
    if (!existing && typeof sessionStorage !== "undefined") {
      existing = sessionStorage.getItem(scope);
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
