<script lang="ts">
  import { locale, tStore as t } from "$lib/i18n";
  import { goto } from "$app/navigation";
  import { browser } from "$app/env";
  import * as env from "$app/env/public";
  import { MediaQuery } from "svelte/reactivity";
  import * as Command from "$lib/components/ui/command/index.js";
  import * as Drawer from "$lib/components/ui/drawer/index.js";
  import FeaturedImageFrame from "$lib/components/FeaturedImageFrame.svelte";
  import type {
    CreatorList,
    FeaturedImage,
    ZPageList,
  } from "$lib/api/f2z.schemas";
  import type { PublicSeries } from "$lib/types/search";
  import { findSeriesForPages } from "$lib/search/series";
  import { paletteImageSrc } from "$lib/search/palette-image";
  import { zpageCanonicalPath } from "$lib/zpage-path";
  import {
    Search,
    Clock,
    FileText,
    CornerDownLeft,
    X,
    UserRound,
    Layers3,
    AlertCircle,
    RotateCcw,
  } from "@lucide/svelte";

  let { open = $bindable(false) }: { open?: boolean } = $props();

  // Responsive surface: centered command dialog on desktop, bottom drawer on
  // mobile (https://www.shadcn-svelte.com/docs/components/drawer#responsive-dialog).
  const isDesktop = new MediaQuery("(min-width: 768px)");

  let query = $state("");
  let pageResults = $state<ZPageList[]>([]);
  let authorResults = $state<CreatorList[]>([]);
  let seriesResults = $state<PublicSeries[]>([]);
  let isLoading = $state(false);
  let failedSources = $state<string[]>([]);
  let recent = $state<string[]>([]);

  let inputRef = $state<HTMLInputElement | null>(null);

  let abortController: AbortController | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let requestGeneration = 0;

  const apiBase = env.PUBLIC_API_BASE_URL?.replace(/\/$/, "") || "";

  // Active/hover state: a subtle lime tint instead of a full lime fill, so the
  // highlighted row reads green but stays low-shine with full-contrast text.
  const itemSelectedClass =
    "cursor-pointer aria-selected:bg-(--f2z-accent-primary)/10 aria-selected:text-(--f2z-text-primary)";

  // Refresh recent searches whenever the palette opens.
  $effect(() => {
    if (open && browser) {
      recent = loadRecent();
    }
  });

  // ⌘K exists so you can start typing immediately, but bits-ui's focus scope
  // claims focus inside a `requestAnimationFrame` — so anything typed in the
  // ~16ms after the shortcut is swallowed, which is exactly how  was
  // reported ("the palette showed Recent searches while my typed query went
  // nowhere").
  //
  // `onOpenAutoFocus` (below, on <Command.Dialog>) cancels that deferred pass
  // outright and focuses the input synchronously instead. Cancelling matters
  // as much as focusing: two focus authorities racing means whichever runs
  // last wins, and the library's runs a frame late — long enough to yank focus
  // back off whatever the user Tabbed to in the meantime.
  //
  // This effect is the fallback for the one ordering `onOpenAutoFocus` cannot
  // cover: if the focus scope mounts before `bind:ref` has handed us the
  // input, the handler has nothing to focus. It runs once when the ref lands
  // and never re-focuses afterwards.
  //
  // Desktop only: on the mobile drawer this would throw up the on-screen
  // keyboard over a sheet the user has not committed to yet. (The dialog and
  // its `onOpenAutoFocus` are desktop-only for the same reason.)
  $effect(() => {
    if (!open || !browser || !isDesktop.current) return;
    inputRef?.focus();
  });

  // Take over the dialog's open-focus entirely: cancel bits-ui's rAF pass and
  // focus the input in the same tick the content mounts.
  function focusInputOnOpen(event: Event) {
    event.preventDefault();
    inputRef?.focus();
  }

  // Debounced, server-side live search driven by the input value.
  $effect(() => {
    const q = query.trim();
    const language = $locale;
    const generation = ++requestGeneration;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    if (!q) {
      pageResults = [];
      authorResults = [];
      seriesResults = [];
      failedSources = [];
      isLoading = false;
      return;
    }
    pageResults = [];
    authorResults = [];
    seriesResults = [];
    failedSources = [];
    isLoading = true;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      runSearch(q, generation, language);
    }, 200);
  });

  async function runSearch(
    q: string,
    generation = ++requestGeneration,
    language = $locale,
  ) {
    if (generation !== requestGeneration) return;
    if (abortController) abortController.abort();
    const controller = new AbortController();
    abortController = controller;
    const isCurrent = () =>
      generation === requestGeneration &&
      abortController === controller &&
      !controller.signal.aborted &&
      $locale === language &&
      query.trim() === q;
    isLoading = true;
    failedSources = [];

    try {
      const pageParams = new URLSearchParams();
      pageParams.set("search", q);
      pageParams.set("page", "1");
      pageParams.set("page_size", "5");
      pageParams.set("lang", language);

      const authorParams = new URLSearchParams();
      authorParams.set("search", q);
      authorParams.set("page", "1");
      authorParams.set("page_size", "5");

      const [pages, authors] = await Promise.allSettled([
        fetchResults<ZPageList>(
          `/api/zpage/?${pageParams.toString()}`,
          controller,
          5,
        ),
        fetchResults<CreatorList>(
          `/api/creator/?${authorParams.toString()}`,
          controller,
          5,
        ),
      ]);

      if (!isCurrent()) return;
      const foundPages = pages.status === "fulfilled" ? pages.value : [];
      const foundSeries = await findSeriesForPages(
        foundPages,
        controller.signal,
        3,
        language,
      );
      if (!isCurrent()) return;
      const failures = new Set<string>();
      if (pages.status === "rejected") failures.add("pages");
      if (authors.status === "rejected") failures.add("creators");
      if (foundSeries.hadFailures) failures.add("related series");
      pageResults = foundPages;
      authorResults = authors.status === "fulfilled" ? authors.value : [];
      seriesResults = foundSeries.results;
      failedSources = Array.from(failures);
    } catch (error: any) {
      if (error?.name === "AbortError") return;
      if (isCurrent()) {
        pageResults = [];
        authorResults = [];
        seriesResults = [];
        failedSources = ["pages", "creators", "related series"];
      }
    } finally {
      if (isCurrent()) isLoading = false;
    }
  }

  function retrySearch() {
    const q = query.trim();
    if (q) runSearch(q);
  }

  function primarySearchFailed(): boolean {
    return (
      failedSources.includes("pages") && failedSources.includes("creators")
    );
  }

  async function fetchResults<T>(
    url: string,
    controller: AbortController,
    limit: number,
  ): Promise<T[]> {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Search request failed: ${res.status}`);
    const data = await res.json();
    return Array.isArray(data?.results) ? data.results.slice(0, limit) : [];
  }

  function resultUrl(item: ZPageList): string {
    return (
      zpageCanonicalPath(item) || (item?.get_url || "").replace("/zpage/", "/")
    );
  }

  function authorUrl(item: CreatorList): string {
    return item?.username ? `/${item.username}` : "";
  }

  function seriesUrl(item: PublicSeries): string {
    const pages = [...(item?.pageorder_set || [])].sort(
      (a, b) => a.order - b.order,
    );
    const firstPage = pages[0]?.page;
    return (
      zpageCanonicalPath(firstPage || {}) ||
      (firstPage?.get_url || "").replace("/zpage/", "/")
    );
  }

  // Bounded by construction: `paletteImageSrc` never yields an original
  // upload, so a 36px chip can never pull a multi-thousand-pixel hero image
  //. A row with no bounded derivative renders its icon placeholder
  // instead -- see the helper for why that trade is the right one here.
  function imageUrl(image?: Partial<FeaturedImage> | null): string {
    const imageUrl = paletteImageSrc(image);
    if (!imageUrl) return "";
    if (/^https?:\/\//.test(imageUrl)) return imageUrl;
    return `${apiBase}${imageUrl.startsWith("/") ? imageUrl : `/${imageUrl}`}`;
  }

  function pageImageUrl(item: ZPageList): string {
    return imageUrl(item?.featured_image);
  }

  function authorImageUrl(item: CreatorList): string {
    return imageUrl(item?.avatar_image);
  }

  function authorName(item: CreatorList): string {
    return item?.full_name?.trim() || `@${item.username}`;
  }

  function pageCreatorName(item: ZPageList): string {
    return item?.creator?.username
      ? `@${item.creator.username}`
      : $t("common.article.unknownAuthor", "Unknown author");
  }

  function close() {
    open = false;
    query = "";
    pageResults = [];
    authorResults = [];
    seriesResults = [];
    failedSources = [];
  }

  function navigate(url: string) {
    if (!url) return;
    close();
    goto(url);
  }

  function submitSearch() {
    const q = query.trim();
    if (!q) return;
    saveRecent(q);
    navigate(`/search?q=${encodeURIComponent(q)}`);
  }

  function selectPage(item: ZPageList) {
    const url = resultUrl(item);
    if (!url) return;
    const q = query.trim();
    if (q) saveRecent(q);
    navigate(url);
  }

  function selectAuthor(item: CreatorList) {
    const url = authorUrl(item);
    if (!url) return;
    const q = query.trim();
    if (q) saveRecent(q);
    navigate(url);
  }

  function selectSeries(item: PublicSeries) {
    const url = seriesUrl(item);
    if (!url) return;
    const q = query.trim();
    if (q) saveRecent(q);
    navigate(url);
  }

  function pickRecent(term: string) {
    saveRecent(term);
    navigate(`/search?q=${encodeURIComponent(term)}`);
  }

  // Recent search persistence (shared with the /search page).
  function loadRecent(): string[] {
    try {
      const stored = JSON.parse(localStorage.getItem("recentSearches") || "[]");
      return Array.isArray(stored) ? stored.slice(0, 6) : [];
    } catch {
      return [];
    }
  }

  function saveRecent(term: string) {
    if (!browser) return;
    let list = loadRecent().filter((s) => s !== term);
    list.unshift(term);
    list = list.slice(0, 6);
    localStorage.setItem("recentSearches", JSON.stringify(list));
    recent = list;
  }

  function removeRecent(term: string, event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (!browser) return;

    const list = loadRecent().filter((s) => s !== term);
    if (list.length) {
      localStorage.setItem("recentSearches", JSON.stringify(list));
    } else {
      localStorage.removeItem("recentSearches");
    }
    recent = list;
  }

  function clearRecent() {
    if (!browser) return;
    localStorage.removeItem("recentSearches");
    recent = [];
  }
</script>

{#snippet searchBody()}
  <Command.Input
    bind:ref={inputRef}
    bind:value={query}
    placeholder={$t(
      "common.navigation.searchPlaceholder",
      "Search creators and pages…",
    )}
  />
  <Command.List class="max-h-[60vh] md:max-h-[320px]">
    {#if query.trim()}
      <Command.Group heading={$t("common.search.title", "Search")}>
        <Command.Item
          value="__search__"
          class={itemSelectedClass}
          onSelect={submitSearch}
        >
          <Search class="text-(--f2z-accent-primary)" />
          <span class="truncate"
            >{$t("common.search.forQuery", "Search for “{query}”", {
              query: query.trim(),
            })}</span
          >
          <Command.Shortcut class="flex items-center gap-1">
            <CornerDownLeft class="size-3" />
          </Command.Shortcut>
        </Command.Item>
      </Command.Group>

      {#if authorResults.length || seriesResults.length || pageResults.length}
        <Command.Separator />
        {#if authorResults.length}
          <Command.Group heading={$t("common.search.authors", "Authors")}>
            {#each authorResults as item (item.username)}
              {@const avatar = authorImageUrl(item)}
              <Command.Item
                class={`items-start gap-3 py-2 ${itemSelectedClass}`}
                value={`author-${item.username}`}
                onSelect={() => selectAuthor(item)}
              >
                {#if avatar}
                  <!--
                    `decoding="async"` keeps the decode off the thread that is
                    handling the next keystroke, `loading="lazy"` keeps rows
                    scrolled out of the 320px list from decoding at all, and
                    the intrinsic 36x36 reserves the box so a late-arriving
                    avatar cannot reflow the list under the user's cursor.
                    All three are load-bearing; the zPage rows below
                    get the same treatment from FeaturedImageFrame.
                  -->
                  <img
                    src={avatar}
                    alt=""
                    width="36"
                    height="36"
                    loading="lazy"
                    decoding="async"
                    class="size-9 shrink-0 rounded-full object-cover"
                  />
                {:else}
                  <span
                    class="flex size-9 shrink-0 items-center justify-center rounded-full bg-(--f2z-bg-secondary) text-(--f2z-text-muted)"
                  >
                    <UserRound class="size-4" />
                  </span>
                {/if}
                <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span class="truncate font-medium">{authorName(item)}</span>
                  <span class="truncate text-xs text-(--f2z-text-muted)">
                    @{item.username}{item.zpages
                      ? ` - ${item.zpages} zpages`
                      : ""}
                  </span>
                </div>
              </Command.Item>
            {/each}
          </Command.Group>
        {/if}

        {#if authorResults.length && seriesResults.length}
          <Command.Separator />
        {/if}

        {#if seriesResults.length}
          <Command.Group heading="Related series">
            {#each seriesResults as item (item.id)}
              <Command.Item
                class={`items-start gap-3 py-2 ${itemSelectedClass}`}
                value={`series-${item.id}`}
                onSelect={() => selectSeries(item)}
              >
                <span
                  class="flex size-10 shrink-0 items-center justify-center rounded-md bg-(--f2z-accent-primary)/10 text-(--f2z-accent-primary)"
                >
                  <Layers3 class="size-4" />
                </span>
                <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span class="truncate font-medium"
                    >{item.name || "Untitled series"}</span
                  >
                  <span class="truncate text-xs text-(--f2z-text-muted)">
                    {item.pageorder_set?.length || 0} pages
                  </span>
                </div>
              </Command.Item>
            {/each}
          </Command.Group>
        {/if}

        {#if (authorResults.length || seriesResults.length) && pageResults.length}
          <Command.Separator />
        {/if}

        {#if pageResults.length}
          <Command.Group heading="Zpages">
            {#each pageResults as item (item.free2zaddr ?? item.get_url)}
              {@const image = pageImageUrl(item)}
              <Command.Item
                class={`items-start gap-3 py-2 ${itemSelectedClass}`}
                value={`page-${item.free2zaddr ?? item.get_url}`}
                onSelect={() => selectPage(item)}
              >
                {#if image}
                  <FeaturedImageFrame
                    src={image}
                    alt=""
                    class="size-10 shrink-0 rounded-md"
                  />
                {:else}
                  <span
                    class="flex size-10 shrink-0 items-center justify-center rounded-md bg-(--f2z-bg-secondary) text-(--f2z-text-muted)"
                  >
                    <FileText class="size-4" />
                  </span>
                {/if}
                <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span class="truncate font-medium"
                    >{item.title || $t("editor.untitled", "Untitled")}</span
                  >
                  <span class="truncate text-xs text-(--f2z-text-muted)">
                    by {pageCreatorName(item)}
                  </span>
                </div>
              </Command.Item>
            {/each}
          </Command.Group>
        {/if}
        {#if failedSources.length}
          <Command.Separator />
          <div
            class="flex items-start gap-2 px-3 py-2 text-xs text-(--f2z-text-muted)"
            role="status"
          >
            <AlertCircle class="mt-0.5 size-3.5 shrink-0 text-amber-500" />
            <span class="min-w-0 flex-1"
              >Some results are unavailable: {failedSources.join(", ")}.</span
            >
            <button
              type="button"
              onclick={retrySearch}
              class="shrink-0 font-medium text-(--f2z-accent-primary) hover:underline"
              >Retry</button
            >
          </div>
        {/if}
      {:else if isLoading}
        <div class="py-8 text-center text-sm text-(--f2z-text-muted)">
          Searching…
        </div>
      {:else if primarySearchFailed()}
        <div class="px-4 py-8 text-center" role="alert">
          <AlertCircle class="mx-auto size-5 text-amber-500" />
          <p class="mt-3 text-sm font-medium">
            Search is temporarily unavailable.
          </p>
          <button
            type="button"
            onclick={retrySearch}
            class="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-(--f2z-accent-primary) hover:underline"
          >
            <RotateCcw class="size-3.5" /> Retry
          </button>
        </div>
      {:else if failedSources.length}
        <div class="px-4 py-8 text-center" role="status">
          <AlertCircle class="mx-auto size-5 text-amber-500" />
          <p class="mt-3 text-sm font-medium">
            Some search results are unavailable.
          </p>
          <p class="mt-1 text-xs text-(--f2z-text-muted)">
            No matches were returned by the available sources.
          </p>
          <button
            type="button"
            onclick={retrySearch}
            class="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-(--f2z-accent-primary) hover:underline"
          >
            <RotateCcw class="size-3.5" /> Retry
          </button>
        </div>
      {:else}
        <div class="py-8 text-center text-sm text-(--f2z-text-muted)">
          No creators or pages found.
        </div>
      {/if}
    {:else if recent.length}
      <Command.Group
        heading={$t("common.search.recentSearches", "Recent searches")}
      >
        {#each recent as term (term)}
          <Command.Item
            class={`gap-2 ${itemSelectedClass}`}
            value={`recent-${term}`}
            onSelect={() => pickRecent(term)}
          >
            <Clock />
            <span class="min-w-0 flex-1 truncate">{term}</span>
            <button
              type="button"
              class="ml-auto flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-sm text-(--f2z-text-muted) hover:bg-(--f2z-bg-secondary) hover:text-(--f2z-text-primary) focus-visible:ring-2 focus-visible:ring-(--f2z-accent-primary)/30 focus-visible:outline-none"
              aria-label={`Delete recent search ${term}`}
              onclick={(event) => removeRecent(term, event)}
            >
              <X class="size-3.5" />
            </button>
          </Command.Item>
        {/each}
      </Command.Group>
      <Command.Separator />
      <Command.Group>
        <Command.Item
          value="__clear-recent__"
          class={itemSelectedClass}
          onSelect={clearRecent}
        >
          <X />
          <span
            >{$t(
              "common.search.clearRecentSearches",
              "Clear recent searches",
            )}</span
          >
        </Command.Item>
      </Command.Group>
    {:else}
      <div class="px-3 py-10 text-center text-sm text-(--f2z-text-muted)">
        Search creators and pages across Free2Z.
      </div>
    {/if}
  </Command.List>
{/snippet}

{#if isDesktop.current}
  <!--
    `shouldFilter={false}` + `filter={() => 1}` are PERFORMANCE contracts, not
    styling. Search is server-side; with filtering left on, bits-ui re-scores
    and re-sorts every registered item on every keystroke, which is the classic
    cmdk main-thread freeze. Both roots below carry them; a refactor
    that drops either reintroduces it. tests/search-palette.test.mjs fails if
    they go missing.
  -->
  <Command.Dialog
    bind:open
    shouldFilter={false}
    filter={() => 1}
    title={$t("common.search.title", "Search")}
    description="Search creators and pages across Free2Z"
    onOpenAutoFocus={focusInputOnOpen}
  >
    {@render searchBody()}
  </Command.Dialog>
{:else}
  <Drawer.Root bind:open>
    <Drawer.Content class="bg-(--f2z-bg-secondary)">
      <Drawer.Header class="sr-only">
        <Drawer.Title>Search</Drawer.Title>
        <Drawer.Description>
          Search creators and pages across Free2Z
        </Drawer.Description>
      </Drawer.Header>
      <!-- Load-bearing for the same reason as the dialog above. -->
      <Command.Root
        shouldFilter={false}
        filter={() => 1}
        class="bg-transparent px-2 pb-4"
      >
        {@render searchBody()}
      </Command.Root>
    </Drawer.Content>
  </Drawer.Root>
{/if}
