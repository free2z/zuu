/**
 * Free-form zPage tags.
 *
 * The backend is `django-taggit` — an open vocabulary with no server-side
 * whitelist. The editor spent a while presenting it as a closed twenty-item
 * picker; these helpers are the vocabulary-free replacement, and every rule
 * here is one the API or the database actually enforces. Nothing invents a
 * restriction the API does not have.
 *
 * Two deliberate non-goals, both of which belong to later steps of the tagging
 * work rather than to a text input:
 *
 *  * **No lowercasing.** Case-folding creator input is destructive and cannot
 *    be undone once saved. What we do instead is free and reversible: when a
 *    typed tag matches a tag the platform already uses, apart from case or
 *    surrounding whitespace, adopt the spelling already in the corpus. That
 *    converges `ZCASh` onto `zcash` without ever deciding that some canonical
 *    form is the only legal one.
 *  * **No cap on how many tags a page may carry.** The API has none. A client
 *    that invented one would reject a page the API would have accepted.
 *
 * Plain JS rather than TypeScript so `tests/tags.test.mjs` can import it
 * directly under `node --test`, the same reason `locale.js` is plain JS.
 */

import { tagHubHref } from "./tag.js";

/**
 * `taggit.models.Tag.name` is `max_length=100`. Longer input is a guaranteed
 * 400 at save time, so the input refuses it up front rather than letting the
 * creator write a paragraph and lose it to a validation error later.
 */
export const TAG_MAX_LENGTH = 100;

/** Characters that end a tag as you type. */
export const TAG_SEPARATOR_PATTERN = /[,\n\t]/;

/**
 * Whitespace-collapse and trim — the deterministic half of normalization,
 * which needs no AI and no vocabulary. `  zebra   husbandry ` and
 * `zebra husbandry` are the same tag by anyone's reckoning.
 *
 * @param {string} raw
 * @returns {string}
 */
export function normalizeTag(raw) {
  return raw.replace(/\s+/g, " ").trim();
}

/**
 * Case-insensitive identity, used for de-duplication and corpus matching.
 *
 * @param {string} raw
 * @returns {string}
 */
export function tagKey(raw) {
  return normalizeTag(raw).toLocaleLowerCase();
}

/**
 * Split raw typed text into candidate tags.
 *
 * Commas and newlines separate; a paste of `a, b,, c` yields three tags. The
 * result is normalized and non-empty but is NOT de-duplicated against anything
 * `mergeTags` owns that, because de-duplication needs to know what is
 * already on the page.
 *
 * @param {string} raw
 * @returns {string[]}
 */
export function parseTagInput(raw) {
  return raw
    .split(TAG_SEPARATOR_PATTERN)
    .map(normalizeTag)
    .filter((tag) => tag.length > 0);
}

/**
 * Add `incoming` to `existing`, preserving order and rejecting duplicates.
 *
 * `corpus` is the list of tags the platform already uses (whatever the
 * autocomplete last returned). A candidate that matches a corpus tag apart
 * from case adopts the corpus spelling. This is the free deterministic pass:
 * it costs one lookup, it is non-destructive — the creator can still type a
 * genuinely new spelling that no existing tag matches — and it is why the
 * folksonomy converges instead of fraying into `zcash` / `Zcash` / `ZCASH`.
 *
 * Over-long candidates are dropped rather than truncated: a silently cut tag
 * is worse than a tag that visibly did not stick, and the caller surfaces the
 * rejection.
 *
 * @param {readonly string[]} existing
 * @param {readonly string[]} incoming
 * @param {readonly string[]} [corpus]
 * @returns {{ tags: string[], rejected: string[] }}
 */
export function mergeTags(existing, incoming, corpus = []) {
  /** @type {Map<string, string>} */
  const canonical = new Map();
  for (const tag of corpus) {
    const key = tagKey(tag);
    if (key && !canonical.has(key)) canonical.set(key, normalizeTag(tag));
  }

  const tags = [...existing];
  const seen = new Set(tags.map(tagKey));
  /** @type {string[]} */
  const rejected = [];

  for (const candidate of incoming) {
    const normalized = normalizeTag(candidate);
    if (!normalized) continue;
    if (normalized.length > TAG_MAX_LENGTH) {
      rejected.push(normalized);
      continue;
    }
    const key = tagKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(canonical.get(key) ?? normalized);
  }

  return { tags, rejected };
}

/**
 * Remove one tag, matched case-insensitively so the chip always disappears.
 *
 * @param {readonly string[]} existing
 * @param {string} tag
 * @returns {string[]}
 */
export function removeTag(existing, tag) {
  const key = tagKey(tag);
  return existing.filter((candidate) => tagKey(candidate) !== key);
}

/**
 * Where a tag leads: its `/tag/<slug>` topic hub.
 *
 * It used to be `/search?tag=`, which worked but was a dead end for anyone
 * arriving from a search engine — `/search` renders no results server-side,
 * declares `noindex, follow`, and canonicalises every `?tag=` variant onto
 * bare `/search`. Google confirmed the cost by reporting the tag URLs under
 * "Excluded by `noindex` tag". `/tag/<slug>` is server-rendered and
 * self-canonical, so a tag chip now feeds link equity into a page that can
 * actually rank.
 *
 * FALLS BACK to the old URL when the tag has no slug — a tag of only emoji or
 * only punctuation reduces to nothing a path can carry. That tag is still
 * browsable, just not as an indexable hub. Emitting `/tag/` for it would be a
 * link to a 404.
 *
 * @param {string} tag
 * @returns {string}
 */
export function tagHref(tag) {
  return tagHubHref(tag) ?? searchTagHref(tag);
}

/**
 * The tag filter on `/search`, which is still a real, working capability —
 * it maps onto the API's `?tags=` parameter (declared in `f2z.yaml` since
 * ) and is deliberately not `?q=`, because a full-text search for `zcash`
 * also returns every article that merely says the word.
 *
 * Kept exported and kept working: `/search?tag=X` with no `?q=` redirects to
 * the hub, but `?q=` combined with `?tag=` is a genuine two-axis filter that
 * the hub cannot express, and it must not be broken by the redirect.
 *
 * @param {string} tag
 * @returns {string}
 */
export function searchTagHref(tag) {
  return `/search?tag=${encodeURIComponent(normalizeTag(tag))}`;
}

/**
 * A tag filter scoped to one creator's profile, which `TagFilter` already drives.
 *
 * @param {string} username
 * @param {string} tag
 * @returns {string}
 */
export function creatorTagHref(username, tag) {
  return `/${encodeURIComponent(username)}?tag=${encodeURIComponent(normalizeTag(tag))}`;
}
