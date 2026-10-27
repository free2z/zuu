// The app's TanStack Query client, and the piece that keeps an SSR render from
// outliving its request.
//
// WHY THIS FILE EXISTS — the  heap leak, actually found
// -----------------------------------------------------------------------
// `new QueryClient()` lives in `+layout.svelte`, so on the server there is one
// per render and it is supposed to die with the request. It did not.
//
// Every `createQuery()` builds a `Query` in that client's `QueryCache`, and
// `Query extends Removable`, whose `scheduleGc()` does:
//
//     this.#gcTimeout = timeoutManager.setTimeout(() => this.optionalRemove(), this.gcTime)
//
// A pending `setTimeout` is a GC ROOT. Node's timer list holds the callback,
// the callback closes over the `Query`, the `Query` holds `options.queryFn`,
// and in a Svelte 5 SSR render that closure chain walks back through
// `$$store_subs` to the component's entire render context. So one armed gc
// timer pins the whole rendered page — measured at ~290KB for `/` — for the
// full `gcTime`, on a heap this container caps at 320MB.
//
// A heap snapshot taken under synthetic load names exactly that retaining path:
//
//     synthetic root -> global.setTimeout -> [context].timerListMap
//       -> TimersList[300000] -> Timeout._onTimeout -> closure
//       -> Query.options.queryFn ->...$$store_subs -> QueryObserver
//
// `TimersList[300000]` is LiveIndicator's `gcTime: 5 * 60 * 1000`, and
// LiveIndicator renders once per card — ~20 per homepage render.
//
// TanStack already knows server renders must not arm this timer: `updateGcTime`
// defaults to `isServer ? Infinity: 5 * 60 * 1000`, and `isValidTimeout`
// rejects `Infinity`, so a query with NO explicit gcTime schedules nothing on
// the server. The leak is what happens when a call site supplies a finite one —
// `Math.max(this.gcTime || 0, newGcTime ??...)` means an explicit option can
// only ever RAISE the value, never fall back to the server default.
//
// Fixing it by auditing every `gcTime:` for a `browser ?` guard would work
// today and rot immediately: the next `createQuery` with a plain `gcTime` puts
// the leak straight back, silently, with a green gate. So the teardown lives
// here instead — one call, at the request boundary, covering every query the
// render created regardless of its options.
import { browser } from "$app/env";
import { onDestroy } from "svelte";
import { QueryClient } from "@tanstack/svelte-query";

/**
 * The client every render gets. Options unchanged from when they lived inline
 * in `+layout.svelte`; only the location moved, so it can be constructed
 * identically from a test.
 */
export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        enabled: browser, // Only enable queries in browser context
        staleTime: 1000 * 60 * 5, // 5 minutes
        gcTime: 1000 * 60 * 10, // 10 minutes (formerly cacheTime)
        retry: (failureCount, error) => {
          // Don't retry on 4xx errors except 408, 429
          if (error && typeof error === "object" && "status" in error) {
            const status = error.status as number;
            if (
              status >= 400 &&
              status < 500 &&
              status !== 408 &&
              status !== 429
            ) {
              return false;
            }
          }
          return failureCount < 3;
        },
      },
    },
  });
}

/**
 * Drop everything a server render put in `client`.
 *
 * `QueryClient.clear()` -> `QueryCache.clear()` -> `remove(query)` ->
 * `query.destroy()` -> `Removable.clearGcTimeout()`. Clearing the gc timeout is
 * the load-bearing step: it is what takes the render out of Node's timer list
 * and therefore off the GC root set. Emptying the cache is the visible effect;
 * un-rooting the render is the point.
 *
 * Teardown runs after the response HTML is rendered. Server fetches may still
 * settle afterward, so cleanup also prevents those completions from arming a
 * fresh garbage-collection timer for the finished request.
 *
 * Exported separately from the registration below so a test can exercise the
 * teardown itself without needing a component instance.
 */
export function releaseSsrQueryClient(client: QueryClient): void {
  // A pending fetch can settle after clear() cancels and removes its query.
  // Query.fetch() schedules GC in its finally block, so prevent that late
  // completion from rooting the finished server render in a new timer.
  for (const query of client.getQueryCache().getAll()) {
    query.setOptions({ ...query.options, gcTime: Infinity });
  }
  client.clear();
}

/**
 * Arrange for `client` to be released when this server render ends.
 *
 * `onDestroy` is the only lifecycle hook Svelte runs during SSR: the renderer
 * collects the callbacks per component body and `Renderer.#close_render()`
 * invokes them, deepest component first, once the markup is accumulated. That
 * makes it the exact end-of-render boundary this needs.
 *
 * Browser-side this is a no-op on purpose. There the client is meant to outlive
 * every navigation — that cache is the whole point of the library — and the
 * root layout is destroyed only on unload, when the process is going away
 * anyway.
 *
 * Must be called during component initialisation (`onDestroy` requires it).
 */
export function registerSsrQueryClientRelease(client: QueryClient): void {
  if (browser) return;
  onDestroy(() => {
    releaseSsrQueryClient(client);
  });
}
