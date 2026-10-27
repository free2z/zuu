import type { PageServerLoad } from "./$types";
import { error, redirect } from "@sveltejs/kit";
import * as env from "$app/env/private";
import type { TagSuggestion } from "$lib/api/f2z.schemas";
import { createAbortSignalWithTimeout } from "$lib/abort-signal.js";
import {
  historicRootAdmission,
  historicRootClientKey,
  historicRootForwardedFor,
} from "$lib/server/historic-root-admission.js";
import { zpageCanonicalPath } from "$lib/zpage-path.js";
import { parseBioFrontmatter } from "$lib/utils/bio.js";
import { loadFirstPartyCardSeed } from "$lib/server/first-party-embed-cards";
import {
  isExpectedOutcome,
  logSsrError,
  logSsrWarning,
} from "$lib/server/ssr-log";
import {
  upstreamClientError,
  upstreamErrorMessage,
} from "$lib/server/upstream-status";

const PROFILE_LOAD_TIMEOUT_MS = 45_000;
const ROOT_ZPAGE_LOOKUP_TIMEOUT_MS = 10_000;

export const load: PageServerLoad = async (event) => {
  // The localhost sidecar will wait 200s, but the public proxy abandons SSR
  // after 60s. Bound the complete loader -- including auth, tags and the
  // initial creator lookup -- so a stalled Django cannot leave work running
  // after the visitor has gone.
  const requestAbort = createAbortSignalWithTimeout(
    event.request.signal,
    PROFILE_LOAD_TIMEOUT_MS,
  );
  try {
    return await loadProfileOrHistoricRoot(event, requestAbort.signal);
  } finally {
    requestAbort.cleanup();
  }
};

async function loadProfileOrHistoricRoot(
  event: Parameters<PageServerLoad>[0],
  requestSignal: AbortSignal,
) {
  const { params, fetch, cookies, url, locals, setHeaders } = event;
  const apiBase = env.PRIVATE_API_BASE_URL || "http://localhost:8000";
  // SvelteKit route params are decoded. Re-encode once before any path or
  // query interpolation so an outer segment such as
  // `/..%2Fget-type%2Fscanner%3Fx` cannot normalize the initial creator read
  // into a different credentialed/backend endpoint before admission runs.
  const encodedUsername = encodeURIComponent(params.username);
  const backendFetch = (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => fetch(input, { ...init, signal: requestSignal });
  let isOwner = false;
  const sessionId = cookies.get("sessionid");
  // A profile is a public surface even when the visitor owns it. Drafts are
  // fetched only by dashboard/editor routes with an explicit `mine=true`.
  // The session-backed profile still varies on the cookie for owner controls.
  setHeaders({ vary: "Cookie" });
  const page = url.searchParams.get("page") || "1";
  const search = url.searchParams.get("search") || "";
  const requestedOrdering = url.searchParams.get("ordering");
  const tag = url.searchParams.get("tag") || "";

  if (sessionId) {
    try {
      const userRes = await backendFetch(`${apiBase}/api/auth/user/`, {
        headers: { Cookie: `sessionid=${sessionId}` },
      });
      if (userRes.ok) {
        const user = await userRes.json();
        if (user.username === params.username) {
          isOwner = true;
        }
      }
    } catch (e: unknown) {
      logSsrError("profile_auth_check_failed", e, { path: url.pathname });
    }
  }

  // Public profiles use immutable publication chronology unless the visitor
  // selected a sort. Owner dashboard ordering is scoped to its own route.
  const ordering = requestedOrdering || "-published_at";

  let upstreamFailureLogged = false;
  try {
    // Try to fetch creator details - this will tell us if it's a creator
    const creatorResponse = await backendFetch(
      `${apiBase}/api/creator/${encodedUsername}/`,
    );

    if (creatorResponse.ok) {
      // It's a creator, get the data
      const creator = await creatorResponse.json();

      // Only a confirmed creator needs tags. Keeping this after the creator
      // lookup prevents arbitrary one-segment scanner misses from consuming a
      // second backend worker/query before the historic-page fallback runs.
      // `type=zpage&username=` scopes the vocabulary to this creator.
      let tags: TagSuggestion[] = [];
      try {
        const tagsQuery = new URLSearchParams({
          type: "zpage",
          username: params.username,
          num_results: "100",
        });
        const tagsRes = await backendFetch(
          `${apiBase}/api/tagging/autocomplete?${tagsQuery}`,
        );
        if (tagsRes.ok) {
          const payload = await tagsRes.json();
          tags = Array.isArray(payload) ? payload : [];
        }
      } catch (e) {
        logSsrError("profile_tags_failed", e, { path: url.pathname });
      }

      let zpagesData;
      let query = `page=${page}&ordering=${ordering}&page_size=6&lang=${encodeURIComponent(locals.locale)}`;
      if (search) {
        query += `&search=${encodeURIComponent(search)}`;
      }
      if (tag) {
        query += `&tags=${encodeURIComponent(tag)}`;
      }

      // The profile list is always public, including for its owner. Draft
      // access belongs to dashboard/editor routes that explicitly opt in.
      const zpagesResponse = await backendFetch(
        `${apiBase}/api/zpage/?username=${encodedUsername}&${query}`,
      );
      zpagesData = zpagesResponse.ok
        ? await zpagesResponse.json()
        : { results: [], count: 0, next: null, previous: null };

      if (sessionId) {
        setHeaders({ "cache-control": "private, no-cache" });
      }

      // `::embed[]` cards in the bio, as THIS reader: the reader's
      // own cookie header (none when anonymous), never the profile owner's
      // context. Only the profile page itself renders a bio as markdown —
      // creator cards, search results and hovers show plain text — so this
      // is the one place a bio card is resolved. The body is the same
      // `parseBioFrontmatter(...).body` the page renders. Never throws.
      const firstPartyCardSeed = await loadFirstPartyCardSeed({
        contents: [parseBioFrontmatter(creator?.description || "").body],
        browserResolvesDataRequest: event.isDataRequest,
        fetch,
        cookie: event.request.headers.get("cookie"),
        locale: locals.locale,
        signal: requestSignal,
        requestHostname: url.hostname,
      });
      return {
        creator,
        zpages: zpagesData,
        tags,
        type: "creator",
        isOwner,
        firstPartyCardSeed,
      };
    } else if (creatorResponse.status === 404) {
      // Historic zPage share links used a globally unique vanity/address at
      // the root (`/<identifier>`). The classic router resolved those links,
      // so sending cookie-less traffic to SvelteKit without doing the same
      // would turn working bookmarks into 404s.
      //
      // Resolve the type before fetching detail. The detail view can run the
      // identifier resolver twice on a miss (public, then subscriber-only),
      // including its unindexed legacy case-insensitive fallback. Arbitrary
      // one-segment scanner paths must stop after get-type's single resolver
      // pass instead of multiplying that work. Forward the session to detail
      // so an owner-only historic link still resolves.
      // Do not spend this deliberately small shared-IP bucket on real creator
      // profiles: SvelteKit hover-preloads those links, and a busy NAT could
      // otherwise deny ordinary profile traffic. The confirmed creator miss is
      // the boundary where the legacy resolver's additional case-insensitive
      // lookup begins. Authentication must not exempt a miss: the global user
      // throttle permits a large burst, so one reusable account could otherwise
      // queue hundreds of resolver scans. New ingress traverses the
      // same-revision sidecar, which collapses XFF to one trusted client; old
      // ingress keeps GCLB's append-only `<prefix...>, <client>, <lb>` suffix.
      // The helper accepts only those two shapes and ignores the forgeable
      // private identity header.
      const clientKey = historicRootClientKey(event);
      if (clientKey) {
        const admission = historicRootAdmission.admit(clientKey);
        if (!admission.admitted) {
          setHeaders({ "retry-after": String(admission.retryAfterSeconds) });
          throw error(429, "errors.creator.loadFailed", { code: 429 });
        }
      }

      // This request crosses the new-ui sidecar and then free2z-service's
      // nginx. Start a trustworthy two-hop XFF chain from the client identity
      // normalized above from either safe ingress shape; otherwise
      // the second nginx limiter sees only the shared SvelteKit pod IP and
      // unrelated visitors throttle each other. A missing/malformed suffix
      // takes the bounded fail-open path and sends no synthetic XFF; downstream
      // nginx exempts that absent-header shape from its exact resolver bucket.
      const forwardedFor = clientKey
        ? historicRootForwardedFor(clientKey)
        : null;
      const backendHeaders = {
        ...(sessionId ? { Cookie: `sessionid=${sessionId}` } : {}),
        ...(forwardedFor ? { "X-Forwarded-For": forwardedFor } : {}),
      };
      // The sidecar proxy waits 200s, while the public proxy abandons SSR after
      // 60s. A shorter body-inclusive bound prevents scanner traffic from
      // leaving orphaned requests and sockets after the visitor has gone.
      const rootAbort = createAbortSignalWithTimeout(
        requestSignal,
        ROOT_ZPAGE_LOOKUP_TIMEOUT_MS,
      );
      const backendRequest = {
        signal: rootAbort.signal,
        ...(Object.keys(backendHeaders).length > 0
          ? { headers: backendHeaders }
          : {}),
      };
      try {
        const typeResponse = await fetch(
          `${apiBase}/api/get-type/${encodedUsername}`,
          backendRequest,
        );
        if (typeResponse.status === 404) {
          throw error(404, "errors.creator.notFound", { code: 404 });
        }
        if (typeResponse.status === 429) {
          throw error(429, "errors.creator.loadFailed", { code: 429 });
        }
        if (!typeResponse.ok) {
          throw error(503, "errors.creator.loadFailed", { code: 503 });
        }
        if ((await typeResponse.json()) !== "zpage") {
          throw error(404, "errors.creator.notFound", { code: 404 });
        }

        const zpageResponse = await fetch(
          `${apiBase}/api/zpage/${encodedUsername}/`,
          backendRequest,
        );
        if (zpageResponse.status === 404) {
          throw error(404, "errors.creator.notFound", { code: 404 });
        }
        if (!zpageResponse.ok) {
          throw error(503, "errors.creator.loadFailed", { code: 503 });
        }

        const payload = await zpageResponse.json();
        // Subscriber-only details use `{show_modal, page}`. The inner page is
        // already redacted for an anonymous visitor but still carries the
        // creator and public identifier needed for the canonical paywall URL.
        const zpage = payload?.page || payload;
        // Prefer the same vanity URL declared canonical by the article page,
        // but fall back to the immutable address when a grandfathered vanity
        // now names a static product route. Old rows can have a colliding
        // free2zaddr too, so the shared helper refuses either unsafe segment.
        const canonicalPath = zpageCanonicalPath(zpage);
        if (canonicalPath) {
          // This redirect can use a mutable vanity. Keep it permanently
          // canonical for crawlers without letting browsers pin it after a
          // later rename/reuse.
          setHeaders({ "cache-control": "no-store" });
          throw redirect(301, `${canonicalPath}${url.search}`);
        }

        throw error(503, "errors.creator.loadFailed", { code: 503 });
      } finally {
        rootAbort.cleanup();
      }
    } else {
      // A throttle, a refusal or a gone is the API's answer, and this page
      // repeats it rather than rendering a 500: a crawler told 500
      // backs off from the whole site, one told 429 + Retry-After just waits.
      const upstream = upstreamClientError(
        creatorResponse.status,
        creatorResponse.headers.get("retry-after"),
      );
      if (upstream) {
        // Not an ERROR — the page answer is right — but SSR itself being
        // throttled or refused is worth one WARNING line: a backend auth or
        // throttle regression would otherwise look like visitors' 403s.
        logSsrWarning(
          "profile_creator_lookup_upstream_4xx",
          `creator API answered ${creatorResponse.status}`,
          {
            path: url.pathname,
            upstream_status: creatorResponse.status,
            retry_after: upstream.retryAfter,
          },
        );
        if (upstream.retryAfter) {
          setHeaders({ "retry-after": upstream.retryAfter });
        }
        throw error(
          upstream.status,
          upstreamErrorMessage(upstream, "errors.creator.loadFailed"),
          { code: upstream.status },
        );
      }
      // Some other error occurred. Logged HERE, where the upstream status is
      // known; the catch below must not log it a second time.
      upstreamFailureLogged = true;
      logSsrError(
        "profile_creator_lookup_failed",
        new Error(`creator API answered ${creatorResponse.status}`),
        { path: url.pathname, upstream_status: creatorResponse.status },
      );
      throw error(500, "errors.creator.loadFailed", { code: 500 });
    }
  } catch (err: unknown) {
    // A redirect, or an `error()` below 500 — an unknown username (every
    // `/wp-admin`, `/.env` probe), a throttled historic-root lookup — is the
    // answer, not a failure: rethrow it without a log line. This
    // used to `console.error("Error loading creator profile: Unknown error")`
    // for each one, because a SvelteKit HttpError is not an `Error`: 4,733
    // ERROR entries in 72 h, every one a scanner 404 or a 301.
    if (isExpectedOutcome(err)) throw err;
    if (!upstreamFailureLogged)
      logSsrError("profile_load_failed", err, { path: url.pathname });
    // A 5xx `error()` from the branches above keeps its own status.
    if (err && typeof err === "object" && "status" in err) throw err;
    throw error(503, "errors.creator.loadFailed", { code: 503 });
  }
}
