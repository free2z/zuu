/**
 * Durable comment drafts (issue ).
 *
 * The comment form used to keep the in-progress text in component-local
 * `let` bindings. That ties the lifetime of the user's typing to the lifetime
 * of the component *instance*, and the instance is not stable: the form lives
 * inside `{#if !$currentUser}` / `{:else}`, and the layout revalidates the
 * session on mount, on every `pathname` change, on window `focus` and on
 * `visibilitychange`. Any of those can flip the auth branch (a 401/403 from
 * `/api/auth/user/` calls `clearAuthState()`), which destroys and re-creates
 * the form — silently wiping whatever had been typed. SvelteKit re-creating
 * the page component does the same.
 *
 * The fix is to give the draft a lifetime of its own: keyed by what is being
 * commented on, stored in `sessionStorage`, restored on mount, cleared on a
 * successful post. Then a remount is a non-event instead of data loss.
 *
 * `sessionStorage` (not `localStorage`) is deliberate: a draft is scoped to
 * the tab and dies with it, so an abandoned draft never outlives the browsing
 * session on a shared machine.
 *
 * Keys are additionally scoped to the authenticated username. sessionStorage
 * outlives a logout, so without that scoping user A could type a draft (with a
 * 2Z weight), log out, and have user B log in on the same tab and find A's text
 * pre-filled — leaking private text and staging a spend against B's balance.
 *
 * Storage is passed in rather than reached for globally so this module is
 * SSR-safe and unit-testable (see tests/comment-drafts.test.mjs).
 */

export const DRAFT_STORAGE_PREFIX = "f2z:comment-draft:";

export const MIN_TUZIS = 1;
export const MAX_TUZIS = 10000;
export const DEFAULT_TUZIS = 1;

/**
 * @typedef {Object} CommentDraft
 * @property {string} headline
 * @property {string} content
 * @property {number} tuzis
 */

/**
 * @typedef {Object} DraftTarget
 * @property {string} [username] the logged-in author of the draft
 * @property {string} [object_type]
 * @property {string} [object_uuid]
 * @property {string} [parent]
 * @property {string} [scope]
 */

/**
 * Stable storage key for who is writing and what they are commenting on.
 *
 * Returns null when the author or the target is not yet known — during SSR,
 * before the article data resolves, or while logged out — so a draft is never
 * written under a key that would later change and orphan it, and never read
 * back by a different account.
 *
 * @param {DraftTarget} target
 * @returns {string | null}
 */
export function commentDraftKey({
  username,
  object_type,
  object_uuid,
  parent,
  scope,
}) {
  if (!username) return null;
  const who = `${DRAFT_STORAGE_PREFIX}${username}:`;
  if (parent) return `${who}reply:${parent}`;
  if (object_type && object_uuid) return `${who}${object_type}:${object_uuid}`;
  if (scope) return `${who}${scope}`;
  return null;
}

/**
 * @returns {CommentDraft}
 */
export function emptyDraft() {
  return { headline: "", content: "", tuzis: DEFAULT_TUZIS };
}

/**
 * @param {CommentDraft} draft
 * @returns {boolean} true when there is nothing worth persisting
 */
export function isEmptyDraft(draft) {
  return (
    draft.headline.trim() === "" &&
    draft.content.trim() === "" &&
    draft.tuzis === DEFAULT_TUZIS
  );
}

/**
 * Coerce anything read back out of storage into a usable draft.
 *
 * Storage is user-writable and survives deploys, so treat every field as
 * hostile: wrong types, missing keys, a `tuzis` of `NaN`/`0`/`1e9`, or a
 * headline/content longer than the backend accepts.
 *
 * @param {unknown} value
 * @returns {CommentDraft | null}
 */
export function normalizeDraft(value) {
  if (!value || typeof value !== "object") return null;

  const raw = /** @type {Record<string, unknown>} */ (value);
  const headline =
    typeof raw.headline === "string" ? raw.headline.slice(0, 100) : "";
  const content =
    typeof raw.content === "string" ? raw.content.slice(0, 1000) : "";

  let tuzis = DEFAULT_TUZIS;
  if (typeof raw.tuzis === "number" && Number.isFinite(raw.tuzis)) {
    tuzis = Math.min(MAX_TUZIS, Math.max(MIN_TUZIS, Math.trunc(raw.tuzis)));
  }

  if (headline === "" && content === "" && tuzis === DEFAULT_TUZIS) return null;
  return { headline, content, tuzis };
}

/**
 * Minimal shape we need from `sessionStorage` — also what the tests fake.
 *
 * @typedef {Pick<Storage, "getItem" | "setItem" | "removeItem">} DraftStorage
 */

/**
 * @param {DraftStorage | null | undefined} storage
 * @param {string | null} key
 * @returns {CommentDraft | null}
 */
export function readCommentDraft(storage, key) {
  if (!storage || !key) return null;
  try {
    const stored = storage.getItem(key);
    if (!stored) return null;
    return normalizeDraft(JSON.parse(stored));
  } catch {
    // Corrupt JSON, or storage disabled (Safari private mode throws on
    // access). A missing draft is recoverable; a thrown error mid-render
    // would take the whole comment section down.
    return null;
  }
}

/**
 * Persist a draft, or remove the entry entirely when there is nothing to keep.
 *
 * @param {DraftStorage | null | undefined} storage
 * @param {string | null} key
 * @param {CommentDraft} draft
 * @returns {void}
 */
export function writeCommentDraft(storage, key, draft) {
  if (!storage || !key) return;
  try {
    if (isEmptyDraft(draft)) {
      storage.removeItem(key);
      return;
    }
    storage.setItem(key, JSON.stringify(draft));
  } catch {
    // Quota exceeded / storage disabled. Losing persistence is bad; throwing
    // out of a reactive statement on every keystroke is worse.
  }
}

/**
 * @param {DraftStorage | null | undefined} storage
 * @param {string | null} key
 * @returns {void}
 */
export function clearCommentDraft(storage, key) {
  if (!storage || !key) return;
  try {
    storage.removeItem(key);
  } catch {
    // See writeCommentDraft.
  }
}

/**
 * `sessionStorage` when it exists and is reachable, otherwise null.
 *
 * @returns {DraftStorage | null}
 */
export function getDraftStorage() {
  try {
    if (typeof sessionStorage === "undefined") return null;
    return sessionStorage;
  } catch {
    return null;
  }
}
