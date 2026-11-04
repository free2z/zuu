import {
  permanentRedirect,
  SIGN_UP_DESTINATION,
} from "$lib/server/legacy-routes";
import type { RequestHandler } from "./$types";

/**
 * Classic `/begin` -> `/login?view=signup`. Superseded by
 * `UnifiedAuthModal`; `/login` is the route that actually opens it.
 * Non-sticky for the same reason as `/find`: classic still serves `/begin`.
 */
export const GET: RequestHandler = () => permanentRedirect(SIGN_UP_DESTINATION);
