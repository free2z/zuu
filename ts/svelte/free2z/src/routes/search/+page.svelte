<script lang="ts">
  import { page } from "$lib/kit-stores";
  import { goto } from "$app/navigation";
  import { onMount } from "svelte";
  import { browser } from "$app/env";
  import { locale, tStore as t } from "$lib/i18n";
  import ZpageCard from "$lib/components/ZpageCard.svelte";
  import CreatorSearchResultCard from "$lib/components/CreatorSearchResultCard.svelte";
  import SeriesSearchResultCard from "$lib/components/SeriesSearchResultCard.svelte";
  import type { CreatorList } from "$lib/api/f2z.schemas";
  import type { PublicSeries } from "$lib/types/search";
  import { findSeriesForPages } from "$lib/search/series";
  import { Button } from "$lib/components/ui/button";
  import * as Accordion from "$lib/components/ui/accordion";
  import {
    AlertCircle,
    ArrowLeft,
    ArrowRight,
    Clock3,
    RotateCcw,
    Search,
    X,
  } from "@lucide/svelte";
  import SeoHead from "$lib/components/SeoHead.svelte";

  const PAGE_SIZE = 10;

  let searchQuery = "";
  let searchDraft = "";
  let searchInput: HTMLInputElement;
  let isSearching = false;
  let searchResults: any[] = [];
  let creatorResults: CreatorList[] = [];
  let seriesResults: PublicSeries[] = [];
  let totalResults = 0;
  let totalCreators = 0;
  let totalSeries = 0;
  let searchFailures: string[] = [];
  // Whether the last request actually asked for creators. A tag-only visit
  // does not, and the fatal-outage test below must not require a failure from
  // a request that was never sent.
  let searchIncludedCreators = true;
  let currentPage = 1;
  let recentSearches: string[] = [];
  let abortController: AbortController | null = null;
  let requestGeneration = 0;
  let lastRequestedSearch = "";
  let lastSectionsQuery = "";
  let openSections = ["creators", "series", "pages"];

  $: searchQuery = $page.url.searchParams.get("q") || "";
  // `?tag=` is a tag filter, not a text query: it maps onto the API's
  // long-standing `?tags=` parameter (now declared in `f2z.yaml`, ) and
  // matches whole tag names case-insensitively. It is deliberately NOT folded
  // into `q` — a full-text search for "zcash" also returns every article that
  // merely says the word, which is why the article page's tag links used to go
  // somewhere almost right and never exactly right.
  $: tagFilter = ($page.url.searchParams.get("tag") || "").trim();
  $: pageParam = $page.url.searchParams.get("page");
  $: currentPage = normalizePage(pageParam);
  $: requestLanguage = $locale;
  $: requestKey = `${searchQuery}:${tagFilter}:${currentPage}:${requestLanguage}`;

  $: if (
    browser &&
    pageParam !== null &&
    (currentPage === 1 || pageParam !== String(currentPage))
  ) {
    replacePageInUrl(currentPage);
  }

  $: if (browser && requestKey !== lastRequestedSearch) {
    lastRequestedSearch = requestKey;
    if (searchQuery !== lastSectionsQuery) {
      lastSectionsQuery = searchQuery;
      openSections = ["creators", "series", "pages"];
    }
    searchDraft = searchQuery;
    if (searchQuery || tagFilter) {
      performSearch(searchQuery, currentPage, requestLanguage, tagFilter);
    } else {
      requestGeneration += 1;
      abortController?.abort();
      abortController = null;
      resetSearchState();
    }
  }

  onMount(() => {
    try {
      const stored = localStorage.getItem("recentSearches");
      recentSearches = stored ? JSON.parse(stored) : [];
    } catch {
      recentSearches = [];
    }
    searchDraft = searchQuery;
  });

  async function performSearch(
    query: string,
    pageNumber = 1,
    language = $locale,
    tag = "",
  ) {
    abortController?.abort();
    const currentController = new AbortController();
    abortController = currentController;
    const generation = ++requestGeneration;
    const isCurrent = () =>
      generation === requestGeneration &&
      abortController === currentController &&
      !currentController.signal.aborted &&
      $locale === language &&
      ($page.url.searchParams.get("q") || "") === query &&
      ($page.url.searchParams.get("tag") || "").trim() === tag &&
      normalizePage($page.url.searchParams.get("page")) === pageNumber;
    isSearching = true;
    searchFailures = [];
    searchIncludedCreators = Boolean(query.trim());

    try {
      const pageParams = new URLSearchParams({
        page: pageNumber.toString(),
        page_size: PAGE_SIZE.toString(),
        lang: language,
      });
      if (query.trim()) pageParams.set("search", query.trim());
      if (tag) pageParams.set("tags", tag);
      const relatedSeriesParams = new URLSearchParams(pageParams);
      relatedSeriesParams.set("page", "1");

      const pageRequest = fetchCollection(
        `/api/zpage/?${pageParams}`,
        currentController,
      );
      const relatedSeriesSeedRequest =
        pageNumber === 1
          ? pageRequest
          : fetchCollection(
              `/api/zpage/?${relatedSeriesParams}`,
              currentController,
            );

      // Creators have no tags, so a tag-only visit must not ask for them: an
      // empty `?search=` matches every creator on the platform and would fill
      // a tag page with people who have nothing to do with the tag. The
      // substitute below is a *fulfilled* empty result, which is why
      // `searchIncludedCreators` exists — without it a tag-only search can
      // never report the "search is unavailable" state, and a `/api/zpage/`
      // outage renders as "no results for this tag" instead.
      const includeCreators = Boolean(query.trim());
      const creatorRequest = includeCreators
        ? fetchCollection(
            `/api/creator/?${new URLSearchParams({
              search: query.trim(),
              page: "1",
              page_size: "4",
            })}`,
            currentController,
          )
        : Promise.resolve({ count: 0, results: [] });

      const [pages, creators, relatedSeriesSeeds] = await Promise.allSettled([
        pageRequest,
        creatorRequest,
        relatedSeriesSeedRequest,
      ]);

      if (!isCurrent()) return;
      const pageData =
        pages.status === "fulfilled" ? pages.value : { count: 0, results: [] };
      const creatorData =
        creators.status === "fulfilled"
          ? creators.value
          : { count: 0, results: [] };
      const relatedSeriesSeedData =
        relatedSeriesSeeds.status === "fulfilled"
          ? relatedSeriesSeeds.value
          : { count: 0, results: [] };
      const lastAvailablePage = Math.max(
        1,
        Math.ceil(pageData.count / PAGE_SIZE),
      );
      if (pageNumber > lastAvailablePage) {
        await replacePageInUrl(
          pages.status === "fulfilled" ? lastAvailablePage : 1,
        );
        return;
      }
      const discoveredSeries = await findSeriesForPages(
        relatedSeriesSeedData.results,
        currentController.signal,
        4,
        language,
      );
      if (!isCurrent()) return;

      const failures = new Set<string>();
      if (pages.status === "rejected") failures.add("pages");
      if (includeCreators && creators.status === "rejected")
        failures.add("creators");
      if (
        relatedSeriesSeeds.status === "rejected" ||
        discoveredSeries.hadFailures
      ) {
        failures.add("related series");
      }

      searchResults = rankPages(pageData.results, query);
      creatorResults = rankCreators(creatorData.results, query).slice(0, 4);
      seriesResults = rankSeries(discoveredSeries.results, query);
      totalResults = pageData.count;
      totalCreators = creatorData.count;
      totalSeries = discoveredSeries.results.length;
      searchFailures = Array.from(failures);
    } catch (error: any) {
      if (error.name === "AbortError") return;
      if (isCurrent()) {
        console.error("Search failed:", error);
        searchResults = [];
        creatorResults = [];
        seriesResults = [];
        totalResults = 0;
        totalCreators = 0;
        totalSeries = 0;
        searchFailures = searchIncludedCreators
          ? ["pages", "creators", "related series"]
          : ["pages", "related series"];
      }
    } finally {
      if (isCurrent()) isSearching = false;
    }
  }

  function textRank(value: string | undefined, query: string): number {
    const candidate = (value || "").trim().toLocaleLowerCase();
    const term = query.trim().toLocaleLowerCase();
    if (!candidate || !term) return 4;
    if (candidate === term) return 0;
    if (candidate.startsWith(term)) return 1;
    if (candidate.includes(term)) return 2;
    return 4;
  }

  function normalizePage(value: string | null): number {
    if (value === null) return 1;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
  }

  function replacePageInUrl(pageNumber: number) {
    const url = new URL(window.location.href);
    if (pageNumber <= 1) url.searchParams.delete("page");
    else url.searchParams.set("page", String(pageNumber));
    return goto(url.pathname + url.search + url.hash, {
      replace: true,
      reset: false,
    });
  }

  function rankCreators(results: CreatorList[], query: string): CreatorList[] {
    return [...results].sort((a, b) => {
      const aRank = Math.min(
        textRank(a.username, query),
        textRank(a.full_name, query),
      );
      const bRank = Math.min(
        textRank(b.username, query),
        textRank(b.full_name, query),
      );
      if (aRank !== bRank) return aRank - bRank;
      if (Boolean(a.is_verified) !== Boolean(b.is_verified))
        return a.is_verified ? -1 : 1;
      return (b.zpages || 0) - (a.zpages || 0);
    });
  }

  function rankSeries(results: PublicSeries[], query: string): PublicSeries[] {
    return [...results].sort((a, b) => {
      const seriesRank = (series: PublicSeries) =>
        Math.min(
          textRank(series.name, query),
          ...series.pageorder_set.map((item) =>
            textRank(item.page.title, query),
          ),
        );
      return seriesRank(a) - seriesRank(b);
    });
  }

  function rankPages(results: any[], query: string): any[] {
    return [...results].sort((a, b) => {
      const pageRank = (item: any) =>
        Math.min(
          textRank(item?.title, query),
          textRank(item?.creator?.username, query),
          ...(item?.tags || []).map((tag: string) => textRank(tag, query)),
        );
      return pageRank(a) - pageRank(b);
    });
  }

  async function fetchCollection(url: string, controller: AbortController) {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Search failed: ${response.status}`);
    const data = await response.json();
    return {
      count: Number(data?.count || 0),
      results: Array.isArray(data?.results) ? data.results : [],
    };
  }

  function handleSearch() {
    const query = searchDraft.trim();
    const url = new URL(window.location.href);
    url.searchParams.delete("page");

    if (query) {
      saveRecentSearch(query);
      url.searchParams.set("q", query);
    } else {
      url.searchParams.delete("q");
    }

    goto(url.pathname + url.search);
  }

  function resetSearchState() {
    searchResults = [];
    creatorResults = [];
    seriesResults = [];
    totalResults = 0;
    totalCreators = 0;
    totalSeries = 0;
    searchFailures = [];
    isSearching = false;
  }

  function retrySearch() {
    if (searchQuery || tagFilter) {
      performSearch(searchQuery, currentPage, requestLanguage, tagFilter);
    }
  }

  function clearTagFilter() {
    const url = new URL(window.location.href);
    url.searchParams.delete("tag");
    url.searchParams.delete("page");
    goto(url.pathname + url.search + url.hash, {
      reset: false,
    });
  }

  async function clearSearch() {
    requestGeneration += 1;
    abortController?.abort();
    abortController = null;
    searchDraft = "";
    resetSearchState();

    const url = new URL(window.location.href);
    url.searchParams.delete("q");
    url.searchParams.delete("page");
    await goto(url.pathname + url.search + url.hash, {
      reset: false,
    });
    searchInput?.focus();
  }

  function saveRecentSearch(query: string) {
    if (!browser) return;
    recentSearches = [
      query,
      ...recentSearches.filter((item) => item !== query),
    ].slice(0, 6);
    localStorage.setItem("recentSearches", JSON.stringify(recentSearches));
  }

  function selectRecentSearch(query: string) {
    searchDraft = query;
    saveRecentSearch(query);
    const url = new URL(window.location.href);
    url.searchParams.set("q", query);
    url.searchParams.delete("page");
    goto(url.pathname + url.search);
  }

  function clearRecentSearches() {
    localStorage.removeItem("recentSearches");
    recentSearches = [];
  }

  function goToPage(pageNumber: number) {
    const normalizedPage = Math.max(1, Math.floor(pageNumber));
    const url = new URL(window.location.href);
    if (normalizedPage === 1) url.searchParams.delete("page");
    else url.searchParams.set("page", normalizedPage.toString());
    goto(url.pathname + url.search);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  $: totalPages = Math.ceil(totalResults / PAGE_SIZE);
  $: hasNextPage = currentPage < totalPages;
  $: hasPrevPage = currentPage > 1;
  $: firstResult = totalResults ? (currentPage - 1) * PAGE_SIZE + 1 : 0;
  $: lastResult = Math.min(currentPage * PAGE_SIZE, totalResults);
  $: hasAnyResults =
    searchResults.length > 0 ||
    creatorResults.length > 0 ||
    seriesResults.length > 0;
  // "Search is temporarily unavailable" rather than "no results": every
  // collection the request actually asked for came back rejected and nothing
  // rendered. A tag-only search asks for pages only, so one failure is enough.
  $: everythingFailed =
    searchFailures.includes("pages") &&
    (!searchIncludedCreators || searchFailures.includes("creators")) &&
    !hasAnyResults;
</script>

<SeoHead
  title={`${searchQuery ? `${searchQuery} - Search` : tagFilter ? `#${tagFilter} - Search` : "Search"} | Free2Z`}
  description="Search creators, pages, and series on Free2Z."
  path="/search"
  robots="noindex, follow"
/>

<div class="min-h-[calc(100vh-3.5rem)] flex-1 bg-(--f2z-bg-primary)">
  <div
    class="mx-auto w-full max-w-4xl px-3 py-3 sm:px-6 sm:py-10 lg:px-8 lg:py-12"
  >
    <header>
      <h1
        class="text-3xl font-bold tracking-[-0.03em] text-foreground sm:text-4xl"
      >
        {$t("common.search.titleV2", "Search Free2Z")}
      </h1>

      <form
        class="group mt-4"
        onsubmit={(event) => {
          event.preventDefault();
          handleSearch();
        }}
      >
        <div
          class="flex h-12 items-center rounded-lg border border-(--f2z-border-primary) bg-(--f2z-bg-secondary) p-1 shadow-xs transition-[border-color,box-shadow] focus-within:border-(--f2z-accent-primary) focus-within:ring-2 focus-within:ring-(--f2z-accent-primary)/15"
        >
          <input
            bind:this={searchInput}
            bind:value={searchDraft}
            type="text"
            role="searchbox"
            autocomplete="off"
            aria-label={$t("common.search.searchFieldLabel", "Search Free2Z")}
            placeholder={$t(
              "common.search.placeholderV3",
              "Search creators and pages…",
            )}
            class="h-full min-w-0 flex-1 bg-transparent px-3 text-base text-(--f2z-text-primary) outline-none placeholder:text-(--f2z-text-muted)"
          />
          {#if searchDraft}
            <button
              type="button"
              onclick={clearSearch}
              class="grid size-8 shrink-0 place-items-center text-(--f2z-text-muted) transition-colors hover:text-red-500 focus-visible:text-red-500 focus-visible:outline-none active:text-red-600"
              aria-label="Clear search"
            >
              <X class="size-4" />
            </button>
          {/if}
          <Button
            type="submit"
            size="icon"
            class="ml-1 size-9 rounded-md"
            aria-label={$t("common.search.searchButton", "Search")}
          >
            <Search class="size-4" />
          </Button>
        </div>
      </form>

      {#if !searchQuery && !tagFilter && recentSearches.length > 0}
        <div class="mt-4 flex flex-wrap items-center gap-2">
          <span
            class="mr-1 inline-flex items-center gap-1.5 text-xs font-medium text-(--f2z-text-muted)"
            ><Clock3 class="size-3.5" /> Recent</span
          >
          {#each recentSearches.slice(0, 4) as recent}
            <button
              type="button"
              onclick={() => selectRecentSearch(recent)}
              class="rounded-full border border-(--f2z-border-primary) bg-transparent px-3 py-1.5 text-xs text-(--f2z-text-secondary) transition-colors hover:border-(--f2z-accent-primary) hover:text-(--f2z-accent-primary)"
              >{recent}</button
            >
          {/each}
          <button
            type="button"
            onclick={clearRecentSearches}
            class="px-2 py-1.5 text-xs text-(--f2z-text-muted) transition-colors hover:text-(--f2z-text-primary)"
            >Clear</button
          >
        </div>
      {/if}
    </header>

    <main class="mt-5 sm:mt-10">
      {#if searchQuery || tagFilter}
        <div
          class="mb-4 flex flex-col gap-1.5 border-b border-border/60 pb-3 sm:mb-6 sm:flex-row sm:items-end sm:justify-between sm:gap-2 sm:pb-5"
        >
          <div>
            <p class="text-sm text-muted-foreground">
              {searchQuery
                ? $t("common.search.results", "Search results for")
                : $t("search.taggedWith", "Tagged with")}
            </p>
            <h2
              class="mt-1 text-xl font-semibold tracking-tight text-foreground sm:text-2xl"
            >
              {#if searchQuery}“{searchQuery}”{:else}#{tagFilter}{/if}
            </h2>
            {#if searchQuery && tagFilter}
              <button
                type="button"
                onclick={clearTagFilter}
                class="mt-2 inline-flex items-center gap-1 rounded-full border border-border bg-muted/60 px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent"
              >
                #{tagFilter}
                <X class="size-3" aria-hidden="true" />
                <span class="sr-only"
                  >{$t("search.clearTagFilter", "Clear tag filter")}</span
                >
              </button>
            {/if}
          </div>
          {#if !isSearching}
            <div
              class="flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted-foreground"
            >
              {#if totalCreators > 0}<span
                  >{totalCreators}
                  {totalCreators === 1 ? "creator" : "creators"}</span
                >{/if}
              {#if totalSeries > 0}<span
                  >{totalSeries} related {totalSeries === 1
                    ? "series"
                    : "series"}</span
                >{/if}
              {#if totalResults > 0}<span
                  >{totalResults} {totalResults === 1 ? "page" : "pages"}</span
                >{/if}
              {#if !hasAnyResults && searchFailures.length === 0}<span
                  >0 results</span
                >{/if}
            </div>
          {/if}
        </div>

        {#if !isSearching && searchFailures.length > 0 && !everythingFailed}
          <div
            class="mb-5 flex items-start gap-3 rounded-lg border border-amber-500/25 bg-amber-500/8 px-4 py-3 text-sm"
            role="status"
          >
            <AlertCircle class="mt-0.5 size-4 shrink-0 text-amber-500" />
            <div class="min-w-0 flex-1">
              <p class="font-medium text-foreground">
                Some results could not be loaded.
              </p>
              <p class="mt-0.5 text-xs text-muted-foreground">
                Unavailable: {searchFailures.join(", ")}.
              </p>
            </div>
            <button
              type="button"
              onclick={retrySearch}
              class="shrink-0 font-medium text-(--f2z-accent-primary) hover:underline"
              >Retry</button
            >
          </div>
        {/if}

        {#if isSearching}
          <div class="space-y-4" aria-label="Searching" aria-live="polite">
            {#each Array(3) as _}
              <div
                class="h-40 animate-pulse rounded-xl border border-border/60 bg-card/60"
              ></div>
            {/each}
          </div>
        {:else if everythingFailed}
          <div
            class="rounded-xl border border-border px-6 py-12 text-center sm:px-10"
            role="alert"
          >
            <AlertCircle class="mx-auto size-5 text-amber-500" />
            <h2 class="mt-4 text-lg font-semibold">
              Search is temporarily unavailable
            </h2>
            <p class="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
              We could not reach the search services. Please try again.
            </p>
            <Button variant="outline" onclick={retrySearch} class="mt-5 gap-2">
              <RotateCcw class="size-4" />
              Retry search
            </Button>
          </div>
        {:else if hasAnyResults}
          <Accordion.Root
            type="multiple"
            bind:value={openSections}
            class="space-y-1 sm:space-y-2"
          >
            {#if creatorResults.length > 0}
              <Accordion.Item
                value="creators"
                class="border-b border-(--f2z-border-primary)"
              >
                <Accordion.Trigger class="py-2 hover:no-underline sm:py-3">
                  <span
                    class="flex min-w-0 flex-1 items-center justify-between gap-3 pr-2"
                  >
                    <span class="font-semibold text-(--f2z-text-primary)"
                      >Creators</span
                    >
                    <span class="text-xs font-normal text-(--f2z-text-muted)"
                      >{totalCreators} found</span
                    >
                  </span>
                </Accordion.Trigger>
                <Accordion.Content
                  class="px-0 pt-1 pb-3 sm:px-1 sm:pt-2 sm:pb-6"
                >
                  <div class="grid gap-3 sm:grid-cols-2">
                    {#each creatorResults as creator (creator.username)}
                      <CreatorSearchResultCard {creator} />
                    {/each}
                  </div>
                </Accordion.Content>
              </Accordion.Item>
            {/if}

            {#if seriesResults.length > 0}
              <Accordion.Item
                value="series"
                class="border-b border-(--f2z-border-primary)"
              >
                <Accordion.Trigger class="py-2 hover:no-underline sm:py-3">
                  <span
                    class="flex min-w-0 flex-1 items-center justify-between gap-3 pr-2"
                  >
                    <span class="font-semibold text-(--f2z-text-primary)"
                      >Related series</span
                    >
                    <span class="text-xs font-normal text-(--f2z-text-muted)"
                      >{totalSeries} related</span
                    >
                  </span>
                </Accordion.Trigger>
                <Accordion.Content
                  class="px-0 pt-1 pb-3 sm:px-1 sm:pt-2 sm:pb-6"
                >
                  <div class="grid gap-3 sm:grid-cols-2">
                    {#each seriesResults as series (series.id)}
                      <SeriesSearchResultCard {series} />
                    {/each}
                  </div>
                </Accordion.Content>
              </Accordion.Item>
            {/if}

            {#if searchResults.length > 0}
              <Accordion.Item value="pages" class="border-b-0">
                <Accordion.Trigger class="py-2 hover:no-underline sm:py-3">
                  <span
                    class="flex min-w-0 flex-1 items-center justify-between gap-3 pr-2"
                  >
                    <span class="font-semibold text-(--f2z-text-primary)"
                      >Pages</span
                    >
                    <span class="text-xs font-normal text-(--f2z-text-muted)"
                      >{firstResult}–{lastResult} of {totalResults}</span
                    >
                  </span>
                </Accordion.Trigger>
                <Accordion.Content class="px-0 py-1 sm:px-4 sm:py-4">
                  <div class="grid gap-3 sm:grid-cols-2 sm:gap-4">
                    {#each searchResults as result}
                      <div class="sm:hidden">
                        <ZpageCard story={result} mobileHorizontal={true} />
                      </div>
                      <div class="hidden sm:block">
                        <ZpageCard story={result} compactOnMobile={true} />
                      </div>
                    {/each}
                  </div>

                  {#if totalPages > 1}
                    <nav
                      class="mt-6 flex items-center justify-between border-t border-border/60 pt-6"
                      aria-label="Search result pages"
                    >
                      <Button
                        variant="outline"
                        disabled={!hasPrevPage}
                        onclick={() => goToPage(currentPage - 1)}
                        class="gap-2"
                      >
                        <ArrowLeft class="size-4" />
                        <span class="hidden sm:inline"
                          >{$t("common.search.previous", "Previous")}</span
                        >
                      </Button>
                      <span
                        class="text-xs font-semibold tracking-wide text-muted-foreground"
                        >Page {currentPage} of {totalPages}</span
                      >
                      <Button
                        variant="outline"
                        disabled={!hasNextPage}
                        onclick={() => goToPage(currentPage + 1)}
                        class="gap-2"
                      >
                        <span class="hidden sm:inline"
                          >{$t("common.search.next", "Next")}</span
                        >
                        <ArrowRight class="size-4" />
                      </Button>
                    </nav>
                  {/if}
                </Accordion.Content>
              </Accordion.Item>
            {/if}
          </Accordion.Root>
        {:else}
          <div
            class="rounded-xl border border-dashed border-border px-6 py-12 text-center sm:px-10"
          >
            <Search class="mx-auto size-5 text-muted-foreground" />
            <h2 class="mt-4 text-lg font-semibold">
              {$t("common.search.noResultsV2", "No results found")}
            </h2>
            <p class="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
              {$t(
                "common.search.noResultsMessageV2",
                "Try another keyword or a broader search.",
              )}
            </p>
          </div>
        {/if}
      {/if}
    </main>
  </div>
</div>
