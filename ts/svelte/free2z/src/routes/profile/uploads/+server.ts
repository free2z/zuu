import type { RequestHandler } from "./$types";

import { redirectToOwnDashboard } from "$lib/server/legacy-routes";

/**
 * Classic `/profile/uploads` -> `/<me>/dashboard/media`. Same
 * session-derived destination, same private cache policy, as `/profile`.
 *
 * `/profile/kyc` is a sibling shim now that the dashboard KYC surface exists.
 */
export const GET: RequestHandler = ({ cookies, fetch, url }) =>
  redirectToOwnDashboard(fetch, cookies, "media", url.pathname);
