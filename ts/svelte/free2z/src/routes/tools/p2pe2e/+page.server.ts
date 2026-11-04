import { gone } from "$lib/server/legacy-routes";
import type { PageServerLoad } from "./$types";

/** The classic EFM meeting tool was retired without a replacement. */
export const load: PageServerLoad = ({ setHeaders }) => {
  gone("tools", setHeaders);
};
