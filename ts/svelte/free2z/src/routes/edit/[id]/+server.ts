import { editDestination, permanentRedirect } from "$lib/server/legacy-routes";
import type { RequestHandler } from "./$types";

/**
 * Classic `/edit/<identifier>` -> `/edit?id=<identifier>`.
 *
 * Both spellings resolve the same identifier space — classic's `EditPage` and
 * the new `/edit` route each call `/api/zpage/<identifier>/` — so this is a
 * pure URL-shape change and a genuine 301. `mapToClassicUi` already maps the
 * new shape back to the old one; this closes the loop.
 *
 * `no-store` matters most here: classic serves `/edit/<id>` and cannot serve
 * `/edit?id=<id>`, so a browser that cached this hop would break the classic
 * editor for a creator who switches back to it.
 *
 * Blast radius, stated plainly: this route shadows `[username]/[vanity]` for
 * the first segment `edit`, so `/edit/<some-vanity>` stops resolving to that
 * page's owner. That is intended — "/edit/x" has meant "edit x" since the
 * classic app shipped, and `edit` is in `FORBIDDEN_USERNAMES`
 * (`dj/apps/g12f/serializers/creator.py`). Note that list is serializer
 * validation on new registrations, not a database constraint; see the
 * namespace audit in `tests/legacy-routes.test.mjs` for the historical-rows
 * caveat that applies to every first segment this PR makes literal.
 */
export const GET: RequestHandler = ({ params, url }) =>
  permanentRedirect(editDestination(params.id, url.search));
