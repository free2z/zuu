/**
 * Keep the retired classic `/storytime/<creator>/<slug>` share shape from
 * occupying the real Storytime creator's three-segment product routes.
 * Returning false lets SvelteKit continue matching the generic `[username]`
 * trees for those literal middle segments.
 */
const STORYTIME_CREATOR_SUBROUTES = new Set(["dashboard", "private", "zpage"]);

export function match(segment: string): boolean {
  return !STORYTIME_CREATOR_SUBROUTES.has(segment.toLowerCase());
}
