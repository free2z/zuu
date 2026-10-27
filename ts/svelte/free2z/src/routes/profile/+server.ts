import type { RequestHandler } from "./$types";

import { redirectToOwnDashboard } from "$lib/server/legacy-routes";

/**
 * Classic `/profile` -> `/<me>/dashboard/profile`.
 *
 * Load-bearing beyond old bookmarks: Django sends people here after the
 * Twitter OAuth callback (`dj/apps/twitter/views.py`) and after confirming an
 * email address (`dj/apps/emails/views.py`), so for an opted-in new-UI user
 * both of those flows currently end on a 404.
 *
 * `+server.ts`, not `+page.server.ts`, so the private cache headers are set on
 * the redirect response itself rather than relying on `setHeaders` surviving a
 * thrown redirect. See `$lib/server/legacy-routes`.
 */
export const GET: RequestHandler = ({ cookies, fetch, url }) =>
  redirectToOwnDashboard(fetch, cookies, "profile", url.pathname);
