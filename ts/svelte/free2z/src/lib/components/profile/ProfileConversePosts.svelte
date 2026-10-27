<script lang="ts">
  /**
   * The per-creator Converse surface: one creator's standalone posts,
   * newest first, with stable cursor load-more.
   *
   * Until now "a user's converse posts" was RSS-only
   * (`/feeds/{username}/converse/recent.xml`). This is the same query the
   * profile tab now sends the API directly: `author=<name>` plus
   * `parent__isnull=true&content_type__isnull=true&pagination=cursor`. All
   * three filters only ever NARROW the endpoint's already-scoped queryset --
   * a deactivated author's posts stay off this list exactly as they stay off
   * `/converse`.
   *
   * Loaded on mount, and the CALLER is responsible for making that lazy.
   * `Tabs.Content` is NOT lazy: bits-ui renders every panel and marks the
   * inactive ones `hidden`, so a bare `<ProfileConversePosts />` inside a
   * closed tab still mounts and still fires its request on every profile
   * view. `[username]/+page.svelte` wraps it in an `{#if...Opened}` that
   * latches on first open -- lazy on mount, but not torn down and refetched
   * every time the visitor tabs away and back.
   */
  import { onDestroy, onMount } from "svelte";
  import { AlertCircle, Loader2, MessagesSquare } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button";
  import {
    ConversePost,
    type ConversePostData,
  } from "$lib/components/converse";
  import { commentsList } from "$lib/api/comments/comments";
  import { CANONICAL_CONTENT_URL_HEADERS } from "$lib/api/canonical-content-url";
  import {
    converseListParams,
    cursorFromNextUrl,
    DEFAULT_CONVERSE_FILTERS,
  } from "$lib/converse/feed-filters";
  import { tStore as t } from "$lib/i18n";

  export let username: string;
  export let displayName: string = username;

  // Same page size as the stream, so a profile scroll and a /converse scroll
  // feel identical.
  const PAGE_SIZE = 12;

  let posts: ConversePostData[] = [];
  // The opaque `cursor` value from the envelope's `next`; null once the end
  // of this creator's posts has been reached (or before page one loads).
  let cursor: string | null = null;
  let loading = false;
  let loaded = false;
  let failed = false;
  let requestSeq = 0;

  // SvelteKit reuses a route component across parameter-only navigations
  // (`/alice` -> `/bob`); if this component survives that, Alice's posts and
  // Alice's continuation cursor must not render under Bob's header.
  let keyedTo: string | null = null;
  $: if (username !== keyedTo) {
    keyedTo = username;
    // Orphan whatever is in flight for the PREVIOUS creator BEFORE starting
    // this one. Bumping the sequence alone is not enough: `load()` refuses to
    // start while `loading` is true, so navigating mid-request would skip
    // Bob's fetch entirely and then let Alice's response -- still the current
    // sequence -- install Alice's posts and Alice's continuation cursor under
    // Bob's header. Clearing `loading` here is what makes the reset able to
    // preempt; the stale response's own `seq !== requestSeq` guard then drops
    // it on arrival, including its `finally`, so it cannot un-set the new
    // request's loading flag either.
    requestSeq += 1;
    loading = false;
    posts = [];
    cursor = null;
    loaded = false;
    failed = false;
    if (mounted) void load(true);
  }

  let mounted = false;

  async function load(reset: boolean) {
    if (loading) return;
    const seq = ++requestSeq;
    loading = true;
    failed = false;
    try {
      const data = await commentsList(
        {
          // The default filter state is the cursored, newest-first stream;
          // the two extra parameters are what make it THIS creator's posts.
          ...converseListParams(
            { ...DEFAULT_CONVERSE_FILTERS, posts: true },
            reset ? null : cursor,
            { authenticated: false },
          ),
          author: username,
          page_size: PAGE_SIZE,
        },
        { headers: CANONICAL_CONTENT_URL_HEADERS },
      );
      if (seq !== requestSeq) return;
      const results = (data.results || []) as ConversePostData[];
      // Keyset boundaries cannot repeat rows; this only guards a double
      // activation of the load-more button racing its own response.
      const known = new Set(reset ? [] : posts.map((post) => post.uuid));
      const fresh = results.filter((post) => {
        if (known.has(post.uuid)) return false;
        known.add(post.uuid);
        return true;
      });
      posts = reset ? fresh : [...posts, ...fresh];
      cursor = cursorFromNextUrl(data.next);
      loaded = true;
    } catch (error) {
      if (seq !== requestSeq) return;
      console.error(error);
      // Keep already-loaded cards; only a failed FIRST page is an error
      // state, because those cards ARE results of this query.
      if (!loaded) failed = true;
    } finally {
      if (seq === requestSeq) loading = false;
    }
  }

  onMount(() => {
    mounted = true;
    if (!loaded) void load(true);
  });

  onDestroy(() => {
    // Orphan any in-flight response so it cannot write into a component
    // that is no longer on screen.
    requestSeq += 1;
  });
</script>

<div class="space-y-4" data-testid="profile-posts-feed">
  {#if failed && posts.length === 0}
    <div
      class="flex flex-col items-center justify-center space-y-3 rounded-xl border-2 border-dashed py-16 text-center"
      role="alert"
    >
      <AlertCircle class="size-10 text-muted-foreground/20" />
      <p class="text-sm text-muted-foreground">
        {$t("profile.postsLoadError", "Could not load posts.")}
      </p>
      <Button variant="outline" size="sm" onclick={() => void load(true)}>
        {$t("profile.postsRetry", "Try again")}
      </Button>
    </div>
  {:else if loading && posts.length === 0}
    <div
      class="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"
      aria-busy="true"
      aria-live="polite"
    >
      <Loader2 class="size-4 animate-spin motion-reduce:animate-none" />
      {$t("profile.postsLoading", "Loading posts")}
    </div>
  {:else if loaded && posts.length === 0}
    <div
      class="flex flex-col items-center justify-center space-y-2 rounded-xl border-2 border-dashed py-16 text-center"
    >
      <MessagesSquare class="size-10 text-muted-foreground/20" />
      <p class="text-sm text-muted-foreground">
        {$t("profile.postsEmpty", "{name} hasn't posted to Converse yet.", {
          name: displayName,
        })}
      </p>
    </div>
  {:else}
    {#each posts as post (post.uuid)}
      <article
        class="relative min-w-0 rounded-2xl border border-border/70 bg-card p-4 transition-[border-color,box-shadow] duration-200 hover:border-primary/25 hover:shadow-sm motion-reduce:transition-none sm:p-5"
      >
        <!-- `rootUuid` is the post's own uuid: these are standalone posts,
             and the detail loader walks the parent chain server-side. -->
        <ConversePost
          {post}
          rootUuid={post.uuid}
          root={true}
          showOpenThread={true}
        />
      </article>
    {/each}

    {#if loading}
      <div
        class="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground"
        aria-live="polite"
      >
        <Loader2 class="size-4 animate-spin motion-reduce:animate-none" />
        {$t("profile.postsLoading", "Loading posts")}
      </div>
    {:else if cursor}
      <div class="flex justify-center py-2">
        <Button
          variant="outline"
          size="sm"
          data-testid="profile-posts-load-more"
          onclick={() => void load(false)}
        >
          {$t("profile.postsLoadMore", "Load more posts")}
        </Button>
      </div>
    {/if}
  {/if}
</div>
