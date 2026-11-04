/**
 * The deadlines a zPage article's server render enforces on its OPTIONAL
 * upstream calls -- and the single place they are written down.
 *
 * WHY THIS MODULE EXISTS
 *
 * `tests/browser/article-enrichment-deadline.spec.ts` proves that the SSR
 * stream completes even when one of those optional calls never answers. It
 * measured that through its own `AbortController`, hardcoded at 6000 ms.
 *
 * 3500 + 2500 = 6000. The spec's bound had become EXACTLY the sum of the two
 * deadlines below, with nothing left over for process start, the primary
 * `/api/zpage/` round trip, the render, and streaming the last byte after
 * `</html>` on a shared 2-core CI runner. Nobody chose that: the literal was
 * written once and the constants moved underneath it. The spec then failed
 * whenever the runner was slower than instant, with a bare
 * `AbortError: This operation was aborted` that named neither the bound nor
 * what it was composed of -- and two agents each spent a diagnosis cycle
 * deciding whether their own unrelated diff had caused it.
 *
 * So: the loaders and the spec now read the same exported numbers, and the
 * spec adds its headroom ON TOP of them explicitly (see
 * ARTICLE_SSR_APP_DEADLINE_MS). Change a deadline here and the spec's bound
 * follows; it can no longer silently become equal to the sum.
 */

/**
 * How long the article loader will hold the stream open for an OPTIONAL
 * enrichment call (`/related/`, `/series/`). Those links must not keep the
 * article behind an upstream stall.
 */
export const ARTICLE_ENRICHMENT_TIMEOUT_MS = 3_500;

/**
 * How long the loader will hold the stream open for a SECOND opinion about
 * which language variant to render. By the time it runs we already hold a
 * complete, renderable article; a stalled retry that blocks the response turns
 * a working page into a gateway timeout, which is strictly worse than serving
 * the language the reader did not ask for (codex adversarial review).
 */
export const ARTICLE_VARIANT_RETRY_TIMEOUT_MS = 2_500;

/**
 * How long the loader will hold the article for its first-party content cards
 * (`::embed[]` of a zPage or converse thread,  part 2). These ARE
 * awaited -- the cards are part of the server-rendered body, not a streamed
 * afterthought -- so this is time before the first byte, and it is kept
 * short: a card that misses it renders as its neutral link card.
 *
 * It must never exceed `ARTICLE_ENRICHMENT_TIMEOUT_MS`. The zPage loader
 * starts the (streamed) enrichment calls BEFORE it awaits the cards, so the
 * two overlap and the composed bound below still holds; that only stays true
 * while this is the shorter of the two, and
 * `tests/article-ssr-deadline-bound.test.mjs` asserts it.
 */
export const FIRST_PARTY_EMBED_TIMEOUT_MS = 1_500;

/**
 * The worst case ONE zPage render can spend waiting out its own deadlines.
 *
 * The two enrichment calls race each other, so they cost one
 * `ARTICLE_ENRICHMENT_TIMEOUT_MS` between them -- but a language-variant retry
 * runs BEFORE them, in series, so on a route that takes both paths the two
 * deadlines add. A bound derived from this sum is therefore correct for every
 * fixture, including one that later grows an `available_languages` list and
 * starts taking the retry path without anybody noticing that the test's bound
 * no longer covered it.
 *
 * This is the app's share of the wall clock and NOTHING ELSE. It deliberately
 * excludes every cost that belongs to the machine the test runs on; a caller
 * that wants a wall-clock bound must add its own named headroom on top.
 */
export const ARTICLE_SSR_APP_DEADLINE_MS =
  ARTICLE_ENRICHMENT_TIMEOUT_MS + ARTICLE_VARIANT_RETRY_TIMEOUT_MS;
