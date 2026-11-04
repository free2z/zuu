/**
 * Combine a caller-owned abort signal with a timeout without relying on
 * AbortSignal.any() or AbortSignal.timeout(). Those APIs are newer than the
 * browser baseline used by the client bundle.
 *
 * @param {AbortSignal | null | undefined} parentSignal
 * @param {number} timeoutMs
 * @returns {{ signal: AbortSignal, cleanup: () => void }}
 */
export function createAbortSignalWithTimeout(parentSignal, timeoutMs) {
  const controller = new AbortController();
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  let cleanedUp = false;

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    parentSignal?.removeEventListener("abort", abortFromParent);
  };

  const abortFromParent = () => {
    controller.abort(parentSignal?.reason);
    cleanup();
  };

  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
    // A caller can abort between the initial check and listener setup. The
    // second check keeps that race from arming a timer after cancellation.
    if (parentSignal?.aborted) {
      abortFromParent();
    } else {
      timer = setTimeout(() => {
        controller.abort(
          new DOMException(
            "The operation was aborted due to timeout",
            "TimeoutError",
          ),
        );
        cleanup();
      }, timeoutMs);
    }
  }

  return { signal: controller.signal, cleanup };
}
