<script lang="ts">
  import XIcon from "@lucide/svelte/icons/x";
  import { MediaQuery } from "svelte/reactivity";
  import * as Dialog from "$lib/components/ui/dialog";
  import * as Drawer from "$lib/components/ui/drawer";
  import { cn } from "$lib/utils";

  let {
    thumbnailUrl,
    fullSizeUrl,
    alt,
    triggerClass = "",
  }: {
    thumbnailUrl: string;
    fullSizeUrl: string;
    alt: string;
    triggerClass?: string;
  } = $props();

  let open = $state(false);
  const isDesktop = new MediaQuery("(min-width: 768px)");
</script>

{#snippet TriggerImage()}
  <img src={thumbnailUrl} {alt} class="h-full w-full object-cover" />
{/snippet}

{#snippet LightboxImage()}
  <img
    src={fullSizeUrl}
    {alt}
    loading="lazy"
    decoding="async"
    class="mx-auto size-76 max-h-full max-w-full object-contain md:size-84"
  />
{/snippet}

{#if isDesktop.current}
  <Dialog.Root bind:open>
    <Dialog.Trigger
      aria-label="View profile picture"
      class={cn(
        "block cursor-zoom-in overflow-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none",
        triggerClass,
      )}
    >
      {@render TriggerImage()}
    </Dialog.Trigger>
    <Dialog.Content
      class="aspect-square w-[min(26rem,calc(100vw-2rem))] max-w-none place-items-center p-8 sm:max-w-none"
    >
      <Dialog.Title class="sr-only">Profile picture for {alt}</Dialog.Title>
      {@render LightboxImage()}
    </Dialog.Content>
  </Dialog.Root>
{:else}
  <Drawer.Root bind:open>
    <Drawer.Trigger
      aria-label="View profile picture"
      class={cn(
        "block cursor-zoom-in overflow-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none",
        triggerClass,
      )}
    >
      {@render TriggerImage()}
    </Drawer.Trigger>
    <Drawer.Content class="max-h-[90dvh] p-2 pt-4 pb-4">
      <Drawer.Title class="sr-only">Profile picture for {alt}</Drawer.Title>
      {@render LightboxImage()}
      <Drawer.Close
        class="absolute top-2 right-2 rounded-md p-1.5 opacity-70 transition-opacity hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <XIcon class="size-4" />
        <span class="sr-only">Close</span>
      </Drawer.Close>
    </Drawer.Content>
  </Drawer.Root>
{/if}
