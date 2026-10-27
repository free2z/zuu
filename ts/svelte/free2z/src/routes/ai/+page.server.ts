import { gone } from "$lib/server/legacy-routes";
import type { PageServerLoad } from "./$types";

/**
 * Classic `/ai` -> 410 Gone. The AI conversation feature is retired,
 * not ported, so there is no destination that would not be a soft-404.
 *
 * ONE SEGMENT, so the only thing it can shadow is a creator literally named
 * `ai`. Verified there is none: `GET /api/creator/ai/` -> 404 in production,
 * and `ai` is in `FORBIDDEN_USERNAMES` so no new account can take it.
 *
 * That verification is the point, not a formality. `FORBIDDEN_USERNAMES` is
 * serializer validation on new registrations — not a database constraint, and
 * added long after signups began — so it says nothing about historical rows.
 * This PR originally also retired `/storytime/**` on the strength of that
 * list; `Storytime` is a REAL creator with three published zPages, and the
 * rule would have answered 410 for their profile and their whole vanity
 * namespace. Those broad routes are gone; Stage 4's exact three/four-segment
 * story leaves cannot collide with creator URLs. Probe before adding a literal
 * root or two-segment route here:
 *
 *     curl -o /dev/null -w '%{http_code}' https://free2z.cash/api/creator/<name>/
 *
 * `tests/legacy-routes.test.mjs` pins the segments this PR is allowed to own,
 * so adding another one fails until someone runs that probe.
 */
export const load: PageServerLoad = ({ setHeaders }) => {
  gone("ai", setHeaders);
};
