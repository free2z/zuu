/**
 * Which page status an upstream API 4xx becomes during SSR.
 *
 * The creator/zPage/article loaders already turn the API's 404 into the
 * page's 404. Every OTHER 4xx used to fall through to the loader's generic
 * failure branch and render a 500 (or 503) page — so a throttled SSR read
 * (`429`) told a crawler "this site is broken" instead of "slow down", and a
 * refusal (`403`) was indistinguishable from an outage in the request log.
 *
 * The mapping is deliberately narrow. Only statuses whose meaning survives
 * the hop from API to page are passed through:
 *
 * - `429` → `429`, with the API's `Retry-After` when it is a plain
 *   delta-seconds value (the only form DRF and nginx emit). An absent or
 *   unparseable header is dropped rather than invented.
 * - `401` / `403` → `403`. SSR forwards the visitor's own session, so the
 *   API refusing it is the visitor's answer. It is never 401: this page has
 *   no `WWW-Authenticate` challenge to offer.
 * - `410` → `410`.
 *
 * Everything else (a `400`, a `405`, …) returns `null` and the caller keeps
 * its existing behaviour: it means SSR built a request the API rejects,
 * which is our defect and SHOULD page as a 5xx with a log line.
 */

// Bounded so a hostile or broken upstream cannot hand the visitor a
// Retry-After of years; one day is far beyond any throttle we configure.
const MAX_RETRY_AFTER_SECONDS = 86_400;

export type UpstreamClientError = {
  status: 403 | 410 | 429;
  retryAfter: string | null;
};

/** A `Retry-After` worth forwarding: delta-seconds only, bounded. */
export function forwardableRetryAfter(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^\d{1,6}$/.test(trimmed)) return null;
  const seconds = Number(trimmed);
  return String(Math.min(seconds, MAX_RETRY_AFTER_SECONDS));
}

/**
 * The page status for an upstream API status, or `null` when the upstream
 * status is not one this page should repeat.
 */
export function upstreamClientError(
  status: number | undefined,
  retryAfter?: string | null,
): UpstreamClientError | null {
  switch (status) {
    case 429:
      return { status: 429, retryAfter: forwardableRetryAfter(retryAfter) };
    case 401:
    case 403:
      return { status: 403, retryAfter: null };
    case 410:
      return { status: 410, retryAfter: null };
    default:
      return null;
  }
}

/**
 * The `error()` message for a mapped status. A throttle keeps the route's own
 * "failed to load" key (the page could not be built, try again); a refusal
 * or a gone uses a plain word so `+error.svelte` shows its 403/410 copy —
 * that page treats only an `errors.*` message as a translatable title.
 */
export function upstreamErrorMessage(
  upstream: UpstreamClientError,
  loadFailedMessage: string,
): string {
  if (upstream.status === 429) return loadFailedMessage;
  return upstream.status === 403 ? "Forbidden" : "Gone";
}
