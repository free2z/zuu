import type { ZPageList } from "$lib/api/f2z.schemas";
import type { PublicSeries } from "$lib/types/search";
import { createAbortSignalWithTimeout } from "$lib/abort-signal.js";

export interface SeriesLookupResult {
  results: PublicSeries[];
  hadFailures: boolean;
}

/**
 * Series discovery is a secondary enrichment fan-out (one request per result
 * page). It must never be able to hold the primary search results hostage, so
 * every request is bounded by its own timeout in addition to the caller's
 * abort signal. A hung/flapping series endpoint degrades to `hadFailures`
 * instead of an unresolved promise.
 */
const SERIES_REQUEST_TIMEOUT_MS = 4000;

export async function findSeriesForPages(
  pages: ZPageList[],
  signal: AbortSignal,
  limit = 4,
  language?: string,
): Promise<SeriesLookupResult> {
  const addresses = Array.from(
    new Set(
      pages.map((page) => page.free2zaddr || page.vanity).filter(Boolean),
    ),
  ).slice(0, 10);

  const responses = await Promise.allSettled(
    addresses.map(async (address) => {
      const requestSignal = createAbortSignalWithTimeout(
        signal,
        SERIES_REQUEST_TIMEOUT_MS,
      );
      try {
        const response = await fetch(
          `/api/g12f/zpage/${encodeURIComponent(String(address))}/series/${language ? `?lang=${encodeURIComponent(language)}` : ""}`,
          { signal: requestSignal.signal },
        );
        if (response.status === 404) return { series: null, failed: false };
        if (!response.ok) return { series: null, failed: true };
        return {
          series: (await response.json()) as PublicSeries,
          failed: false,
        };
      } finally {
        requestSignal.cleanup();
      }
    }),
  );
  signal.throwIfAborted();

  const unique = new Map<string, PublicSeries>();
  let hadFailures = false;
  for (const response of responses) {
    if (response.status !== "fulfilled") {
      hadFailures = true;
      continue;
    }
    hadFailures ||= response.value.failed;
    if (!response.value.series?.id) continue;
    unique.set(response.value.series.id, response.value.series);
  }
  return {
    results: Array.from(unique.values()).slice(0, limit),
    hadFailures,
  };
}
