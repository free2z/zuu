<script lang="ts">
  import { env } from "$env/dynamic/public";
  import type { CommentData } from "./types";
  import DisplayThreadedComment from "./DisplayThreadedComment.svelte";
  import { ChevronDown } from "@lucide/svelte";
  import { tStore as t } from "$lib/i18n";

  export let comment: CommentData;
  export let object_type: "zpage" | "ai_conversation" | undefined = undefined;
  export let object_uuid: string | undefined = undefined;
  export let reload: number = 0;
  export let expandAll: boolean = false;

  const VISIBLE_REPLIES = 3;
  const apiBase = env.PUBLIC_API_BASE_URL?.replace(/\/$/, "") || "";

  let children: CommentData[] = [];
  let showAll = false;
  let fetchRevision = 0;

  $: visibleChildren =
    expandAll || showAll ? children : children.slice(0, VISIBLE_REPLIES);

  async function fetchChildren(
    url: string,
    visitedUrls: Set<string>,
    revision: number,
  ) {
    try {
      const fullUrl = url.startsWith("http") ? url : `${apiBase}${url}`;

      if (visitedUrls.has(fullUrl)) {
        console.warn("Circular pagination detected while loading replies");
        return;
      }
      visitedUrls.add(fullUrl);

      const res = await fetch(fullUrl);
      if (!res.ok) throw new Error("Failed to fetch replies");

      const data = await res.json();
      if (revision !== fetchRevision) return;

      children = [...children, ...(data.results || [])];

      if (data.next) {
        await fetchChildren(data.next, visitedUrls, revision);
      }
    } catch (error) {
      if (revision === fetchRevision) console.error(error);
    }
  }

  $: {
    const _ = { reload, comment };
    children = [];
    const revision = ++fetchRevision;
    const knownChildCount = Number(comment.num_children) || 0;

    if (knownChildCount > 0 || reload > 0) {
      fetchChildren(
        `/api/comments/${comment.uuid}/replies/`,
        new Set<string>(),
        revision,
      );
    }
  }
</script>

{#if children.length > 0}
  <div
    class="mt-4 ml-4 space-y-6 border-l border-border pl-5 transition-colors duration-200 group-hover/panel:border-foreground/25 motion-reduce:transition-none sm:ml-5 sm:pl-6"
  >
    {#each visibleChildren as child (child.uuid)}
      <DisplayThreadedComment
        comment={child}
        {object_type}
        {object_uuid}
        {expandAll}
      />
    {/each}
  </div>

  {#if !expandAll && children.length > VISIBLE_REPLIES}
    <button
      type="button"
      onclick={() => (showAll = !showAll)}
      class="mt-4 ml-4 inline-flex cursor-pointer items-center gap-1.5 rounded pl-5 text-xs font-medium text-muted-foreground transition-colors hover:text-primary focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none motion-reduce:transition-none sm:ml-5 sm:pl-6"
      aria-expanded={showAll}
    >
      <ChevronDown
        class="size-3.5 transition-transform duration-200 motion-reduce:transition-none {showAll
          ? 'rotate-180'
          : ''}"
      />
      {showAll
        ? $t("comments.showFewer", "Show fewer replies")
        : $t("comments.showMore", "Show {count} more replies").replace(
            "{count}",
            String(children.length - VISIBLE_REPLIES),
          )}
    </button>
  {/if}
{/if}
