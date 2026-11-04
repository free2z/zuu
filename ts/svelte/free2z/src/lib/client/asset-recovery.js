export const ASSET_RECOVERY_STORAGE_KEY = "f2z:asset-recovery";
export const ASSET_RECOVERY_MAX_AGE_MS = 30_000;

/**
 * @param {unknown} value
 * @param {string} base
 * @returns {URL | null}
 */
function toUrl(value, base) {
  try {
    return value instanceof URL ? value : new URL(String(value), base);
  } catch {
    return null;
  }
}

/**
 * Only hashed SvelteKit assets and the version probe can identify a mixed
 * revision. Ordinary application errors must not trigger a full reload.
 *
 * @param {unknown} value
 * @param {string} [base]
 * @returns {boolean}
 */
export function isSvelteKitAssetUrl(value, base = "https://free2z.cash/") {
  const url = toUrl(value, base);
  return Boolean(
    url &&
    (url.pathname === "/_app/version.json" ||
      url.pathname.startsWith("/_app/immutable/")),
  );
}

/**
 * Browser engines and Vite use several messages for a failed chunk import.
 * Keep this matcher deliberately narrow: a random rejected promise must not
 * become a reload loop.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSvelteKitAssetErrorMessage(value) {
  const message =
    typeof value === "string"
      ? value
      : value && typeof value === "object" && "message" in value
        ? String(value.message)
        : "";

  return /failed to fetch dynamically imported module|importing a module script failed|loading (?:chunk|css).*failed|chunkloaderror/i.test(
    message,
  );
}

/**
 * Remove a marker left by a recovery in a previous document once its guard
 * window has elapsed.
 *
 * @param {Storage} storage
 * @param {number} [now]
 */
export function clearExpiredAssetRecovery(storage, now = Date.now()) {
  try {
    const raw = storage.getItem(ASSET_RECOVERY_STORAGE_KEY);
    if (!raw) return;
    const marker = JSON.parse(raw);
    const age = now - Number(marker?.timestamp);
    if (!Number.isFinite(age) || age < 0 || age > ASSET_RECOVERY_MAX_AGE_MS) {
      storage.removeItem(ASSET_RECOVERY_STORAGE_KEY);
    }
  } catch {
    // A corrupt marker must never prevent recovery forever.
    try {
      storage.removeItem(ASSET_RECOVERY_STORAGE_KEY);
    } catch {
      // Storage may be disabled by the browser.
    }
  }
}

/**
 * Claim the one guarded reload allowed for this page URL during the guard
 * window. Returning false is important when sessionStorage is unavailable:
 * repeatedly reloading without a durable marker would be worse than leaving
 * the current document in its error state.
 *
 * @param {Storage} storage
 * @param {string} pageUrl
 * @param {number} [now]
 * @returns {boolean}
 */
export function claimAssetRecovery(storage, pageUrl, now = Date.now()) {
  try {
    const raw = storage.getItem(ASSET_RECOVERY_STORAGE_KEY);
    if (raw) {
      const marker = JSON.parse(raw);
      const age = now - Number(marker?.timestamp);
      if (
        marker?.url === pageUrl &&
        Number.isFinite(age) &&
        age >= 0 &&
        age <= ASSET_RECOVERY_MAX_AGE_MS
      ) {
        return false;
      }
    }

    storage.setItem(
      ASSET_RECOVERY_STORAGE_KEY,
      JSON.stringify({ timestamp: now, url: pageUrl }),
    );
    return true;
  } catch {
    return false;
  }
}
