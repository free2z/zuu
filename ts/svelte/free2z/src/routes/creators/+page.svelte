<script lang="ts">
  import { onMount } from 'svelte';
  import { browser } from '$app/environment';
  import { env } from '$env/dynamic/public';
  import CreatorCard from '$lib/components/CreatorCard.svelte';
  import CreatorsFilterControls from '$lib/components/CreatorsFilterControls.svelte';
  import { tStore as t, loading } from '$lib/i18n';
  import { creatorList } from '$lib/api/creator/creator';
  import { createZpageList } from '$lib/api/zpage/zpage';
  import { createInfiniteQuery } from '@tanstack/svelte-query';
  import { Badge } from "$lib/components/ui/badge";
  import { Search, SlidersHorizontal, X, Users, ArrowUp } from "@lucide/svelte";
  import Button from '$lib/components/ui/button/button.svelte';
  import { buttonVariants } from "$lib/components/ui/button";
  import * as Drawer from "$lib/components/ui/drawer";
  import { Separator } from "$lib/components/ui/separator";
  import PageHeader from '$lib/components/PageHeader.svelte';
  import SeoHead from '$lib/components/SeoHead.svelte';
  import {
    creatorsFilterStore,
    activeFilterCount as activeFilterCountStore,
    hasClientSideFilters as hasClientSideFiltersStore,
    getApiSortParams
  } from '$lib/stores/creatorsFilter';

  const apiBase = (env.PUBLIC_API_BASE_URL || '').replace(/\/$/, '');

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
    sortBy
  } = filterState);

  // Active filters for badges
  $: activeFilters = [
    { condition: searchQuery, label: `"${searchQuery}"`, onClick: () => creatorsFilterStore.setSearchQuery('') },
    { condition: verifiedFilter === 'verified', label: 'Verified', onClick: () => creatorsFilterStore.setVerifiedFilter('all') },
    { condition: verifiedFilter === 'unverified', label: 'Not Verified', onClick: () => creatorsFilterStore.setVerifiedFilter('all') },
    { condition: membershipFilter === 'free', label: 'Free', onClick: () => creatorsFilterStore.setMembershipFilter('all') },
    { condition: membershipFilter === 'paid', label: 'Paid', onClick: () => creatorsFilterStore.setMembershipFilter('all') },
    { condition: onlyZcash, label: 'Zcash', onClick: () => creatorsFilterStore.setOnlyZcash(false), class: 'text-primary' },
    { condition: minPosts, label: `≥${minPosts} posts`, onClick: () => creatorsFilterStore.setMinPosts(null) },
    { condition: minFollowers, label: `≥${minFollowers} followers`, onClick: () => creatorsFilterStore.setMinFollowers(null) },
  ].filter(f => f.condition);

  let showDesktopSidebar = true;
  let isDrawerOpen = false;
  let showBackToTop = false;

  function handleWindowScroll() {
    showBackToTop = window.scrollY > 800;
  }

  function scrollToTop() {
    window.scrollTo({ top: 0, behavior: 'smooth' });
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
    const normalized = imagePath.startsWith('/') ? imagePath : `/${imagePath}`;
    return `${apiBase}${normalized.startsWith('/uploadz/') ? '' : '/uploadz'}${normalized}`.replace('/uploadz/uploadz', '/uploadz');
  }

  function avatarUrl(c?: any): string | null {
    const img = c?.avatar_image?.url || c?.avatar_image?.thumbnail;
    return buildImageUrl(img);
  }

  function fmtDate(iso?: string): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // Infinite query for creators
  // Note: membershipFilter, onlyZcash, minPosts, minFollowers are client-side only filters
  // verifiedFilter and search are handled at API level
  $: creatorsQuery = createInfiniteQuery({
    queryKey: ['creators', 'infinite', debouncedSearch, verifiedFilter, sortBy],
    queryFn: async ({ pageParam = 1 }) => {
      const params: any = { page: pageParam };
      
      if (debouncedSearch) params.search = debouncedSearch;
      
      if (verifiedFilter === 'verified') {
          params.is_verified = 'true';
      } else if (verifiedFilter === 'unverified') {
          params.is_verified = 'false';
      }

      const sortParams = getApiSortParams(sortBy);
      Object.assign(params, sortParams);
      
      const res = await creatorList(params);
      return res;
    },
    initialPageParam: 1,
    getNextPageParam: (lastPage) => {
      if (lastPage.next) {
        const url = new URL(lastPage.next);
        const page = url.searchParams.get('page');
        return page ? parseInt(page) : undefined;
      }
      return undefined;
    }
  });

  // Articles query (keeping existing logic for mapping articles to creators, though it only covers the first page of articles)
  $: articlesQuery = browser
    ? createZpageList({ ordering: '-created_at', page: 1 })
    : null;

  // Flatten creators from all pages and ensure uniqueness by username
  $: creators = (() => {
    const all = $creatorsQuery.data?.pages.flatMap(page => page.results) || [];
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
          new Date(article.created_at) > new Date(map[username].created_at)
        ) {
          map[username] = article;
        }
      }
      return map;
    },
    {}
  );

  // Combine creators with their latest articles
  $: creatorsWithArticles = creators
    .filter((creator: any) => creator && typeof creator.username === 'string')
    .map((creator: any) => ({
      creator,
      latestArticle: articlesByCreator[creator.username.toLowerCase()],
    }));

  // Client-side filtering and sorting (applied after we've flattened pages)
  function parseFollowers(total?: string): number {
    if (!total) return 0;
    const n = Number(String(total).replace(/[^0-9.-]+/g, ''));
    return Number.isNaN(n) ? 0 : n;
  }

  // Client-side sorting function
  // Note: 'popular', 'followers_*', 'newest', 'oldest', 'updated', 'alphabetical_*' are handled by API
  // These client-side sorts are for: 'content_*', 'recent_activity', 'price_*'
  function sortCreators(items: any[], sort: string): any[] {
    const sorted = [...items]; // Create a copy to avoid mutation
    switch (sort) {
      case 'content_desc':
        sorted.sort((a, b) => Number(b.creator.zpages || 0) - Number(a.creator.zpages || 0));
        break;
      case 'content_asc':
        sorted.sort((a, b) => Number(a.creator.zpages || 0) - Number(b.creator.zpages || 0));
        break;
      case 'recent_activity':
        sorted.sort((a, b) => {
          const da = a.latestArticle ? new Date(a.latestArticle.created_at).getTime() : 0;
          const db = b.latestArticle ? new Date(b.latestArticle.created_at).getTime() : 0;
          return db - da;
        });
        break;
      case 'price_asc':
        sorted.sort((a, b) => parseFloat(a.creator.member_price || '0') - parseFloat(b.creator.member_price || '0'));
        break;
      case 'price_desc':
        sorted.sort((a, b) => parseFloat(b.creator.member_price || '0') - parseFloat(a.creator.member_price || '0'));
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
    creatorsWithArticles
      .filter(({ creator }: any) => {
        if (!creator) return false;
        
        if (membershipFilter === 'free') {
            const price = parseFloat(creator.member_price || '0');
            if (price > 0) return false;
        } else if (membershipFilter === 'paid') {
            const price = parseFloat(creator.member_price || '0');
            if (price <= 0 || creator.member_price === null) return false;
        }

        if (onlyZcash && !creator.p2paddr) return false;
        
        if (minPosts && (Number(creator.zpages || 0) < Number(minPosts))) return false;
        if (minFollowers && (parseFollowers(creator.total) < Number(minFollowers))) return false;

        return true;
      }),
    sortBy
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
      const observer = new IntersectionObserver((entries) => {
          if (entries[0].isIntersecting && $creatorsQuery.hasNextPage && !$creatorsQuery.isFetchingNextPage) {
              $creatorsQuery.fetchNextPage();
          }
      }, { rootMargin: '400px' });

      observer.observe(node);

      return {
          destroy() {
              observer.disconnect();
          }
      };
  }

</script>

<SeoHead
  title="Creators Directory | Free2Z"
  description="Discover independent creators publishing stories, ideas, and original work on Free2Z."
  path="/creators"
  imageAlt="Free2Z creator directory"
/>

<svelte:window on:scroll={handleWindowScroll} />

<main class="flex-1 bg-background text-foreground font-sans">

  <PageHeader title="Creators" titleSuffix="." subtitle={$t('creators.subtitle', 'Discover amazing creators sharing their stories on Free2Z')} />

  <div class="container mx-auto px-4 pt-8 pb-6 lg:pb-12 max-w-7xl">
    
    <!-- Mobile Controls Trigger & Summary Bar -->
    <div class="lg:hidden mb-6 space-y-3">
        <div class="flex items-center justify-between bg-card/50 backdrop-blur-sm p-3 rounded-xl border border-border/40 shadow-sm">
             <div class="flex items-center gap-3">
                 <div class="flex flex-col">
                    <span class="text-xs text-muted-foreground">Showing</span>
                    <span class="text-lg font-semibold">{displayedCreators.length} <span class="text-sm font-normal text-muted-foreground">creators</span></span>
                 </div>
                 {#if isLoading || isFetchingNextPage}
                    <div class="flex h-2 w-2 rounded-full bg-primary animate-pulse shadow-[0_0_8px_rgba(132,204,22,0.5)]"></div>
                 {/if}
            </div>
            <Button variant="outline" size="sm" onclick={() => isDrawerOpen = true} class="gap-2 h-10 font-medium text-sm relative">
                <SlidersHorizontal class="w-4 h-4" />
                Filters
                {#if activeFilterCount > 0}
                    <Badge class="absolute -top-2 -right-2 h-5 w-5 p-0 flex items-center justify-center text-[10px] bg-primary text-primary-foreground">
                        {activeFilterCount}
                    </Badge>
                {/if}
            </Button>
        </div>
        
        {#if activeFilterCount > 0}
            <div class="flex flex-wrap gap-2 px-1">
                {#each activeFilters as filter}
                    <Badge variant="secondary" class="text-xs px-2 py-1 gap-1 cursor-pointer hover:bg-destructive/10 hover:text-destructive transition-colors {filter.class || ''}" onclick={filter.onClick}>
                        {filter.label} <X class="w-3 h-3" />
                    </Badge>
                {/each}
                <Button variant="link" size="sm" class="text-xs text-muted-foreground hover:text-destructive p-0 h-auto" onclick={clearFilters}>
                    Clear all
                </Button>
            </div>
        {/if}
    </div>

    <div class="flex flex-col lg:flex-row gap-8 items-start lg:h-full">
        
        <!-- Desktop Sidebar -->
        <aside 
            class="hidden lg:block shrink-0 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto lg:pb-12 transition-all duration-300 ease-in-out"
            class:w-80={showDesktopSidebar}
            class:w-0={!showDesktopSidebar}
            class:opacity-100={showDesktopSidebar}
            class:opacity-0={!showDesktopSidebar}
        >
            <div class="w-80 relative">
                <Button 
                    variant="ghost" 
                    size="icon"
                    onclick={() => showDesktopSidebar = false}
                    class="absolute top-3 right-3 z-10 h-7 w-7 text-muted-foreground hover:text-foreground"
                    title="Hide filters"
                >
                    <X class="w-4 h-4" />
                </Button>
                <CreatorsFilterControls />
            </div>
        </aside>

        <!-- Main Grid -->
        <div class="w-full flex-1 min-w-0 lg:pb-24">
            
            <!-- Desktop Main Header (Always Visible) -->
            <div class="hidden lg:flex items-center justify-between mb-4 pb-4 border-b border-border/40 min-h-[57px]">
                <div class="flex items-center gap-4 flex-wrap">
                    <div class="transition-all duration-300 ease-in-out overflow-hidden flex items-center gap-4" class:max-w-0={showDesktopSidebar} class:max-w-xs={!showDesktopSidebar} class:opacity-0={showDesktopSidebar} class:opacity-100={!showDesktopSidebar}>
                        <Button variant="outline" size="sm" onclick={() => showDesktopSidebar = true} class="gap-2 h-9 font-medium text-sm whitespace-nowrap">
                            <SlidersHorizontal class="w-4 h-4" />
                            Show Filters
                            {#if activeFilterCount > 0}
                                <Badge class="ml-1 h-5 w-5 p-0 flex items-center justify-center text-[10px] bg-primary text-primary-foreground">
                                    {activeFilterCount}
                                </Badge>
                            {/if}
                        </Button>
                        <Separator orientation="vertical" class="h-6" />
                    </div>
                    
                    <div class="flex items-center gap-2">
                        <span class="text-sm text-muted-foreground">Showing</span>
                        <span class="text-sm font-semibold">
                            {displayedCreators.length}
                        </span>
                        <span class="text-sm text-muted-foreground">creators</span>
                        {#if isLoading || isFetchingNextPage}
                             <span class="flex h-2 w-2 rounded-full bg-primary animate-pulse ml-1"></span>
                        {/if}
                    </div>
                    
                    {#if activeFilterCount > 0}
                         <Separator orientation="vertical" class="h-6" />
                         <div class="flex gap-2 items-center flex-wrap">
                            {#each activeFilters as filter}
                                <Badge variant="secondary" class="text-xs px-2 py-1 gap-1 cursor-pointer hover:bg-destructive/10 hover:text-destructive transition-colors {filter.class || ''}" onclick={filter.onClick}>
                                    {filter.label} <X class="w-3 h-3" />
                                </Badge>
                            {/each}
                            <Button variant="link" size="sm" class="text-xs text-muted-foreground hover:text-destructive p-0 h-auto ml-1" onclick={clearFilters} title="Clear all filters">
                                Clear all
                            </Button>
                        </div>
                    {/if}
                </div>
            </div>

            {#if isLoading && !creators.length}
                <!-- Loading state -->
                <div class="flex flex-wrap gap-4 sm:gap-5 lg:gap-6 transition-all duration-300 justify-center sm:justify-start">
                {#each Array(12) as _}
                    <div class="w-full min-w-0 sm:flex-grow sm:basis-[250px] sm:max-w-[320px] sm:aspect-square h-28 sm:h-auto border border-border bg-card/10 animate-pulse relative overflow-hidden rounded-2xl flex sm:flex-col sm:p-4">
                        <div class="h-full w-[34%] sm:h-32 sm:w-full bg-muted/20 sm:border sm:border-border/20 shrink-0"></div>
                        <div class="flex flex-1 min-w-0 items-center gap-3 pl-0 pr-4 sm:-mt-10 sm:flex-col sm:justify-start sm:gap-4 sm:px-0">
                            <div class="-ml-7 w-16 h-16 sm:ml-0 sm:w-20 sm:h-20 rounded-full bg-muted/40 border-4 border-background shrink-0"></div>
                            <div class="space-y-2 min-w-0 flex-1 sm:flex-none sm:w-full">
                                <div class="h-4 bg-muted/30 w-3/4 sm:mx-auto"></div>
                                <div class="h-3 bg-muted/20 w-1/2 sm:mx-auto"></div>
                            </div>
                        </div>
                    </div>
                {/each}
                </div>
            {:else if error}
                <!-- Error state -->
                <div class="text-center py-20 border-2 border-dashed border-destructive/30 bg-destructive/5">
                    <h2 class="text-2xl font-bold text-destructive mb-4">Error Loading Data</h2>
                    <p class="text-muted-foreground mb-6 text-sm">Please check your connection or try again later.</p>
                    <Button 
                        variant="destructive"
                        onclick={() => location.reload()} 
                        class="font-bold uppercase text-xs px-8 transition-all hover:tracking-widest"
                    >
                        Retry
                    </Button>
                </div>
            {:else if creatorsWithArticles.length > 0 && displayedCreators.length > 0}
                <!-- Creators grid -->
                <div class="flex flex-wrap gap-4 sm:gap-5 lg:gap-6 transition-all duration-300 justify-center sm:justify-start">
                {#each displayedCreators as { creator, latestArticle } (creator.username)}
                    <div class="group relative w-full min-w-0 sm:flex-grow sm:basis-[250px] sm:max-w-[320px]">
                        <CreatorCard {creator} {avatarUrl} {buildImageUrl} {fmtDate} />
                    </div>
                {/each}
                </div>

                <!-- Infinite Scroll Sentinel & Loader -->
                <div class="py-8 flex justify-center w-full" use:sentinelAction>
                {#if isFetchingNextPage}
                    <div class="flex items-center gap-3 text-muted-foreground">
                        <div class="flex gap-1">
                            <div class="w-1.5 h-1.5 rounded-full bg-primary animate-bounce"></div>
                            <div class="w-1.5 h-1.5 rounded-full bg-primary animate-bounce" style="animation-delay: 0.1s"></div>
                            <div class="w-1.5 h-1.5 rounded-full bg-primary animate-bounce" style="animation-delay: 0.2s"></div>
                        </div>
                        <span class="text-sm">Loading more creators...</span>
                    </div>
                {:else if !$creatorsQuery.hasNextPage}
                    <div class="text-center text-sm text-muted-foreground">
                        You've seen all {displayedCreators.length} creators
                    </div>
                {/if}
                </div>

            {:else if creatorsWithArticles.length > 0 && displayedCreators.length === 0}
                <!-- No matches after applying filters -->
                <div class="text-center py-16 px-6 rounded-xl border border-border/50 bg-card/30">
                    <div class="w-16 h-16 rounded-full bg-muted/30 flex items-center justify-center mx-auto mb-4">
                        <Search class="w-8 h-8 text-muted-foreground/40" />
                    </div>
                    <h2 class="text-lg font-semibold text-foreground mb-2">No creators match your filters</h2>
                    <p class="text-muted-foreground max-w-md mx-auto text-sm mb-6">
                        Try removing some filters or broadening your search criteria to find more creators.
                    </p>
                    <Button onclick={clearFilters} class="gap-2">
                        <X class="w-4 h-4" />
                        Clear all filters
                    </Button>
                </div>

            {:else}
                <!-- Empty state -->
                <div class="text-center py-16 px-6 rounded-xl border border-border/50 bg-card/30">
                    <div class="w-16 h-16 rounded-full bg-muted/30 flex items-center justify-center mx-auto mb-4">
                        <Users class="w-8 h-8 text-muted-foreground/40" />
                    </div>
                    <h2 class="text-lg font-semibold text-foreground mb-2">No creators found</h2>
                    <p class="text-muted-foreground max-w-md mx-auto text-sm">
                        We couldn't find any creators. Try adjusting your search or check back later.
                    </p>
                </div>
            {/if}
        </div>
    </div>
  </div>

  {#if showBackToTop}
    <div class="fixed bottom-6 right-6 z-50 transition-all duration-300 animate-in fade-in slide-in-from-bottom-4">
        <Button 
            onclick={scrollToTop} 
            size="icon" 
            class="h-10 w-10 rounded-full shadow-lg"
            aria-label="Back to top"
        >
            <ArrowUp class="h-6 w-6" />
        </Button>
    </div>
  {/if}

  <!-- Mobile Filters Drawer -->
  <Drawer.Root bind:open={isDrawerOpen}>
    <Drawer.Content class="bg-card">
        <div class="mx-auto w-full  pt-4 pb-8 px-4 max-h-[85vh] overflow-y-auto">          
            <div class="mt-2">
                <CreatorsFilterControls />
            </div>
        </div>
    </Drawer.Content>
  </Drawer.Root>
</main>
