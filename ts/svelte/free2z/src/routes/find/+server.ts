import { findDestination, permanentRedirect } from "$lib/server/legacy-routes";
import type { RequestHandler } from "./$types";

/**
 * Classic `/find` -> `/search` with a query, `/trending` without.
 *
 * 301 rather than 410 even though the owner retired classic's Find page: the
 * capability did not go away, it split. `/find` both searched
 * (`/api/zpage/?search=`) and browsed, and those are two routes here — see
 * `findDestination` for why a query-less visit must not land on `/search`.
 * Django serves a social card for `/find` today (`find_social`), so this is
 * public, indexable surface rather than an internal URL.
 *
 * `+server.ts` so the redirect can carry `cache-control: no-store` — the
 * classic app still owns `/find` and owns neither destination, so a browser
 * that remembered this hop would break `/find` for anyone who switches back.
 * See `permanentRedirect`.
 */
export const GET: RequestHandler = ({ url }) =>
  permanentRedirect(findDestination(url.search));
