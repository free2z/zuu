import type { PageServerLoad } from "./$types";
import { requireAuthenticatedUser } from "$lib/server/backend";

// The developer console  needs a session: without one, the visitor
// goes to /login and comes back here. Only a 401/403 (or no cookie) is
// "signed out"; a backend 5xx or timeout is an error page. The
// registrations themselves load in the browser, with the visitor's session.
export const load: PageServerLoad = async ({ cookies, fetch, url }) => {
  await requireAuthenticatedUser(fetch, cookies, url.pathname + url.search);
  return {};
};
