import { error, redirect } from "@sveltejs/kit";
import * as env from "$app/env/private";
import { createAbortSignalWithTimeout } from "$lib/abort-signal.js";
import {
  historicRootAdmission,
  historicRootClientKey,
} from "$lib/server/historic-root-admission.js";
import { isNullishSlug } from "$lib/zpage-slug";
import { zpageCanonicalPath } from "$lib/zpage-path";
import type { ZPageDetail } from "$lib/api/f2z.schemas";
import type { PageServerLoad } from "./$types";

type GatedArticleResponse = { show_modal: boolean; page: ZPageDetail };
const LEGACY_ARTICLE_LOOKUP_TIMEOUT_MS = 10_000;

// Historic emitters used both slash shapes. Handle both here so SvelteKit's
// default trailing-slash normalizer cannot publish an extra 308 to the legacy
// URL before this route resolves the page identity and returns the one
// collision-safe, query-preserving 301.
export const trailingSlash = "ignore";

export const load: PageServerLoad = async ({
  params,
  url,
  request,
  fetch,
  setHeaders,
}) => {
  //a literal `null`/`undefined` slug can only 404 at the destination,
  // so 301-ing it would publish a redirect *chain* that ends in a 404 — two
  // crawler round trips and two SSR renders for an answer we already know.
  // Say 404 here instead.
  if (isNullishSlug(params.slug)) {
    throw error(404, "errors.article.notFound", { code: 404 });
  }

  // The redirect is permanent but its vanity can be renamed or reused, and
  // lookup failures must not become sticky CDN/browser answers either.
  setHeaders({ "cache-control": "no-store" });

  const apiBase = env.PRIVATE_API_BASE_URL?.replace(/\/$/, "");
  if (!apiBase) {
    console.error("Legacy article lookup has no private API base");
    throw error(503, "Failed to load article", { code: 503 });
  }

  // This compatibility endpoint accepts arbitrary legacy identifiers and the
  // backend resolver can reach its case-insensitive fallback twice on a miss.
  // Reuse the bounded per-client admission applied to historic root links so
  // scanners cannot turn every request into two database scans. Missing or
  // malformed proxy identity retains that helper's deliberate fail-open path.
  const clientKey = historicRootClientKey({ request });
  if (clientKey) {
    const admission = historicRootAdmission.admit(clientKey);
    if (!admission.admitted) {
      setHeaders({ "retry-after": String(admission.retryAfterSeconds) });
      throw error(429, "Failed to load article", { code: 429 });
    }
  }

  const lookupAbort = createAbortSignalWithTimeout(
    request.signal,
    LEGACY_ARTICLE_LOOKUP_TIMEOUT_MS,
  );
  let response: Response;
  try {
    const cookie = request.headers.get("cookie");
    response = await fetch(
      `${apiBase}/api/zpage/${encodeURIComponent(params.slug)}/`,
      {
        headers: cookie ? { cookie } : undefined,
        signal: lookupAbort.signal,
      },
    );
  } catch (cause) {
    lookupAbort.cleanup();
    console.error("Failed to resolve legacy article URL", cause);
    throw error(503, "Failed to load article", { code: 503 });
  }

  if (response.status === 404) {
    response.body?.cancel().catch(() => {});
    lookupAbort.cleanup();
    throw error(404, "errors.article.notFound", { code: 404 });
  }
  if (response.status === 429) {
    response.body?.cancel().catch(() => {});
    lookupAbort.cleanup();
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter) setHeaders({ "retry-after": retryAfter });
    throw error(429, "Failed to load article", { code: 429 });
  }
  if (!response.ok) {
    response.body?.cancel().catch(() => {});
    lookupAbort.cleanup();
    throw error(503, "Failed to load article", { code: 503 });
  }

  let payload: ZPageDetail | GatedArticleResponse;
  try {
    payload = (await response.json()) as ZPageDetail | GatedArticleResponse;
  } catch (cause) {
    console.error("Legacy article lookup returned invalid JSON", cause);
    throw error(503, "Failed to load article", { code: 503 });
  } finally {
    lookupAbort.cleanup();
  }
  if (!payload || typeof payload !== "object") {
    throw error(503, "Failed to load article", { code: 503 });
  }
  const article = "page" in payload ? payload.page : payload;
  if (!article || typeof article !== "object") {
    throw error(503, "Failed to load article", { code: 503 });
  }
  const canonicalPath = zpageCanonicalPath(article);
  if (!canonicalPath) {
    throw error(503, "Failed to load article", { code: 503 });
  }

  redirect(301, `${canonicalPath}${url.search}`);
};
