import { updated } from "$app/state";
import {
  claimAssetRecovery,
  clearExpiredAssetRecovery,
  isSvelteKitAssetErrorMessage,
  isSvelteKitAssetUrl,
} from "$lib/client/asset-recovery.js";

const recoveryStorage = (() => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
})();

if (recoveryStorage) {
  clearExpiredAssetRecovery(recoveryStorage);
}

let recoveryStarted = false;

/**
 * A missing hashed asset can happen when the Service sends HTML and the next
 * request to a different revision. Ask SvelteKit to check its deterministic
 * version endpoint, then reload the same URL once. sessionStorage prevents a
 * persistent skew from turning into an infinite refresh loop.
 *
 * @param {string} [asset]
 */
async function recoverFromAssetFailure(asset?: string) {
  if (recoveryStarted || !recoveryStorage) return;

  if (!claimAssetRecovery(recoveryStorage, window.location.href)) return;
  recoveryStarted = true;

  console.warn("[free2z] recovering from a stale SvelteKit asset", {
    asset,
    page: window.location.pathname,
  });

  try {
    await Promise.race([
      updated.check(),
      new Promise<void>((resolve) => window.setTimeout(resolve, 1500)),
    ]);
  } catch {
    // A failed version probe is itself consistent with an in-flight rollout.
  }

  window.location.reload();
}

function assetUrlFromTarget(target: EventTarget | null) {
  if (target instanceof HTMLScriptElement) return target.src;
  if (target instanceof HTMLLinkElement) return target.href;
  return "";
}

function handleAssetError(event: ErrorEvent) {
  const targetUrl = assetUrlFromTarget(event.target);
  if (
    (targetUrl && isSvelteKitAssetUrl(targetUrl, window.location.href)) ||
    isSvelteKitAssetErrorMessage(event.message)
  ) {
    void recoverFromAssetFailure(targetUrl || undefined);
  }
}

function handleRejectedAsset(event: PromiseRejectionEvent) {
  if (isSvelteKitAssetErrorMessage(event.reason)) {
    void recoverFromAssetFailure();
  }
}

window.addEventListener("error", handleAssetError, true);
window.addEventListener("unhandledrejection", handleRejectedAsset);
window.addEventListener("vite:preloadError", (event) => {
  event.preventDefault();
  void recoverFromAssetFailure();
});
