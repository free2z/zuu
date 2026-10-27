import { createAbortSignalWithTimeout } from "../abort-signal.js";
import { fetchWithAbort } from "../abortable-fetch.js";
import { ARTICLE_ENRICHMENT_TIMEOUT_MS } from "../article-ssr-deadlines.js";
import type { ZPageDetail, ZPageList } from "$lib/api/f2z.schemas";

type EnrichmentFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;
type ApiUrlBuilder = (
  path: string,
  params?: Record<string, string | number | undefined>,
) => string;
type SsrErrorLogger = (
  event: string,
  error: unknown,
  fields: Record<string, string>,
) => void;
type CanonicalPathBuilder = (page: {
  creator?: { username?: string | null } | null;
  vanity?: string | null;
  free2zaddr?: string | null;
}) => string | null;

type SeriesApiResponse = {
  id: string;
  name: string;
  pageorder_set?: Array<{ page: ZPageList; order: number }>;
};

export type SeriesPageSummary = {
  free2zaddr: string;
  vanity?: string | null;
  title: string;
  username: string;
  order: number;
  url: string;
};

export type SeriesContext = {
  id: string;
  name: string;
  position: number;
  count: number;
  pages: SeriesPageSummary[];
  previous: SeriesPageSummary | null;
  next: SeriesPageSummary | null;
};

// A fetch signal alone does not reliably end a stalled response body on all
// supported server paths. Own the reader so the same deadline settles the
// deferred value and cancels body consumption even after headers have arrived.
async function readEnrichmentJson(response: Response, signal: AbortSignal) {
  if (signal.aborted) {
    void response.body?.cancel().catch(() => {});
    throw signal.reason;
  }
  if (!response.body) return JSON.parse("");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => {
    rejectAbort(signal.reason);
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const consume = async () => {
      let body = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (signal.aborted) throw signal.reason;
        if (done) return JSON.parse(body + decoder.decode());
        body += decoder.decode(value, { stream: true });
      }
    };
    return await Promise.race([consume(), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

async function loadRelatedArticles(
  article: ZPageDetail,
  eventFetch: EnrichmentFetch,
  locale: string,
  requestSignal: AbortSignal,
  buildApiUrl: ApiUrlBuilder,
  logSsrError: SsrErrorLogger,
) {
  const abort = createAbortSignalWithTimeout(
    requestSignal,
    ARTICLE_ENRICHMENT_TIMEOUT_MS,
  );
  try {
    const response = await fetchWithAbort(
      () =>
        eventFetch(
          buildApiUrl(
            `/api/zpage/${encodeURIComponent(article.free2zaddr)}/related/`,
            { lang: locale },
          ),
          { credentials: "omit", signal: abort.signal },
        ),
      abort.signal,
      (lateResponse) => {
        void lateResponse.body?.cancel().catch(() => {});
      },
    );
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      return [] as ZPageList[];
    }

    const payload = await readEnrichmentJson(response, abort.signal);
    return Array.isArray(payload) ? (payload as ZPageList[]) : [];
  } catch (relatedError) {
    logSsrError("zpage_related_failed", relatedError, {
      free2zaddr: article.free2zaddr,
    });
    return [] as ZPageList[];
  } finally {
    // Keep the deadline active until JSON body consumption has settled.
    abort.cleanup();
  }
}

function seriesPageSummary(
  order: { page: ZPageList; order: number },
  canonicalPath: CanonicalPathBuilder,
) {
  const page = order.page;
  const username = page.creator?.username || "";
  return {
    free2zaddr: page.free2zaddr,
    vanity: page.vanity,
    title: page.title,
    username,
    order: order.order,
    url: canonicalPath(page) || page.get_url || "/",
  } satisfies SeriesPageSummary;
}

async function loadSeriesContext(
  article: ZPageDetail,
  eventFetch: EnrichmentFetch,
  locale: string,
  requestSignal: AbortSignal,
  buildApiUrl: ApiUrlBuilder,
  logSsrError: SsrErrorLogger,
  canonicalPath: CanonicalPathBuilder,
): Promise<SeriesContext | null> {
  const abort = createAbortSignalWithTimeout(
    requestSignal,
    ARTICLE_ENRICHMENT_TIMEOUT_MS,
  );
  try {
    const response = await fetchWithAbort(
      () =>
        eventFetch(
          buildApiUrl(
            `/api/g12f/zpage/${encodeURIComponent(article.free2zaddr)}/series/`,
            { lang: locale },
          ),
          { credentials: "omit", signal: abort.signal },
        ),
      abort.signal,
      (lateResponse) => {
        void lateResponse.body?.cancel().catch(() => {});
      },
    );
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      return null;
    }

    const series = (await readEnrichmentJson(
      response,
      abort.signal,
    )) as SeriesApiResponse;
    const orders = [...(series.pageorder_set || [])].sort(
      (left, right) => left.order - right.order,
    );
    const currentIndex = orders.findIndex(
      ({ page }) =>
        page.free2zaddr === article.free2zaddr ||
        (!!article.vanity && page.vanity === article.vanity),
    );
    if (currentIndex < 0) return null;

    return {
      id: series.id,
      name: series.name,
      position: currentIndex + 1,
      count: orders.length,
      pages: orders.map((order) => seriesPageSummary(order, canonicalPath)),
      previous:
        currentIndex > 0
          ? seriesPageSummary(orders[currentIndex - 1], canonicalPath)
          : null,
      next:
        currentIndex + 1 < orders.length
          ? seriesPageSummary(orders[currentIndex + 1], canonicalPath)
          : null,
    };
  } catch (seriesError) {
    logSsrError("zpage_series_failed", seriesError, {
      free2zaddr: article.free2zaddr,
    });
    return null;
  } finally {
    // Keep the deadline active until JSON body consumption has settled.
    abort.cleanup();
  }
}

/** Start the optional promises returned by the article server loader. */
export function loadArticleEnrichments(
  article: ZPageDetail,
  eventFetch: EnrichmentFetch,
  locale: string,
  requestSignal: AbortSignal,
  buildApiUrl: ApiUrlBuilder,
  logSsrError: SsrErrorLogger,
  canonicalPath: CanonicalPathBuilder,
) {
  return {
    relatedArticles: loadRelatedArticles(
      article,
      eventFetch,
      locale,
      requestSignal,
      buildApiUrl,
      logSsrError,
    ),
    seriesContext: loadSeriesContext(
      article,
      eventFetch,
      locale,
      requestSignal,
      buildApiUrl,
      logSsrError,
      canonicalPath,
    ),
  };
}
