<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import SeoHead from "$lib/components/SeoHead.svelte";
  import { browser } from "$app/env";
  import { beforeNavigate, goto } from "$app/navigation";
  import { page } from "$lib/kit-stores";
  import type { PageData } from "./$types";
  import {
    ConversePost,
    ConverseThread,
    type ConversePostData,
  } from "$lib/components/converse";
  import { commentsList, commentsRetrieve } from "$lib/api/comments/comments";
  import { CANONICAL_CONTENT_URL_HEADERS } from "$lib/api/canonical-content-url";
  import {
    CONVERSE_RSS_PATH,
    converseFiltersKey,
    converseFiltersToQuery,
    converseListParams,
    cursorFromNextUrl,
    isServerRenderedStream,
    nextPageToken,
    parseConverseFilters,
    parseTagList,
    type ConverseFilters,
    type ConversePageToken,
    type ConverseSort,
    type ConverseView,
  } from "$lib/converse/feed-filters";
  import MobileConverseComposer from "$lib/components/converse/MobileConverseComposer.svelte";
  import { authStatus, currentUser } from "$lib/stores/auth";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import * as ToggleGroup from "$lib/components/ui/toggle-group";
  import {
    AlertCircle,
    Clock3,
    Flame,
    Layers,
    List,
    Loader2,
    MessageSquare,
    MessagesSquare,
    RefreshCw,
    Rss,
    Search,
    Tag,
    Users,
    X,
  } from "@lucide/svelte";
  import { tStore as t } from "$lib/i18n";
  import { useFirstPartyCards } from "$lib/first-party-card-resolver";

  // Bound on the thread digest's parent walk. The firehose has no walk at all;
  // this only governs `view=threads`. See the comment on `loadThreads()`.
  const DIGEST_ROOT_TARGET = 10;
  const DIGEST_MAX_SOURCE_PAGES = 3;

  // How long the feed will hold for a definite auth answer before loading
  // as-if-anonymous. Generous next to the ~200ms `/api/auth/user/` normally
  // takes, and short enough that a stuck auth endpoint does not leave the
  // public feed as a skeleton.
  const AUTH_RESOLVE_GRACE_MS = 2_500;
  let authGraceExpired = false;
  let authGraceTimer: ReturnType<typeof setTimeout> | null = null;
  // Page one is in the HTML now, so "the feed is visible" no longer
  // means "the page is interactive". This flips in onMount and is exposed as
  // `data-hydrated` on <main> so a browser test can wait for the real state
  // instead of for a fixed sleep.
  let hydrated = false;

  export let data: PageData;

  // The server resolved the `::embed[]` cards of what it rendered, as this
  // reader; hand them to the page's resolver so hydration renders
  // exactly the server's markup and the browser does not repeat those calls.
  const firstPartyCards = useFirstPartyCards();
  $: firstPartyCards.seed(data.firstPartyCardSeed);

  let comments: ConversePostData[] = [];
  // The next-page token. For the default stream (New + stream view) this is
  // the opaque `cursor` value out of the envelope's `next`; for the thread
  // digest and the Hot sort it stays a 1-based page number. `null` is "page
  // one" before a load and "end of feed" after one. See feed-filters.ts.
  let nextPage: ConversePageToken = null;
  let loading = false;
  let loadingMore = false;
  let errorMessage: string | null = null;
  let searchDraft = "";
  let tagDraft = "";
  let pendingFilters: ConverseFilters | null = null;
  let filterNavigationSeq = 0;
  $: mobileFilters = pendingFilters ?? filters;
  let tagFilterInput: HTMLInputElement | null = null;

  let searchDebounce: ReturnType<typeof setTimeout> | null = null;
  let requestSeq = 0;
  let lastLoadedKey: string | null = null;
  let lastLoadedAuthKey: string | null = null;
  // bits-ui's single toggle group lets you deselect the active item, emitting
  // "". The callback correctly ignores that (the sort stays applied), but the
  // button was left looking unselected. Bumping these keys remounts the
  // group so it re-reads `value=` and re-highlights itself.
  let sortGroupKey = 0;
  let viewGroupKey = 0;
  let rootCache = new Map<string, Promise<ConversePostData>>();

  // The URL is the single source of truth for filter state, so a filtered feed
  // is linkable and survives a reload. Everything below derives from it.
  $: filters = parseConverseFilters($page.url);
  $: filtersKey = converseFiltersKey(filters);

  // Auth here is THREE-state, not two. `!$isAuthenticated` is also true
  // for the ~200ms before `/api/auth/user/` answers, and this page uses the
  // answer twice: to decide whether `subscribed_to` goes on the wire, and to
  // decide whether to tell the visitor they need to sign in. Treating
  // "unresolved" as "anonymous" would render the unfiltered firehose under a
  // "sign in to filter this" notice to somebody who is already signed in.
  //
  // `page.data.hasSession` is the per-request server signal (no `sessionid`
  // cookie means Django cannot authenticate this request, full stop) and is
  // only consulted as a fallback, so a client-side login can never demote a
  // signed-in visitor. Same shape as `Navbar.svelte`.
  $: resolvedAuthStatus =
    $authStatus !== "unknown"
      ? $authStatus
      : $page.data.hasSession === false
        ? "anonymous"
        : "unknown";
  $: authenticated = resolvedAuthStatus === "authenticated";
  // Say so whenever the Following filter is NOT being applied, whatever the
  // reason. `anonymous` is the ordinary case; `unknown` after the grace period
  // is the auth-endpoint-is-down case, where the request still carries the
  // session cookie but we cannot honestly claim to be filtering by it. Both
  // render the whole stream, so both have to be admitted rather than leaving
  // the visitor to wonder why "Following" looks like everyone.
  $: subscribedNeedsSignIn =
    filters.subscribed && !waitingForAuth && !authenticated;
  // Wait for a definite answer before the first request, but never forever: if
  // `/api/auth/user/` hangs while `/api/comments/` is healthy, a permanent
  // skeleton on the platform's main public feed is a worse outcome than a feed
  // fetched as-if-anonymous. When the answer does arrive it changes
  // `requestKey` and the feed reloads.
  $: waitingForAuth = resolvedAuthStatus === "unknown" && !authGraceExpired;

  // EVERY list request is auth-sensitive, not just the `subscribed` one:
  // `scope_comments_to_visible_parents` widens the queryset for an
  // authenticated caller (their own drafts' threads, their own private AI
  // conversations). So the auth answer is always part of the key — when a
  // session expires or is revoked, the key changes and the feed is refetched
  // instead of leaving the previous identity's results in the DOM. Gating the
  // FIRST load on resolution is what keeps that from costing a second request:
  // an anonymous visitor resolves synchronously from `hasSession === false`,
  // and a cookie-holder waits once rather than fetching twice.
  // An authenticated-to-authenticated account switch must also invalidate
  // cards and in-flight responses. Older self responses may omit the stable ID.
  $: actorKey =
    $currentUser?.id != null
      ? `id:${$currentUser.id}`
      : `username:${$currentUser?.username ?? ""}`;
  $: viewerKey = waitingForAuth
    ? "pending"
    : authenticated
      ? `authenticated:${actorKey}`
      : resolvedAuthStatus;
  $: requestKey = `${filtersKey}|${viewerKey}`;

  // SSR page one. `+page.server.ts` fetches the unfiltered stream
  // with the visitor's cookie forwarded, so the server-rendered HTML carries
  // real posts for crawlers and for anyone on a slow connection. This block
  // runs on the server too -- that is the point -- and adopts a payload only
  // when the URL asks for exactly what the server fetched.
  //
  // Adoption is keyed on the PAYLOAD, not on "the first time this component
  // ran". The loader reads `url.searchParams`, so SvelteKit re-runs it on a
  // `?sort=hot` -> `/converse` navigation and hands the component a FRESH
  // page one. A once-per-lifetime latch would discard that successful
  // response and immediately fetch page one again -- two sequential backend
  // round trips, two visibility-scoped counts, and a feed that goes to the
  // error state if the second one loses a race with a rolling restart, having
  // just been handed usable results.
  //
  // Cookie presence does not attest which creator shaped an SSR payload.
  // Keep it while identity is pending, then refresh every session-bearing
  // render: another tab may have changed Alice's cookie to Bob's before this
  // document resolved identity. Anonymous SSR still avoids a duplicate fetch.
  // Check every arriving payload, including invalidateAll responses that do
  // not change the filter/viewer key. Late SSR must not overwrite a new viewer.
  $: ssrAuthMatches = waitingForAuth || (!data.ssrHadSession && !authenticated);
  let adoptedServerPage: PageData["initialPage"] = null;
  let ssrSatisfiedFiltersKey: string | null = null;
  $: if (data.initialPage !== adoptedServerPage) {
    adoptedServerPage = data.initialPage ?? null;
    if (data.initialPage && isServerRenderedStream(filters) && ssrAuthMatches) {
      // Orphan whatever is still in flight for the PREVIOUS URL. Without
      // this, a `?sort=hot` response arriving after the navigation is still
      // the current sequence and would overwrite the adopted stream with Hot
      // posts and a Hot page number, under a UI that says New -- and nothing
      // would refetch, because the key below has already been consumed.
      requestSeq += 1;
      comments = (data.initialPage.results || []) as ConversePostData[];
      nextPage = cursorFromNextUrl(data.initialPage.next);
      errorMessage = null;
      loading = false;
      loadingMore = false;
      ssrSatisfiedFiltersKey = filtersKey;
    } else {
      ssrSatisfiedFiltersKey = null;
    }
  }

  $: if (browser && requestKey !== lastLoadedKey) {
    lastLoadedKey = requestKey;
    // An older tag-blur navigation may settle after the user starts a new
    // search. Own navigations already commit their drafts synchronously;
    // only external URL changes should replace uncommitted input here.
    if (!pendingFilters && !searchDebounce) searchDraft = filters.search;
    if (!pendingFilters) tagDraft = filters.tags.join(", ");
    const authKey = viewerKey;
    // An identity change empties the feed IMMEDIATELY rather than at the end of
    // the replacement request. Browser fetches have no timeout and nginx allows
    // ~200s, so "loading" is not a bound: on a stalled reload the previous
    // identity's cards would otherwise stay on screen for minutes after the
    // session was revoked. A plain filter change keeps its cards while the next
    // page loads, because those cards belong to the same viewer.
    // Only anonymous SSR can be matched without authoritative viewer data.
    // An authenticated status alone cannot distinguish one creator from another.
    const ssrCoversThisKey =
      ssrSatisfiedFiltersKey === filtersKey && ssrAuthMatches;
    if (authKey !== lastLoadedAuthKey) {
      lastLoadedAuthKey = authKey;
      requestSeq += 1;
      rootCache = new Map();
      if (!ssrCoversThisKey) {
        comments = [];
        nextPage = null;
      }
    }
    if (waitingForAuth) {
      // Show the skeleton rather than a feed built on a guess. `lastLoadedKey`
      // is the pending key, so the resolved one is a different key and
      // re-triggers this block.
      if (!ssrCoversThisKey) {
        loading = true;
        errorMessage = null;
      }
    } else if (ssrCoversThisKey) {
      // The server already answered this exact request for this cookie.
      // Consume the token: from here on every key change is a real change.
      ssrSatisfiedFiltersKey = null;
      loading = false;
    } else {
      ssrSatisfiedFiltersKey = null;
      void loadFirstPage(filters, authenticated);
    }
  }

  function applyFilters(patch: Partial<ConverseFilters>) {
    // Every navigation carries the CURRENT drafts, not just the one control
    // that was operated. Two ways the naive version loses a filter:
    //
    //   - the search debounce is still pending, fires ~350ms later against a
    //     draft this navigation has already replaced, and the typed query
    //     disappears;
    //   - clicking a toggle while the tag input has focus fires `blur` first,
    //     which starts its own `goto`, and then the click computes its patch
    //     from the pre-blur URL and starts a second `goto` without the tag.
    //     The second navigation wins and the tag is silently dropped.
    //
    // Reading both drafts here makes the last navigation the complete one
    // whichever order the events arrive in.
    if (searchDebounce) {
      clearTimeout(searchDebounce);
      searchDebounce = null;
    }
    const pending: Partial<ConverseFilters> = {
      search: searchDraft.trim(),
      tags: parseTagList(tagDraft),
    };
    // URL updates can trail rapid taps. Preserve every pending choice until
    // the latest navigation settles, rather than overwriting it from an old URL.
    const next: ConverseFilters = {
      ...(pendingFilters ?? filters),
      ...pending,
      ...patch,
    };
    // Preserve a trailing space while the user pauses between search words.
    if (searchDraft.trim() !== next.search) searchDraft = next.search;
    const nextTags = next.tags.join(", ");
    if (parseTagList(tagDraft).join(", ") !== nextTags) tagDraft = nextTags;
    pendingFilters = next;
    const navigation = ++filterNavigationSeq;
    const query = converseFiltersToQuery(next);
    return goto(`/converse${query}`, {
      replace: true,
      reset: false,
    }).finally(() => {
      if (navigation === filterNavigationSeq) pendingFilters = null;
    });
  }

  function assertViewerCache(cache: typeof rootCache) {
    if (cache !== rootCache)
      throw new Error("Viewer changed during thread lookup");
  }

  async function fetchComment(
    uuid: string,
    cache: typeof rootCache,
  ): Promise<ConversePostData> {
    assertViewerCache(cache);
    const cached = cache.get(uuid);
    if (cached) return cached;
    const request = commentsRetrieve(uuid, {
      headers: CANONICAL_CONTENT_URL_HEADERS,
    }) as Promise<ConversePostData>;
    cache.set(uuid, request);
    return request;
  }

  async function resolveRoot(
    post: ConversePostData,
    cache: typeof rootCache,
  ): Promise<ConversePostData> {
    assertViewerCache(cache);
    let current = post;
    const visited = new Set<string>();

    while (current.parent && !visited.has(current.uuid)) {
      visited.add(current.uuid);
      current = await fetchComment(current.parent, cache);
      assertViewerCache(cache);
    }

    cache.set(current.uuid, Promise.resolve(current));
    return current;
  }

  /**
   * The firehose. One API page in, one API page of cards out — no parent walk,
   * no collapsing, no second round trip. This is what the owner asked for and
   * what classic's `ConverseList` did: every post on the platform, newest
   * first. Thread context is not lost, it is just not fetched eagerly: each
   * card links to `/converse/{uuid}`, whose server loader already walks to the
   * root and focuses the post (`converse/[uuid]/+page.server.ts:35-46`).
   */
  async function loadStream(
    filterState: ConverseFilters,
    auth: boolean,
    pageToken: ConversePageToken,
    append: boolean,
  ) {
    const data = await commentsList(
      converseListParams(filterState, pageToken, { authenticated: auth }),
      { headers: CANONICAL_CONTENT_URL_HEADERS },
    );
    const results = (data.results || []) as ConversePostData[];
    const known = new Set(
      append ? comments.map((comment) => comment.uuid) : [],
    );
    const fresh = results.filter((post) => {
      if (known.has(post.uuid)) return false;
      known.add(post.uuid);
      return true;
    });
    // Cursor mode: the next token is the opaque `cursor` value out of `next`
    // (the uuid de-dupe above is pure defense now -- keyset boundaries cannot
    // repeat rows). The numbered modes advance the integer.
    return { posts: fresh, next: nextPageToken(filterState, data, pageToken) };
  }

  /**
   * The digest: collapse every result onto its thread root so a card is a
   * conversation rather than a post. Costs one extra `GET /api/comments/{uuid}/`
   * per hop up the parent chain, memoised per uuid for the lifetime of the
   * page, and is bounded twice — at most `DIGEST_MAX_SOURCE_PAGES` API pages
   * consumed and `DIGEST_ROOT_TARGET` roots produced per screenful. That bound
   * is exactly why it is no longer the default: 3 API pages (36 posts) can
   * render as 10 cards, which is the opposite of a full stream.
   */
  async function loadThreads(
    filterState: ConverseFilters,
    auth: boolean,
    pageToken: ConversePageToken,
    append: boolean,
  ) {
    const cache = rootCache;
    const knownRoots = new Set(
      append ? comments.map((comment) => comment.uuid) : [],
    );
    const roots: ConversePostData[] = [];
    // The digest is ALWAYS numbered (it consumes several API pages per
    // screenful), so a non-number can only be the initial `null` -- page one.
    let cursor: number | null =
      typeof pageToken === "number" && pageToken > 0 ? pageToken : 1;
    let sourcePages = 0;

    while (
      cursor !== null &&
      roots.length < DIGEST_ROOT_TARGET &&
      sourcePages < DIGEST_MAX_SOURCE_PAGES
    ) {
      assertViewerCache(cache);
      const data = await commentsList(
        converseListParams(filterState, cursor, { authenticated: auth }),
        { headers: CANONICAL_CONTENT_URL_HEADERS },
      );
      assertViewerCache(cache);
      const resolved = await Promise.all(
        ((data.results || []) as ConversePostData[]).map((post) =>
          resolveRoot(post, cache),
        ),
      );
      assertViewerCache(cache);
      for (const root of resolved) {
        if (!knownRoots.has(root.uuid)) {
          knownRoots.add(root.uuid);
          roots.push(root);
        }
      }
      cursor = data.next ? cursor + 1 : null;
      sourcePages += 1;
    }

    return { posts: roots, next: cursor };
  }

  async function fetchPage(
    filterState: ConverseFilters,
    auth: boolean,
    pageToken: ConversePageToken,
    append: boolean,
  ) {
    const seq = ++requestSeq;
    if (append) {
      loadingMore = true;
    } else {
      loading = true;
      loadingMore = false;
      errorMessage = null;
    }

    try {
      const load = filterState.view === "threads" ? loadThreads : loadStream;
      const { posts, next } = await load(filterState, auth, pageToken, append);
      if (seq !== requestSeq) return;
      comments = append ? [...comments, ...posts] : posts;
      nextPage = next;
    } catch (error) {
      if (seq !== requestSeq) return;
      console.error(error);
      errorMessage = $t(
        "converse.loadError",
        "Could not load conversations. Try refreshing.",
      );
      // A failed FIRST page must clear what is on screen. The URL, the toggles
      // and the tag badges have all already moved to the new filter; leaving
      // the previous filter's cards underneath the error banner presents them
      // as the result of a query that never succeeded. An append failure keeps
      // what is already loaded, because those cards ARE results of the current
      // query.
      if (!append) {
        comments = [];
        nextPage = null;
      }
    } finally {
      if (seq === requestSeq) {
        loading = false;
        loadingMore = false;
      }
    }
  }

  function loadFirstPage(filterState: ConverseFilters, auth: boolean) {
    // `null` is page one in both modes: no cursor, and page 1 for numbered.
    return fetchPage(filterState, auth, null, false);
  }

  function reload() {
    return loadFirstPage(filters, authenticated);
  }

  function onSearchInput() {
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      searchDebounce = null;
      void applyFilters({ search: searchDraft.trim() });
    }, 350);
  }

  function commitTags() {
    void applyFilters({ tags: parseTagList(tagDraft) });
  }

  function onTagKeydown(event: KeyboardEvent) {
    if (event.key === "Enter") {
      event.preventDefault();
      commitTags();
    }
  }

  function removeTag(tag: string) {
    void applyFilters({
      tags: filters.tags.filter((candidate) => candidate !== tag),
    });
  }

  function handlePosted() {
    void reload();
  }

  function infiniteScroll(node: HTMLDivElement) {
    const scrollObserver = new IntersectionObserver(
      (entries) => {
        if (
          entries[0]?.isIntersecting &&
          nextPage !== null &&
          !loading &&
          !loadingMore
        ) {
          void fetchPage(filters, authenticated, nextPage, true);
        }
      },
      { rootMargin: "400px 0px" },
    );

    scrollObserver.observe(node);
    return {
      destroy() {
        scrollObserver.disconnect();
      },
    };
  }

  beforeNavigate(({ type }) => {
    if (type === "goto") return;
    // Links and Back/Forward adopt their URL, rather than a pending local
    // debounce. Filter-owned goto calls keep the drafts they submitted.
    filterNavigationSeq += 1;
    pendingFilters = null;
    // A link to the current URL does not change requestKey, so restore its
    // drafts here too. A different destination is adopted when it arrives.
    searchDraft = filters.search;
    tagDraft = filters.tags.join(", ");
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = null;
  });

  onMount(() => {
    hydrated = true;
    searchDraft = filters.search;
    tagDraft = filters.tags.join(", ");
    authGraceTimer = setTimeout(() => {
      authGraceExpired = true;
    }, AUTH_RESOLVE_GRACE_MS);
  });

  onDestroy(() => {
    if (searchDebounce) clearTimeout(searchDebounce);
    if (authGraceTimer) clearTimeout(authGraceTimer);
  });
</script>

<SeoHead
  title={$t("converse.metaTitle", "Converse • Free2Z")}
  description={$t(
    "converse.metaDescription",
    "Join community conversations, threads, and discussions on Free2Z.",
  )}
  path="/converse"
/>

<svelte:head>
  <!-- Feed autodiscovery. Classic advertised the global Converse feed from
       both `/` and `/converse`; the SvelteKit rewrite shipped without it, so
       every reader and crawler lost the microblog's syndication entry point. -->
  <link
    rel="alternate"
    type="application/rss+xml"
    title={$t("converse.rssTitle", "Free2Z Converse")}
    href={CONVERSE_RSS_PATH}
  />
</svelte:head>

<main
  class="converse-mobile-buttons flex-1 bg-background pb-20 text-foreground"
  data-hydrated={hydrated}
>
  <div class="container mx-auto max-w-4xl space-y-6 px-3 py-6 sm:px-4 sm:py-8">
    <!-- The feed header stays quiet; composing moves to a mobile FAB. -->
    <header class="flex items-center justify-between gap-3">
      <div class="flex min-w-0 items-center gap-2.5">
        <MessagesSquare
          strokeWidth={1.5}
          class="size-6 shrink-0 text-primary"
        />
        <h1 class="truncate text-3xl leading-tight font-bold tracking-tight">
          {$t("converse.title", "Converse")}
        </h1>
      </div>

      <!-- Icon only, with the sentence kept as its accessible name: a feed
           link needs to be findable, not explained. -->
      <a
        href={CONVERSE_RSS_PATH}
        data-sveltekit-reload
        data-testid="converse-rss-link"
        title={$t("converse.rssLabel", "Subscribe by RSS")}
        aria-label={$t("converse.rssLabel", "Subscribe by RSS")}
        class="-m-2 inline-flex shrink-0 items-center rounded-md p-2 text-muted-foreground no-underline hover:text-primary focus-visible:text-primary focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <Rss strokeWidth={1.5} class="size-4" />
      </a>
    </header>

    <MobileConverseComposer on:posted={handlePosted} />

    <section
      aria-label={$t("converse.filters", "Conversation filters")}
      class="flex flex-col gap-3"
    >
      <div class="flex items-center gap-2 sm:gap-3">
        <div class="relative min-w-0 flex-1">
          <Search
            strokeWidth={1.5}
            class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            class="pl-9"
            aria-label={$t("converse.searchLabel", "Search conversations")}
            placeholder={$t(
              "converse.searchPlaceholder",
              "Search conversations...",
            )}
            autocomplete="off"
            bind:value={searchDraft}
            oninput={onSearchInput}
          />
        </div>

        <Button
          size="icon"
          class="sm:hidden"
          variant={mobileFilters.sort === "hot" ? "default" : "outline"}
          aria-label={$t("converse.sortLabel", "Sort conversations") +
            ": " +
            (mobileFilters.sort === "hot"
              ? $t("converse.sortHot", "Hot")
              : $t("converse.sortNew", "New"))}
          title={mobileFilters.sort === "hot"
            ? $t("converse.sortHot", "Hot")
            : $t("converse.sortNew", "New")}
          aria-pressed={mobileFilters.sort === "hot"}
          onclick={() =>
            applyFilters({
              sort: mobileFilters.sort === "hot" ? "new" : "hot",
            })}
        >
          {#if mobileFilters.sort === "hot"}<Flame
              strokeWidth={1.5}
              class="size-4"
            />{:else}<Clock3 strokeWidth={1.5} class="size-4" />{/if}
        </Button>

        {#key sortGroupKey}
          <ToggleGroup.Root
            type="single"
            value={filters.sort}
            onValueChange={(value) => {
              if (value) {
                void applyFilters({ sort: value as ConverseSort });
              } else {
                sortGroupKey += 1;
              }
            }}
            variant="outline"
            size="default"
            class="hidden shrink-0 overflow-hidden sm:flex sm:w-auto"
            aria-label={$t("converse.sortLabel", "Sort conversations")}
          >
            <ToggleGroup.Item
              value="new"
              class="flex-1 gap-1.5 px-3.5 sm:flex-none"
              aria-label={$t("converse.sortNew", "New")}
            >
              <Clock3 strokeWidth={1.5} class="size-3.5" />
              {$t("converse.sortNew", "New")}
            </ToggleGroup.Item>
            <ToggleGroup.Item
              value="hot"
              class="flex-1 gap-1.5 px-3.5 sm:flex-none"
              aria-label={$t("converse.sortHot", "Hot")}
            >
              <Flame strokeWidth={1.5} class="size-3.5" />
              {$t("converse.sortHot", "Hot")}
            </ToggleGroup.Item>
          </ToggleGroup.Root>
        {/key}
      </div>

      <div class="flex items-center gap-2 sm:gap-3">
        <div class="contents sm:hidden">
          <Button
            size="icon"
            variant={mobileFilters.view === "threads" ? "default" : "outline"}
            aria-label={$t("converse.viewLabel", "Feed layout") +
              ": " +
              (mobileFilters.view === "threads"
                ? $t("converse.viewThreads", "Threads")
                : $t("converse.viewStream", "Stream"))}
            title={mobileFilters.view === "threads"
              ? $t("converse.viewThreads", "Threads")
              : $t("converse.viewStream", "Stream")}
            aria-pressed={mobileFilters.view === "threads"}
            onclick={() =>
              applyFilters({
                view: mobileFilters.view === "threads" ? "stream" : "threads",
              })}
          >
            {#if mobileFilters.view === "threads"}<Layers
                strokeWidth={1.5}
                class="size-4"
              />{:else}<List strokeWidth={1.5} class="size-4" />{/if}
          </Button>
          <Button
            size="icon"
            variant={mobileFilters.posts ? "default" : "outline"}
            aria-label={$t(
              "converse.postsOnlyLabel",
              "Show standalone posts only",
            )}
            title={mobileFilters.posts
              ? $t("converse.postsOnly", "Posts only")
              : $t("converse.postsAndReplies", "Posts & replies")}
            aria-pressed={mobileFilters.posts}
            onclick={() => applyFilters({ posts: !mobileFilters.posts })}
          >
            <MessageSquare strokeWidth={1.5} class="size-4" />
          </Button>
          {#if authenticated}
            <Button
              size="icon"
              variant={mobileFilters.subscribed ? "default" : "outline"}
              aria-label={mobileFilters.subscribed
                ? $t("converse.subscribedOnly", "Following")
                : $t("converse.allAuthors", "Everyone")}
              title={mobileFilters.subscribed
                ? $t("converse.subscribedOnly", "Following")
                : $t("converse.allAuthors", "Everyone")}
              aria-pressed={mobileFilters.subscribed}
              onclick={() =>
                applyFilters({ subscribed: !mobileFilters.subscribed })}
            >
              <Users strokeWidth={1.5} class="size-4" />
            </Button>
          {/if}
        </div>
        <div class="relative min-w-0 flex-1">
          <Tag
            strokeWidth={1.5}
            aria-hidden="true"
            class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="text"
            class="pl-9"
            aria-label={$t("converse.tagLabel", "Filter by tag")}
            placeholder={$t("converse.tagPlaceholder", "zcash, art")}
            autocomplete="off"
            data-testid="converse-tag-filter"
            bind:ref={tagFilterInput}
            bind:value={tagDraft}
            onkeydown={onTagKeydown}
            onblur={commitTags}
          />
        </div>

        {#key viewGroupKey}
          <ToggleGroup.Root
            type="single"
            value={filters.view}
            onValueChange={(value) => {
              if (value) {
                void applyFilters({ view: value as ConverseView });
              } else {
                viewGroupKey += 1;
              }
            }}
            variant="outline"
            size="default"
            class="hidden shrink-0 overflow-hidden sm:flex sm:w-auto"
            aria-label={$t("converse.viewLabel", "Feed layout")}
          >
            <ToggleGroup.Item
              value="stream"
              class="flex-1 gap-1.5 px-3.5 sm:flex-none"
              aria-label={$t("converse.viewStream", "Stream")}
            >
              <List strokeWidth={1.5} class="size-3.5" />
              {$t("converse.viewStream", "Stream")}
            </ToggleGroup.Item>
            <ToggleGroup.Item
              value="threads"
              class="flex-1 gap-1.5 px-3.5 sm:flex-none"
              aria-label={$t("converse.viewThreads", "Threads")}
            >
              <Layers strokeWidth={1.5} class="size-3.5" />
              {$t("converse.viewThreads", "Threads")}
            </ToggleGroup.Item>
          </ToggleGroup.Root>
        {/key}

        <!-- "Microblog only": standalone posts, no replies. The
             firehose interleaves replies on zPages with standalone posts,
             which is right for "the live pulse of the site" and wrong for
             "show me the microblog". `parent__isnull=true` on the wire. -->
        <Button
          size="sm"
          variant={filters.posts ? "default" : "outline"}
          class="hidden shrink-0 sm:inline-flex sm:w-auto"
          aria-pressed={filters.posts}
          aria-label={$t(
            "converse.postsOnlyLabel",
            "Show standalone posts only",
          )}
          data-testid="converse-posts-only-toggle"
          onclick={() => applyFilters({ posts: !filters.posts })}
        >
          <MessageSquare strokeWidth={1.5} class="size-3.5" />
          {filters.posts
            ? $t("converse.postsOnly", "Posts only")
            : $t("converse.postsAndReplies", "Posts & replies")}
        </Button>

        {#if authenticated}
          <Button
            size="sm"
            variant={filters.subscribed ? "default" : "outline"}
            class="hidden shrink-0 sm:inline-flex sm:w-auto"
            aria-pressed={filters.subscribed}
            data-testid="converse-subscribed-toggle"
            onclick={() => applyFilters({ subscribed: !filters.subscribed })}
          >
            <Users strokeWidth={1.5} class="size-3.5" />
            {filters.subscribed
              ? $t("converse.subscribedOnly", "Following")
              : $t("converse.allAuthors", "Everyone")}
          </Button>
        {/if}
      </div>

      {#if filters.tags.length}
        <div
          class="flex flex-wrap items-center gap-1.5"
          aria-label={$t("converse.activeTags", "Active tag filters")}
        >
          {#each filters.tags as tag (tag)}
            <Badge variant="secondary" class="gap-1 font-normal">
              {tag}
              <button
                type="button"
                class="text-muted-foreground hover:text-foreground"
                aria-label={$t("converse.removeTag", "Remove tag {tag}", {
                  tag,
                })}
                onclick={() => removeTag(tag)}
              >
                <X strokeWidth={1.5} class="size-3" />
              </button>
            </Badge>
          {/each}
        </div>
      {/if}

      {#if subscribedNeedsSignIn}
        <p
          class="text-xs text-muted-foreground"
          data-testid="converse-subscribed-anon-notice"
        >
          {$t(
            "converse.subscribedSignInHint",
            "Sign in to narrow this stream to the creators you follow. Showing everyone for now.",
          )}
        </p>
      {/if}
    </section>

    {#if errorMessage}
      <div
        class="flex flex-col gap-3 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive sm:flex-row sm:items-center"
        role="alert"
      >
        <div class="flex flex-1 items-center gap-2">
          <AlertCircle strokeWidth={1.5} class="size-4 shrink-0" />
          <span>{errorMessage}</span>
        </div>
        <Button variant="outline" size="sm" onclick={reload}>
          <RefreshCw strokeWidth={1.5} class="size-3.5" />
          {$t("converse.retry", "Try again")}
        </Button>
      </div>
    {/if}

    <section aria-label={$t("converse.communityFeed", "Community threads")}>
      {#if loading && comments.length === 0}
        <div
          class="space-y-4"
          aria-busy="true"
          aria-label={$t("converse.loading", "Loading conversations")}
        >
          {#each Array(3) as _, index (index)}
            <div class="rounded-xl border border-border/70 bg-card p-4 sm:p-5">
              <div class="flex gap-3">
                <Skeleton class="size-9 shrink-0 rounded-full sm:size-10" />
                <div class="min-w-0 flex-1 space-y-2.5">
                  <div class="flex items-center gap-2">
                    <Skeleton class="h-3.5 w-28" />
                    <Skeleton class="h-3 w-16" />
                  </div>
                  <Skeleton class="h-4 w-3/5" />
                  <Skeleton class="h-3 w-full" />
                  <Skeleton class="h-3 w-4/5" />
                  <Skeleton class="mt-1 h-8 w-32 rounded-lg" />
                </div>
              </div>
            </div>
          {/each}
        </div>
        <!-- The error banner above already explains an empty screen; adding
             "No conversations found. Start the first conversation." underneath
             it reports a failed request as a fact about the platform. -->
      {:else if comments.length === 0 && !errorMessage}
        <!-- The composer already supplies the action for an empty feed. -->
        <p class="py-8 text-center text-sm text-muted-foreground">
          {$t("converse.emptyTitle", "No conversations found")}
        </p>
      {:else}
        <div class="space-y-4" data-testid="converse-feed">
          {#each comments as comment (comment.uuid)}
            {#if filters.view === "threads"}
              <ConverseThread post={comment} mode="feed" />
            {:else}
              <article
                class="relative rounded-2xl border border-border/70 bg-card p-4 transition-[border-color,box-shadow] duration-200 hover:border-primary/25 hover:shadow-sm motion-reduce:transition-none sm:p-5"
              >
                <!-- `rootUuid` is this post's own uuid on purpose: the detail
                     loader walks the parent chain server-side and focuses the
                     comment, so a reply card needs no client-side lookup to
                     link into its thread. -->
                <ConversePost
                  post={comment}
                  rootUuid={comment.uuid}
                  root={true}
                  showOpenThread={true}
                  on:replyPosted={reload}
                />
              </article>
            {/if}
          {/each}

          <div use:infiniteScroll class="h-1 w-full" aria-hidden="true"></div>

          {#if loadingMore}
            <div
              class="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground"
              aria-live="polite"
            >
              <Loader2 class="size-4 animate-spin motion-reduce:animate-none" />
              {$t("converse.loadingMore", "Loading more")}
            </div>
          {/if}
        </div>
      {/if}
    </section>
  </div>
</main>

<style>
  @media (max-width: 639px) {
    .converse-mobile-buttons :global(:is(button, [data-slot="button"])) {
      /* Clear decorative elevation while retaining Tailwind's focus rings. */
      --tw-shadow: 0 0 #0000;
    }
  }
</style>
