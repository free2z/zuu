import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, test } from "node:test";

/**
 * "One thing I want is the full microblog stream easily available." —.
 *
 * Two independent halves, and this file pins both.
 *
 * **Reach.** `/converse` had exactly one entrance: an icon-only navbar button
 * with no visible text at any breakpoint (`Navbar.svelte`). It was absent from
 * `EXPLORE_LINKS`, which is the list `MobileNavMenu` renders from — so on a
 * phone the microblog was an unlabeled glyph and nothing else — and absent
 * from the footer. The classic UI's `<link rel="alternate">` pointing at
 * `/feeds/converse/recent.xml` was also dropped in the rewrite, so the feed
 * had no autodiscovery from either `/` or `/converse`.
 *
 * **Filters.** The backend has supported `tags` and `subscribed_to` since the
 * classic feed shipped, and orval generates them into `CommentsListParams` —
 * but the page hand-rolled `fetch("/api/comments/?...")` and used neither, and
 * held its sort/search in component state, so a filtered stream was not
 * linkable and did not survive a reload.
 *
 * NEGATIVE CONTROLS (each was run by reverting the change and re-running):
 *
 *   - remove `/converse` from EXPLORE_LINKS  -> "explore nav" tests fail
 *   - restore `size="icon-sm"` + drop the label span in Navbar.svelte
 *                                            -> "visible label" test fails
 *   - delete the two `<link rel="alternate">` blocks
 *                                            -> both "RSS autodiscovery" tests fail
 *   - `converseFiltersToSearchParams` returning `new URLSearchParams()`
 *                                            -> every round-trip test fails
 *   - `converseListParams` ignoring `tags` / `subscribed_to`
 *                                            -> the request-shape tests fail
 *   - splitting the tag input on whitespace  -> "a multi-word tag stays ONE
 *                                               tag" fails
 *   - `$: authenticated = $isAuthenticated`  -> the three-state test fails
 *   - dropping the `if (!append) comments = []` error path
 *                                            -> the stale-cards test fails
 *
 * The module tests below load the REAL module through vite, not a copy of its
 * logic. The component tests are source assertions, deliberately written
 * against the contract (a `/converse` entry exists, a label is rendered) with
 * formatting factored out, because a prettier pass must not turn them red.
 */

const url = (relative) => new URL(relative, import.meta.url);

const navbarSource = await readFile(
  url("../src/lib/components/layout/Navbar.svelte"),
  "utf8",
);
const mobileMenuSource = await readFile(
  url("../src/lib/components/layout/MobileNavMenu.svelte"),
  "utf8",
);
const footerSource = await readFile(
  url("../src/lib/components/layout/Footer.svelte"),
  "utf8",
);
const conversePageSource = await readFile(
  url("../src/routes/converse/+page.svelte"),
  "utf8",
);
const converseServerSource = await readFile(
  url("../src/routes/converse/+page.server.ts"),
  "utf8",
);
const profilePageSource = await readFile(
  url("../src/routes/[username]/+page.svelte"),
  "utf8",
);
const profilePostsSource = await readFile(
  url("../src/lib/components/profile/ProfileConversePosts.svelte"),
  "utf8",
);
const homepageSource = await readFile(
  url("../src/routes/+page.svelte"),
  "utf8",
);

let vite;
let navLinks;
let filters;

before(async () => {
  const { createServer } = await import("vite");
  vite = await createServer({
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
  });
  navLinks = await vite.ssrLoadModule("/src/lib/nav-links.js");
  filters = await vite.ssrLoadModule("/src/lib/converse/feed-filters.ts");
});

after(async () => {
  await vite?.close();
});

// ---------------------------------------------------------------------------
// Reach
// ---------------------------------------------------------------------------

describe("the microblog is reachable from site navigation", () => {
  test("`/converse` is in the shared explore nav list", () => {
    const converse = navLinks.EXPLORE_LINKS.find(
      (link) => link.href === "/converse",
    );
    assert.ok(
      converse,
      "EXPLORE_LINKS must carry /converse — it is the list the mobile menu " +
        "and the footer both render from.",
    );
    // A link with no i18n key renders the raw key to every non-English
    // visitor, which is how a nav entry ships broken and nobody notices.
    assert.equal(converse.key, "converse.title");
    assert.equal(converse.fallback, "Converse");
  });

  test("the mobile menu renders the explore list, so it gets /converse for free", () => {
    assert.match(mobileMenuSource, /EXPLORE_LINKS/);
    assert.match(
      mobileMenuSource,
      /key:\s*"navigation\.explore"[\s\S]{0,80}links:\s*EXPLORE_LINKS/,
      "the Explore section must be fed by EXPLORE_LINKS, not a second copy",
    );
    // Every other explore destination has an icon; a fallthrough to the
    // padlock glyph would look like a broken entry.
    assert.match(
      mobileMenuSource,
      /link\.href === "\/converse"[\s\S]{0,120}<MessagesSquare/,
    );
    assert.match(mobileMenuSource, /\bMessagesSquare\b[\s\S]{0,400}@lucide/);
  });

  test("the footer has an Explore column driven by the same list", () => {
    assert.match(
      footerSource,
      /import \{\s*EXPLORE_LINKS\s*\} from "\$lib\/nav-links\.js"/,
      "hard-coding the footer's explore links is what let it drift before",
    );
    assert.match(footerSource, /#each EXPLORE_LINKS as link/);
    assert.match(footerSource, /data-testid="footer-explore"/);
  });

  test("the navbar entry carries a visible label, not just an icon", () => {
    const button = navbarSource.slice(
      navbarSource.indexOf('href="/converse"'),
      navbarSource.indexOf(
        "</Button>",
        navbarSource.indexOf('href="/converse"'),
      ),
    );
    assert.ok(button.includes("/converse"), "converse navbar button not found");
    assert.match(
      button,
      /<span[^>]*>\s*\{\$t\("converse\.title"/,
      "the converse button must render its label as text, not only as " +
        "aria-label/title — an unlabeled glyph is why nobody found it",
    );
    assert.doesNotMatch(
      button,
      /size="icon-sm"/,
      "`icon-sm` collapses the button to a square with no room for the label",
    );
  });
});

// ---------------------------------------------------------------------------
// RSS autodiscovery
// ---------------------------------------------------------------------------

describe("the Converse RSS feed is discoverable again", () => {
  test("the feed path is defined once and is the real Django route", () => {
    assert.equal(filters.CONVERSE_RSS_PATH, "/feeds/converse/recent.xml");
  });

  test("/converse advertises the feed with <link rel=alternate>", () => {
    assert.match(
      conversePageSource,
      /<link\s+rel="alternate"[\s\S]{0,200}type="application\/rss\+xml"[\s\S]{0,200}href=\{CONVERSE_RSS_PATH\}/,
    );
  });

  test("the homepage advertises it too, as classic did", () => {
    assert.match(
      homepageSource,
      /<link\s+rel="alternate"[\s\S]{0,200}type="application\/rss\+xml"[\s\S]{0,200}href=\{CONVERSE_RSS_PATH\}/,
    );
    assert.match(
      homepageSource,
      /import \{ CONVERSE_RSS_PATH \} from "\$lib\/converse\/feed-filters"/,
    );
  });

  test("/converse offers the feed as a link a human can click", () => {
    assert.match(conversePageSource, /data-testid="converse-rss-link"/);
    assert.match(conversePageSource, /href=\{CONVERSE_RSS_PATH\}/);
  });
});

// ---------------------------------------------------------------------------
// Filter state lives in the URL
// ---------------------------------------------------------------------------

describe("converse filter state round-trips through the URL", () => {
  test("an unfiltered feed produces a bare /converse", () => {
    const parsed = filters.parseConverseFilters(
      new URL("https://free2z.cash/converse"),
    );
    assert.deepEqual(parsed, filters.DEFAULT_CONVERSE_FILTERS);
    assert.equal(filters.converseFiltersToQuery(parsed), "");
  });

  test("every filter survives serialize -> URL -> parse", () => {
    const chosen = {
      search: "zebra",
      sort: "hot",
      tags: ["zcash", "art"],
      subscribed: true,
      view: "threads",
      posts: true,
    };
    const query = filters.converseFiltersToQuery(chosen);
    // This is the string that has to be pasteable into another browser.
    assert.match(query, /^\?/);
    const reloaded = filters.parseConverseFilters(
      new URL(`https://free2z.cash/converse${query}`),
    );
    assert.deepEqual(reloaded, chosen);
    // And a second trip is stable, so a reload cannot drift the URL.
    assert.equal(filters.converseFiltersToQuery(reloaded), query);
  });

  test("each parameter is individually addressable", () => {
    const cases = [
      ["?q=hello", { search: "hello" }],
      ["?sort=hot", { sort: "hot" }],
      ["?tags=zcash", { tags: ["zcash"] }],
      ["?subscribed=1", { subscribed: true }],
      ["?view=threads", { view: "threads" }],
    ];
    for (const [query, expected] of cases) {
      const parsed = filters.parseConverseFilters(
        new URL(`https://free2z.cash/converse${query}`),
      );
      assert.deepEqual(
        parsed,
        { ...filters.DEFAULT_CONVERSE_FILTERS, ...expected },
        `${query} did not round-trip`,
      );
    }
  });

  test("a hand-edited or hostile URL still renders a feed", () => {
    const parsed = filters.parseConverseFilters(
      new URL("https://free2z.cash/converse?sort=DROP&view=../../etc&tags=,,,"),
    );
    assert.equal(parsed.sort, "new");
    assert.equal(parsed.view, "stream");
    assert.deepEqual(parsed.tags, []);
  });

  test("tag input accepts what a person types and de-duplicates it", () => {
    // `iexact` on the backend, so `Zcash` and `zcash` are the same JOIN twice.
    assert.deepEqual(filters.parseTagList("#Zcash, zcash , art"), [
      "Zcash",
      "art",
    ]);
    assert.deepEqual(filters.parseTagList(""), []);
    assert.deepEqual(filters.parseTagList(null), []);
  });

  test("a multi-word tag stays ONE tag", () => {
    // Tag names here really do contain spaces — `shielded-pool accounting
    // notes` is a fixture in tests/browser/tag-filter.spec.ts — and the
    // backend matches the whole name with `iexact`. Splitting on whitespace
    // turns one filter that matches into two ANDed filters that match nothing,
    // and it looks exactly like "there are no posts with that tag".
    assert.deepEqual(filters.parseTagList("zero knowledge"), [
      "zero knowledge",
    ]);
    assert.deepEqual(filters.parseTagList("zero   knowledge,  art "), [
      "zero knowledge",
      "art",
    ]);
    const roundTripped = filters.parseConverseFilters(
      new URL(
        `https://free2z.cash/converse${filters.converseFiltersToQuery({
          ...filters.DEFAULT_CONVERSE_FILTERS,
          tags: ["zero knowledge"],
        })}`,
      ),
    );
    assert.deepEqual(roundTripped.tags, ["zero knowledge"]);
    assert.equal(
      filters.converseListParams(
        { ...filters.DEFAULT_CONVERSE_FILTERS, tags: ["zero knowledge"] },
        1,
        { authenticated: false },
      ).tags,
      "zero knowledge",
    );
  });

  test("the tag list is bounded", () => {
    const many = Array.from({ length: 40 }, (_, i) => `t${i}`).join(",");
    assert.equal(
      filters.parseTagList(many).length,
      filters.MAX_CONVERSE_TAGS,
      "CommaSeparatedCharFilter ANDs one JOIN per tag — an unbounded list " +
        "from the address bar is an unbounded number of joins",
    );
  });
});

// ---------------------------------------------------------------------------
// What actually goes on the wire
// ---------------------------------------------------------------------------

describe("the request built for /api/comments/", () => {
  const withDefaults = (patch) => ({
    ...filters.DEFAULT_CONVERSE_FILTERS,
    ...patch,
  });

  test("sort maps onto the two orderings the backend declares", () => {
    // `ordering_fields = ['created_at', 'tuzis']`; anything else is a 400.
    assert.equal(
      filters.converseListParams(withDefaults({ sort: "new" }), 1, {
        authenticated: false,
      }).ordering,
      "-created_at",
    );
    assert.equal(
      filters.converseListParams(withDefaults({ sort: "hot" }), 1, {
        authenticated: false,
      }).ordering,
      "-tuzis",
    );
  });

  test("tags and search reach the generated client's params", () => {
    const params = filters.converseListParams(
      withDefaults({
        tags: ["zcash", "art"],
        search: "hello",
        view: "threads",
      }),
      2,
      { authenticated: true },
    );
    assert.equal(params.tags, "zcash,art");
    assert.equal(params.search, "hello");
    assert.equal(params.page, 2);
  });

  test("no filter means no parameter, not an empty one", () => {
    const params = filters.converseListParams(withDefaults({}), 1, {
      authenticated: true,
    });
    assert.equal("search" in params, false);
    assert.equal("tags" in params, false);
    assert.equal("subscribed_to" in params, false);
  });

  test("subscribed_to is sent for a signed-in visitor", () => {
    const params = filters.converseListParams(
      withDefaults({ subscribed: true }),
      1,
      { authenticated: true },
    );
    assert.equal(params.subscribed_to, true);
  });

  test("subscribed_to is NOT sent for an anonymous visitor", () => {
    // `filter_subscribed_to` returns the queryset unchanged when the caller is
    // anonymous — it does not error. Sending it anyway would show the whole
    // firehose under a UI claiming to be filtered. Degrade explicitly instead.
    const params = filters.converseListParams(
      withDefaults({ subscribed: true }),
      1,
      { authenticated: false },
    );
    assert.equal("subscribed_to" in params, false);
    // The URL keeps the flag, so signing in applies it with no re-navigation.
    assert.match(
      filters.converseFiltersToQuery(withDefaults({ subscribed: true })),
      /subscribed=1/,
    );
  });

  test("a nonsense page number degrades to page 1 rather than a 404", () => {
    // Numbered modes only -- the cursor stream has no page numbers at all.
    for (const bad of [0, -3, 1.5, NaN, Infinity, null, "c3RlYW0"]) {
      assert.equal(
        filters.converseListParams(withDefaults({ view: "threads" }), bad, {
          authenticated: false,
        }).page,
        1,
      );
    }
  });

  // -------------------------------------------------------------------------
  //stable keyset pagination for the live stream
  // -------------------------------------------------------------------------

  test("the stream opts into cursor pagination and never sends a page number", () => {
    // The default view (stream + New) is a live firehose read newest-first --
    // exactly the shape keyset pagination exists for. A post arriving between
    // fetches must not shift rows across the boundary, and the backend
    // refuses `page=` in cursor mode with a 400, so it must not be sent.
    const params = filters.converseListParams(withDefaults({}), null, {
      authenticated: true,
    });
    assert.equal(params.pagination, "cursor");
    assert.equal(params.ordering, "-created_at");
    assert.equal("page" in params, false);
    assert.equal("cursor" in params, false);
    assert.equal(filters.isCursorStream(withDefaults({})), true);
  });

  test("the second stream page carries the opaque cursor token, not an offset", () => {
    const nextUrl =
      "https://free2z.cash/api/comments/?pagination=cursor&page_size=12&ordering=-created_at&cursor=c3RlYW0";
    const token = filters.nextPageToken(
      withDefaults({}),
      { next: nextUrl },
      null,
    );
    assert.equal(token, "c3RlYW0");
    const params = filters.converseListParams(withDefaults({}), token, {
      authenticated: false,
    });
    assert.equal(params.cursor, "c3RlYW0");
    assert.equal(params.pagination, "cursor");
    assert.equal("page" in params, false);
  });

  test("a missing `next` is end-of-feed in both modes", () => {
    assert.equal(
      filters.nextPageToken(withDefaults({}), { next: null }, "x"),
      null,
    );
    assert.equal(
      filters.nextPageToken(withDefaults({ view: "threads" }), {}, 3),
      null,
    );
    //...and the numbered modes advance the integer.
    assert.equal(
      filters.nextPageToken(
        withDefaults({ view: "threads" }),
        { next: "https://free2z.cash/api/comments/?page=4" },
        3,
      ),
      4,
    );
  });

  test("a broken or foreign `next` link degrades to end-of-feed, not a crash", () => {
    assert.equal(filters.cursorFromNextUrl(null), null);
    assert.equal(filters.cursorFromNextUrl(undefined), null);
    assert.equal(filters.cursorFromNextUrl(""), null);
    assert.equal(filters.cursorFromNextUrl("not a url"), null);
    assert.equal(filters.cursorFromNextUrl(42), null);
    // A different path never hands out tokens...
    assert.equal(
      filters.cursorFromNextUrl(
        "https://free2z.cash/api/zpage/?cursor=steal-me",
      ),
      null,
    );
    //...and neither does the comments path WITHOUT a cursor parameter.
    assert.equal(
      filters.cursorFromNextUrl("https://free2z.cash/api/comments/?page=2"),
      null,
    );
    // A relative `next` (a proxy that strips the origin) still works.
    assert.equal(
      filters.cursorFromNextUrl("/api/comments/?pagination=cursor&cursor=abc"),
      "abc",
    );
  });

  test("threads and Hot keep numbered pages; Hot cannot be cursored", () => {
    // The digest consumes up to three API pages per screenful by design, and
    // Hot cannot be cursored at all (-tuzis is mutable; the backend refuses
    // the combination with a 400).
    const threads = filters.converseListParams(
      withDefaults({ view: "threads" }),
      2,
      { authenticated: false },
    );
    assert.equal(threads.page, 2);
    assert.equal("pagination" in threads, false);
    assert.equal("cursor" in threads, false);

    const hot = filters.converseListParams(withDefaults({ sort: "hot" }), 3, {
      authenticated: false,
    });
    assert.equal(hot.page, 3);
    assert.equal(hot.ordering, "-tuzis");
    assert.equal("pagination" in hot, false);
    assert.equal(filters.isCursorStream(withDefaults({ sort: "hot" })), false);
    assert.equal(
      filters.isCursorStream(withDefaults({ view: "threads" })),
      false,
    );
  });

  test('posts-only sends BOTH halves of "microblog" and round-trips', () => {
    // `parent IS NULL` alone is not a microblog post: a first-level comment
    // on a zPage or an AI conversation has no parent either, and would still
    // show up in a feed labelled "Posts". A standalone converse post is
    // `parent IS NULL AND content_type IS NULL` (`visibility.py`), so both
    // parameters have to go on the wire.
    const params = filters.converseListParams(
      withDefaults({ posts: true }),
      null,
      {
        authenticated: false,
      },
    );
    assert.equal(params.parent__isnull, true);
    assert.equal(params.content_type__isnull, true);
    const unfiltered = filters.converseListParams(withDefaults({}), null, {
      authenticated: false,
    });
    assert.equal("parent__isnull" in unfiltered, false);
    assert.equal("content_type__isnull" in unfiltered, false);
    const query = filters.converseFiltersToQuery(withDefaults({ posts: true }));
    assert.match(query, /posts=1/);
    assert.equal(filters.parseConverseFilters(query).posts, true);
    assert.equal(filters.parseConverseFilters("").posts, false);
  });

  test("only the bare, unfiltered stream is what the server rendered", () => {
    assert.equal(filters.isServerRenderedStream(withDefaults({})), true);
    for (const patch of [
      { sort: "hot" },
      { view: "threads" },
      { search: "x" },
      { tags: ["zcash"] },
      { subscribed: true },
      { posts: true },
    ]) {
      assert.equal(
        filters.isServerRenderedStream(withDefaults(patch)),
        false,
        JSON.stringify(patch),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The feed page uses the generated client, and defaults to the full stream
// ---------------------------------------------------------------------------

describe("the /converse page", () => {
  test("calls the generated client instead of hand-rolling the URL", () => {
    assert.match(
      conversePageSource,
      /import \{ commentsList, commentsRetrieve \} from "\$lib\/api\/comments\/comments"/,
    );
    assert.doesNotMatch(
      conversePageSource,
      /fetch\(`?\$?\{?apiBase\}?\/api\/comments/,
      "a hand-rolled URL is how the tags/subscribed_to parameters stayed " +
        "unreachable while the generated client already had them",
    );
    assert.doesNotMatch(
      conversePageSource,
      /new URLSearchParams\(\)[\s\S]{0,200}\/api\/comments\//,
    );
  });

  test("defaults to the full stream, not the thread digest", () => {
    assert.equal(filters.DEFAULT_CONVERSE_FILTERS.view, "stream");
    // The digest survives as an explicitly chosen, linkable view — but the
    // parent walk that collapses 36 posts into 10 cards may only run there.
    assert.match(
      conversePageSource,
      /filterState\.view === "threads" \? loadThreads : loadStream/,
    );
    const stream = conversePageSource.slice(
      conversePageSource.indexOf("async function loadStream"),
      conversePageSource.indexOf("async function loadThreads"),
    );
    assert.ok(stream.length > 0, "loadStream not found");
    assert.doesNotMatch(
      stream,
      /resolveRoot/,
      "the stream view must not walk parents — that walk is the N+1 and it " +
        "is what made the feed a digest instead of a firehose",
    );
  });

  test("treats auth as three-state, not as a boolean", () => {
    // `!$isAuthenticated` is also true for the ~200ms before /api/auth/user/
    // answers. Using it here would render the unfiltered firehose
    // under a "sign in to filter this" notice to somebody already signed in,
    // and would fire a second identical list request on every visit.
    assert.match(
      conversePageSource,
      /import\s*\{[^}]*\bauthStatus\b[^}]*\}\s*from "\$lib\/stores\/auth"/,
    );
    // Pinned on the import, not on the identifier: the identifier also appears
    // in the comment explaining why it is not used, and an assertion a comment
    // can break is an assertion people delete.
    assert.doesNotMatch(
      conversePageSource,
      /import \{[^}]*\bisAuthenticated\b[^}]*\} from "\$lib\/stores\/auth"/,
    );
    assert.match(conversePageSource, /resolvedAuthStatus === "authenticated"/);
    assert.match(conversePageSource, /page\.data\.hasSession === false/);
    // EVERY list request is auth-sensitive, not only the subscribed one:
    // `scope_comments_to_visible_parents` widens the queryset for an
    // authenticated caller. Keying only the subscribed filter on auth leaves
    // the previous identity's results in the DOM after a session is revoked.
    assert.match(
      conversePageSource,
      /requestKey = `\$\{filtersKey\}\|\$\{viewerKey\}`/,
    );
    //...and the wait for that answer is bounded, so a stuck /api/auth/user/
    // cannot leave the public feed as a permanent skeleton.
    assert.match(conversePageSource, /AUTH_RESOLVE_GRACE_MS/);
    assert.match(
      conversePageSource,
      /waitingForAuth =[\s\S]{0,120}!authGraceExpired/,
    );
  });

  test("a filter change commits a pending search instead of erasing it", () => {
    // Type a query, then click Hot before the 350ms debounce fires: the
    // navigation used to commit the OLD (empty) search, the reactive block
    // then reset the draft, and the pending timer committed the erased value.
    assert.match(
      conversePageSource,
      /if \(searchDebounce\) \{\s*clearTimeout\(searchDebounce\);\s*searchDebounce = null;\s*\}\s*const pending: Partial<ConverseFilters> = \{\s*search: searchDraft\.trim\(\),/,
    );
    // An older URL must not overwrite input while a filter navigation or
    // a newly typed search debounce is still pending.
    assert.match(
      conversePageSource,
      /if \(!pendingFilters && !searchDebounce\) searchDraft = filters\.search;/,
    );
  });

  test("a failed first page clears the previous filter's cards", () => {
    // The URL, the toggles and the tag badges have already moved. Leaving the
    // old cards under the error banner presents them as the result of a query
    // that never succeeded.
    assert.match(conversePageSource, /if \(!append\) \{\s*comments = \[\];/);
    assert.match(
      conversePageSource,
      /comments\.length === 0 && !errorMessage/,
      "the empty state must not claim there are no conversations when the " +
        "request failed",
    );
  });

  test("an identity change empties the feed before the reload, not after", () => {
    // A browser fetch has no timeout and nginx allows ~200s, so `loading` is
    // not a bound: a stalled reload would keep the previous identity's cards
    // on screen for minutes after the session was revoked.
    assert.match(
      conversePageSource,
      /if \(authKey !== lastLoadedAuthKey\) \{[\s\S]{0,200}comments = \[\];/,
    );
  });

  test("every navigation carries both drafts, not just the control touched", () => {
    // `blur` fires before `click`, so operating a toggle while the tag input
    // has focus starts two navigations and the second one wins.
    assert.match(
      conversePageSource,
      /const pending: Partial<ConverseFilters> = \{[\s\S]{0,140}tags: parseTagList\(tagDraft\),/,
    );
  });

  test("reads its filter state from the URL, and writes changes back", () => {
    assert.match(conversePageSource, /parseConverseFilters\(\$page\.url\)/);
    assert.match(
      conversePageSource,
      /goto\(`\/converse\$\{query\}`[\s\S]{0,120}replace: true/,
      "a filter change must replace history, not stack an entry per keystroke",
    );
  });
});

// ---------------------------------------------------------------------------
//SSR page one, cursor paging on the page, and the per-creator surface
// ---------------------------------------------------------------------------

describe("the stream is server-rendered and cursored (#1420)", () => {
  test("a +page.server.ts loader fetches page one of the cursor stream", () => {
    assert.match(
      converseServerSource,
      /pagination=cursor/,
      "SSR must request the same stable-keyset mode the client continues with",
    );
    assert.match(converseServerSource, /page_size=\$\{STREAM_PAGE_SIZE\}/);
    assert.match(converseServerSource, /ordering=-created_at/);
    // The same header the client sends, so SSR and client cards agree on
    // content URLs.
    assert.match(converseServerSource, /CANONICAL_CONTENT_URL_HEADERS/);
  });

  test("SSR forwards the session cookie and declares the response per-visitor", () => {
    // Same contract as converse/[uuid]/+page.server.ts: visibility widens for
    // a forwarded session, so shared caches must not collapse identities.
    assert.match(converseServerSource, /headers\?\.get\("cookie"\)/);
    assert.match(converseServerSource, /"cache-control": "private, no-cache"/);
    assert.match(converseServerSource, /vary: "Cookie"/);
  });

  test("an upstream failure is fail-open: null, not a 500 of the main feed", () => {
    assert.match(
      converseServerSource,
      /return \{ initialPage: null, ssrHadSession \};/,
      "the client can load page one itself; the public feed must never hard-fail",
    );
    assert.doesNotMatch(
      converseServerSource,
      /\berror\(\d{3}/,
      "the loader has no business throwing",
    );
    // The  lesson: one bounded upstream request, not an unbounded wait.
    assert.match(converseServerSource, /createHomepageUpstreamSignal/);
    assert.match(converseServerSource, /UPSTREAM_TIMEOUT_MS = 3_500/);
  });

  test("a filtered URL is not fetched server-side at all", () => {
    // The page adopts the SSR payload ONLY for the bare stream
    // (`isServerRenderedStream`). Fetching it anyway on `?tags=zcash`,
    // `?posts=1`, `?sort=hot` or `?view=threads` blocks the render for up to
    // UPSTREAM_TIMEOUT_MS on a result the component throws away, and pays for
    // a full visibility-scoped `count()` and sort to produce it. The SAME
    // predicate must gate both sides, so the loader cannot drift into
    // fetching a page the page will not take.
    assert.match(
      converseServerSource,
      /import \{\s*isServerRenderedStream,\s*parseConverseFilters,\s*\} from "\$lib\/converse\/feed-filters"/,
    );
    assert.match(
      converseServerSource,
      /if \(!isServerRenderedStream\(parseConverseFilters\(url\.searchParams\)\)\) \{\s*return \{ initialPage: null, ssrHadSession \};\s*\}/,
    );
    //...and it has to come BEFORE the fetch, not after it.
    assert.ok(
      converseServerSource.indexOf("isServerRenderedStream") <
        converseServerSource.indexOf("await fetch("),
      "the guard must short-circuit the upstream call, not filter its result",
    );
  });

  test("the page adopts the server page once, only for the unfiltered stream, and does not refetch it", () => {
    assert.match(conversePageSource, /export let data: PageData;/);
    assert.match(
      conversePageSource,
      /data\.initialPage &&\s*isServerRenderedStream\(filters\)/,
    );
    assert.match(conversePageSource, /ssrSatisfiedFiltersKey = filtersKey;/);
    // The first resolved auth answer for that key is satisfied by the SSR
    // page (it was fetched with the same cookie), not refetched.
    assert.match(
      conversePageSource,
      /else if \(ssrCoversThisKey\) \{[\s\S]{0,400}ssrSatisfiedFiltersKey = null;/,
    );
    // The adoption block must NOT be browser-gated: SSR HTML needs the cards.
    const adoption = conversePageSource.slice(
      conversePageSource.indexOf("let adoptedServerPage"),
      conversePageSource.indexOf("ssrSatisfiedFiltersKey = filtersKey;"),
    );
    assert.doesNotMatch(adoption, /\bbrowser\b/);
    //...and adoption is keyed on the PAYLOAD, not on "the first run of this
    // component". The loader reads `url.searchParams`, so SvelteKit re-runs
    // it on a `?sort=hot` -> `/converse` navigation and hands the component a
    // fresh page one; a once-per-lifetime latch would throw that successful
    // response away and immediately fetch page one again -- two sequential
    // backend round trips for one navigation, and an error state if the
    // second one loses a race it never needed to run.
    assert.match(
      conversePageSource,
      /\$: if \(data\.initialPage !== adoptedServerPage\) \{/,
    );
    assert.doesNotMatch(conversePageSource, /serverPageConsidered/);
    // Adopting mid-life must orphan the previous URL's in-flight request:
    // a Hot response landing after the navigation is still the current
    // sequence, and would overwrite the adopted stream under a UI that says
    // New -- with nothing left to refetch it, the key having been consumed.
    assert.match(adoption, /requestSeq \+= 1;/);
  });

  test("the server page is dropped when the browser resolves a DIFFERENT identity", () => {
    // The same cookie does not guarantee the same AUTHORIZATION over time.
    // Revoke the session between the SSR render and the browser's first
    // `/api/auth/user/` answer and the server page is the cookie-holder's
    // feed -- widened by `scope_comments_to_visible_parents` to their drafts'
    // threads and their private AI conversations -- while the client has just
    // been told it is anonymous. Adopting it would leave that content in the
    // DOM permanently, because the page believes the server already answered
    // this exact request and so never refetches.
    // The SESSION cookie specifically, through the same helper `hasSession`
    // uses. `Boolean(cookie)` would count a `free2z-locale` or `csrftoken`
    // as a session, so an anonymous visitor's own hydration would declare a
    // mismatch against its own correct anonymous render and throw the
    // server-rendered feed away.
    assert.match(
      converseServerSource,
      /const ssrHadSession = Boolean\(getSessionCookie\(cookies\)\)/,
    );
    assert.doesNotMatch(
      converseServerSource,
      /ssrHadSession = Boolean\(cookie\)/,
    );
    assert.match(
      converseServerSource,
      /import \{ getSessionCookie \} from "\$lib\/server\/backend"/,
    );
    assert.equal(
      converseServerSource.match(/ssrHadSession \}/g)?.length,
      4,
      "every return path must report whether a session cookie accompanied the render",
    );
    assert.match(conversePageSource, /!data\.ssrHadSession && !authenticated/);
    //...but only once there IS an answer: while it is outstanding nothing
    // contradicts the server page, and a skeleton over real cards is a
    // regression of the SSR this whole loader exists for.
    assert.match(
      conversePageSource,
      /waitingForAuth \|\|\s*\(!data\.ssrHadSession && !authenticated\)/,
    );
    // The gate has to be part of `ssrCoversThisKey` itself, which is what the
    // identity-clear, the skeleton and the refetch all read.
    assert.match(
      conversePageSource,
      /ssrCoversThisKey =\s*ssrSatisfiedFiltersKey === filtersKey && ssrAuthMatches/,
    );
  });

  test("stream pages advance by cursor token; the digest keeps its arithmetic", () => {
    assert.match(conversePageSource, /let nextPage: ConversePageToken = null;/);
    assert.match(
      conversePageSource,
      /next: nextPageToken\(filterState, data, pageToken\)/,
    );
    assert.match(
      conversePageSource,
      /fetchPage\(filterState, auth, null, false\)/,
    );
    const threads = conversePageSource.slice(
      conversePageSource.indexOf("async function loadThreads"),
      conversePageSource.indexOf("async function fetchPage"),
    );
    assert.match(threads, /cursor = data\.next \? cursor \+ 1 : null;/);
  });

  test("the posts-only toggle is on the page and writes the URL", () => {
    assert.match(
      conversePageSource,
      /data-testid="converse-posts-only-toggle"/,
    );
    assert.match(
      conversePageSource,
      /applyFilters\(\{ posts: !filters\.posts \}\)/,
    );
  });
});

describe("the per-creator Posts tab (#1420)", () => {
  test("exists for the owner AND for every other visitor", () => {
    const triggers = profilePageSource.match(
      /<Tabs\.Trigger value="posts" data-testid="profile-posts-tab">/g,
    );
    assert.equal(
      triggers?.length,
      2,
      "one trigger in the owner's tab bar and one in the public tab bar",
    );
    const contents = profilePageSource.match(
      /<ProfileConversePosts username=\{creator\.username\} \{displayName\} \/>/g,
    );
    assert.equal(contents?.length, 2);
  });

  test("the posts panel does not mount until its tab is opened", () => {
    // `Tabs.Content` is NOT lazy. bits-ui renders every panel and marks the
    // inactive ones `hidden` (`tabs-content.svelte` renders `children`
    // unconditionally; `TabsContentState.props` only sets `hidden`). So a
    // bare `<ProfileConversePosts />` inside the closed panel mounts on EVERY
    // profile view, and its `onMount` fires
    // `GET /api/comments/?author=...&pagination=cursor` -- which runs a full
    // `count()` over `comments_comment` with no supporting index -- for every
    // visitor and every crawler hit, whether or not anyone opens the tab.
    // The `{#if}` guards are what make it lazy, and they LATCH so tabbing
    // away and back does not tear the feed down and refetch it.
    assert.match(profilePageSource, /let ownerPostsOpened = false;/);
    assert.match(profilePageSource, /let publicPostsOpened = false;/);
    assert.match(
      profilePageSource,
      /\$: if \(ownerTab === "posts"\) ownerPostsOpened = true;/,
    );
    assert.match(
      profilePageSource,
      /\$: if \(publicTab === "posts"\) publicPostsOpened = true;/,
    );
    // Every mount site is inside one of those guards.
    for (const flag of ["ownerPostsOpened", "publicPostsOpened"]) {
      const guarded = new RegExp(
        `\\{#if ${flag}\\}\\s*<ProfileConversePosts username=\\{creator\\.username\\} \\{displayName\\} />\\s*\\{/if\\}`,
      );
      assert.match(profilePageSource, guarded);
    }
    const mounts =
      profilePageSource.match(/<ProfileConversePosts username=/g)?.length ?? 0;
    const guards =
      profilePageSource.match(/\{#if (?:owner|public)PostsOpened\}/g)?.length ??
      0;
    assert.equal(
      mounts,
      guards,
      "every ProfileConversePosts mount site is behind an opened-tab guard",
    );
  });

  test("the article pager is hidden on the Posts tab", () => {
    // Publications and Drafts are two views of the same `?page=`-paginated
    // article list and share ONE pager that lives outside every tab panel.
    // The Posts tab loads by cursor from its own component, so an owner with
    // more than ten articles would otherwise see numbered article pagination
    // under their posts -- and clicking page 2 refetches articles and rewrites
    // the URL while the posts on screen do not move.
    assert.match(profilePageSource, /let ownerTab = "published";/);
    assert.match(profilePageSource, /<Tabs\.Root bind:value=\{ownerTab\}/);
    assert.match(
      profilePageSource,
      /\{#if totalCount > 10 && ownerTab !== "posts"\}/,
    );
    // The public view has only one article tab, so its pager belongs INSIDE
    // that panel rather than being gated.
    const publicPanel =
      /<Tabs\.Content\s+value="articles"[\s\S]*?<\/Tabs\.Content>/.exec(
        profilePageSource,
      );
    assert.notEqual(publicPanel, null);
    assert.match(publicPanel[0], /CustomPagination/);
  });

  test("article search, sort and tag filter are hidden on the Posts tab", () => {
    // Same class of defect as the pager. These drive the `?search=` /
    // `?ordering=` / `?tag=` ARTICLE query and ProfileConversePosts takes
    // none of them, so on the Posts tab they read as controls over the posts
    // on screen while operating one reloads the articles behind the panel and
    // leaves the posts exactly where they were.
    assert.match(profilePageSource, /let publicTab = "articles";/);
    assert.match(profilePageSource, /<Tabs\.Root bind:value=\{publicTab\}/);
    assert.match(profilePageSource, /\{#if publicTab !== "posts"\}/);
    const gated = profilePageSource.slice(
      profilePageSource.indexOf('{#if publicTab !== "posts"}'),
      profilePageSource.indexOf(
        "<Tabs.Content",
        profilePageSource.indexOf('{#if publicTab !== "posts"}'),
      ),
    );
    assert.match(gated, /<TagFilter/);
    assert.match(gated, /<Select\.Root/);

    //...and the OWNER view needs the identical gate. Its control row sits
    // above the tab panels too, so an owner on Posts who picks "Oldest" or a
    // tag reloads the articles behind the panel while the posts do not move.
    assert.match(profilePageSource, /\{#if ownerTab !== "posts"\}/);
    const ownerGated = profilePageSource.slice(
      profilePageSource.indexOf('{#if ownerTab !== "posts"}'),
      profilePageSource.indexOf(
        "{/if}",
        profilePageSource.indexOf('{#if ownerTab !== "posts"}'),
      ),
    );
    assert.match(ownerGated, /<TagFilter/);
    assert.match(ownerGated, /<Select\.Root/);
    assert.match(ownerGated, /oninput=\{handleSearch\}/);
    // The "New Article" button is a global action, not a control over the
    // article list, so it stays visible on every tab.
    assert.doesNotMatch(ownerGated, /href="\/edit"/);
    assert.match(profilePageSource, /href="\/edit"/);
  });

  test("queries standalone posts by author with the cursor stream", () => {
    // The cursor mode itself comes from converseListParams on the default
    // (stream + New) filter state, which is the cursored one; `posts: true`
    // is `parent__isnull=true&content_type__isnull=true` on the wire, so the
    // tab shows the creator's POSTS and not every root comment they have
    // left under somebody else's article.
    assert.match(
      profilePostsSource,
      /\{\s*\.\.\.DEFAULT_CONVERSE_FILTERS,\s*posts:\s*true\s*\}/,
    );
    assert.match(profilePostsSource, /author: username/);
    assert.match(
      profilePostsSource,
      /cursor = cursorFromNextUrl\(data\.next\)/,
    );
    // The load-more button carries the cursor forward; it is not numbered.
    assert.match(profilePostsSource, /data-testid="profile-posts-load-more"/);
    assert.match(profilePostsSource, /void load\(false\)/);
    assert.doesNotMatch(profilePostsSource, /\bpage:\s*\d/);
  });

  test("resets when the route parameter changes under a reused component", () => {
    assert.match(profilePostsSource, /if \(username !== keyedTo\)/);
    const reset = profilePostsSource.slice(
      profilePostsSource.indexOf("if (username !== keyedTo)"),
      profilePostsSource.indexOf("let mounted"),
    );
    assert.match(reset, /posts = \[\];/);
    assert.match(reset, /cursor = null;/);
    //...and the reset must ORPHAN whatever is in flight for the previous
    // creator. Bumping the sequence alone is not enough: `load()` returns
    // early while `loading` is true, so navigating `/alice` -> `/bob`
    // mid-request would skip Bob's fetch entirely and then let Alice's
    // response -- still the current sequence -- install Alice's posts and
    // Alice's continuation cursor under Bob's header.
    assert.match(reset, /requestSeq \+= 1;/);
    assert.match(reset, /loading = false;/);
    assert.equal(
      reset.indexOf("requestSeq += 1;") < reset.indexOf("void load(true)"),
      true,
      "the in-flight request must be orphaned BEFORE the new one starts",
    );
  });

  test("a stale response cannot write into the component", () => {
    // Both the success path and the failure path are guarded, and so is the
    // `finally` -- otherwise a superseded request would clear the NEW
    // request's loading flag and the spinner would vanish under an empty tab.
    const load = profilePostsSource.slice(
      profilePostsSource.indexOf("async function load("),
      profilePostsSource.indexOf("onMount("),
    );
    assert.equal(load.match(/seq !== requestSeq/g)?.length, 2);
    assert.match(load, /finally \{[\s\S]{0,120}seq === requestSeq/);
  });
});
