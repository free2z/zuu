<script lang="ts">
  import { onDestroy, onMount, tick } from "svelte";
  import { goto } from "$app/navigation";
  import * as env from "$app/env/public";
  import ZpageCard from "$lib/components/ZpageCard.svelte";
  import { Button } from "$lib/components/ui/button";
  import { ArrowUp, Loader2, Search } from "@lucide/svelte";
  import { tStore as t } from "$lib/i18n";
  import {
    createAbortDeadline,
    asRelativeZpagePageUrl,
    calculateVirtualFeedWindow,
    createFeedPager,
    isDrfPageOutOfRange,
    shouldReportFeedFailure,
    zpageKey,
  } from "$lib/feed.js";

  // Reverse-chronological feed for phones. The first page arrives from the
  // server load; this component appends the rest as the sentinel scrolls into
  // view. Rendered only below `md` — the desktop magazine layout is a separate
  // subtree in +page.svelte.
  export let initial: any[] = [];
  export let heroStory: any | null = null;
  /** Trending items are loaded with the homepage so the switch stays in-place. */
  export let trending: any[] = [];
  export let trendingHasMore = false;
  export let trendingNextPageUrl: string | null = null;
  export let creators: any[] = [];
  export let hasMore = false;
  export let nextPageUrl: string | null = null;
  export let pageSize = 20;
  /** Locale the server paged with; page 2+ must match or languages mix. */
  export let lang = "en";

  const apiBase = env.PUBLIC_API_BASE_URL?.replace(/\/$/, "") || "";

  // Dedupe lives in $lib/feed.js so the rule is unit-tested — see
  // tests/feed.test.mjs. A duplicate key crashes Svelte's keyed each.
  let pager = createFeedPager(initial);
  let items: any[] = pager.items;
  let trendingPager = createFeedPager(trending);
  let trendingItems: any[] = trendingPager.items;
  function firstPagePath(isTrending: boolean): string {
    const params = new URLSearchParams({
      pagination: "cursor",
      page_size: String(pageSize),
      lang,
    });
    if (isTrending) params.set("homeSort", "updated");
    else params.set("ordering", "-created_at,-id");
    return `/api/zpage/?${params.toString()}`;
  }

  // If SSR delivered nothing (upstream hiccup or a desktop UA later narrowed
  // to mobile), page 1 was never rendered. Start from the cursor endpoint's
  // first page rather than inventing a page-number offset.
  let latestCursor =
    nextPageUrl ||
    (initial.length === 0 && hasMore ? firstPagePath(false) : null);
  let trendingCursor =
    trendingNextPageUrl ||
    (trending.length === 0 && trendingHasMore ? firstPagePath(true) : null);
  let more = hasMore;
  let trendingMore = trendingHasMore;
  let loading = false;
  let failed = false;
  let trendingFailed = false;
  let query = "";
  let feedMode: "latest" | "trending" = "latest";
  $: displayedItems = feedMode === "latest" ? items : trendingItems;
  $: feedRows = [
    ...(heroStory ? [{ story: heroStory, featured: true }] : []),
    ...displayedItems
      .filter((story) => !heroStory || zpageKey(story) !== zpageKey(heroStory))
      .map((story) => ({ story, featured: false })),
  ];
  let observer: IntersectionObserver | null = null;
  let requestGeneration = 0;
  let activeController: AbortController | null = null;
  let showScrollTop = false;
  let feedList: HTMLUListElement | null = null;
  let virtualStart = 0;
  let virtualEnd = 20;
  let virtualTopSpacer = 0;
  let virtualBottomSpacer = 0;
  let virtualFrame: number | null = null;
  const FEED_ROW_STRIDE = 140;
  const FEED_OVERSCAN = 6;
  $: virtualRows = feedRows
    .slice(virtualStart, virtualEnd)
    .map((row, offset) => ({
      ...row,
      index: virtualStart + offset,
    }));

  function updateVirtualWindow() {
    virtualFrame = null;
    if (!feedList || typeof window === "undefined") return;
    const listTop = feedList.getBoundingClientRect().top + window.scrollY;
    const nextWindow = calculateVirtualFeedWindow({
      itemCount: feedRows.length,
      scrollTop: window.scrollY,
      listTop,
      viewportHeight: window.innerHeight,
      rowStride: FEED_ROW_STRIDE,
      overscan: FEED_OVERSCAN,
    });
    virtualStart = nextWindow.start;
    virtualEnd = nextWindow.end;
    virtualTopSpacer = nextWindow.topSpacer;
    virtualBottomSpacer = nextWindow.bottomSpacer;
  }

  function scheduleVirtualWindowUpdate() {
    if (typeof window === "undefined" || virtualFrame !== null) return;
    virtualFrame = window.requestAnimationFrame(updateVirtualWindow);
  }

  function handleViewportChange() {
    updateScrollTopVisibility();
    scheduleVirtualWindowUpdate();
  }

  function updateScrollTopVisibility() {
    showScrollTop = window.scrollY > 560;
  }

  function scrollToTop() {
    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    window.scrollTo({
      top: 0,
      behavior: prefersReducedMotion ? "auto" : "smooth",
    });
  }

  // The homepage load re-runs on invalidateAll() — most importantly when the
  // layout detects a browser locale that differs from the SSR one and swaps
  // the whole page to it. Without rebuilding, page 1 would keep the old
  // language while `lang` (and so its continuation cursor) moved to the new
  // one.
  let pagerSource = initial;
  let pagerLang = lang;
  let trendingSource = trending;
  let latestCursorSource = nextPageUrl;
  let trendingCursorSource = trendingNextPageUrl;
  $: if (
    initial !== pagerSource ||
    lang !== pagerLang ||
    trending !== trendingSource ||
    nextPageUrl !== latestCursorSource ||
    trendingNextPageUrl !== trendingCursorSource
  ) {
    requestGeneration += 1;
    activeController?.abort();
    activeController = null;
    loading = false;
    pagerSource = initial;
    pagerLang = lang;
    pager = createFeedPager(initial);
    items = pager.items;
    trendingSource = trending;
    latestCursorSource = nextPageUrl;
    trendingCursorSource = trendingNextPageUrl;
    trendingPager = createFeedPager(trending);
    trendingItems = trendingPager.items;
    latestCursor =
      nextPageUrl ||
      (initial.length === 0 && hasMore ? firstPagePath(false) : null);
    trendingCursor =
      trendingNextPageUrl ||
      (trending.length === 0 && trendingHasMore ? firstPagePath(true) : null);
    more = hasMore;
    trendingMore = trendingHasMore;
    failed = false;
    trendingFailed = false;
    scheduleVirtualWindowUpdate();
  }

  // Cursor pages should not overlap. Keep a small duplicate-recovery bound as
  // defense in depth for stale proxies or a mixed-version backend rollout.
  const MAX_DUPLICATE_PAGES = 3;
  // One deadline covers the entire duplicate-recovery chain, not each fetch.
  // Ten seconds is long enough for a mobile radio wake-up while still giving
  // the reader a retry action instead of an endless spinner.
  const LOAD_MORE_TIMEOUT_MS = 10_000;

  async function loadMore() {
    const isTrending = feedMode === "trending";
    const activeMore = isTrending ? trendingMore : more;
    if (loading || !activeMore) return;
    const generation = requestGeneration;
    const controller = new AbortController();
    const deadline = createAbortDeadline(controller, LOAD_MORE_TIMEOUT_MS);
    activeController = controller;
    loading = true;
    if (isTrending) trendingFailed = false;
    else failed = false;
    try {
      let reachedNewContentOrEnd = false;
      for (let attempt = 0; attempt < MAX_DUPLICATE_PAGES; attempt++) {
        const cursor = isTrending ? trendingCursor : latestCursor;
        const requestPath =
          asRelativeZpagePageUrl(cursor) ||
          (cursor ? null : firstPagePath(isTrending));
        if (!requestPath) throw new Error("Invalid feed cursor URL");
        const url = `${apiBase}${requestPath}`;
        // `omit`: the SSR first page is fetched anonymously, so sending the
        // session here would page a different (draft-inclusive) dataset and
        // invalidate the public continuation cursor.
        const res = await fetch(url, {
          credentials: "omit",
          signal: controller.signal,
        });
        // A locale/page-source reset invalidates this entire response chain.
        // Do not let the old request append rows or advance the new pager.
        if (generation !== requestGeneration) return;
        if (!res.ok) {
          let errorBody: unknown = null;
          if (res.status === 404) {
            try {
              errorBody = await res.json();
            } catch {
              // A proxy/plain-text 404 is not paginator exhaustion. It falls
              // through to the visible retry state below.
            }
          }
          if (generation !== requestGeneration) return;
          if (isDrfPageOutOfRange(res.status, errorBody)) {
            // Keep this compatibility path for an old page-number backend
            // during a mixed-version rollout.
            if (isTrending) trendingMore = false;
            else more = false;
            reachedNewContentOrEnd = true;
            break;
          }
          throw new Error(
            `${isTrending ? "trending" : "latest"} cursor page: ${res.status}`,
          );
        }
        const data = await res.json();
        if (generation !== requestGeneration) return;

        const activePager = isTrending ? trendingPager : pager;
        const added = activePager.append(data?.results);
        const nextCursor = asRelativeZpagePageUrl(data?.next);
        if (isTrending) {
          trendingItems = [...activePager.items];
          trendingCursor = nextCursor;
          trendingMore = Boolean(nextCursor);
        } else {
          items = [...activePager.items]; // new array so Svelte sees the change
          latestCursor = nextCursor;
          more = Boolean(nextCursor);
        }
        scheduleVirtualWindowUpdate();

        const stillMore = isTrending ? trendingMore : more;
        if (added > 0 || !stillMore) {
          reachedNewContentOrEnd = true;
          break;
        }
      }

      // Exactly MAX_DUPLICATE_PAGES were consumed without finding a new row.
      // Stop automatic observation and expose a retry rather than silently
      // leaving an intersecting sentinel that will never fire again.
      if (!reachedNewContentOrEnd) {
        if (isTrending && trendingMore) trendingFailed = true;
        if (!isTrending && more) failed = true;
      }
    } catch (error) {
      if (
        !shouldReportFeedFailure({
          isCurrent: generation === requestGeneration,
          aborted: controller.signal.aborted,
          timedOut: deadline.expired,
        })
      )
        return;
      console.error(error);
      // Leave the active feed's cursor available so the retry button can try
      // this page again.
      if (isTrending) trendingFailed = true;
      else failed = true;
    } finally {
      deadline.clear();
      if (generation === requestGeneration) {
        loading = false;
        if (activeController === controller) activeController = null;
      }
    }
  }

  // Svelte action: fire loadMore when the sentinel nears the viewport.
  function sentinel(node: HTMLElement) {
    observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMore();
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(node);
    return {
      destroy() {
        observer?.disconnect();
        observer = null;
      },
    };
  }

  function submitSearch(event: SubmitEvent) {
    event.preventDefault();
    const q = query.trim();
    if (q) goto(`/search?q=${encodeURIComponent(q)}`);
  }

  async function toggleFeedMode() {
    // A request belongs to the mode that started it. Cancel it before the
    // switch so a shared `loading` flag cannot swallow the new mode's sole
    // IntersectionObserver callback while its sentinel is already visible.
    requestGeneration += 1;
    activeController?.abort();
    activeController = null;
    loading = false;
    feedMode = feedMode === "latest" ? "trending" : "latest";
    await tick();
    scheduleVirtualWindowUpdate();
    // Do not rely on the existing observer crossing its threshold again:
    // switching modes is explicit intent, so immediately continue that mode
    // when it has another cursor.
    loadMore();
  }

  function creatorAvatarUrl(creator: any): string | null {
    const image =
      creator?.avatar_image?.thumbnail || creator?.avatar_image?.url;
    if (!image) return null;
    if (/^https?:\/\//i.test(image)) return image;
    const normalized = image.startsWith("/") ? image : `/${image}`;
    return `${apiBase}${normalized.startsWith("/uploadz/") ? "" : "/uploadz"}${normalized}`.replace(
      "/uploadz/uploadz",
      "/uploadz",
    );
  }

  function creatorBannerUrl(creator: any): string | null {
    const image =
      creator?.banner_image?.thumbnail || creator?.banner_image?.url;
    if (!image) return null;
    if (/^https?:\/\//i.test(image)) return image;
    const normalized = image.startsWith("/") ? image : `/${image}`;
    return `${apiBase}${normalized.startsWith("/uploadz/") ? "" : "/uploadz"}${normalized}`.replace(
      "/uploadz/uploadz",
      "/uploadz",
    );
  }

  function creatorName(creator: any): string {
    return (
      creator?.display_name ||
      creator?.full_name ||
      creator?.username ||
      "Creator"
    );
  }

  function creatorInitials(creator: any): string {
    return creatorName(creator)
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase();
  }

  onDestroy(() => {
    requestGeneration += 1;
    activeController?.abort();
    observer?.disconnect();
    if (typeof window !== "undefined") {
      window.removeEventListener("scroll", handleViewportChange);
      window.removeEventListener("resize", handleViewportChange);
      if (virtualFrame !== null) window.cancelAnimationFrame(virtualFrame);
    }
  });

  onMount(() => {
    handleViewportChange();
    window.addEventListener("scroll", handleViewportChange, { passive: true });
    window.addEventListener("resize", handleViewportChange, { passive: true });
  });
</script>

<section
  data-testid="homepage-mobile-feed"
  class="relative flex min-h-screen min-h-svh flex-col bg-linear-to-b from-transparent via-(--f2z-bg-primary)/70 to-(--f2z-bg-primary)/90 px-4 md:bg-none"
  aria-labelledby="mobile-feed-heading"
>
  <!-- Only below md. From md up the navbar shows its own centre search field,
       and two search boxes on one screen is worse than none. The navbar's
       mobile search *icon* is hidden on this route for the same reason. -->
  <form role="search" onsubmit={submitSearch} class="py-5 md:hidden">
    <div
      data-testid="homepage-mobile-search"
      class="flex h-12 w-full max-w-full min-w-0 items-center rounded-lg border border-(--f2z-border-primary) bg-(--f2z-bg-secondary) p-1 shadow-xs transition-[border-color,box-shadow] focus-within:border-(--f2z-accent-primary) focus-within:ring-2 focus-within:ring-(--f2z-accent-primary)/15"
    >
      <input
        type="search"
        bind:value={query}
        enterkeyhint="search"
        autocomplete="off"
        class="h-full min-w-0 flex-1 appearance-none bg-transparent px-2 text-[0.9375rem] text-(--f2z-text-primary) outline-none placeholder:text-(--f2z-text-muted) sm:px-3 sm:text-base [&::-webkit-search-decoration]:hidden"
        aria-label={$t("search.title", "Search")}
        placeholder={$t(
          "navigation.searchPlaceholder",
          "Search creators and pages…",
        )}
      />
      <Button
        type="submit"
        variant="default"
        size="icon"
        class="ml-1 size-9 shrink-0 rounded-md border-0 shadow-none focus-visible:ring-2 focus-visible:ring-primary-foreground/70 focus-visible:ring-inset"
        aria-label={$t("search.title", "Search")}
      >
        <Search class="size-4" />
      </Button>
    </div>
  </form>

  {#if creators.length}
    <section class="py-4" aria-labelledby="mobile-creators-heading">
      <div class="mb-3 flex items-center justify-between gap-3">
        <h2
          id="mobile-creators-heading"
          class="text-sm font-semibold tracking-tight text-(--f2z-text-primary)"
        >
          {$t("homepage.creatorsToExplore", "Creators to explore")}
        </h2>
        <a
          href="/creators"
          class="text-xs font-medium text-(--f2z-accent-primary) no-underline transition-opacity hover:opacity-75 focus-visible:ring-2 focus-visible:ring-(--f2z-accent-primary)/30 focus-visible:outline-none"
        >
          {$t("homepage.seeAllCreators", "See all")}
        </a>
      </div>
      <div
        class="mobile-creator-rail relative -mx-1 flex snap-x snap-mandatory gap-1.5 overflow-x-auto px-1 pr-8 pb-2"
        role="region"
        aria-label={$t(
          "homepage.creatorsScrollLabel",
          "Scroll creators horizontally",
        )}
      >
        {#each creators as creator (creator.username)}
          <a
            href={`/${creator.username}`}
            class="group relative flex size-40 shrink-0 snap-start flex-col overflow-hidden rounded-xl border border-(--f2z-border-primary) bg-(--f2z-bg-secondary)/90 text-center no-underline transition-colors hover:border-(--f2z-accent-primary)/45 focus-visible:ring-2 focus-visible:ring-(--f2z-accent-primary)/30 focus-visible:outline-none"
            aria-label={$t(
              "homepage.viewCreatorProfile",
              "View {name}'s profile",
              { name: creatorName(creator) },
            )}
          >
            <span
              class="relative block h-16 w-full shrink-0 overflow-hidden bg-(--f2z-bg-tertiary)"
            >
              {#if creatorBannerUrl(creator)}
                <img
                  src={creatorBannerUrl(creator)}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  class="size-full object-cover transition-transform duration-500 group-hover:scale-105"
                />
              {/if}
              <span
                class="absolute inset-0 bg-linear-to-t from-(--f2z-bg-secondary) via-(--f2z-bg-secondary)/15 to-transparent"
              ></span>
            </span>
            <span
              class="absolute top-8 left-1/2 grid size-14 -translate-x-1/2 place-items-center overflow-hidden rounded-full border-2 border-(--f2z-bg-secondary) bg-(--f2z-accent-primary)/15 text-sm font-bold text-(--f2z-accent-primary) shadow-md"
            >
              {#if creatorAvatarUrl(creator)}
                <img
                  src={creatorAvatarUrl(creator)}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  class="size-full object-cover"
                />
              {:else}
                {creatorInitials(creator)}
              {/if}
            </span>
            <span
              class="mt-6 w-full truncate px-3 text-sm font-semibold text-(--f2z-text-primary)"
              >{creatorName(creator)}</span
            >
            <span
              class="mt-1 w-full truncate px-3 text-xs text-(--f2z-text-muted)"
              >@{creator.username}</span
            >
          </a>
        {/each}
      </div>
    </section>
    <div
      class="mx-1 h-px bg-linear-to-r from-transparent via-(--f2z-border-primary) to-transparent opacity-60"
      aria-hidden="true"
    ></div>
  {/if}

  <div class="flex justify-end pt-3 pb-3">
    <button
      type="button"
      id="mobile-feed-heading"
      data-testid="homepage-feed-switch"
      class="group inline-flex min-h-10 items-center gap-0.5 rounded-lg bg-(--f2z-bg-secondary)/50 p-0.5 text-xs transition-colors hover:bg-(--f2z-bg-secondary) focus-visible:ring-2 focus-visible:ring-(--f2z-accent-primary)/30 focus-visible:outline-none"
      aria-label={feedMode === "latest"
        ? $t("homepage.switchToTrending", "Switch to Trending")
        : $t("homepage.switchToLatest", "Switch to Latest")}
      title={feedMode === "latest"
        ? $t("homepage.switchToTrending", "Switch to Trending")
        : $t("homepage.switchToLatest", "Switch to Latest")}
      aria-pressed={feedMode === "trending"}
      aria-live="polite"
      onclick={toggleFeedMode}
    >
      <span
        class="rounded-md px-2.5 py-1.5 font-semibold transition-colors {feedMode ===
        'latest'
          ? 'bg-(--f2z-bg-primary) text-(--f2z-text-primary) shadow-xs'
          : 'text-(--f2z-text-muted)'}"
      >
        {$t("homepage.latest", "Latest")}
      </span>
      <span class="text-(--f2z-text-muted)/60" aria-hidden="true">/</span>
      <span
        class="rounded-md px-2.5 py-1.5 font-semibold transition-colors {feedMode ===
        'trending'
          ? 'bg-(--f2z-accent-primary)/10 text-(--f2z-accent-primary) shadow-xs'
          : 'text-(--f2z-text-muted)'}"
      >
        {$t("homepage.trending", "Trending")}
      </span>
    </button>
  </div>

  {#if feedRows.length}
    <ul
      bind:this={feedList}
      class="m-0 list-none p-0"
      aria-label={feedMode === "latest"
        ? $t("homepage.latest", "Latest")
        : $t("homepage.trending", "Trending")}
    >
      {#if virtualTopSpacer > 0}
        <li aria-hidden="true" style={`height: ${virtualTopSpacer}px`}></li>
      {/if}
      {#each virtualRows as row (zpageKey(row.story))}
        <li
          class="feed-row"
          aria-posinset={row.index + 1}
          aria-setsize={feedRows.length}
        >
          <ZpageCard
            story={row.story}
            mobileHorizontal={true}
            featured={row.featured}
          />
        </li>
      {/each}
      {#if virtualBottomSpacer > 0}
        <li aria-hidden="true" style={`height: ${virtualBottomSpacer}px`}></li>
      {/if}
    </ul>
  {:else}
    <p
      class="border-b border-(--f2z-border-primary) py-10 text-center text-sm text-(--f2z-text-muted)"
    >
      {$t("homepage.latestEmpty", "Nothing published yet.")}
    </p>
  {/if}

  {#if (feedMode === "latest" && failed) || (feedMode === "trending" && trendingFailed)}
    <div class="flex flex-col items-center gap-2 py-4">
      <p class="m-0 text-sm text-(--f2z-text-muted)">
        {$t("homepage.latestError", "Could not load more.")}
      </p>
      <Button variant="outline" size="sm" onclick={loadMore}>
        {$t("homepage.latestRetry", "Try again")}
      </Button>
    </div>
  {:else if (feedMode === "latest" && more) || (feedMode === "trending" && trendingMore)}
    <div use:sentinel class="flex justify-center py-4" aria-hidden="true">
      {#if loading}
        <Loader2 class="size-5 animate-spin text-(--f2z-text-muted)" />
      {/if}
    </div>
  {/if}

  {#if showScrollTop}
    <button
      type="button"
      class="fixed right-4 bottom-4 z-30 grid size-9 place-items-center rounded-full border border-(--f2z-border-primary) bg-(--f2z-bg-secondary)/90 text-(--f2z-text-muted) shadow-sm backdrop-blur transition-colors hover:border-(--f2z-accent-primary)/50 hover:text-(--f2z-accent-primary) focus-visible:ring-2 focus-visible:ring-(--f2z-accent-primary)/40 focus-visible:outline-none md:hidden"
      aria-label={$t("creators.backToTop", "Back to top")}
      title={$t("creators.backToTop", "Back to top")}
      onclick={scrollToTop}
    >
      <ArrowUp class="size-4" strokeWidth={1.75} />
    </button>
  {/if}
</section>

<style>
  .mobile-creator-rail {
    scrollbar-width: none;
    -ms-overflow-style: none;
  }

  .mobile-creator-rail::-webkit-scrollbar {
    display: none;
  }

  .feed-row {
    height: 128px;
    margin-bottom: 12px;
  }
</style>
