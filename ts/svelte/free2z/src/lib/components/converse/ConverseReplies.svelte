<script lang="ts">
  import { env } from "$env/dynamic/public";
  import { browser } from "$app/environment";
  import { Button } from "$lib/components/ui/button";
  import { AlertCircle, ChevronRight, Loader2 } from "@lucide/svelte";
  import { tStore as t } from "$lib/i18n";
  import ConversePost from "./ConversePost.svelte";
  import type { ConversePostData } from "./types";

  export let parent: ConversePostData;
  export let rootUuid: string;
  export let reload = 0;
  export let preview = false;
  export let depth = 1;
  export let focusUuid: string | undefined = undefined;

  const apiBase = env.PUBLIC_API_BASE_URL?.replace(/\/$/, "") || "";
  const PREVIEW_LIMIT = 2;

  let posts: ConversePostData[] = [];
  let loading = false;
  let failed = false;
  let requestRevision = 0;

  $: visiblePosts = preview ? posts.slice(0, PREVIEW_LIMIT) : posts;

  function asRelative(url: string) {
    if (url.startsWith("/")) return url;
    try {
      const parsed = new URL(url);
      return `${parsed.pathname}${parsed.search}`;
    } catch {
      return url;
    }
  }

  async function loadReplies() {
    if (!browser) return;
    const revision = ++requestRevision;
    posts = [];
    failed = false;

    if (!Number(parent.num_children)) return;
    loading = true;

    try {
      let next: string | null = `/api/comments/${parent.uuid}/replies/`;
      const loaded: ConversePostData[] = [];
      const visited = new Set<string>();

      while (next) {
        const relative = asRelative(next);
        if (visited.has(relative)) break;
        visited.add(relative);

        const response = await fetch(`${apiBase}${relative}`);
        if (!response.ok) throw new Error("Failed to load replies");
        const data = await response.json();
        loaded.push(...(data.results || []));
        next = data.next;
      }

      if (revision === requestRevision) posts = loaded;
    } catch (error) {
      console.error(error);
      if (revision === requestRevision) failed = true;
    } finally {
      if (revision === requestRevision) loading = false;
    }
  }

  function handleReplyPosted() {
    reload += 1;
  }

  $: {
    const _ = { id: parent.uuid, reload };
    loadReplies();
  }
</script>

{#if loading && posts.length === 0}
  <div class="flex items-center gap-2 py-4 text-sm text-muted-foreground">
    <Loader2 class="size-4 animate-spin motion-reduce:animate-none" />
    {$t("converse.loadingReplies", "Loading replies…")}
  </div>
{:else if failed}
  <button
    type="button"
    class="flex items-center gap-2 py-3 text-sm text-destructive hover:underline"
    onclick={loadReplies}
  >
    <AlertCircle class="size-4" />
    {$t("converse.retryReplies", "Could not load replies. Try again.")}
  </button>
{:else if posts.length > 0}
  <div
    class={depth > 3
      ? "mt-4 space-y-5"
      : "mt-4 space-y-5 border-l border-border/70 pl-4 sm:pl-5"}
  >
    {#each visiblePosts as reply (reply.uuid)}
      <div>
        <ConversePost
          post={reply}
          {rootUuid}
          focused={focusUuid === reply.uuid}
          on:replyPosted={handleReplyPosted}
        />
        {#if !preview && Number(reply.num_children) > 0}
          <svelte:self
            parent={reply}
            {rootUuid}
            {reload}
            {focusUuid}
            depth={depth + 1}
            on:replyPosted={handleReplyPosted}
          />
        {/if}
      </div>
    {/each}

    {#if preview && Number(parent.num_children) > visiblePosts.length}
      <Button
        href={`/converse/${rootUuid}`}
        variant="ghost"
        size="sm"
        class="h-8 bg-transparent text-muted-foreground hover:bg-transparent hover:text-primary dark:hover:bg-transparent"
      >
        {$t("converse.moreReplies", "View all {count} replies").replace(
          "{count}",
          String(parent.num_children),
        )}
        <ChevronRight strokeWidth={1.5} class="size-4" />
      </Button>
    {/if}
  </div>
{/if}
