// A read-only Svelte store whose value is per-request on the server.
//
// The naive version of this — make the base locale store request-aware and let
// `derived(locale, …)` inherit the isolation — does not work, and the trap is
// worth spelling out. `derived` starts its source subscription when its own
// subscriber count goes 0 → 1 and caches the computed value for as long as any
// subscriber remains. Under overlapping SSR that means request A subscribes
// first, the derived captures A's locale, and request B — subscribing while A
// is still suspended — is handed A's cached value without the source store ever
// being consulted again. Every `$t` in the app goes through such a derived, so
// that path is the whole bug, not an edge of it.
//
// Wrapping instead of deriving keeps the sampling at the subscription itself:
// `subscribe` is a plain function call, so it re-reads the request scope for
// every subscriber, and there is no shared cached value to inherit.

/**
 * @template T
 * @param {import("svelte/store").Readable<T>} fallback
 *   Store used when there is no request scope — the browser, prerendering,
 *   scripts. Its behaviour is completely unchanged.
 * @param {() => T | null} scopedValue
 *   The value for the in-flight request, or null when there is no request
 *   scope.
 * @returns {import("svelte/store").Readable<T>}
 */
export function requestScopedStore(fallback, scopedValue) {
  return {
    subscribe(run, invalidate) {
      const value = scopedValue();
      if (value !== null && value !== undefined) {
        // A request's value is fixed for the life of the request, so a single
        // emission is the whole subscription.
        run(value);
        return () => {};
      }
      return fallback.subscribe(run, invalidate);
    },
  };
}
