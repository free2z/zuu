// Synthetic public content only. No copied production rows or visitor data.
export const NULL_URL_STATES = ["missing", "empty", "nullable", "present"];

/** @param {string} state @param {string} origin */
export function nullUrlFixtures(state, origin) {
  const media =
    state === "present"
      ? {
          url: `${origin}/brand/icon-192.png`,
          thumbnail: `${origin}/brand/icon-192.png`,
        }
      : state === "nullable"
        ? null
        : state === "empty"
          ? { url: "", thumbnail: "" }
          : undefined;
  const optionalLink =
    state === "nullable" ? null : state === "empty" ? "" : undefined;
  const creator = {
    username: "null-url-fixture",
    full_name:
      state === "present"
        ? "URL boundary fixture"
        : state === "empty"
          ? ""
          : undefined,
    description: "Public fixture bio. The word null is ordinary content.",
    avatar_image: media,
    banner_image: media,
    member_price: null,
    p2paddr: "",
    zpages: 1,
    total: "0",
    is_verified: false,
    is_live: false,
  };
  const page = {
    free2zaddr: "null-url-article",
    vanity: "null-url-article",
    creator,
    title: "URL boundary article",
    description: "Public URL fixture",
    content: [
      "## URL boundary content",
      "The word null and JSON null are not URLs.",
      "[Valid query](/search?q=null#null)",
      state === "present"
        ? "![Fixture image](/brand/icon-192.png)\n\n::embed[https://example.com/public-fixture]"
        : "",
    ].join("\n\n"),
    featured_image: media,
    get_url: optionalLink,
    is_published: true,
    is_subscriber_only: false,
    p2paddr: "",
    total_raised: 0,
    total: "0",
    f2z_score: "0",
    comments: [],
    tags: [],
    source_language: "en",
    requested_language: "en",
    actual_language: "en",
    fallback_used: false,
    available_languages: ["en"],
    variant_is_published: true,
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
  };
  const comment = {
    uuid: "null-url-conversation",
    parent: null,
    headline: "URL boundary conversation",
    content: "Public conversation fixture. [Valid query](/search?q=null)",
    author: creator,
    content_url:
      state === "present" ? "/null-url-fixture/null-url-article" : optionalLink,
    num_children: "1",
    tuzis: 0,
    tags: [],
    created_at: page.created_at,
    updated_at: page.updated_at,
  };
  const reply = {
    ...comment,
    uuid: "null-url-reply",
    parent: comment.uuid,
    content: "Delayed reply fixture",
    num_children: "0",
  };
  /** @param {unknown[]} results */
  const list = (results) => ({
    count: results.length,
    next: null,
    previous: null,
    results,
  });
  return (/** @type {URL} */ url) => {
    if (url.pathname === "/api/creator/null-url-fixture/") return creator;
    if (url.pathname === "/api/creator/") return list([creator]);
    if (url.pathname === "/api/zpage/null-url-article/") return page;
    if (url.pathname === "/api/zpage/") return list([page]);
    if (url.pathname === "/api/comments/null-url-conversation/") return comment;
    if (url.pathname === "/api/comments/null-url-conversation/replies/")
      return list([reply]);
    if (url.pathname === "/api/comments/zpage/null-url-article/")
      return list([]);
    return undefined;
  };
}
