<script lang="ts">
  import type { CommentData } from "./types";
  import CommentCard from "./CommentCard.svelte";
  import CommentChildren from "./CommentChildren.svelte";
  import { createMediaQuery } from "$lib/utils/media-query";
  import {
    Dialog,
    DialogContent,
    DialogTrigger,
    DialogHeader,
    DialogTitle,
    DialogDescription,
  } from "$lib/components/ui/dialog";
  import {
    Drawer,
    DrawerContent,
    DrawerTrigger,
    DrawerHeader,
    DrawerTitle,
    DrawerDescription,
  } from "$lib/components/ui/drawer";
  import { Maximize2 } from "@lucide/svelte";
  import { tStore as t } from "$lib/i18n";

  export let comment: CommentData;
  export let object_type: "zpage" | "ai_conversation" | undefined = undefined;
  export let object_uuid: string | undefined = undefined;

  let open = false;
  let reload = 0;
  const isDesktop = createMediaQuery("(min-width: 768px)");

  // A reply posted to the top comment from inside the dialog should refetch the thread.
  function handleReload() {
    reload++;
  }

  // A quiet icon button tucked into the top corner of the comment panel.
  const triggerClass =
    "absolute right-3 top-3 inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-transparent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 dark:hover:bg-transparent sm:right-4 sm:top-4";
  const triggerLabel = $t("comments.expandThread", "Expand thread");
</script>

{#snippet triggerInner()}
  <Maximize2 strokeWidth={1.5} class="size-4" />
  <span class="sr-only">{triggerLabel}</span>
{/snippet}

{#snippet thread()}
  <CommentCard {comment} {object_type} {object_uuid} on:reload={handleReload} />
  <div class="mt-4 border-t border-dashed border-border/60 pt-4">
    <CommentChildren {comment} {object_type} {object_uuid} {reload} expandAll />
  </div>
{/snippet}

{#if $isDesktop}
  <Dialog bind:open>
    <DialogTrigger class={triggerClass}>
      {@render triggerInner()}
    </DialogTrigger>
    <DialogContent
      class="flex max-h-[85vh] flex-col gap-0 overflow-hidden bg-card p-0 sm:max-w-2xl"
    >
      <DialogHeader
        class="shrink-0 border-b border-dashed border-border/60 px-5 py-3 text-left"
      >
        <DialogTitle class="text-sm font-semibold tracking-tight">
          {$t("comments.threadTitle", "Thread")}
        </DialogTitle>
        <DialogDescription class="sr-only">
          {$t("comments.threadDescription", "All replies to this comment.")}
        </DialogDescription>
      </DialogHeader>
      <div class="min-h-0 flex-1 overflow-y-auto p-5">
        {@render thread()}
      </div>
    </DialogContent>
  </Dialog>
{:else}
  <Drawer bind:open>
    <DrawerTrigger class={triggerClass}>
      {@render triggerInner()}
    </DrawerTrigger>
    <DrawerContent class="max-h-[90vh] bg-card">
      <DrawerHeader
        class="shrink-0 border-b border-dashed border-border/60 text-left"
      >
        <DrawerTitle class="text-sm font-semibold tracking-tight">
          {$t("comments.threadTitle", "Thread")}
        </DrawerTitle>
        <DrawerDescription class="sr-only">
          {$t("comments.threadDescription", "All replies to this comment.")}
        </DrawerDescription>
      </DrawerHeader>
      <div class="min-h-0 flex-1 overflow-y-auto px-4 pt-4 pb-6">
        {@render thread()}
      </div>
    </DrawerContent>
  </Drawer>
{/if}
