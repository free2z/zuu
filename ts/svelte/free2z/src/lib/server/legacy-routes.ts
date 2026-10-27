/**
 * Routing contract for paths that only ever existed in the classic React SPA
 * (`ts/react/free2z/src/App.tsx`). See.
 *
 * Historically every one of them fell through SvelteKit's greedy `[username]`
 * route and 404'd, so an opted-in new-UI user hitting `/profile` — where the
 * Twitter OAuth callback and the email-confirmation landing both send people
 * from Django — got a 404. When classic is deleted that becomes everyone.
 *
 * Three dispositions live here, and the difference between them is the point:
 *
 *  * **301, `no-store`** for a path whose content genuinely moved. Permanent
 *    for search engines; deliberately NOT sticky in browsers — see
 *    `permanentRedirect`.
 *  * **302 + `private, no-store`** for a path whose destination is derived
 *    from the caller's session (`/profile` -> `/<me>/dashboard/profile`).
 *    Cloud CDN's cache key is host + protocol + path + query — the session
 *    cookie is NOT in it (k8s/free2z/backend-config.yaml, cacheMode
 *    USE_ORIGIN_HEADERS). A cacheable redirect here would hand one user's
 *    dashboard URL to the next visitor. This is why `buy-2z` is a 302 too.
 *  * **410** for a feature that was removed with no replacement. A 301 to an
 *    unrelated page is a soft-404 to Google and is exactly the class of
 *    signal  spent a PR removing; 410 says "gone, permanently" to search
 *    engines and to feed readers in one machine-readable byte.
 *
 * Every response is built here rather than thrown with `redirect()`, because
 * the cache headers are load-bearing and a thrown redirect carries none.
 */
import { error } from "@sveltejs/kit";

import {
  AUTH_USER_TIMEOUT_MS,
  resolveAuthenticatedUser,
} from "$lib/server/backend";
import { slugifyTag } from "$lib/tag-slug.js";
import { tagPageHref } from "$lib/tag.js";

type CookieReader = {
  get: (name: string) => string | undefined;
};

/**
 * How long the identity lookup behind `/profile`, `/profile/uploads` and
 * `/events` may take before those routes give up and answer 503. Well under
 * the 60s the public proxy waits on new-ui, so we fail while anyone is still
 * listening. See `resolveOwnUsername`.
 */
export const IDENTITY_TIMEOUT_MS = AUTH_USER_TIMEOUT_MS;

/**
 * A permanent redirect that browsers must not remember.
 *
 * `no-store` looks contradictory next to a 301 and is the whole point while
 * BOTH UIs are live. A browser that cached a Svelte-only redirect indefinitely
 * would keep it even if the pinned classic image were restored.
 *
 * Search engines are unaffected: caching headers do not change how a 301 is
 * interpreted for canonicalisation, so the consolidation signal still lands.
 * Revisit only after the classic rollback window closes.
 */
export function permanentRedirect(location: string): Response {
  return new Response(null, {
    status: 301,
    headers: { location, "cache-control": "no-store" },
  });
}

/**
 * Cache policy for a redirect whose Location depends on the session cookie.
 * `no-store` rather than `private, no-cache`: there is nothing here worth
 * revalidating, and a shared cache must not hold it even briefly.
 */
export const PRIVATE_REDIRECT_HEADERS: Readonly<Record<string, string>> = {
  "cache-control": "private, no-store",
  vary: "Cookie",
};

/** A 302 whose Location is caller-specific. Never 301: see the module note. */
export function privateRedirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location, ...PRIVATE_REDIRECT_HEADERS },
  });
}

/**
 * Where an unauthenticated caller is sent: the real `/login` page, with a
 * safe `?next=`. The definition lives in `$lib/login-destination` (shared
 * with the universal editor load and the login page itself)  * retired the inert homepage sentinel every other guard used to bounce to;
 * these routes were the first to use the real page and keep their import.
 */
import { LOGIN_DESTINATION, loginDestination } from "$lib/login-destination";

export { LOGIN_DESTINATION, loginDestination };

/**
 * Resolve the caller's own username, distinguishing "not signed in" from
 * "the backend could not answer".
 *
 * A thin wrapper over `resolveAuthenticatedUser`, which is where the
 * rule now lives for every server load: only a 401/403 is "not signed in";
 * a Django 502/503, a 429 from the throttle, a timeout or a rollout blip is a
 * 503. A redirect-only route has no other signal, so folding those into
 * "logged out" would hand a signed-in user a login page that cannot help.
 *
 * What the 503 buys, precisely: an honest status at the APPLICATION layer,
 * which a 302 to a login page can never be. It is not an end-to-end promise
 * `@newui` in `k8s/free2z/nginx.conf` retries a 503 and currently degrades to
 * `@classic_fallback`, so the visitor may receive the classic shell at 200.
 * What matters here is that this route emits the 5xx instead of laundering a
 * backend outage into "logged out" before nginx applies its UI fallback.
 *
 * @returns the username, or `null` when the caller is genuinely anonymous.
 * @throws a 503 HttpError when the backend could not be consulted.
 */
export async function resolveOwnUsername(
  fetchFn: typeof fetch,
  cookies: CookieReader,
): Promise<string | null> {
  const user = await resolveAuthenticatedUser(fetchFn, cookies);
  return user ? user.username.trim() : null;
}

/**
 * Send a retired per-user classic page (`/profile`, `/events`,...) to the
 * caller's own dashboard, or to the login affordance when anonymous.
 */
export async function redirectToOwnDashboard(
  fetchFn: typeof fetch,
  cookies: CookieReader,
  dashboardPage: string,
  returnTo?: string,
): Promise<Response> {
  const username = await resolveOwnUsername(fetchFn, cookies);
  if (username === null) {
    // `next` is this very path, so signing in resumes the journey: /login ->
    // /profile -> /<me>/dashboard/profile. The second hop is this handler
    // again, now with a session, so there is no loop.
    return privateRedirect(loginDestination(returnTo));
  }
  return privateRedirect(
    `/${encodeURIComponent(username)}/dashboard/${dashboardPage}`,
  );
}

/**
 * Where a `/find` visit without a text query belongs: the canonical, indexed
 * zPage discovery listing. NOT bare `/search`, which renders an empty form
 * and declares `noindex, follow` — a permanent redirect from a crawlable
 * listing to a noindex empty state is a downgrade, not a move.
 */
export const BROWSE_DESTINATION = "/trending";

/**
 * `/find` -> `/search` when it carries a text query, `/trending` otherwise.
 *
 * Classic's Find page queried `/api/zpage/?search=` and doubled as a browsable
 * listing: with no query it still rendered pages, and classic emits tag-only
 * links like `/find?tags=video`. Those two behaviours now live in two
 * different routes, so the redirect has to pick per URL rather than per path.
 *
 *  * `?search=zcash` -> `/search?q=zcash`. `/search` is the superset
 *    (creators + series + pages) and reads the query from `q`; this is the
 *    inverse of `mapToClassicUi`'s `/search` -> `/find` rule in
 *    `$lib/utils/classic-ui`.
 *  * `?tags=video` -> `/tag/video`, the topic hub. It used to land on
 *    `/trending` with the filter dropped, then on `/search?tag=video` once
 *    `/search` honoured a tag filter. It goes straight to the hub now
 *    rather than through `/search`, because `/search?tag=` itself 301s to the
 *    hub — and a 301 that lands on another 301 is a chain that costs crawl
 *    budget and dilutes the signal this redirect exists to preserve.
 *    Classic could emit several comma-separated tags; the API ANDs them and a
 *    hub is one tag, so a multi-tag value keeps going to `/search?tag=`, which
 *    can express the AND. So does a tag with no slug at all (an emoji-only
 *    tag), which has no hub URL to redirect to.
 *  * `?search=zcash&tags=video` -> `/search?q=zcash&tag=video`. A text query
 *    AND a tag is a two-axis filter no hub expresses; dropping either half to
 *    reach a prettier URL would lose what the visitor asked for.
 *  * anything else (bare `/find`, `?ordering=…`) -> `/trending`, a real
 *    listing a visitor can browse and a crawler can index.
 *
 * Only parameters the destination actually honours cross over.
 *
 * `page` is validated rather than copied — `/search` parses it, and handing it
 * `page=abc` or `page=-3` would ask it to normalise our garbage.
 */
export function findDestination(search: string): string {
  const source = new URLSearchParams(search);
  const query = (source.get("search") || "").trim();
  const tags = (source.get("tags") || "").trim();
  if (!query && !tags) {
    return BROWSE_DESTINATION;
  }

  // One tag and no text query is exactly what a hub is. Anything else — a
  // comma-joined AND, a tag with no slug — has no hub URL and keeps the
  // `/search` destination that can still express it.
  if (!query && !tags.includes(",")) {
    const slug = slugifyTag(tags);
    if (slug) return tagPageHref({ slug });
  }

  const destination = new URLSearchParams();
  if (query) destination.set("q", query);
  if (tags) destination.set("tag", tags);

  const page = source.get("page");
  if (page && /^[1-9][0-9]*$/.test(page)) {
    destination.set("page", page);
  }

  return `/search?${destination.toString()}`;
}

/** `/edit/<identifier>` -> `/edit?id=<identifier>`, preserving `?lang=`. */
export function editDestination(id: string, search: string): string {
  const params = new URLSearchParams(search);
  params.set("id", id);
  return `/edit?${params.toString()}`;
}

/**
 * Features the owner retired outright. The message key is rendered as
 * the heading by `src/routes/+error.svelte`, which also emits
 * `noindex, nofollow, noarchive` — so a crawler that follows an old link is
 * told the same thing twice.
 */
export const RETIRED_FEATURE_MESSAGES = {
  ai: "errors.gone.ai",
  storytime: "errors.gone.storytime",
  tools: "errors.gone.tools",
} as const;

export type RetiredFeature = keyof typeof RETIRED_FEATURE_MESSAGES;

/**
 * Always throws. Declared `never` so callers need no unreachable return.
 *
 * `setHeaders` is passed in so the 410 can say `no-store`. A 410 is
 * heuristically cacheable, and classic still serves some of these paths. A
 * browser that retained the response could keep refusing the path after the
 * user returned through `/classic-ui`. Cloud CDN is not the exposure here
 * (negative caching is off); the browser is.
 */
export function gone(
  feature: RetiredFeature,
  setHeaders?: (headers: Record<string, string>) => void,
): never {
  setHeaders?.({ "cache-control": "no-store" });
  throw error(410, RETIRED_FEATURE_MESSAGES[feature], { code: 410 });
}

/**
 * `/begin` and `/begin/alt` were classic's standalone sign-up screens, so the
 * destination is the sign-up view of `/login` rather than its default log-in
 * view. Not a 410: signing up is not a retired capability, only its URL is.
 */
export const SIGN_UP_DESTINATION = `${LOGIN_DESTINATION}?view=signup`;
