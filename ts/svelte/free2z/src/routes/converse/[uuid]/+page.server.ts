import { error, isHttpError } from "@sveltejs/kit";
import * as env from "$app/env/private";
import type { PageServerLoad } from "./$types";
import { CANONICAL_CONTENT_URL_HEADERS } from "$lib/api/canonical-content-url";
import { loadFirstPartyCardSeed } from "$lib/server/first-party-embed-cards";
import { forwardableRetryAfter } from "$lib/server/upstream-status";
import { createAbortSignalWithTimeout } from "$lib/abort-signal.js";
import {
  CONVERSE_ANCESTOR_WALK_TIMEOUT_MS,
  CONVERSE_MAX_ANCESTOR_DEPTH,
} from "$lib/converse-ssr-bounds.js";

const WALK_DEADLINE = Symbol("converse-ancestor-walk-deadline");

export const load: PageServerLoad = async ({
  params,
  request,
  fetch,
  setHeaders,
  locals,
  url,
  isDataRequest,
}) => {
  try {
    const { uuid } = params;
    const cookie = request?.headers?.get("cookie");
    // Comment visibility can depend on the forwarded session. Keep public
    // responses variant-aware and keep cookie-backed conversation renders out
    // of shared caches.
    setHeaders(
      cookie
        ? { "cache-control": "private, no-cache", vary: "Cookie" }
        : { vary: "Cookie" },
    );
    const apiBase = env.PRIVATE_API_BASE_URL || "";
    const headers = {
      ...CANONICAL_CONTENT_URL_HEADERS,
      ...(cookie ? { cookie } : {}),
    };

    // A throttle is the API's answer to THIS visitor (SSR forwards their
    // session; anonymous comment reads are not throttled), so it stays a 429
    // with the API's Retry-After, as on every other SSR route. It
    // must not become a 503: nginx retries a 503 on another pod and then
    // replaces it with the site-wide maintenance page for a human.
    const throwIfTransient = (upstream: Response) => {
      if (upstream.status === 429) {
        const retryAfter = forwardableRetryAfter(
          upstream.headers.get("retry-after"),
        );
        if (retryAfter) setHeaders({ "retry-after": retryAfter });
        throw error(429, "errors.http.429.title", { code: 429 });
      }
      if (upstream.status >= 500) {
        throw error(503, "errors.http.503.title", { code: 503 });
      }
    };

    const response = await fetch(`${apiBase}/api/comments/${uuid}/`, {
      headers,
    });

    if (!response.ok) {
      // Only an answer ABOUT the post is a 404. A throttle (429) or a backend
      // 5xx says nothing about whether it exists, and a "not found" here is
      // what a social unfurler caches as the link's card (: unfurlers
      // reach this route since the Django card tier was retired). A 5xx is a
      // 503, which nginx's crawler location turns into a retryable 503.
      throwIfTransient(response);
      throw error(404, "errors.conversation.notFound", { code: 404 });
    }

    const selectedComment = await response.json();
    let comment = selectedComment;
    const visited = new Set<string>();
    //the walk to the root is bounded twice -- a hop cap (fan-out on a
    // deep chain) and ONE deadline over every hop and body (a stalled
    // ancestor). The cap is deterministic, so hitting it renders the deepest
    // ancestor reached and hands the page its parent for a "view earlier"
    // link; that page walks the next stretch. The deadline is a slow
    // backend, i.e. transient, so it is a retryable 503 like an ancestor 5xx.
    // See $lib/converse-ssr-bounds.js.
    let ancestorsFetched = 0;
    let truncatedByDepth = false;
    const walk = createAbortSignalWithTimeout(
      request?.signal,
      CONVERSE_ANCESTOR_WALK_TIMEOUT_MS,
    );
    // Raced against each hop as well as passed as its signal: the deadline
    // must hold even for a fetch (or a body) that does not honour abort.
    const deadline = new Promise<typeof WALK_DEADLINE>((resolve) => {
      if (walk.signal.aborted) resolve(WALK_DEADLINE);
      else
        walk.signal.addEventListener("abort", () => resolve(WALK_DEADLINE), {
          once: true,
        });
    });

    try {
      while (comment.parent && !visited.has(comment.uuid)) {
        if (ancestorsFetched >= CONVERSE_MAX_ANCESTOR_DEPTH) {
          truncatedByDepth = true;
          break;
        }
        visited.add(comment.uuid);
        const parentUuid = comment.parent;
        const hop = (async () => {
          const upstream = await fetch(
            `${apiBase}/api/comments/${parentUuid}/`,
            {
              headers,
              signal: walk.signal,
            },
          );
          if (!upstream.ok) {
            // Same rule as the first fetch: a transient failure must not
            // render a 200 card titled after the reply (or a middle
            // ancestor) when the healthy page is titled after the root --
            // an unfurler would cache the wrong card. A genuine 404/403
            // ancestor (deleted, hidden) still stops the walk, as before.
            throwIfTransient(upstream);
            return null;
          }
          return upstream.json();
        })();
        let next;
        try {
          next = await Promise.race([hop, deadline]);
        } catch (hopError) {
          if (isHttpError(hopError) || !walk.signal.aborted) throw hopError;
          next = WALK_DEADLINE;
        }
        if (next === WALK_DEADLINE) {
          // Same rule as an ancestor 5xx above: a render titled after
          // whichever ancestor happened to arrive in time is a card an
          // unfurler would keep after the backend recovers (no-store does not
          // stop it extracting the tags). Retryable, never "not found".
          throw error(503, "errors.http.503.title", { code: 503 });
        }
        if (next === null) break;
        comment = next;
        ancestorsFetched += 1;
      }
    } finally {
      walk.cleanup();
    }

    // `::embed[]` cards in the server-rendered root post, as THIS
    // reader (their cookie; none when anonymous). Replies load in the
    // browser and resolve there, inside the same page budget (the seed's
    // calls count against it). Never throws.
    const firstPartyCardSeed = await loadFirstPartyCardSeed({
      contents: [comment?.content],
      browserResolvesDataRequest: isDataRequest,
      fetch,
      cookie,
      locale: locals?.locale,
      signal: request?.signal,
      requestHostname: url?.hostname,
    });

    return {
      comment,
      focusUuid: selectedComment.uuid,
      // Set only when the depth cap stopped the walk short of the root.
      earlierUuid: truncatedByDepth ? (comment.parent as string) : null,
      firstPartyCardSeed,
    };
  } catch (err) {
    if (isHttpError(err)) throw err;
    // A transport failure (connection refused mid-rollout, a reset, a bad
    // body) is equally no evidence that the post is gone.
    console.error("Failed to load conversation", err);
    throw error(503, "errors.http.503.title", { code: 503 });
  }
};
