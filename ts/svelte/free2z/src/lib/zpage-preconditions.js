/**
 * `ETag` / `If-Match` optimistic concurrency for the zPage editor.
 *
 * Two tabs editing the same article used to overwrite each other in silence.
 * The backend now emits a strong `ETag` on every zPage and variant read and
 * honours `If-Match` on the writes, answering **412** rather than applying a
 * write built on state somebody else has already replaced.
 *
 * This module is the browser half, and it exists as a module rather than as a
 * few lines inside `routes/edit/+page.svelte` for one reason: **orval emits no
 * code for `in: header` parameters**. Regenerating the client can never make
 * the browser send `If-Match`; a green `api-client` job proves shape parity
 * with the spec and nothing about what is on the wire. So the wiring is
 * hand-written, and being a module is what makes it testable
 * (`tests/zpage-preconditions.test.mjs` drives it against a real HTTP server
 * and asserts the server received the header).
 *
 * The registry is keyed by **request URL**, which is the part that is easy to
 * get wrong. The editor writes to two different resources — the canonical
 * article and a translation variant — and each carries its own validator. A
 * single "current etag" variable would eventually send a translation's
 * validator on a canonical save, and the creator would get a 412 on a page
 * nobody else had touched. Keying by URL makes that unrepresentable.
 *
 * Everything degrades to today's behaviour: no stored validator means no
 * header, which means last-write-wins exactly as before. That is deliberate —
 * a missing validator must never *block* a save.
 */

export const ETAG_HEADER = "ETag";
export const IF_MATCH_HEADER = "If-Match";
/** The create-only precondition on a variant write. */
export const IF_NONE_MATCH_HEADER = "If-None-Match";

/**
 * HTTP status for "your `If-Match` no longer describes this resource".
 *
 * Not 409. A 409 on these routes means the write can never be right as
 * written (a language already taken, a translation ceiling reached); a 412
 * means it was right a moment ago and the remedy is to re-read and re-apply.
 */
export const PRECONDITION_FAILED = 412;

/**
 * The `If-Match` header for a save, or nothing at all.
 *
 * @param {string | null | undefined} etag
 * @returns {Record<string, string>} spreadable into a `fetch` headers object
 */
export function preconditionHeaders(etag) {
  return etag ? { [IF_MATCH_HEADER]: etag } : {};
}

/**
 * `If-None-Match: *` for a save that STARTS a variant, or nothing.
 *
 * `If-Match` protects an edit of a version that exists; it has nothing to say
 * about a create. Two tabs that both opened a blank French version would both
 * PUT `/variants/fr/`, and the second silently replaced the first one's new
 * translation. With `*` the server refuses the losing write with 412.
 *
 * A held validator always wins. It is proof the variant exists (the server
 * handed it out), so sending both would ask for "exists AND does not exist"
 * and every save would 412. That happens for real: keeping your own text over
 * an AI draft that arrived mid-sentence seeds that draft's validator while the
 * editor still thinks of itself as a new translation.
 *
 * @param {{startsVariant: boolean, etag?: string | null}} save
 * @returns {Record<string, string>} spreadable into a `fetch` headers object
 */
export function createOnlyHeaders({ startsVariant, etag }) {
  return startsVariant && !etag ? { [IF_NONE_MATCH_HEADER]: "*" } : {};
}

/**
 * A validator out of a `Response`, or `null`.
 *
 * Tolerates a response with no `headers` at all: SSR stubs, a mocked fetch and
 * `tests/browser/mock-api.mjs` all produce those, and a missing validator has
 * to degrade to "no precondition" rather than throw inside a save.
 *
 * @param {{headers?: {get?: (name: string) => string | null}}} response
 * @returns {string | null}
 */
export function readEtag(response) {
  const value = response?.headers?.get?.(ETAG_HEADER);
  return value ? value : null;
}

/**
 * Per-URL store of the newest validator the server has handed us.
 *
 * @returns {{
 *   get: (url: string) => string | null,
 *   size: () => number,
 *   set: (url: string, etag: string | null | undefined) => void,
 *   remember: (url: string, response: unknown) => void,
 *   forget: (url: string) => void,
 *   clear: () => void,
 * }}
 */
export function createEtagRegistry() {
  /** @type {Map<string, string>} */
  const byUrl = new Map();

  return {
    get: (url) => byUrl.get(url) ?? null,
    size: () => byUrl.size,
    set: (url, etag) => {
      if (etag) byUrl.set(url, etag);
      else byUrl.delete(url);
    },
    /**
     * Record whatever validator a response carried.
     *
     * A write response carries the validator the *next* read will emit, which
     * is what keeps an editor's second autosave from 412ing against its own
     * first one. A response with no `ETag` clears the entry rather than
     * keeping the stale one: continuing to send a validator the server has
     * stopped issuing would fail every subsequent save.
     */
    remember: (url, response) => {
      const etag = readEtag(/** @type {any} */ (response));
      if (etag) byUrl.set(url, etag);
      else byUrl.delete(url);
    },
    forget: (url) => {
      byUrl.delete(url);
    },
    /**
     * Drop every validator we hold.
     *
     * A canonical write invalidates more than the canonical entry: a
     * translation's validator digests the canonical row too, because a
     * translation PUT writes shared article fields (`p2paddr`, `vanity`,
     * tags, …) onto the parent. So after a canonical write made outside the
     * save path there is no entry left that still describes current state,
     * and keeping any of them latches the editor into a false conflict.
     * (codex adversarial review.)
     */
    clear: () => {
      byUrl.clear();
    },
  };
}

/**
 * Is this failed save a lost-update conflict rather than a bad request?
 *
 * @param {{status?: number} | null | undefined} response
 * @returns {boolean}
 */
export function isPreconditionFailure(response) {
  return response?.status === PRECONDITION_FAILED;
}
