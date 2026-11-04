<script lang="ts">
  import { MessageSquareText } from "@lucide/svelte";
  import {
    formatLocalizedNumber,
    isSingularCount,
    locale,
    tStore as t,
  } from "$lib/i18n";
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
    post = {
      ...post,
      num_children: String(Number(post.num_children) + 1),
    };
  }
</script>

<article
  class={detail
    ? "relative rounded-2xl border border-border/70 bg-card p-4 shadow-sm sm:p-6"
    : "relative rounded-2xl border border-border/70 bg-card p-4 transition-[border-color,box-shadow] duration-200 hover:border-primary/25 hover:shadow-sm motion-reduce:transition-none sm:p-5"}
>
  <ConversePost
    {post}
    rootUuid={post.uuid}
    root={true}
    showOpenThread={!detail}
    focused={focusUuid === post.uuid}
    on:replyPosted={handleReplyPosted}
  />

  {#if replyCount > 0}
    <section class="mt-5 pt-1" aria-label={$t("converse.replies", "Replies")}>
      <!-- The count is the whole heading. "DISCUSSION" above "3 replies" was
           a category label for a thing already named by its contents, in the
           register the microblog is explicitly not written in. -->
      <div
        class="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums"
      >
        <MessageSquareText strokeWidth={1.5} class="size-3.5" />
        {#if isSingularCount(replyCount, $locale)}
          {$t("converse.replyCountOne", "{count} reply", {
            count: formatLocalizedNumber(replyCount, $locale),
          })}
        {:else}
          {$t("converse.replyCountOther", "{count} replies", {
            count: formatLocalizedNumber(replyCount, $locale),
          })}
        {/if}
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
