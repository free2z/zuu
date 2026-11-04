/**
 * After a confirmed logout: stay on this page, or leave for the homepage?
 *
 *
 * Either way the answer is a FULL DOCUMENT LOAD — `window.location.reload()`
 * or `window.location.assign("/")`, never a client-side navigation. Component
 * state can hold data fetched while authenticated (the homepage derives its
 * display lists once on mount, and an authenticated response includes private
 * drafts), and a soft navigation does not necessarily discard it. The redirect
 * home used to conflate "discard authenticated state" with "go to the
 * homepage"; only the first is load-bearing, so a page that reads perfectly
 * well logged out keeps its URL and gets a fresh document instead.
 *
 * There is no registry of "this route needs a session", so it is derived
 * here from the pathname — and the default is FAIL-SAFE: an unrecognised
 * route leaves for `/`. A route that wrongly stays put can render a logged-out
 * visitor a broken or empty authenticated view (or reload a capability URL);
 * a route that wrongly redirects is merely the old behaviour.
 *
 * Pure and pathname-only so it can be unit-tested without a browser; the
 * caller snapshots the pathname BEFORE the async logout and compares it
 * afterwards, so a navigation that lands mid-logout can never be reloaded
 * under a stale verdict.
 */
export type LogoutDestination = "reload" | "home";

/** Exact public paths. */
const PUBLIC_PATHS = new Set([
  "/",
  "/converse",
  "/creators",
  "/search",
  "/trending",
]);

/** Public roots that take exactly one more segment: `/tag/<slug>` etc. */
const PUBLIC_ROOTS_WITH_CHILD = new Set(["converse", "tag", "article", "live"]);

/**
 * First segments that are NOT a creator's username. Anything here that is
 * not also listed above is a route we do not vouch for after logout — the
 * editor, checkout, the login page itself, the retired classic entry points —
 * so it falls through to the fail-safe redirect.
 */
const RESERVED_ROOTS = new Set([
  "api",
  "ws",
  "uploadz",
  "healthz",
  "edit",
  "buy-2z",
  "login",
  "reset-password",
  "checkout",
  "projects",
  "find",
  "begin",
  "profile",
  "events",
  "ai",
  "storytime",
  "tools",
  "tag",
  "article",
  "live",
  "converse",
  "creators",
  "search",
  "trending",
  // The OIDC consent screen, connected apps and the developer console
  //all need a session, so logout leaves them for the homepage.
  "oauth",
  "account",
  "developers",
]);

/**
 * Second segments under a username that are NOT a public zPage: the owner's
 * dashboard, gated listings, the broadcast console, and the secret-bearing
 * private-page URL, which must never be reloaded after a logout.
 */
const PRIVATE_PROFILE_CHILDREN = new Set([
  "dashboard",
  "private",
  "broadcast",
  "ppv",
  "subscribers-only",
  "zpage",
  "edit",
]);

const USERNAME = /^[A-Za-z0-9_.-]+$/;

export function logoutDestination(pathname: string): LogoutDestination {
  if (typeof pathname !== "string" || !pathname.startsWith("/")) return "home";
  // A backslash resolves like a slash in a browser; do not reason about it.
  if (pathname.includes("\\")) return "home";

  const trimmed =
    pathname.length > 1 && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;
  if (PUBLIC_PATHS.has(trimmed)) return "reload";

  const segments = trimmed.slice(1).split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    return "home";
  }
  const [first, second] = segments;

  if (segments.length === 2 && PUBLIC_ROOTS_WITH_CHILD.has(first)) {
    return "reload";
  }

  if (RESERVED_ROOTS.has(first) || !USERNAME.test(first)) return "home";

  // `/<username>` — a public profile.
  if (segments.length === 1) return "reload";

  // `/<username>/<vanity>` — a public zPage, unless the second segment is one
  // of the owner-only children.
  if (segments.length === 2 && !PRIVATE_PROFILE_CHILDREN.has(second)) {
    return "reload";
  }

  return "home";
}
