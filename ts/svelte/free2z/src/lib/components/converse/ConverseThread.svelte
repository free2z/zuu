<script lang="ts">
  import { MessageSquareText } from "@lucide/svelte";
  import { tStore as t } from "$lib/i18n";
  import ConversePost from "./ConversePost.svelte";
  import ConverseReplies from "./ConverseReplies.svelte";
  import type { ConversePostData } from "./types";

  export let post: ConversePostData;
  export let mode: "feed" | "detail" = "feed";
  export let focusUuid: string | undefined = undefined;

  let reload = 0;
  $: replyCount = Number(post.num_children) || 0;
  $: detail = mode === "detail";

  function handleReplyPosted() {
    reload += 1;
    post = { ...post, num_children: Number(post.num_children) + 1 };
  }
</script>

<article
  class={detail
    ? "rounded-2xl border border-border/70 bg-card p-4 shadow-sm sm:p-6"
    : "rounded-2xl border border-border/70 bg-card p-4 transition-[border-color,box-shadow] duration-200 hover:border-primary/25 hover:shadow-sm motion-reduce:transition-none sm:p-5"}
>
  <ConversePost
    {post}
    rootUuid={post.uuid}
    root={true}
    {detail}
    showOpenThread={!detail}
    focused={focusUuid === post.uuid}
    on:replyPosted={handleReplyPosted}
  />

  {#if replyCount > 0}
    <section class="mt-5 pt-1" aria-label="Replies">
      <div class="mb-2 flex items-center gap-3">
        <div
          class="flex items-center gap-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
        >
          <MessageSquareText strokeWidth={1.5} class="size-4" />
          {$t("converse.discussion", "Discussion")}
          <span class="rounded-full bg-muted px-1.5 py-0.5 tabular-nums"
            >{replyCount}</span
          >
        </div>
      </div>

      <ConverseReplies
        parent={post}
        rootUuid={post.uuid}
        {reload}
        {focusUuid}
        preview={!detail}
        on:replyPosted={handleReplyPosted}
      />
    </section>
  {/if}
</article>
