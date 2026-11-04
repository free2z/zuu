import { gone } from "$lib/server/legacy-routes";
import type { PageServerLoad } from "./$types";

/**
 * Classic `/ai/conversation/<uuid>` -> 410 Gone.
 *
 * This is the shape that matters: `/feeds/ai/recent.xml` published these
 * permalinks into feed readers and search indexes, and the feature has no
 * replacement. The feeds are retired in the same change, so nothing keeps
 * minting new ones.
 *
 * SCOPED TO THREE SEGMENTS ON PURPOSE — this is the safe shape, and it is the
 * only one under `/ai/` that is safe. `[username]/[vanity]` is two segments
 * and resolves on the globally unique vanity ALONE, and the only three-segment
 * creator routes carry a literal middle of `zpage`, `private` or `dashboard`.
 * `/ai/conversation/<x>` therefore cannot collide with any creator URL, no
 * matter who registers what.
 *
 * The first cut of this PR used `/ai/[...rest]`, which would have swallowed
 * `/ai/<vanity>` — and `public`, from classic's `/ai/public`, IS a live zPage
 * vanity today (`/api/zpage/public/` -> 200). A 410 there would have replaced
 * a working page with a deindex signal. See `/storytime`, deleted from this
 * PR for the same reason, and the note on `src/routes/ai/+page.server.ts`.
 */
export const load: PageServerLoad = ({ setHeaders }) => {
  gone("ai", setHeaders);
};
