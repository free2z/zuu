/**
 * `Idempotency-Key` for the editor's POST /api/zpage/.
 *
 * A create the editor abandons at its bound  may still commit, and
 * without a key every POST mints a new page — so the editor used to stop and
 * tell the creator to go check. With a key, re-sending the SAME body under the
 * SAME key is safe: the server returns the page the first attempt made (or
 * makes it, if that attempt never committed), and never a second one.
 *
 * orval emits no code for `in: header` parameters, so the header only reaches
 * the wire because the editor sets it by hand (see CLAUDE.md).
 */

export const ZPAGE_CREATE_IDEMPOTENCY_HEADER = "Idempotency-Key";

/**
 * A fresh UUIDv4 for one create attempt, or `null` when this browser cannot
 * mint one. `randomUUID` exists only in a secure context (https, localhost),
 * and a key made from `Math.random` is not one we want to stake "this is the
 * same page" on — so no key means the editor keeps its old, conservative
 * behaviour for a timed-out create: stop, and ask the creator to check.
 *
 * @param {{ randomUUID?: () => string } | undefined} [cryptoApi]
 * @returns {string | null}
 */
export function newZpageCreateKey(cryptoApi = globalThis.crypto) {
  if (typeof cryptoApi?.randomUUID !== "function") return null;
  try {
    return cryptoApi.randomUUID();
  } catch {
    return null;
  }
}

/**
 * What one answer to a keyed POST /api/zpage/ proves about the create
 * attempt (key AND body) it carried. Anything short of proof keeps the
 * attempt, because dropping it is how a second page gets made.
 *
 * - `"created"`: a 2xx that names the page. A 2xx whose body could not be
 *   read is NOT this — the page may exist and we do not know which it is.
 * - `"not-created"`: a 400 from Django (a JSON body), or the second-page
 *   `402 insufficient_funds`. The server consults the key before
 *   either, so a committed original would have been replayed; this answer
 *   means nothing under this key committed and the key is not spent.
 * - `"refused"`: a 409 — the server will not honour the key
 *   (`idempotency_mismatch`, `idempotency_page_gone`).
 * - `"unresolved"`: everything else. A 401/403 (expired session, CSRF), a 429
 *   or a 404 from a proxy turned the request away before it reached the
 *   receipt; a 5xx can arrive while Django is still committing; no response
 *   at all is the  timeout itself.
 *
 * @param {number | null | undefined} status
 * @param {unknown} [result] the parsed response body, if any
 * @returns {"created" | "not-created" | "refused" | "unresolved"}
 */
export function resolvesCreateAttempt(status, result) {
  if (typeof status !== "number") return "unresolved";
  if (status >= 200 && status < 300) {
    const address =
      result && typeof result === "object"
        ? /** @type {{ free2zaddr?: unknown }} */ (result).free2zaddr
        : undefined;
    return typeof address === "string" && address ? "created" : "unresolved";
  }
  if (status === 400) {
    // Only Django's own 400 — a JSON body naming what it refused — proves the
    // view ran (and so consulted the key). A proxy's 400 (an oversized cookie
    // header, say) is an HTML page, which parses to `{}` here, and proves
    // nothing about the original (codex review).
    // The 1-2Z page-quota refusal was a bare JSON string until, and a
    // backend from before that release can still answer one, so a non-empty
    // string counts as well.
    const isApplicationRefusal =
      (typeof result === "string" && result.length > 0) ||
      (Boolean(result) &&
        typeof result === "object" &&
        Object.keys(/** @type {object} */ (result)).length > 0);
    return isApplicationRefusal ? "not-created" : "unresolved";
  }
  if (status === 402) {
    // The page-quota refusal. Only its own body proves the view ran;
    // a 402 from anything else proves nothing about the original.
    const code =
      result && typeof result === "object"
        ? /** @type {{ code?: unknown }} */ (result).code
        : undefined;
    return code === "insufficient_funds" ? "not-created" : "unresolved";
  }
  if (status === 409) return "refused";
  return "unresolved";
}

/**
 * Response header every POST /api/zpage/ answer carries on a backend that
 * honours the key. Declared in f2z.yaml.
 */
export const ZPAGE_CREATE_KEY_HONORED_HEADER = "Idempotency-Key-Honored";

const HONORED_STORAGE_KEY = "f2z.zpageCreateKeyHonored";
/** In-memory copy, for when sessionStorage is unavailable. */
let honoredInMemory = false;

/**
 * Record what one create answer says about the backend ( review).
 *
 * A keyed retry is only safe against a backend that honours the key. An older
 * one (a rollback, a rollout that never converged) ignores it, and every retry
 * that commits is another page — a PUBLISHED one if the original was a
 * Publish. So the capability is learned from the answers themselves: seen on
 * any create answer, it is trusted for the rest of this tab's session; a page
 * CREATED without it (a 2xx with no signal: a backend that ignored the key)
 * withdraws that trust at once. A header-less error proves nothing either way
 * a proxy's 429/502 never reached Django — so it leaves the trust as it is.
 *
 * @param {{ ok?: boolean, headers?: { get?: (name: string) => string | null } } | null | undefined} response
 * @returns {boolean} whether this answer carried the signal
 */
export function noteCreateResponse(response) {
  const honored =
    response?.headers?.get?.(ZPAGE_CREATE_KEY_HONORED_HEADER) === "true";
  if (!honored && !response?.ok) return false;
  honoredInMemory = honored;
  try {
    if (honored) globalThis.sessionStorage?.setItem(HONORED_STORAGE_KEY, "1");
    else globalThis.sessionStorage?.removeItem(HONORED_STORAGE_KEY);
  } catch {
    // Storage blocked: the in-memory copy still covers this page's lifetime.
  }
  return honored;
}

/** Whether this session has seen proof that the backend honours the key. */
export function backendHonorsCreateKey() {
  try {
    if (globalThis.sessionStorage?.getItem(HONORED_STORAGE_KEY) === "1") {
      return true;
    }
  } catch {
    // Fall through to the in-memory copy.
  }
  return honoredInMemory;
}
