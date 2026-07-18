<script lang="ts">
  import type { CommentData } from "./types";
  import CommentCard from "./CommentCard.svelte";
  import CommentChildren from "./CommentChildren.svelte";

  export let comment: CommentData;
  export let object_type: "zpage" | "ai_conversation" | undefined = undefined;
  export let object_uuid: string | undefined = undefined;
  export let top: boolean = false;
  export let expandAll: boolean = false;

  let reload = Number(comment.num_children) || 0;

  function handleReload() {
    reload++;
  }
</script>

{#if top}
  <article
    class="group/panel relative rounded-xl border border-border/70 bg-card p-4 transition-colors duration-200 hover:border-primary/30 motion-reduce:transition-none sm:p-5"
  >
    <CommentCard
      {comment}
      {object_type}
      {object_uuid}
      {top}
      on:reload={handleReload}
    />
    <CommentChildren
      {reload}
      {comment}
      {object_type}
      {object_uuid}
      {expandAll}
    />
  </article>
{:else}
  <div>
    <CommentCard
      {comment}
      {object_type}
      {object_uuid}
      {top}
      on:reload={handleReload}
    />
    <CommentChildren
      {reload}
      {comment}
      {object_type}
      {object_uuid}
      {expandAll}
    />
  </div>
{/if}
