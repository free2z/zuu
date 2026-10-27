import * as env from "$app/env/private";
import * as publicEnv from "$app/env/public";
import { CANONICAL_ORIGIN } from "$lib/seo";
import {
  badRequestResponse,
  fetchSitemapBackend,
  MAX_SITEMAP_VARIANTS_PER_ZPAGE,
  notFoundResponse,
  parseSitemapChunkPayload,
  parseSitemapChild,
  renderUrlset,
  STATIC_SITEMAP_ENTRIES,
  unavailableResponse,
  xmlResponse,
} from "$lib/server/sitemap";
import type { SitemapKind } from "$lib/server/sitemap";
import type { RequestHandler } from "./$types";

const canonicalOrigin =
  publicEnv.PUBLIC_CANONICAL_BASE_URL?.replace(/\/$/, "") || CANONICAL_ORIGIN;

function parseKind(value: string): SitemapKind | null {
  return value === "creators" || value === "zpages" || value === "tags"
    ? value
    : null;
}

export async function _loadSitemapChunk(
  fetch: typeof globalThis.fetch,
  kind: SitemapKind,
  page: number,
  revision: string,
  requestSignal?: AbortSignal,
  timeoutMs?: number,
) {
  const apiBase = env.PRIVATE_API_BASE_URL?.replace(/\/$/, "") || "";
  if (!apiBase) throw new Error("PRIVATE_API_BASE_URL is not configured.");

  const { response, payload } = await fetchSitemapBackend(
    fetch,
    `${apiBase}/api/sitemap/${kind}/${page}/${revision}/`,
    requestSignal,
    timeoutMs,
    kind === "zpages"
      ? {
          "X-Free2Z-Sitemap-Canonical-Address": "1",
          // This replica's parser accepts exactly MAX_SITEMAP_VARIANTS_PER_ZPAGE
          // languages per row, and says so as a NUMBER. A row longer
          // than that bound makes `parseLanguages` throw, which 503s the whole
          // child and takes up to 499 unrelated articles offline — and Django
          // rolls BEFORE the frontend does, so during every rollout an old
          // reader is talking to a backend that already knows a larger number.
          //
          // 's boolean header could only ever mean "the 65-language
          // generation", so raising the publish cap to 96 would have 503'd
          // every sitemap child for the length of that rollout. Django answers
          // `min(this, its own maximum)`, so both directions of a mixed
          // rollout are safe and the NEXT cap change needs no new header.
          "X-Free2Z-Sitemap-Max-Variants": String(
            MAX_SITEMAP_VARIANTS_PER_ZPAGE,
          ),
          // Still sent for a Django replica that predates  and knows only
          // the boolean. That backend's maximum is 65, which this parser can
          // read, so the pair is safe in every combination.
          "X-Free2Z-Sitemap-Wide-Variants": "1",
        }
      : undefined,
  );
  const protocol = response.headers.get("x-sitemap-protocol");
  if (response.status === 409 && protocol === "2") return null;
  if (!response.ok) {
    const error = new Error(
      `Backend sitemap chunk failed with ${response.status}.`,
    );
    Object.assign(error, {
      status: response.status,
      protocol,
      retryAfter: response.headers.get("retry-after"),
    });
    throw error;
  }
  return parseSitemapChunkPayload(payload, kind, page, canonicalOrigin);
}

export const GET: RequestHandler = async ({ fetch, params, request, url }) => {
  if (url.search) return badRequestResponse();

  const kind = parseKind(params.kind);
  const child = parseSitemapChild(params.page);
  if (!kind || child === null) return notFoundResponse();

  try {
    const entries = await _loadSitemapChunk(
      fetch,
      kind,
      child.page,
      child.revision,
      request?.signal,
    );
    // A root index can be fetched immediately before a canonical/publish
    // mutation. Return a small valid sitemap for that now-stale capability so
    // a crawler never sees a retry storm or an externally-canonicalized URL.
    if (entries === null) {
      return xmlResponse(
        renderUrlset([STATIC_SITEMAP_ENTRIES[0]], canonicalOrigin),
        "no-store",
      );
    }
    // Dynamic sitemap contents can change at any save. Versioned paths keep
    // root/child pairs coherent, while no-store prevents a previously valid
    // Free2Z URL surviving a canonical_url mutation in a shared cache.
    return xmlResponse(renderUrlset(entries, canonicalOrigin), "no-store");
  } catch (cause) {
    if (
      cause instanceof Error &&
      "status" in cause &&
      (cause as Error & { status: number; protocol?: string }).status === 404 &&
      (cause as Error & { status: number; protocol?: string }).protocol === "2"
    ) {
      return notFoundResponse();
    }
    // A 404 from an old backend during a rolling deployment is not a valid
    // empty child: surface a retryable failure so crawlers never index HTML or
    // silently accept an incomplete sitemap.
    console.error("Unable to build a complete sitemap child.", cause);
    const retryAfter =
      cause instanceof Error && "retryAfter" in cause
        ? (cause as Error & { retryAfter?: string }).retryAfter
        : undefined;
    return unavailableResponse(retryAfter);
  }
};
