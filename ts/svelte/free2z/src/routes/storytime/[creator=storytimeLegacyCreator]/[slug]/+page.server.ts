import { gone } from "$lib/server/legacy-routes";
import type { PageServerLoad } from "./$types";

/**
 * Retire only classic's three-segment shared-story shape. `/storytime` is a
 * real creator and `/storytime/<vanity>` remains that creator's article
 * namespace. The route matcher also releases that creator's zpage/private/
 * dashboard subroutes to their generic `[username]` handlers.
 */
export const load: PageServerLoad = ({ setHeaders }) =>
  gone("storytime", setHeaders);
