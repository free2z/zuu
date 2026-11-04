import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = ({ setHeaders }) => {
  setHeaders({ "cache-control": "no-store", "referrer-policy": "no-referrer" });
  return {};
};
