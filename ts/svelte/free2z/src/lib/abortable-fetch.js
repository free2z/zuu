/**
 * Await the response headers from a fetch while also observing its abort
 * signal. Some server fetch implementations do not settle their returned
 * promise promptly when the signal aborts before response headers arrive.
 * The race lets callers finish their own deadline; the signal still cancels
 * the underlying request, and a response that arrives late has its body
 * cancelled instead of being left unread.
 *
 * @template T
 * @param {() => Promise<T>} startFetch
 * @param {AbortSignal} signal
 * @param {(response: T) => void} cancelLateResponse
 * @returns {Promise<T>}
 */
export function fetchWithAbort(startFetch, signal, cancelLateResponse) {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }

  /** @type {(reason: unknown) => void} */
  let rejectAbort = () => {};
  const aborted = new Promise((_, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });

  // Defer starting until the abort listener is installed. If this request is
  // aborted before headers arrive, a late response must not retain its body.
  const request = Promise.resolve()
    .then(() => {
      if (signal.aborted) throw signal.reason;
      return startFetch();
    })
    .then((response) => {
      if (signal.aborted) {
        cancelLateResponse(response);
        throw signal.reason;
      }
      return response;
    });

  return Promise.race([request, aborted]).finally(() => {
    signal.removeEventListener("abort", onAbort);
  });
}
