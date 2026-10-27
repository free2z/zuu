import type { PageServerLoad } from "./$types";
import { loadLivePage } from "$lib/server/live-page";

export const load: PageServerLoad = (event) => loadLivePage(event);
