/**
 * The Converse stream fixture, shared by `converse-stream.spec.ts` and
 * `mock-api.mjs`.
 *
 * `/converse` is server-rendered since: `converse/+page.server.ts`
 * fetches page one of the stream from `PRIVATE_API_BASE_URL` -- THIS mock
 * server -- and a `page.route()` in a spec cannot see that request. The
 * browser-side route in the spec answers every LATER list request (filters,
 * load-more, reloads after a revoked session). Both halves have to describe
 * the same five posts, or a spec could pass against an SSR page one that the
 * client would never have produced. One module, imported by both, is how
 * they agree.
 *
 * Deliberately asymmetric -- three roots and two replies -- so `view=stream`
 * (five cards) and `view=threads` (three) give different answers on identical
 * data. A fixture where both render the same number could not tell a
 * regression from a fix.
 */

/**
 * @typedef {object} FixturePost
 * @property {string} uuid
 * @property {string | null} parent
 * @property {string} headline
 * @property {string} content
 * @property {number} tuzis
 * @property {string} num_children
 * @property {string[]} tags
 * @property {string | null} content_url
 * @property {string} created_at
 * @property {string} updated_at
 * @property {{ username: string; avatar_image: null }} author
 */

/**
 * @param {string} uuid
 * @param {string} content
 * @param {Partial<FixturePost>} [overrides]
 * @returns {FixturePost}
 */
export function conversePost(uuid, content, overrides = {}) {
  return {
    uuid,
    parent: null,
    headline: "",
    content,
    tuzis: 1,
    num_children: "0",
    tags: [],
    content_url: null,
    created_at: "2026-08-20T12:00:00Z",
    updated_at: "2026-08-20T12:00:00Z",
    author: { username: "streamfixture", avatar_image: null },
    ...overrides,
  };
}

// Newest first, which is what `-created_at` returns. Two of the five are
// replies: the firehose shows them as their own cards, the digest folds them
// into `converse-root-a`.
/** @type {FixturePost[]} */
export const CONVERSE_STREAM_FIXTURE = [
  conversePost("converse-root-a", "ROOT-A-BODY", {
    headline: "Shielded notes on the stream",
    tags: ["zcash"],
    tuzis: 5,
    num_children: "2",
  }),
  conversePost("converse-reply-a1", "REPLY-A1-BODY", {
    parent: "converse-root-a",
    author: { username: "replyfixture", avatar_image: null },
  }),
  conversePost("converse-reply-a2", "REPLY-A2-BODY", {
    parent: "converse-root-a",
    author: { username: "replyfixture", avatar_image: null },
  }),
  conversePost("converse-root-b", "ROOT-B-BODY", {
    headline: "A loud thread nobody replied to",
    tags: ["art"],
    tuzis: 99,
  }),
  conversePost("converse-root-c", "ROOT-C-BODY"),
];

/**
 * The unfiltered page-one envelope the SSR loader receives. `next` is null:
 * five posts fit on one page, so the client has nothing to continue.
 */
export function converseStreamPageOne() {
  return {
    count: CONVERSE_STREAM_FIXTURE.length,
    next: null,
    previous: null,
    results: CONVERSE_STREAM_FIXTURE,
  };
}
