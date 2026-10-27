import { gone } from "$lib/server/legacy-routes";
import type { PageServerLoad } from "./$types";

/** The classic public AI gallery was retired without a replacement. */
export const load: PageServerLoad = ({ setHeaders }) => {
  gone("ai", setHeaders);
};
