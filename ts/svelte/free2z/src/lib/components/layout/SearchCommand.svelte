<script lang="ts">
  import { goto } from "$app/navigation";
  import { browser } from "$app/environment";
  import { env } from "$env/dynamic/public";
  import { MediaQuery } from "svelte/reactivity";
  import * as Command from "$lib/components/ui/command/index.js";
  import * as Drawer from "$lib/components/ui/drawer/index.js";
  import type {
    CreatorList,
    FeaturedImage,
    ZPageList,
  } from "$lib/api/f2z.schemas";
  import {
    Search,
    Clock,
    FileText,
    CornerDownLeft,
    X,
    UserRound,
  } from "@lucide/svelte";

  let { open = $bindable(false) }: { open?: boolean } = $props();

  // Responsive surface: centered command dialog on desktop, bottom drawer on
  // mobile (https://www.shadcn-svelte.com/docs/components/drawer#responsive-dialog).
  const isDesktop = new MediaQuery("(min-width: 768px)");

  let query = $state("");
  let pageResults = $state<ZPageList[]>([]);
  let authorResults = $state<CreatorList[]>([]);
  let isLoading = $state(false);
  let recent = $state<string[]>([]);

  let abortController: AbortController | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

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

  // Debounced, server-side live search driven by the input value.
  $effect(() => {
    const q = query.trim();
    if (debounceTimer) clearTimeout(debounceTimer);
    if (!q) {
      if (abortController) {
        abortController.abort();
        abortController = null;
      }
      pageResults = [];
      authorResults = [];
      isLoading = false;
      return;
    }
    isLoading = true;
    debounceTimer = setTimeout(() => runSearch(q), 200);
  });

  async function runSearch(q: string) {
    if (abortController) abortController.abort();
    const controller = new AbortController();
    abortController = controller;

    try {
      const pageParams = new URLSearchParams();
      pageParams.set("search", q);
      pageParams.set("page", "1");
      pageParams.set("page_size", "5");

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

      if (abortController === controller) {
        pageResults = pages.status === "fulfilled" ? pages.value : [];
        authorResults = authors.status === "fulfilled" ? authors.value : [];
        isLoading = false;
      }
    } catch (error: any) {
      if (error?.name === "AbortError") return;
      if (abortController === controller) {
        pageResults = [];
        authorResults = [];
        isLoading = false;
      }
    }
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
    return (item?.get_url || "").replace("/zpage/", "/");
  }

  function authorUrl(item: CreatorList): string {
    return item?.username ? `/${item.username}` : "";
  }

  function imageUrl(image?: Partial<FeaturedImage> | null): string {
    const imageUrl = image?.thumbnail || image?.url;
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
      : "Unknown author";
  }

  function close() {
    open = false;
    query = "";
    pageResults = [];
    authorResults = [];
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
  <Command.Input bind:value={query} placeholder="Search creators and pages…" />
  <Command.List class="max-h-[60vh] md:max-h-[320px]">
    {#if query.trim()}
      <Command.Group heading="Search">
        <Command.Item
          value="__search__"
          class={itemSelectedClass}
          onSelect={submitSearch}
        >
          <Search class="text-(--f2z-accent-primary)" />
          <span class="truncate">Search for &ldquo;{query.trim()}&rdquo;</span>
          <Command.Shortcut class="flex items-center gap-1">
            <CornerDownLeft class="size-3" />
          </Command.Shortcut>
        </Command.Item>
      </Command.Group>

      {#if authorResults.length || pageResults.length}
        <Command.Separator />
        {#if authorResults.length}
          <Command.Group heading="Authors">
            {#each authorResults as item (item.username)}
              {@const avatar = authorImageUrl(item)}
              <Command.Item
                class={`items-start gap-3 py-2 ${itemSelectedClass}`}
                value={`author-${item.username}`}
                onSelect={() => selectAuthor(item)}
              >
                {#if avatar}
                  <img
                    src={avatar}
                    alt=""
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

        {#if authorResults.length && pageResults.length}
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
                  <img
                    src={image}
                    alt=""
                    class="size-10 shrink-0 rounded-md object-cover"
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
                    >{item.title || "Untitled"}</span
                  >
                  <span class="truncate text-xs text-(--f2z-text-muted)">
                    by {pageCreatorName(item)}
                  </span>
                </div>
              </Command.Item>
            {/each}
          </Command.Group>
        {/if}
      {:else if isLoading}
        <div class="py-8 text-center text-sm text-(--f2z-text-muted)">
          Searching…
        </div>
      {:else}
        <div class="py-8 text-center text-sm text-(--f2z-text-muted)">
          No authors or zpages found.
        </div>
      {/if}
    {:else if recent.length}
      <Command.Group heading="Recent searches">
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
          <span>Clear recent searches</span>
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
  <Command.Dialog
    bind:open
    shouldFilter={false}
    filter={() => 1}
    title="Search"
    description="Search creators and pages across Free2Z"
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
