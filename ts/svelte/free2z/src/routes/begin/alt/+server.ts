import {
  permanentRedirect,
  SIGN_UP_DESTINATION,
} from "$lib/server/legacy-routes";
import type { RequestHandler } from "./$types";

/**
 * Classic `/begin/alt` -> `/login?view=signup`. It was an A/B variant
 * of `/begin`; both variants now land on the same modal.
 */
export const GET: RequestHandler = () => permanentRedirect(SIGN_UP_DESTINATION);
