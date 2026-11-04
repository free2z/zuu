<script lang="ts">
  import { formatDate, toTimestamp } from "$lib/utils/date";
  import { onMount } from "svelte";
  import { browser } from "$app/env";
  import * as env from "$app/env/public";
  import CreatorCard from "$lib/components/CreatorCard.svelte";
  import CreatorsFilterControls from "$lib/components/CreatorsFilterControls.svelte";
  import {
    formatLocalizedNumber,
    isSingularCount,
    locale,
    tStore as t,
    loading,
  } from "$lib/i18n";
  import { creatorList } from "$lib/api/creator/creator";
  import { createZpageList } from "$lib/api/zpage/zpage";
  import { createInfiniteQuery } from "@tanstack/svelte-query";
  import { Badge } from "$lib/components/ui/badge";
  import { Search, SlidersHorizontal, X, Users, ArrowUp } from "@lucide/svelte";
  import Button from "$lib/components/ui/button/button.svelte";
  import { buttonVariants } from "$lib/components/ui/button";
  import * as Drawer from "$lib/components/ui/drawer";
  import { Separator } from "$lib/components/ui/separator";
  import PageHeader from "$lib/components/PageHeader.svelte";
  import SeoHead from "$lib/components/SeoHead.svelte";
  import {
    creatorsFilterStore,
    activeFilterCount as activeFilterCountStore,
    hasClientSideFilters as hasClientSideFiltersStore,
    getApiSortParams,
  } from "$lib/stores/creatorsFilter";

  const apiBase = (env.PUBLIC_API_BASE_URL || "").replace(/\/$/, "");

  $: filterState = $creatorsFilterStore;
  $: activeFilterCount = $activeFilterCountStore;
  $: hasClientSideFilters = $hasClientSideFiltersStore;

  $: ({
    searchQuery,
    debouncedSearch,
    verifiedFilter,
    membershipFilter,
    onlyZcash,
    minPosts,
    minFollowers,
    sortBy,
  } = filterState);

  // Active filters for badges
  $: activeFilters = [
    {
      condition: searchQuery,
      label: `"${searchQuery}"`,
      onClick: () => creatorsFilterStore.setSearchQuery(""),
    },
    {
      condition: verifiedFilter === "verified",
      label: $t("creators.filters.verified", "Verified"),
      onClick: () => creatorsFilterStore.setVerifiedFilter("all"),
    },
    {
      condition: verifiedFilter === "unverified",
      label: $t("creators.filters.unverified", "Not verified"),
      onClick: () => creatorsFilterStore.setVerifiedFilter("all"),
    },
    {
      condition: membershipFilter === "free",
      label: $t("creators.filters.free", "Free"),
      onClick: () => creatorsFilterStore.setMembershipFilter("all"),
    },
    {
      condition: membershipFilter === "paid",
      label: $t("creators.filters.paid", "Paid"),
      onClick: () => creatorsFilterStore.setMembershipFilter("all"),
    },
    {
      condition: onlyZcash,
      label: "Zcash",
      onClick: () => creatorsFilterStore.setOnlyZcash(false),
      class: "text-primary",
    },
    {
      condition: minPosts,
      label: isSingularCount(minPosts ?? 0, $locale)
        ? $t("creators.filters.minimumPostsValueOne", "At least {count} post", {
            count: formatLocalizedNumber(minPosts ?? 0, $locale),
          })
        : $t("creators.filters.minimumPostsValue", "At least {count} posts", {
            count: formatLocalizedNumber(minPosts ?? 0, $locale),
          }),
      onClick: () => creatorsFilterStore.setMinPosts(null),
    },
    {
      condition: minFollowers,
      label: isSingularCount(minFollowers ?? 0, $locale)
        ? $t(
            "creators.filters.minimumFollowersValueOne",
            "At least {count} follower",
            { count: formatLocalizedNumber(minFollowers ?? 0, $locale) },
          )
        : $t(
            "creators.filters.minimumFollowersValue",
            "At least {count} followers",
            { count: formatLocalizedNumber(minFollowers ?? 0, $locale) },
          ),
      onClick: () => creatorsFilterStore.setMinFollowers(null),
    },
  ].filter((f) => f.condition);

  let showDesktopSidebar = true;
  let isDrawerOpen = false;
  let showBackToTop = false;

  function handleWindowScroll() {
    showBackToTop = window.scrollY > 800;
  }

  function scrollToTop() {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  onMount(() => {
    if (browser) {
      creatorsFilterStore.initFromStorage();
      handleWindowScroll();
    }
  });

  function clearFilters() {
    creatorsFilterStore.clearFilters();
  }

  function buildImageUrl(imagePath?: string | null): string | null {
    if (!imagePath) return null;
    if (/^https?:\/\//i.test(imagePath)) return imagePath;
    const normalized = imagePath.startsWith("/") ? imagePath : `/${imagePath}`;
    return `${apiBase}${normalized.startsWith("/uploadz/") ? "" : "/uploadz"}${normalized}`.replace(
      "/uploadz/uploadz",
      "/uploadz",
    );
  }

  function avatarUrl(c?: any): string | null {
    const img = c?.avatar_image?.url || c?.avatar_image?.thumbnail;
    return buildImageUrl(img);
  }

  function createDateFormatter(currentLocale: string) {
    return (iso?: string): string =>
      formatDate(iso, currentLocale, undefined, "");
  }

  $: fmtDate = createDateFormatter($locale);

  // Infinite query for creators
  // Note: membershipFilter, onlyZcash and minPosts are client-side only filters
  // verifiedFilter, search and minFollowers are handled at API level
  $: creatorsQuery = createInfiniteQuery({
    queryKey: [
      "creators",
      "infinite",
      debouncedSearch,
      verifiedFilter,
      sortBy,
      minFollowers,
    ],
    queryFn: async ({ pageParam = 1 }) => {
      const params: any = { page: pageParam };

      if (debouncedSearch) params.search = debouncedSearch;

      if (verifiedFilter === "verified") {
        params.is_verified = "true";
      } else if (verifiedFilter === "unverified") {
        params.is_verified = "false";
      }

      // Followers are counted in the database. This used to be a
      // client-side comparison against `creator.total`, which is
      // `Creator.cache_total()` — Sum(zpage.total) + tuzis/1000, a cached
      // ZEC-denominated page-support score — so "at least 5 followers" really
      // asked for "at least 5 ZEC of page support" and returned creators
      // chosen by a quantity nobody was filtering on.
      if (minFollowers) params.min_followers = minFollowers;

      const sortParams = getApiSortParams(sortBy);
      Object.assign(params, sortParams);

      const res = await creatorList(params);
      return res;
    },
    initialPageParam: 1,
    getNextPageParam: (lastPage) => {
      if (lastPage.next) {
        const url = new URL(lastPage.next);
        const page = url.searchParams.get("page");
        return page ? parseInt(page) : undefined;
      }
      return undefined;
    },
  });

  // Articles query (keeping existing logic for mapping articles to creators, though it only covers the first page of articles)
  $: articlesQuery = browser
    ? createZpageList({ ordering: "-published_at", page: 1 })
    : null;

  // Flatten creators from all pages and ensure uniqueness by username
  $: creators = (() => {
    const all =
      $creatorsQuery.data?.pages.flatMap((page) => page.results) || [];
    const seen = new Set<string>();
    return all.filter((creator: any) => {
      if (!creator?.username || seen.has(creator.username)) {
        return false;
      }
      seen.add(creator.username);
      return true;
    });
  })();
  $: articles = $articlesQuery?.data?.results || [];
  $: isLoading = $creatorsQuery.isLoading;
  $: isFetchingNextPage = $creatorsQuery.isFetchingNextPage;
  $: error = $creatorsQuery.error || $articlesQuery?.error;

  // Create map of creator username to latest article
  $: articlesByCreator = articles.reduce(
    (map: Record<string, any>, article: any) => {
      if (article.creator?.username && article.is_published !== false) {
        const username = article.creator.username.toLowerCase();
        if (
          !map[username] ||
          toTimestamp(article.published_at || article.created_at) >
            toTimestamp(map[username].published_at || map[username].created_at)
        ) {
          map[username] = article;
        }
      }
      return map;
    },
    {},
  );

  // Combine creators with their latest articles
  $: creatorsWithArticles = creators
    .filter((creator: any) => creator && typeof creator.username === "string")
    .map((creator: any) => ({
      creator,
      latestArticle: articlesByCreator[creator.username.toLowerCase()],
    }));

  // Client-side sorting function
  // Note: 'popular', 'followers_*', 'newest', 'oldest', 'updated', 'alphabetical_*' are handled by API
  // These client-side sorts are for: 'content_*', 'recent_activity', 'price_*'
  function sortCreators(items: any[], sort: string): any[] {
    const sorted = [...items]; // Create a copy to avoid mutation
    switch (sort) {
      case "content_desc":
        sorted.sort(
          (a, b) =>
            Number(b.creator.zpages || 0) - Number(a.creator.zpages || 0),
        );
        break;
      case "content_asc":
        sorted.sort(
          (a, b) =>
            Number(a.creator.zpages || 0) - Number(b.creator.zpages || 0),
        );
        break;
      case "recent_activity":
        sorted.sort((a, b) => {
          const da = a.latestArticle
            ? toTimestamp(
                a.latestArticle.published_at || a.latestArticle.created_at,
              ) || 0
            : 0;
          const db = b.latestArticle
            ? toTimestamp(
                b.latestArticle.published_at || b.latestArticle.created_at,
              ) || 0
            : 0;
          return db - da;
        });
        break;
      case "price_asc":
        sorted.sort(
          (a, b) =>
            parseFloat(a.creator.member_price || "0") -
            parseFloat(b.creator.member_price || "0"),
        );
        break;
      case "price_desc":
        sorted.sort(
          (a, b) =>
            parseFloat(b.creator.member_price || "0") -
            parseFloat(a.creator.member_price || "0"),
        );
        break;
      // For API-handled sorts, don't re-sort client-side
      default:
        break;
    }
    return sorted;
  }

  // Client-side filters (these are NOT handled by API)
  // Note: verifiedFilter and search ARE handled by API, so we don't re-filter those here
  $: displayedCreators = sortCreators(
    creatorsWithArticles.filter(({ creator }: any) => {
      if (!creator) return false;

      if (membershipFilter === "free") {
        const price = parseFloat(creator.member_price || "0");
        if (price > 0) return false;
      } else if (membershipFilter === "paid") {
        const price = parseFloat(creator.member_price || "0");
        if (price <= 0 || creator.member_price === null) return false;
      }

      if (onlyZcash && !creator.p2paddr) return false;

      if (minPosts && Number(creator.zpages || 0) < Number(minPosts))
        return false;
      // minFollowers is applied by the API (`min_followers`), not here — see
      // the query above. Re-filtering it client-side is impossible anyway:
      // the serialized creator carries no follower count.

      return true;
    }),
    sortBy,
  );

  // Auto-fetch more pages when client-side filters reduce visible results too much
  // This ensures users see results even when filters exclude most creators on loaded pages
  const MIN_VISIBLE_THRESHOLD = 6; // Minimum number of visible creators before auto-loading more
  $: {
    if (
      browser &&
      hasClientSideFilters &&
      displayedCreators.length < MIN_VISIBLE_THRESHOLD &&
      creatorsWithArticles.length > 0 && // We have some data loaded
      $creatorsQuery.hasNextPage &&
      !$creatorsQuery.isFetchingNextPage &&
      !$creatorsQuery.isLoading
    ) {
      // Fetch next page to try to get more matching creators
      $creatorsQuery.fetchNextPage();
    }
  }

  // Sentinel Action to detect when user scrolls to bottom
  function sentinelAction(node: HTMLElement) {
    const observer = new IntersectionObserver(
      (entries) => {
        if (
          entries[0].isIntersecting &&
          $creatorsQuery.hasNextPage &&
          !$creatorsQuery.isFetchingNextPage
        ) {
          $creatorsQuery.fetchNextPage();
        }
      },
      { rootMargin: "400px" },
    );

    observer.observe(node);

    return {
      destroy() {
        observer.disconnect();
      },
    };
  }
</script>

<SeoHead
  title={$t("creators.metaTitle", "Creator directory – Free2Z")}
  description={$t(
    "creators.pageDescription",
    "Discover amazing creators sharing their stories and content on Free2Z, an independent platform for creative expression.",
  )}
  path="/creators"
  imageAlt={$t("creators.ogImageAlt", "Free2Z creator directory")}
/>

<svelte:window on:scroll={handleWindowScroll} />

<main class="flex-1 bg-background font-sans text-foreground">
  <PageHeader
    title={$t("creators.title", "Creators")}
    titleSuffix="."
    subtitle={$t(
      "creators.subtitle",
      "Discover amazing creators sharing their stories on Free2Z",
    )}
  />

  <div class="container mx-auto max-w-7xl px-4 pt-8 pb-6 lg:pb-12">
    <!-- Mobile Controls Trigger & Summary Bar -->
    <div class="mb-6 space-y-3 lg:hidden">
      <div
        class="flex items-center justify-between rounded-xl border border-border/40 bg-card/50 p-3 shadow-sm backdrop-blur-sm"
      >
        <div class="flex items-center gap-3">
          <div class="flex flex-col">
            <span class="text-lg font-semibold">
              {isSingularCount(displayedCreators.length, $locale)
                ? $t("creators.showingCountOne", "Showing {count} creator", {
                    count: formatLocalizedNumber(
                      displayedCreators.length,
                      $locale,
                    ),
                  })
                : $t("creators.showingCount", "Showing {count} creators", {
                    count: formatLocalizedNumber(
                      displayedCreators.length,
                      $locale,
                    ),
                  })}
            </span>
          </div>
          {#if isLoading || isFetchingNextPage}
            <div
              class="flex h-2 w-2 animate-pulse rounded-full bg-primary shadow-[0_0_8px_rgba(132,204,22,0.5)]"
            ></div>
          {/if}
        </div>
        <Button
          variant="outline"
          size="sm"
          onclick={() => (isDrawerOpen = true)}
          class="relative h-10 gap-2 text-sm font-medium"
        >
          <SlidersHorizontal class="h-4 w-4" />
          {$t("creators.filters.title", "Filters")}
          {#if activeFilterCount > 0}
            <Badge
              class="absolute -top-2 -right-2 flex h-5 w-5 items-center justify-center bg-primary p-0 text-[10px] text-primary-foreground"
            >
              {activeFilterCount}
            </Badge>
          {/if}
        </Button>
      </div>

      {#if activeFilterCount > 0}
        <div class="flex flex-wrap gap-2 px-1">
          {#each activeFilters as filter}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              data-testid="creator-active-filter"
              aria-label={$t(
                "creators.filters.removeActiveFilter",
                "Remove filter: {label}",
                { label: filter.label },
              )}
              class="h-auto gap-1 rounded-full px-2 py-1 text-xs transition-colors hover:bg-destructive/10 hover:text-destructive {filter.class ||
                ''}"
              onclick={filter.onClick}
            >
              {filter.label}
              <X class="h-3 w-3" aria-hidden="true" />
            </Button>
          {/each}
          <Button
            variant="link"
            size="sm"
            class="h-auto p-0 text-xs text-muted-foreground hover:text-destructive"
            onclick={clearFilters}
          >
            {$t("creators.filters.clearAll", "Clear all filters")}
          </Button>
        </div>
      {/if}
    </div>

    <div class="flex flex-col items-start gap-8 lg:h-full lg:flex-row">
      <!-- Desktop Sidebar -->
      <aside
        class="hidden shrink-0 transition-all duration-300 ease-in-out lg:sticky lg:top-4 lg:block lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto lg:pb-12"
        class:w-80={showDesktopSidebar}
        class:w-0={!showDesktopSidebar}
        class:opacity-100={showDesktopSidebar}
        class:opacity-0={!showDesktopSidebar}
      >
        <div class="relative w-80">
          <Button
            variant="ghost"
            size="icon"
            onclick={() => (showDesktopSidebar = false)}
            class="absolute top-3 right-3 z-10 h-7 w-7 text-muted-foreground hover:text-foreground"
            title={$t("creators.filters.hide", "Hide filters")}
          >
            <X class="h-4 w-4" />
          </Button>
          <CreatorsFilterControls />
        </div>
      </aside>

      <!-- Main Grid -->
      <div class="w-full min-w-0 flex-1 lg:pb-24">
        <!-- Desktop Main Header (Always Visible) -->
        <div
          class="mb-4 hidden min-h-[57px] items-center justify-between border-b border-border/40 pb-4 lg:flex"
        >
          <div class="flex flex-wrap items-center gap-4">
            <div
              class="flex items-center gap-4 overflow-hidden transition-all duration-300 ease-in-out"
              class:max-w-0={showDesktopSidebar}
              class:max-w-xs={!showDesktopSidebar}
              class:opacity-0={showDesktopSidebar}
              class:opacity-100={!showDesktopSidebar}
            >
              <Button
                variant="outline"
                size="sm"
                onclick={() => (showDesktopSidebar = true)}
                class="h-9 gap-2 text-sm font-medium whitespace-nowrap"
              >
                <SlidersHorizontal class="h-4 w-4" />
                {$t("creators.filters.show", "Show filters")}
                {#if activeFilterCount > 0}
                  <Badge
                    class="ml-1 flex h-5 w-5 items-center justify-center bg-primary p-0 text-[10px] text-primary-foreground"
                  >
                    {activeFilterCount}
                  </Badge>
                {/if}
              </Button>
              <Separator orientation="vertical" class="h-6" />
            </div>

            <div class="flex items-center gap-2">
              <span class="text-sm font-semibold">
                {isSingularCount(displayedCreators.length, $locale)
                  ? $t("creators.showingCountOne", "Showing {count} creator", {
                      count: formatLocalizedNumber(
                        displayedCreators.length,
                        $locale,
                      ),
                    })
                  : $t("creators.showingCount", "Showing {count} creators", {
                      count: formatLocalizedNumber(
                        displayedCreators.length,
                        $locale,
                      ),
                    })}
              </span>
              {#if isLoading || isFetchingNextPage}
                <span
                  class="ml-1 flex h-2 w-2 animate-pulse rounded-full bg-primary"
                ></span>
              {/if}
            </div>

            {#if activeFilterCount > 0}
              <Separator orientation="vertical" class="h-6" />
              <div class="flex flex-wrap items-center gap-2">
                {#each activeFilters as filter}
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    data-testid="creator-active-filter"
                    aria-label={$t(
                      "creators.filters.removeActiveFilter",
                      "Remove filter: {label}",
                      { label: filter.label },
                    )}
                    class="h-auto gap-1 rounded-full px-2 py-1 text-xs transition-colors hover:bg-destructive/10 hover:text-destructive {filter.class ||
                      ''}"
                    onclick={filter.onClick}
                  >
                    {filter.label}
                    <X class="h-3 w-3" aria-hidden="true" />
                  </Button>
                {/each}
                <Button
                  variant="link"
                  size="sm"
                  class="ml-1 h-auto p-0 text-xs text-muted-foreground hover:text-destructive"
                  onclick={clearFilters}
                  title={$t("creators.filters.clearAll", "Clear all filters")}
                >
                  {$t("creators.filters.clearAll", "Clear all filters")}
                </Button>
              </div>
            {/if}
          </div>
        </div>

        {#if isLoading && !creators.length}
          <!-- Loading state -->
          <div
            class="flex flex-wrap justify-center gap-4 transition-all duration-300 sm:justify-start sm:gap-5 lg:gap-6"
          >
            {#each Array(12) as _}
              <div
                class="relative flex h-28 w-full min-w-0 animate-pulse overflow-hidden rounded-2xl border border-border bg-card/10 sm:aspect-square sm:h-auto sm:max-w-[320px] sm:flex-grow sm:basis-[250px] sm:flex-col sm:p-4"
              >
                <div
                  class="h-full w-[34%] shrink-0 bg-muted/20 sm:h-32 sm:w-full sm:border sm:border-border/20"
                ></div>
                <div
                  class="flex min-w-0 flex-1 items-center gap-3 pr-4 pl-0 sm:-mt-10 sm:flex-col sm:justify-start sm:gap-4 sm:px-0"
                >
                  <div
                    class="-ml-7 h-16 w-16 shrink-0 rounded-full border-4 border-background bg-muted/40 sm:ml-0 sm:h-20 sm:w-20"
                  ></div>
                  <div class="min-w-0 flex-1 space-y-2 sm:w-full sm:flex-none">
                    <div class="h-4 w-3/4 bg-muted/30 sm:mx-auto"></div>
                    <div class="h-3 w-1/2 bg-muted/20 sm:mx-auto"></div>
                  </div>
                </div>
              </div>
            {/each}
          </div>
        {:else if error}
          <!-- Error state -->
          <div
            class="border-2 border-dashed border-destructive/30 bg-destructive/5 py-20 text-center"
          >
            <h2 class="mb-4 text-2xl font-bold text-destructive">
              {$t("creators.loadErrorTitle", "Could not load creators")}
            </h2>
            <p class="mb-6 text-sm text-muted-foreground">
              {$t(
                "creators.loadErrorBody",
                "Check your connection or try again later.",
              )}
            </p>
            <Button
              variant="destructive"
              onclick={() => location.reload()}
              class="px-8 text-xs font-bold uppercase transition-all hover:tracking-widest"
            >
              {$t("creators.retry", "Try again")}
            </Button>
          </div>
        {:else if creatorsWithArticles.length > 0 && displayedCreators.length > 0}
          <!-- Creators grid -->
          <div
            class="flex flex-wrap justify-center gap-4 transition-all duration-300 sm:justify-start sm:gap-5 lg:gap-6"
          >
            {#each displayedCreators as { creator, latestArticle } (creator.username)}
              <div
                class="group relative w-full min-w-0 sm:max-w-[320px] sm:flex-grow sm:basis-[250px]"
              >
                <CreatorCard {creator} {avatarUrl} {buildImageUrl} {fmtDate} />
              </div>
            {/each}
          </div>

          <!-- Infinite Scroll Sentinel & Loader -->
          <div class="flex w-full justify-center py-8" use:sentinelAction>
            {#if isFetchingNextPage}
              <div class="flex items-center gap-3 text-muted-foreground">
                <div class="flex gap-1">
                  <div
                    class="h-1.5 w-1.5 animate-bounce rounded-full bg-primary"
                  ></div>
                  <div
                    class="h-1.5 w-1.5 animate-bounce rounded-full bg-primary"
                    style="animation-delay: 0.1s"
                  ></div>
                  <div
                    class="h-1.5 w-1.5 animate-bounce rounded-full bg-primary"
                    style="animation-delay: 0.2s"
                  ></div>
                </div>
                <span class="text-sm"
                  >{$t("creators.loadingMore", "Loading more creators…")}</span
                >
              </div>
            {:else if !$creatorsQuery.hasNextPage}
              <div class="text-center text-sm text-muted-foreground">
                {isSingularCount(displayedCreators.length, $locale)
                  ? $t(
                      "creators.allSeenOne",
                      "You have seen {count} creator.",
                      {
                        count: formatLocalizedNumber(
                          displayedCreators.length,
                          $locale,
                        ),
                      },
                    )
                  : $t(
                      "creators.allSeen",
                      "You have seen all {count} creators.",
                      {
                        count: formatLocalizedNumber(
                          displayedCreators.length,
                          $locale,
                        ),
                      },
                    )}
              </div>
            {/if}
          </div>
        {:else if creatorsWithArticles.length > 0 && displayedCreators.length === 0}
          <!-- No matches after applying filters -->
          <div
            class="rounded-xl border border-border/50 bg-card/30 px-6 py-16 text-center"
          >
            <div
              class="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-muted/30"
            >
              <Search class="h-8 w-8 text-muted-foreground/40" />
            </div>
            <h2 class="mb-2 text-lg font-semibold text-foreground">
              {$t("creators.noMatchesTitle", "No creators match your filters")}
            </h2>
            <p class="mx-auto mb-6 max-w-md text-sm text-muted-foreground">
              {$t(
                "creators.noMatchesBody",
                "Remove some filters or broaden your search to find more creators.",
              )}
            </p>
            <Button onclick={clearFilters} class="gap-2">
              <X class="h-4 w-4" />
              {$t("creators.filters.clearAll", "Clear all filters")}
            </Button>
          </div>
        {:else}
          <!-- Empty state -->
          <div
            class="rounded-xl border border-border/50 bg-card/30 px-6 py-16 text-center"
          >
            <div
              class="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-muted/30"
            >
              <Users class="h-8 w-8 text-muted-foreground/40" />
            </div>
            <h2 class="mb-2 text-lg font-semibold text-foreground">
              {$t("creators.noCreatorsTitle", "No creators found")}
            </h2>
            <p class="mx-auto max-w-md text-sm text-muted-foreground">
              {$t(
                "creators.noCreatorsBody",
                "Adjust your search or check back later.",
              )}
            </p>
          </div>
        {/if}
      </div>
    </div>
  </div>

  {#if showBackToTop}
    <div
      class="fixed right-6 bottom-6 z-50 animate-in transition-all duration-300 fade-in slide-in-from-bottom-4"
    >
      <Button
        onclick={scrollToTop}
        size="icon"
        class="h-10 w-10 rounded-full shadow-lg"
        aria-label={$t("creators.backToTop", "Back to top")}
      >
        <ArrowUp class="h-6 w-6" />
      </Button>
    </div>
  {/if}

  <!-- Mobile Filters Drawer -->
  <Drawer.Root bind:open={isDrawerOpen}>
    <Drawer.Content class="bg-card">
      <div class="mx-auto max-h-[85vh] w-full overflow-y-auto px-4 pt-4 pb-8">
        <div class="mt-2">
          <CreatorsFilterControls />
        </div>
      </div>
    </Drawer.Content>
  </Drawer.Root>
</main>
