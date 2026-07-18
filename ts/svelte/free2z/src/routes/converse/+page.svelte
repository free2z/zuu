<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { env } from "$env/dynamic/public";
  import {
    ConverseComposer,
    ConverseThread,
    type ConversePostData,
  } from "$lib/components/converse";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import * as ToggleGroup from "$lib/components/ui/toggle-group";
  import {
    AlertCircle,
    Clock3,
    Flame,
    Loader2,
    MessagesSquare,
    PenLine,
    RefreshCw,
    Search,
    X,
  } from "@lucide/svelte";
  import { tStore as t } from "$lib/i18n";

  type SortMode = "new" | "hot";

  const apiBase = env.PUBLIC_API_BASE_URL?.replace(/\/$/, "") || "";

  let comments: ConversePostData[] = [];
  let nextUrl: string | null = null;
  let loading = false;
  let loadingMore = false;
  let errorMessage: string | null = null;
  let searchTerm = "";
  let appliedSearch = "";
  let sortMode: SortMode = "new";
  let composerOpen = false;
  let searchDebounce: ReturnType<typeof setTimeout> | null = null;
  let requestSeq = 0;
  const rootCache = new Map<string, Promise<ConversePostData>>();

  function buildFirstPageUrl(): string {
    const params = new URLSearchParams();
    params.set("ordering", sortMode === "new" ? "-created_at" : "-tuzis");
    if (appliedSearch) params.set("search", appliedSearch);
    return `/api/comments/?${params.toString()}`;
  }

  function asRelative(url: string): string {
    if (url.startsWith("/")) return url;
    try {
      const parsed = new URL(url);
      return `${parsed.pathname}${parsed.search}`;
    } catch {
      return url;
    }
  }

  async function fetchComment(uuid: string): Promise<ConversePostData> {
    const cached = rootCache.get(uuid);
    if (cached) return cached;

    const request = fetch(`${apiBase}/api/comments/${uuid}/`).then(
      async (response) => {
        if (!response.ok) throw new Error("Failed to load thread context");
        return response.json();
      },
    );
    rootCache.set(uuid, request);
    return request;
  }

  async function resolveRoot(
    post: ConversePostData,
  ): Promise<ConversePostData> {
    let current = post;
    const visited = new Set<string>();

    while (current.parent && !visited.has(current.uuid)) {
      visited.add(current.uuid);
      current = await fetchComment(current.parent);
    }

    rootCache.set(current.uuid, Promise.resolve(current));
    return current;
  }

  async function fetchPage(url: string, append: boolean) {
    const seq = ++requestSeq;
    if (append) {
      loadingMore = true;
    } else {
      loading = true;
      loadingMore = false;
      errorMessage = null;
    }

    try {
      const knownRoots = new Set(
        append ? comments.map((comment) => comment.uuid) : [],
      );
      const roots: ConversePostData[] = [];
      let cursor: string | null = url;
      let sourcePages = 0;

      while (cursor && roots.length < 10 && sourcePages < 3) {
        const res: Response = await fetch(`${apiBase}${asRelative(cursor)}`);
        if (!res.ok) {
          throw new Error(`Failed to load conversations (${res.status})`);
        }

        const data: {
          results?: ConversePostData[];
          next: string | null;
        } = await res.json();
        const resolved = await Promise.all(
          (data.results || []).map((post: ConversePostData) =>
            resolveRoot(post),
          ),
        );

        for (const root of resolved) {
          if (!knownRoots.has(root.uuid)) {
            knownRoots.add(root.uuid);
            roots.push(root);
          }
        }

        cursor = data.next;
        sourcePages += 1;
      }

      if (seq !== requestSeq) return;
      comments = append ? [...comments, ...roots] : roots;
      nextUrl = cursor;
    } catch (error) {
      if (seq !== requestSeq) return;
      console.error(error);
      errorMessage = $t(
        "converse.loadError",
        "Could not load conversations. Try refreshing.",
      );
    } finally {
      if (seq === requestSeq) {
        loading = false;
        loadingMore = false;
      }
    }
  }

  function reload() {
    fetchPage(buildFirstPageUrl(), false);
  }

  function setSort(mode: SortMode) {
    if (mode === sortMode) return;
    sortMode = mode;
    reload();
  }

  function onSearchInput() {
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      appliedSearch = searchTerm.trim();
      reload();
    }, 350);
  }

  function handlePosted() {
    composerOpen = false;
    reload();
  }

  function infiniteScroll(node: HTMLDivElement) {
    const scrollObserver = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && nextUrl && !loading && !loadingMore) {
          fetchPage(nextUrl, true);
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

  onMount(reload);

  onDestroy(() => {
    if (searchDebounce) clearTimeout(searchDebounce);
  });
</script>

<svelte:head>
  <title>Converse • Free2Z</title>
  <meta
    name="description"
    content="Join the conversation on Free2Z — comments, threads, and discussions from the whole community."
  />
</svelte:head>

<main class="flex-1 bg-background pb-20 text-foreground">
  <div class="container mx-auto max-w-4xl space-y-6 px-3 py-6 sm:px-4 sm:py-8">
    <header
      class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <div class="min-w-0">
        <div class="flex items-center gap-2.5">
          <MessagesSquare
            strokeWidth={1.5}
            class="size-6 shrink-0 text-primary"
          />
          <h1
            class="text-3xl leading-tight font-bold tracking-tight text-balance"
          >
            {$t("converse.title", "Converse")}
          </h1>
        </div>
        <p class="mt-1 max-w-xl text-sm text-pretty text-muted-foreground">
          {$t(
            "converse.subtitle",
            "Start a thread, follow the discussion, and keep every reply in context.",
          )}
        </p>
      </div>

      <Button
        class="w-full shrink-0 sm:w-auto"
        size="sm"
        variant={composerOpen ? "outline" : "default"}
        onclick={() => (composerOpen = !composerOpen)}
        aria-expanded={composerOpen}
        aria-controls="conversation-composer"
      >
        {#if composerOpen}
          <X strokeWidth={1.5} class="size-4" />
          {$t("converse.closeComposer", "Close")}
        {:else}
          <PenLine strokeWidth={1.5} class="size-4" />
          {$t("converse.startConversation", "Start a conversation")}
        {/if}
      </Button>
    </header>

    {#if composerOpen}
      <section id="conversation-composer" aria-label="Start a conversation">
        <ConverseComposer on:posted={handlePosted} />
      </section>
    {/if}

    <section
      aria-label={$t("converse.filters", "Conversation filters")}
      class="flex flex-col gap-3 sm:flex-row sm:items-center"
    >
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
          bind:value={searchTerm}
          oninput={onSearchInput}
        />
      </div>

      <ToggleGroup.Root
        type="single"
        value={sortMode}
        onValueChange={(value) => value && setSort(value as SortMode)}
        variant="outline"
        size="default"
        class="w-full shrink-0 overflow-hidden sm:w-auto"
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

    <section
      aria-label={$t("converse.communityFeed", "Community conversations")}
    >
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
      {:else if comments.length === 0}
        <div
          class="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card/40 px-6 py-10 text-center"
        >
          <div
            class="mb-3 flex size-11 items-center justify-center rounded-lg bg-primary/10 text-primary"
          >
            <MessagesSquare strokeWidth={1.5} class="size-5" />
          </div>
          <h2 class="text-sm font-semibold text-foreground">
            {$t("converse.emptyTitle", "No conversations found")}
          </h2>
          <p class="mt-1 max-w-sm text-sm text-pretty text-muted-foreground">
            {appliedSearch
              ? $t(
                  "converse.emptySearchBody",
                  "Try a different search or clear your query.",
                )
              : $t(
                  "converse.emptyBody",
                  "Start the first conversation and give the community something worth discussing.",
                )}
          </p>
          {#if !appliedSearch && !composerOpen}
            <Button
              class="mt-4"
              size="sm"
              onclick={() => (composerOpen = true)}
            >
              <PenLine strokeWidth={1.5} class="size-4" />
              {$t("converse.startConversation", "Start a conversation")}
            </Button>
          {/if}
        </div>
      {:else}
        <div class="space-y-4">
          {#each comments as comment (comment.uuid)}
            <ConverseThread post={comment} mode="feed" />
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
