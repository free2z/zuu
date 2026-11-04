import { error } from "@sveltejs/kit";
import type { PageServerLoad } from "./$types";

// No project data source or contribution contract exists for this route.
export const load: PageServerLoad = () => {
  error(404, "Not Found");
};
