import { gone } from "$lib/server/legacy-routes";
import type { PageServerLoad } from "./$types";

/** Classic's orphaned Storytime editor has no Svelte replacement. */
export const load: PageServerLoad = ({ setHeaders }) =>
  gone("storytime", setHeaders);
