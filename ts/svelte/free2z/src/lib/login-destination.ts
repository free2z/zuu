/**
 * Where an unauthenticated caller is sent when a page needs a session, and
 * the ONLY place that answer is spelled.
 *
 * It used to be an inert `?login` sentinel on the homepage, in ~27 places.
 * Nothing ever read that parameter: the homepage ignored it and the navbar's
 * modal starts closed, so the visitor landed on an ordinary homepage with no
 * prompt and lost the page they were on. `/login` is a real route whose page opens `UnifiedAuthModal`
 * on arrival, honours `?next=` (same-site paths only, via `getSafeNextPath`)
 * and `?view=signup`, and can explain WHY the visitor is looking at a login
 * screen through `?reason=`.
 *
 * Shared, not `$lib/server`: `routes/edit/+page.ts` is a universal load
 * (`ssr = false`) and cannot import a server-only module, and the login page
 * itself consumes `reason` in the browser.
 *
 * This module is for SERVER guards and progressive fallbacks — a load that
 * has nothing to render without a session. A click on a public page must NOT
 * come here: it opens the modal in place through `$lib/stores/auth-modal`, so
 * the visitor keeps their URL, scroll and history.
 */
import { getSafeNextPath } from "./safe-next";

export const LOGIN_DESTINATION = "/login";

/**
 * The reasons the login page knows how to explain. An allow-list on purpose:
 * `reason` is a representation selector read straight off the URL, and free
 * text there would be a phishing banner on a free2z origin.
 */
export const LOGIN_REASONS = [
  "email-changed",
  "email-removed",
  "session-expired",
  // An app asked for a fresh sign-in (OIDC `prompt=login`, `max_age`, or a
  // spend-cap raise; ). The consent page signed the visitor out first.
  "reauthenticate",
  // Raising a connected app's spending limit on /account/apps needs a
  // recent sign-in; that page signed the visitor out first.
  "confirm-limit",
  // Deleting the account on /account/delete needs a sign-in within the last
  // five minutes; that page signed the visitor out first.
  "delete-account",
] as const;

export type LoginReason = (typeof LOGIN_REASONS)[number];

export function parseLoginReason(
  value: string | null | undefined,
): LoginReason | null {
  if (!value) return null;
  return (LOGIN_REASONS as readonly string[]).includes(value)
    ? (value as LoginReason)
    : null;
}

/**
 * `/login`, returning to `path` once the visitor is signed in.
 *
 * `path` is normally our own route's `url.pathname + url.search`, so it is
 * same-site by construction — but it goes through the same guard the login
 * page uses to consume it, so there is exactly one definition of "safe
 * `next`" in the codebase. A path the guard rejects is simply dropped: the
 * visitor still gets a real login screen, just without the return trip.
 */
export function loginDestination(
  path?: string | null,
  reason?: LoginReason | null,
): string {
  const params = new URLSearchParams();
  const safe = getSafeNextPath(path);
  if (safe) params.set("next", safe);
  if (reason) params.set("reason", reason);
  const query = params.toString();
  return query ? `${LOGIN_DESTINATION}?${query}` : LOGIN_DESTINATION;
}
