import { error } from "@sveltejs/kit";
import type { RequestEvent } from "@sveltejs/kit";
import * as env from "$app/env/private";
import { type LivePageData, type PublicStreamType } from "$lib/stream-types";
import {
  isPublicStreamType,
  requiresAuthenticatedViewer,
} from "$lib/streamTypes.js";
import { NOINDEX_FOLLOW_ROBOTS } from "$lib/seo";
import {
  getSessionCookie,
  requireAuthenticatedUser,
} from "$lib/server/backend";
import { isSocialUnfurler } from "$lib/social-unfurler.js";

/**
 * Load the shared data and access policy for a public live-stream viewer.
 *
 * Both `/live/:username` and the canonical `/:username/:type` routes use this
 * helper so legacy links and pretty share links cannot drift apart.
 */
export async function loadLivePage(
  event: RequestEvent,
  routeType?: PublicStreamType,
): Promise<LivePageData> {
  const { params, url, fetch, request, setHeaders } = event;
  const username = params.username;
  if (!username) {
    throw error(400, "errors.creator.usernameRequired", { code: 400 });
  }

  // This value becomes `/api/dyte/{username}/{type}`, whose public path is a
  // closed enum. In particular, `private` is a separate creator-management
  // route and must never be offered by an ordinary viewer page.
  // Validate before fetching the creator so rejected values cost no upstream
  // request. Case normalization matches the API path converter.
  const requestedType = (
    routeType ||
    url.searchParams.get("type") ||
    "broadcast"
  ).toLowerCase();
  if (!isPublicStreamType(requestedType)) {
    throw error(404, "errors.stream.unknownType", { code: 404 });
  }

  const type = requestedType;
  const apiBase = env.PRIVATE_API_BASE_URL || "";
  const cookie = request.headers.get("cookie") || "";

  // `X-Robots-Tag`, not just the `<meta name="robots">` the page renders
  //. A protected stream 302s an anonymous visitor to /login BEFORE the
  // component is built, so on exactly the URLs that most need the directive
  // the markup never exists — Googlebot would see a bare temporary redirect
  // and could keep `/{u}/ppv` and `/{u}/subscribers-only` in the index
  // (codex adversarial review). A header rides on the redirect; `setHeaders`
  // values are applied to it, verified on the wire. Set here rather than in
  // the component so it covers every exit from this loader.
  //
  // Protected stream guards additionally use the session cookie; mark those
  // responses variant-aware even when the visitor is anonymous, and private
  // when a cookie was actually forwarded to the auth endpoint. They also vary
  // on User-Agent: an anonymous social unfurler gets a 200 card where
  // an anonymous browser gets a 302, and a shared cache must not hand one the
  // other's answer.
  if (requiresAuthenticatedViewer(type)) {
    setHeaders({
      "x-robots-tag": NOINDEX_FOLLOW_ROBOTS,
      ...(cookie
        ? { "cache-control": "private, no-cache", vary: "Cookie, User-Agent" }
        : { vary: "Cookie, User-Agent" }),
    });
  } else {
    setHeaders({ "x-robots-tag": NOINDEX_FOLLOW_ROBOTS });
  }

  // Fetch the creator profile to ensure existence and provide SEO data.
  let creator;
  try {
    const creatorResponse = await fetch(`${apiBase}/api/creator/${username}/`);

    if (creatorResponse.ok) {
      creator = await creatorResponse.json();
    } else if (creatorResponse.status === 404) {
      throw error(404, "errors.creator.notFound", { code: 404 });
    } else {
      console.error("Creator API error:", creatorResponse.status);
      throw error(500, "errors.creator.loadFailed", { code: 500 });
    }
  } catch (err: any) {
    if (err?.status && err?.body) throw err;
    console.error("Error fetching creator:", err);
    throw error(500, "errors.http.500.title", { code: 500 });
  }

  let viewerActorId: number | undefined;

  // Protected streams require a valid session before the viewer boots the
  // client-side meeting. Fail closed if the auth check itself errors — but
  // closed means a 503, not "you are logged out": only a 401/403 (or no
  // session cookie) sends the viewer to /login.
  if (requiresAuthenticatedViewer(type)) {
    //a shared `/{u}/ppv` or `/{u}/subscribers-only` link must unfurl
    // as the creator's card, not as the login page the 302 below lands on.
    // An anonymous social unfurler therefore gets the page rendered in its
    // gated-preview state: the creator's PUBLIC profile (the same
    // `/api/creator/{username}/` payload `/{username}` and `/{u}/broadcast`
    // already serve to anyone) and NO viewer. `LiveStreamViewer` is never
    // mounted, so nothing here or in the browser asks `/api/dyte/...` for a
    // meeting or a token; that endpoint stays the access check (401 / 402).
    //
    // A spoofed User-Agent buys only that public card. A request that carries
    // a session cookie never takes this branch — a signed-in visitor whose
    // in-app browser happens to match the list must still reach the stream —
    // and Googlebot and anonymous humans keep the redirect they had before
    //  moved unfurlers onto this tier.
    if (
      !getSessionCookie(event.cookies) &&
      isSocialUnfurler(request.headers.get("user-agent"))
    ) {
      return { creator, type, username, gatedPreview: true };
    }
    const viewer = await requireAuthenticatedUser(
      fetch,
      event.cookies,
      url.pathname + url.search,
    );
    if (type === "ppv") {
      if (
        typeof viewer.id !== "number" ||
        !Number.isSafeInteger(viewer.id) ||
        viewer.id <= 0
      ) {
        throw error(503, "errors.http.503.title", { code: 503 });
      }
      viewerActorId = viewer.id;
    }
  }

  return {
    creator,
    type,
    username,
    gatedPreview: false,
    ...(viewerActorId ? { viewerActorId } : {}),
  };
}
