import * as env from "$app/env/private";
import * as publicEnv from "$app/env/public";
import { CANONICAL_ORIGIN } from "$lib/seo";
import {
  badRequestResponse,
  fetchSitemapBackend,
  parseSitemapIndexPayload,
  renderSitemapIndex,
  unavailableResponse,
  xmlResponse,
} from "$lib/server/sitemap";
import type { RequestHandler } from "./$types";

const canonicalOrigin =
  publicEnv.PUBLIC_CANONICAL_BASE_URL?.replace(/\/$/, "") || CANONICAL_ORIGIN;

export async function _loadSitemapIndex(
  fetch: typeof globalThis.fetch,
  requestSignal?: AbortSignal,
  timeoutMs?: number,
) {
  const apiBase = env.PRIVATE_API_BASE_URL?.replace(/\/$/, "") || "";
  if (!apiBase) throw new Error("PRIVATE_API_BASE_URL is not configured.");

  const { response, payload } = await fetchSitemapBackend(
    fetch,
    `${apiBase}/api/sitemap/`,
    requestSignal,
    timeoutMs,
  );
  if (!response.ok) {
    const error = new Error(
      `Backend sitemap index failed with ${response.status}.`,
    );
    Object.assign(error, {
      status: response.status,
      protocol: response.headers.get("x-sitemap-protocol"),
      retryAfter: response.headers.get("retry-after"),
    });
    throw error;
  }

  return parseSitemapIndexPayload(payload);
}

export const GET: RequestHandler = async ({ fetch, request, url }) => {
  if (url.search) return badRequestResponse();

  try {
    const manifest = await _loadSitemapIndex(fetch, request?.signal);
    const paths = [
      "/sitemap/static.xml",
      ...manifest.creators.map(
        ({ page, revision }) => `/sitemap/creators/${page}-${revision}.xml`,
      ),
      ...manifest.zpages.map(
        ({ page, revision }) => `/sitemap/zpages/${page}-${revision}.xml`,
      ),
      // Tag hubs last: an old backend simply omits them, and the
      // order here is the order a crawler works through the index.
      ...manifest.tags.map(
        ({ page, revision }) => `/sitemap/tags/${page}-${revision}.xml`,
      ),
    ];
    // The index contains only versioned child capabilities, never content
    // URLs. A short root TTL limits references to children invalidated by a
    // concurrent publish/canonical change.
    return xmlResponse(
      renderSitemapIndex(paths, canonicalOrigin),
      "public, max-age=300",
    );
  } catch (cause) {
    console.error("Unable to build a complete sitemap index.", cause);
    const retryAfter =
      cause instanceof Error && "retryAfter" in cause
        ? (cause as Error & { retryAfter?: string }).retryAfter
        : undefined;
    return unavailableResponse(retryAfter);
  }
};
