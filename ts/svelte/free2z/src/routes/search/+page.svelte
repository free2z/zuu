<script lang="ts">
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { browser } from '$app/environment';
  import { tStore as t } from '$lib/i18n';
  import SearchResultCard from '$lib/components/SearchResultCard.svelte';
  import { Input } from '$lib/components/ui/input';
  import { Button } from '$lib/components/ui/button';
  import { Search } from '@lucide/svelte';
  import SeoHead from '$lib/components/SeoHead.svelte';

  let searchQuery = '';
  let searchInput: HTMLInputElement;
  let isSearching = false;
  let searchResults: any[] = [];
  let totalResults = 0;
  let currentPage = 1;
  let recentSearches: string[] = [];
  let abortController: AbortController | null = null;

  // Get query from URL params
  $: searchQuery = $page.url.searchParams.get('q') || '';
  $: currentPage = parseInt($page.url.searchParams.get('page') || '1');

  // Perform search when query or page changes from URL
  $: if (searchQuery && browser) {
    performSearch(searchQuery, currentPage);
  } else if (!searchQuery) {
    // Clear results when no query
    searchResults = [];
    totalResults = 0;
  }

  // Load recent searches from localStorage
  onMount(() => {
    if (browser) {
      const stored = localStorage.getItem('recentSearches');
      if (stored) {
        try {
          recentSearches = JSON.parse(stored);
        } catch (e) {
          recentSearches = [];
        }
      }
    }

    // Set initial search value
    if (searchInput && searchQuery) {
      searchInput.value = searchQuery;
    }
  });

  // Search function with request cancellation
  async function performSearch(query: string, page: number = 1) {
    if (abortController) {
      abortController.abort();
    }
    const currentController = new AbortController();
    abortController = currentController;

    if (!query.trim()) {
      // For now, if no query, clear results
      searchResults = [];
      totalResults = 0;
      return;
    }

    // Set loading state
    isSearching = true;

    try {
      // Use the correct backend search parameter that triggers VectorSearchFilter
      const searchParams = new URLSearchParams();
      searchParams.set('search', query.trim());
      searchParams.set('page', page.toString());
      searchParams.set('page_size', '10'); // Backend handles pagination

      const response = await fetch(
        `/api/zpage/?${searchParams.toString()}`,
        { signal: currentController.signal }
      );
      const data = await response.json();

      // Only apply results if this is still the active search
      if (abortController === currentController) {
        searchResults = data.results || [];
        totalResults = data.count || 0;
      }
    } catch (error: any) {
      if (error.name === 'AbortError') return;
      if (abortController === currentController) {
        console.error('Search failed:', error);
        searchResults = [];
        totalResults = 0;
      }
    } finally {
      if (abortController === currentController) {
        isSearching = false;
      }
    }
  }

  // Handle search form submission
  function handleSearch() {
    const query = searchInput?.value?.trim() || '';

    if (query) {
      // Save to recent searches
      saveRecentSearch(query);

      // Update URL
      const url = new URL(window.location.href);
      url.searchParams.set('q', query);
      url.searchParams.delete('page'); // Reset to page 1
      goto(url.pathname + url.search, { replaceState: false });
    } else {
      // Clear search
      const url = new URL(window.location.href);
      url.searchParams.delete('q');
      url.searchParams.delete('page');
      goto(url.pathname + url.search, { replaceState: false });
    }
  }

  function saveRecentSearch(query: string) {
    if (!browser) return;

    // Remove if already exists
    recentSearches = recentSearches.filter((s) => s !== query);
    // Add to beginning
    recentSearches.unshift(query);
    // Keep only last 10
    recentSearches = recentSearches.slice(0, 10);

    localStorage.setItem('recentSearches', JSON.stringify(recentSearches));
  }

  function selectRecentSearch(query: string) {
    if (searchInput) {
      searchInput.value = query;
      handleSearch();
    }
  }

  function clearRecentSearches() {
    if (browser) {
      localStorage.removeItem('recentSearches');
      recentSearches = [];
    }
  }

  // Handle pagination
  function goToPage(page: number) {
    const url = new URL(window.location.href);
    if (page === 1) {
      url.searchParams.delete('page');
    } else {
      url.searchParams.set('page', page.toString());
    }
    goto(url.pathname + url.search, { replaceState: false });
  }

  // Calculate pagination
  $: totalPages = Math.ceil(totalResults / 10);
  $: hasNextPage = currentPage < totalPages;
  $: hasPrevPage = currentPage > 1;

  // Reactive header text for results — substitute placeholders manually to avoid
  // any mismatch with the i18n interpolation mechanism.
  $: resultsHeader = (() => {
    if (isSearching) return $t('common.search.searching', 'Searching...');
    if (!searchQuery) return '';
    if (totalResults > 0) {
      const tpl = $t(
        'common.search.resultsCount',
        'Found {count} results for "{query}"'
      );
      return tpl
        .replace('{count}', String(totalResults))
        .replace('{query}', searchQuery);
    }
    const noTpl = $t(
      'common.search.noResultsFor',
      'No results found for "{query}"'
    );
    return noTpl.replace('{query}', searchQuery);
  })();
</script>
<SeoHead
  title={`${searchQuery ? `${searchQuery} - Search` : 'Search'} | Free2Z`}
  description="Search Free2Z articles, creators, and topics."
  path="/search"
  robots="noindex, follow"
/>

<div class="min-h-screen bg-background p-4 md:p-8">
  <div class="max-w-[800px] mx-auto">
    <!-- Search Header -->
    <div class="mb-12 text-center">
      <h1 class="text-4xl md:text-5xl font-bold mb-6 text-foreground">{$t('common.search.title', 'Search')}</h1>

      <!-- Main Search Box -->
      <div class="relative max-w-[600px] mx-auto">
        <Input
          bind:ref={searchInput}
          type="text"
          placeholder={$t(
            'common.search.placeholder',
            'Search articles, creators, topics...'
          )}
          onkeydown={(e) => e.key === 'Enter' && handleSearch()}
          class="w-full py-3.5 pl-5 pr-10 md:py-4 md:pl-6 md:pr-12 text-[16px] md:text-lg border-2 border-white/20 rounded-full bg-white/10 text-foreground outline-none transition-all duration-200 ease-in backdrop-blur-md focus-visible:border-primary focus-visible:bg-white/15 focus-visible:ring-4 focus-visible:ring-primary/10 placeholder:text-white/60 h-auto"
          bind:value={searchQuery}
        />
        <Button
          size="icon"
          onclick={handleSearch}
          class="absolute right-2 top-1/2 -translate-y-1/2 rounded-full w-9 h-9 md:w-10 md:h-10 transition-colors duration-200"
          aria-label={$t('common.search.searchButton', 'Search')}
        >
          <Search class="w-5 h-5 text-white" />
        </Button>
      </div>
    </div>

    <!-- Search Results or Empty State -->
    <div class="mt-8">
      {#if searchQuery}
        <!-- Search Results -->
        <div class="mb-8">
          <p class="text-base text-muted-foreground m-0">{resultsHeader}</p>
        </div>

        <!-- Results List -->
        {#if isSearching}
          <div class="flex flex-col items-center gap-4 py-12 px-4 text-muted-foreground">
            <div class="w-8 h-8 border-2 border-border border-t-primary rounded-full animate-spin"></div>
            <p>{$t('common.search.searching', 'Searching...')}</p>
          </div>
        {:else if searchResults.length > 0}
          <div class="flex flex-col gap-4">
            {#each searchResults as result}
              <SearchResultCard article={result} />
            {/each}
          </div>

          <!-- Pagination -->
          {#if totalPages > 1}
            <div class="flex justify-center items-center gap-2 mt-12 py-8">
              <Button
                variant="outline"
                disabled={!hasPrevPage}
                onclick={() => goToPage(currentPage - 1)}
              >
                ← {$t('common.search.previous', 'Previous')}
              </Button>

              <div class="flex gap-1 mx-4">
                {#each Array(Math.min(5, totalPages)) as _, i}
                  {@const pageNum =
                    Math.max(1, Math.min(totalPages - 4, currentPage - 2)) + i}
                  {#if pageNum <= totalPages}
                    <Button
                      variant={pageNum === currentPage ? "default" : "outline"}
                      size="icon"
                      onclick={() => goToPage(pageNum)}
                    >
                      {pageNum}
                    </Button>
                  {/if}
                {/each}
              </div>

              <Button
                variant="outline"
                disabled={!hasNextPage}
                onclick={() => goToPage(currentPage + 1)}
              >
                {$t('common.search.next', 'Next')} →
              </Button>
            </div>
          {/if}
        {:else}
          <div class="text-center py-12 px-4">
            <div class="text-5xl mb-4 opacity-50">🔍</div>
            <h3 class="text-2xl mb-2 text-foreground">{$t('common.search.noResults', 'No results found')}</h3>
            <p class="text-muted-foreground">
              {$t(
                'common.search.noResultsMessage',
                'Try different keywords or check your spelling',
                { query: searchQuery }
              )}
            </p>
          </div>
        {/if}
      {:else}
        <!-- Empty State -->
        <div class="text-center py-12 px-4">
          <div class="w-16 h-16 mx-auto mb-8 text-muted-foreground">
            <Search class="w-full h-full" />
          </div>

          <h2 class="text-2xl font-semibold mb-2 text-foreground">
            {$t('common.search.emptyTitle', 'Start your search')}
          </h2>
          <p class="text-muted-foreground mb-8">
            {$t(
              'common.search.emptyDescription',
              'Search for articles, creators, and topics across Free2Z'
            )}
          </p>

          <!-- Recent Searches -->
          {#if recentSearches.length > 0}
            <div class="max-w-[400px] mx-auto text-left">
              <div class="flex justify-between items-center mb-4">
                <h3 class="text-lg font-semibold m-0 text-foreground">{$t('common.search.recentSearches', 'Recent searches')}</h3>
                <Button
                  variant="ghost"
                  size="sm"
                  onclick={clearRecentSearches}
                  class="text-primary"
                >
                  {$t('common.search.clearRecent', 'Clear')}
                </Button>
              </div>

              <div class="flex flex-col gap-2">
                {#each recentSearches as recent}
                  <Button
                    variant="outline"
                    class="w-full justify-start gap-3 h-auto py-3 px-4 text-foreground bg-card hover:bg-muted"
                    onclick={() => selectRecentSearch(recent)}
                  >
                    <svg
                      class="w-4 h-4 text-muted-foreground shrink-0"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                    >
                      <path d="M12 2l9 4.5v3L12 14l-9-4.5v-3L12 2z"></path>
                      <path d="M12 14l9-4.5v4.5L12 19l-9-4.5v-4.5L12 14z"
                      ></path>
                    </svg>
                    <span class="truncate">{recent}</span>
                  </Button>
                {/each}
              </div>
            </div>
          {/if}
        </div>
      {/if}
    </div>
  </div>
</div>
