<script lang="ts">
  import type { CommentData } from "./types";
  import CommentCard from "./CommentCard.svelte";
  import CommentChildren from "./CommentChildren.svelte";
  import CommentThreadDialog from "./CommentThreadDialog.svelte";

  export let comment: CommentData;
  export let object_type: "zpage" | "ai_conversation" | undefined = undefined;
  export let object_uuid: string | undefined = undefined;
  export let top: boolean = false;
  // Render the whole subtree inline with no truncation (used inside the dialog).
  export let expandAll: boolean = false;

  let reload = Number(comment.num_children) || 0;

  function handleReload() {
    reload++;
  }

  // Top-level comments with a reply thread get a corner "expand" affordance
  // that opens the full thread in a focused dialog/drawer.
  $: childCount = Number(comment.num_children) || 0;
  $: hasThread = top && childCount > 0;
</script>

{#if top}
  <!-- Top-level comment: a single raised panel. Replies inside it stay cardless
         (a thread rail divides them) so the panel never nests cards within cards. -->
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
    {#if hasThread}
      <!-- Corner affordance: open the whole thread in a focused dialog/drawer. -->
      <CommentThreadDialog {comment} {object_type} {object_uuid} />
    {/if}
  </article>
{:else}
  <!-- Reply: flat, lives inside the parent's thread rail. -->
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
