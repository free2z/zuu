import type { RequestHandler } from "./$types";

import { redirectToOwnDashboard } from "$lib/server/legacy-routes";

/** Classic `/profile/kyc` -> the completed Svelte dashboard KYC surface. */
export const GET: RequestHandler = ({ cookies, fetch, url }) =>
  redirectToOwnDashboard(fetch, cookies, "kyc", url.pathname);
