import { gone } from "$lib/server/legacy-routes";
import type { PageServerLoad } from "./$types";

/** Retired shared EFM meeting links have no replacement. */
export const load: PageServerLoad = ({ setHeaders }) => {
  gone("tools", setHeaders);
};
