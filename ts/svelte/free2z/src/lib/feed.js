/**
 * Helpers for the paginated mobile feed (see MobileFeed.svelte).
 *
 * Extracted from the component so the de-duplication rule is unit-testable:
 * it guards a crash, not a cosmetic issue.
 */

/**
 * Stable identity for a zpage row.
 *
 * @param {any} article
 * @returns {string} the key, or "" when the row has no usable identity
 */
export function zpageKey(article) {
  const key = article?.free2zaddr ?? article?.vanity ?? article?.id;
  return key === undefined || key === null ? "" : String(key);
}

/**
 * Abort one complete load-more chain after a fixed deadline. The same signal
 * is shared by duplicate-page recovery attempts, so three slow requests cannot
 * each consume a full timeout independently.
 *
 * @param {AbortController} controller
 * @param {number} timeoutMs
 */
export function createAbortDeadline(controller, timeoutMs) {
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, timeoutMs);

  return {
    get expired() {
      return expired;
    },
    clear() {
      clearTimeout(timer);
    },
  };
}

/**
 * DRF's paginator returns a distinctive JSON detail when an offset page
 * disappears after catalogue shrinkage. A generic/plain 404 may instead be a
 * proxy or routing failure and must remain retryable.
 *
 * @param {number} status
 * @param {unknown} body
 */
export function isDrfPageOutOfRange(status, body) {
  if (status !== 404 || !body || typeof body !== "object") return false;
  const detail = /** @type {{ detail?: unknown }} */ (body).detail;
  return typeof detail === "string" && /^invalid page\.?$/i.test(detail.trim());
}

/**
 * Locale changes and component teardown deliberately abort an active request
 * and should stay silent. A deadline abort is different: the reader needs a
 * visible retry action.
 *
 * @param {{ isCurrent: boolean, aborted: boolean, timedOut: boolean }} state
 */
export function shouldReportFeedFailure(state) {
  return state.isCurrent && (!state.aborted || state.timedOut);
}

/**
 * Normalize an API-provided next link without exposing the backend origin to
 * the browser. Only the zpage collection endpoint is accepted.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function asRelativeZpagePageUrl(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = new URL(value, "http://free2z.invalid");
    if (parsed.pathname !== "/api/zpage/") return null;
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

/**
 * Calculate a bounded render window for fixed-height mobile feed rows.
 *
 * The full logical list remains available for de-duplication and navigation,
 * but only the visible rows plus a small overscan are mounted in the DOM.
 *
 * @param {{
 *   itemCount: number,
 *   scrollTop: number,
 *   listTop: number,
 *   viewportHeight: number,
 *   rowStride: number,
 *   overscan: number,
 * }} state
 */
export function calculateVirtualFeedWindow(state) {
  const itemCount = Math.max(0, Math.floor(state.itemCount || 0));
  const rowStride = Math.max(1, state.rowStride || 1);
  const overscan = Math.max(0, Math.floor(state.overscan || 0));
  const viewportHeight = Math.max(1, state.viewportHeight || 1);
  const localScroll = Math.max(
    0,
    (state.scrollTop || 0) - (state.listTop || 0),
  );
  const firstVisible = Math.min(itemCount, Math.floor(localScroll / rowStride));
  const visibleCount = Math.max(1, Math.ceil(viewportHeight / rowStride));
  const start = Math.max(0, firstVisible - overscan);
  const end = Math.min(itemCount, firstVisible + visibleCount + overscan);

  return {
    start,
    end,
    topSpacer: start * rowStride,
    bottomSpacer: Math.max(0, itemCount - end) * rowStride,
  };
}

/**
 * Incremental pager that never yields the same row twice.
 *
 * Cursor pages should be disjoint, but duplicate suppression remains useful
 * during mixed-version deployments and against malformed or stale proxy
 * responses. Svelte's keyed `{#each}` throws on a duplicate key, which would
 * take down the whole feed.
 *
 * @param {any[]} [initial] rows already rendered (e.g. from SSR)
 */
export function createFeedPager(initial = []) {
  const items = [...initial];
  const seen = new Set(items.map(zpageKey).filter(Boolean));

  return {
    /** @returns {any[]} the rows to render, in order */
    get items() {
      return items;
    },

    /**
     * Append only rows not already present.
     *
     * Rows without a usable key are dropped: they cannot be de-duplicated,
     * and Svelte cannot key them either.
     *
     * @param {any[]} incoming
     * @returns {number} how many rows were actually added
     */
    append(incoming) {
      let added = 0;
      for (const article of incoming || []) {
        const key = zpageKey(article);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        items.push(article);
        added += 1;
      }
      return added;
    },
  };
}
