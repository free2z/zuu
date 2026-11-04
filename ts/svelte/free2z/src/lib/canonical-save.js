/**
 * @typedef {{ok: boolean, status: number}} ResponseLike
 * @typedef {{response: ResponseLike, result: Record<string, any>}} SaveAttempt
 */

/**
 * Django remains the validation authority. Retry only an autosave whose sole
 * validation failure is canonical_url, and never retry an already-trimmed
 * payload or a manual save.
 *
 * @param {{
 *   isAuto: boolean,
 *   attempt: SaveAttempt,
 *   payload: Record<string, any>
 * }} options
 */
export function shouldRetryAutosaveWithoutCanonicalUrl({
  isAuto,
  attempt,
  payload,
}) {
  if (
    !isAuto ||
    attempt.response.status !== 400 ||
    !Object.prototype.hasOwnProperty.call(payload, "canonical_url") ||
    !Object.prototype.hasOwnProperty.call(attempt.result, "canonical_url")
  ) {
    return false;
  }

  return Object.keys(attempt.result).every((key) => key === "canonical_url");
}

/**
 * Send at most two requests: the original payload, then one defensive
 * autosave retry without canonical_url when Django alone rejects that field.
 *
 * @param {{
 *   isAuto: boolean,
 *   payload: Record<string, any>,
 *   send: (payload: Record<string, any>) => Promise<SaveAttempt>
 * }} options
 * @returns {Promise<SaveAttempt & {canonicalRejected: boolean, attempts: number}>}
 */
export async function saveWithCanonicalAutosaveFallback({
  isAuto,
  payload,
  send,
}) {
  const firstAttempt = await send(payload);

  if (
    !shouldRetryAutosaveWithoutCanonicalUrl({
      isAuto,
      attempt: firstAttempt,
      payload,
    })
  ) {
    return {
      ...firstAttempt,
      canonicalRejected: false,
      attempts: 1,
    };
  }

  const retryPayload = { ...payload };
  delete retryPayload.canonical_url;
  const retryAttempt = await send(retryPayload);

  return {
    ...retryAttempt,
    canonicalRejected: true,
    attempts: 2,
  };
}
