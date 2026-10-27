/**
 * The bounds `/converse/<uuid>`'s server render puts on its walk up a reply
 * chain to the thread's root  -- and the single place they are written.
 *
 * The API has no "ancestors of this comment" endpoint, so the loader follows
 * `parent` one `/api/comments/<uuid>/` call at a time. Unbounded, a reply 100
 * levels deep cost 101 SEQUENTIAL backend calls per render -- for any
 * anonymous visitor and, routed every social unfurler to SSR, for
 * each platform that fetches a shared link. At ~0.6 s a call that is past
 * nginx's 60 s read timeout on the `@newui` locations.
 *
 * Two bounds, because they fail differently:
 *
 *  - a DEPTH cap bounds the fan-out when the backend is fast (it is what an
 *    attacker with a deep chain controls), and
 *  - a DEADLINE bounds the wall clock when one ancestor call stalls (which no
 *    depth cap can do: one hung request is one request).
 *
 * Hitting the depth cap renders the deepest ancestor reached, with a "view
 * earlier" link to its parent -- whose own page walks the next stretch, so a
 * reader can still climb the whole chain, one bounded render at a time. That
 * shape is a property of the chain, so it is stable and cacheable.
 *
 * Hitting the deadline is a slow backend, not a property of the chain, so it
 * is a retryable 503 -- the same answer an ancestor 5xx gets. Rendering
 * whichever ancestor arrived in time would hand a social unfurler a card for
 * the URL that differs from the healthy one, and it keeps it.
 */

/**
 * The most `parent` hops one render will follow. The render therefore costs
 * at most 1 + this many comment reads, however deep the chain.
 *
 * It is sized AGAINST the deadline below, not on its own: a healthy deep
 * reply must reach this cap (a deterministic 200 with "view earlier") before
 * it reaches the deadline (a 503). With 5 hops in 6 s each hop may average
 * 1.2 s -- twice the ~0.6 s per comment read  measured. Ten hops in 3 s
 * (the first draft) needed < 300 ms a hop, so ordinary six-deep replies
 * became 503s (codex review).
 */
export const CONVERSE_MAX_ANCESTOR_DEPTH = 5;

/**
 * Wall-clock budget for the WHOLE ancestor walk (every hop and its body),
 * not per call. It sits before `FIRST_PARTY_EMBED_TIMEOUT_MS` (the root's
 * `::embed[]` cards are awaited after it), so the two add; keep their sum
 * well inside the 8 s undetected-app-spend ceiling the article routes use.
 */
export const CONVERSE_ANCESTOR_WALK_TIMEOUT_MS = 6_000;

/**
 * The per-hop latency a healthy walk must tolerate and still reach the depth
 * cap -- twice the ~0.6 s  measured for one comment read. The test
 * asserts the two bounds above leave at least this much per hop.
 */
export const CONVERSE_ANCESTOR_HOP_BUDGET_MS = 1_200;
