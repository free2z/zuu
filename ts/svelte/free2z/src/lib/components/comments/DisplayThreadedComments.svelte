<script lang="ts">
  import { page } from "$app/state";
  import * as env from "$app/env/public";
  import DisplayThreadedComment from "./DisplayThreadedComment.svelte";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import { MessagesSquare } from "@lucide/svelte";
  import { tStore as t } from "$lib/i18n";
  import type { CommentData } from "./types";
  import { CANONICAL_CONTENT_URL_HEADERS } from "$lib/api/canonical-content-url";

  export let object_type: "zpage" | "ai_conversation" | undefined = undefined;
  export let object_uuid: string | undefined = undefined;
  export let parent: string | undefined = undefined;
  export let reload: number = 0;

  let comments: CommentData[] = [];
  let loading = true;
  let fetchRevision = 0;
  // Total reported by the paginator on the first page. The badge uses this so
  // it shows the real total immediately instead of ticking upward as pages
  // stream in — and so a mid-walk failure cannot silently under-report.
  let totalCount: number | null = null;
  const apiBase = env.PUBLIC_API_BASE_URL?.replace(/\/$/, "") || "";

  $: hasCommentTarget = page.url.hash.startsWith("#comment-");
  $: displayCount = totalCount ?? comments.length;

  async function fetchComments(
    url: string,
    visitedUrls: Set<string>,
    revision: number,
    filterComment: (comment: CommentData) => boolean = () => true,
  ) {
    try {
      // If url is relative, prepend apiBase
      const fullUrl = url.startsWith("http") ? url : `${apiBase}${url}`;

      if (visitedUrls.has(fullUrl)) {
        console.warn("Circular pagination detected, stopping fetch");
        return;
      }
      visitedUrls.add(fullUrl);

      const res = await fetch(fullUrl, {
        headers: CANONICAL_CONTENT_URL_HEADERS,
      });
      if (!res.ok) throw new Error("Failed to fetch comments");

      const data = await res.json();
      if (revision !== fetchRevision) return;

      if (totalCount === null && typeof data.count === "number") {
        totalCount = data.count;
      }

      const results = Array.isArray(data.results)
        ? data.results.filter(filterComment)
        : [];

      comments = [...comments, ...results];

      if (data.next) {
        await fetchComments(data.next, visitedUrls, revision, filterComment);
      }
    } catch (error) {
      if (revision === fetchRevision) {
        console.error(error);
      }
    } finally {
      if (revision === fetchRevision) {
        loading = false;
      }
    }
  }

  $: {
    // Trigger reactive statement when these props change
    const _ = { reload, parent, object_type, object_uuid };

    comments = [];
    totalCount = null;
    loading = true;
    const revision = ++fetchRevision;
    let visitedUrls = new Set<string>();
    let url = "";
    let filterComment: ((comment: CommentData) => boolean) | undefined;
    if (object_type && object_uuid) {
      // `parent__isnull=True` MUST stay on the URL. Filtering top-level
      // comments client-side instead means draining every page of the whole
      // thread (PAGE_SIZE=12, and the pagination walk below is sequential) just
      // to render the handful of root cards: a 600-comment zpage becomes 50
      // serial round-trips. The server-side filter lives in
      // py/dj/apps/comments/views.py (AuthorParentCommentFilter).
      url = `/api/comments/${object_type}/${object_uuid}/?parent__isnull=True`;
      // Belt and braces: if the query param is ever dropped or ignored, we
      // still render a root-comment list rather than a flattened thread.
      filterComment = (comment) => !comment.parent;
    } else if (parent) {
      url = `/api/comments/${parent}/replies/`;
    }

    if (url) {
      fetchComments(url, visitedUrls, revision, filterComment);
    } else {
      loading = false;
    }
  }
</script>

<section aria-label={$t("comments.discussion", "Discussion")}>
  <!-- Thread header: a label, a live count, and a dashed hairline rule. -->
  <header
    class="mb-5 flex items-center gap-2 border-b border-dashed border-border/60 pb-3"
  >
    <h3 class="text-sm font-semibold tracking-tight text-foreground">
      {$t("comments.discussion", "Discussion")}
    </h3>
    {#if displayCount > 0}
      <span
        class="rounded-md border border-primary/20 bg-primary/10 px-1.5 py-0.5 text-[11px] leading-none font-bold text-primary tabular-nums"
      >
        {displayCount}
      </span>
    {/if}
  </header>

  {#if loading && comments.length === 0}
    <!-- Loading: skeleton comments rather than a bare spinner. -->
    <div
      class="space-y-4"
      aria-busy="true"
      aria-label={$t("comments.loading", "Loading comments")}
    >
      {#each Array(2) as _, i (i)}
        <div class="rounded-xl border border-border/70 bg-card p-4 sm:p-5">
          <div class="flex gap-3">
            <Skeleton class="size-9 shrink-0 rounded-full sm:size-10" />
            <div class="min-w-0 flex-1 space-y-2.5">
              <div class="flex items-center gap-2">
                <Skeleton class="h-3.5 w-28" />
                <Skeleton class="h-3 w-16" />
              </div>
              <Skeleton class="h-3 w-full" />
              <Skeleton class="h-3 w-4/5" />
              <Skeleton class="mt-1 h-8 w-24 rounded-lg" />
            </div>
          </div>
        </div>
      {/each}
    </div>
  {:else if comments.length > 0}
    <div class="space-y-4">
      {#each comments as comment (comment.uuid)}
        <DisplayThreadedComment
          {comment}
          {object_type}
          {object_uuid}
          top={true}
          expandAll={hasCommentTarget}
        />
      {/each}
    </div>
  {:else}
    <!-- Empty: welcoming, on-brand prompt to back the first take with 2Zs. -->
    <div
      class="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card/40 px-6 py-10 text-center"
    >
      <div
        class="mb-3 flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary"
      >
        <MessagesSquare strokeWidth={1.5} class="size-5" />
      </div>
      <p class="text-sm font-medium text-foreground">
        {$t("comments.emptyTitle", "No comments yet")}
      </p>
      <p class="mt-1 max-w-xs text-sm text-muted-foreground">
        {$t(
          "comments.emptyBody",
          "Be the first to weigh in — back your take with 2Zs.",
        )}
      </p>
    </div>
  {/if}
</section>
