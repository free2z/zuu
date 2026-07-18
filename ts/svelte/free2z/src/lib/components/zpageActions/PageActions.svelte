<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { fly, scale } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { PlusIcon, XIcon } from '@lucide/svelte';
  import { Button } from '$lib/components/ui/button';
  import { tStore as t } from '$lib/i18n';

  import BoostButton from './BoostButton.svelte';
  import DonateZcashButton from './DonateZcashButton.svelte';
  import ShareButton from './ShareButton.svelte';

  export let article: any = null;

  let fabOpen = false;
  let dropdownOpen = false;
  let _outsideClickHandler: ((event: MouseEvent) => void) | null = null;
  let fabContainer: HTMLDivElement | null = null;

  function toggleFab(event?: MouseEvent) {
    if (event) event.stopPropagation();
    fabOpen = !fabOpen;
  }

  onMount(() => {
    _outsideClickHandler = (event: MouseEvent) => {
      if (!fabOpen) return;
      const target = event.target as Node | null;
      if (!target) return;

      // Don't close if clicking inside the FAB container
      if (fabContainer && fabContainer.contains(target)) return;

      // Small delay to check if a dropdown menu has opened
      requestAnimationFrame(() => {
        if (dropdownOpen) {
          return; // Don't close if a dropdown just opened
        }

        fabOpen = false;
      });
    };
    document.addEventListener('click', _outsideClickHandler);
  });

  onDestroy(() => {
    if (_outsideClickHandler) document.removeEventListener('click', _outsideClickHandler);
    _outsideClickHandler = null;
  });
</script>

<div
  class="fixed right-5 bottom-5 flex flex-col items-end gap-6 z-50"
  aria-hidden={false}
  bind:this={fabContainer}
>
  <div class="flex flex-col gap-6 mb-2 items-end">
    {#if fabOpen}
      {#if article?.free2zaddr}
        <div in:fly={{ y: 8, duration: 220, easing: cubicOut, delay: 30 }} out:fly={{ y: 6, duration: 160 }}>
          <div in:scale={{ start: 0.92, duration: 200, easing: cubicOut, delay: 30 }}>
            <BoostButton pageId={article.free2zaddr} score={Number(Number(article?.f2z_score).toFixed(2))} />
          </div>
        </div>
      {/if}
      <div in:fly={{ y: 6, duration: 200, easing: cubicOut, delay: 10 }} out:fly={{ y: 6, duration: 140 }}>
        <div in:scale={{ start: 0.92, duration: 180, easing: cubicOut, delay: 10 }}>
          <DonateZcashButton creator={article?.creator} />
        </div>
      </div>
      <div in:fly={{ y: 6, duration: 200, easing: cubicOut, delay: 10 }} out:fly={{ y: 6, duration: 140 }}>
        <div in:scale={{ start: 0.92, duration: 180, easing: cubicOut, delay: 10 }}>
          <ShareButton article={article} onOpen={() => dropdownOpen = true} onClose={() => dropdownOpen = false} />
        </div>
      </div>
    {/if}
  </div>

  <Button
    class="pointer-events-auto rounded-full flex items-center justify-center shadow-lg text-lg transition-transform active:scale-95"
    style="background:var(--f2z-accent-primary); color:var(--f2z-bg-primary);"
    aria-expanded={fabOpen}
    size="icon-lg"
    aria-label={fabOpen ? $t('pageActions.actions.close', 'Close actions') : $t('pageActions.actions.open', 'Open actions')}
    onclick={toggleFab}
  >
    {#if fabOpen}
      <XIcon class="w-4 h-4" />
    {:else}
      <PlusIcon class="w-4 h-4" />
    {/if}
  </Button>
</div>
