import type { RequestHandler } from "./$types";

import { redirectToOwnDashboard } from "$lib/server/legacy-routes";

/**
 * Classic `/events` -> `/<me>/dashboard/notifications`.
 *
 * The classic event feed and the new notifications dashboard render the same
 * `dj.apps.events` data; `mapToClassicUi` in `$lib/utils/classic-ui` already
 * encodes that correspondence in the opposite direction. Not a 410: the
 * feature exists, only its URL is retired.
 */
export const GET: RequestHandler = ({ cookies, fetch, url }) =>
  redirectToOwnDashboard(fetch, cookies, "notifications", url.pathname);
