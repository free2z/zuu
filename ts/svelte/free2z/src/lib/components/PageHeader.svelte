<script>
  import { Button } from '$lib/components/ui/button';
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';

  export let title = '';
  export let titleSuffix = '';
  export let subtitle = '';
  export let showBackButton = true;
  export let onBack = () => history.back();
</script>

<div class="border-b border-border bg-card/30">
  <div class="container mx-auto px-4 pt-8 pb-8 md:pt-12 md:pb-12 max-w-7xl">
    <header class="flex flex-col md:flex-row justify-between items-start md:items-end gap-6">
      <div class="space-y-4">
        {#if showBackButton}
          <Button
            onclick={onBack}
            variant="outline"
            class="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors group mb-2"
            aria-label="Go back"
          >
            <ArrowLeft class="w-5 h-5 group-hover:-translate-x-1 transition-transform" />
            <span class="font-bold text-xs tracking-widest uppercase">Back</span>
          </Button>
        {/if}

        <h1 class="text-5xl md:text-7xl font-black tracking-tighter uppercase leading-[0.9]">
          {title}<span class="text-primary">{titleSuffix}</span>
        </h1>
      </div>
      <div class="max-w-md">
        <p class="text-lg md:text-xl font-medium text-muted-foreground leading-relaxed border-l-2 border-primary/50 pl-4">
          {subtitle}
        </p>
      </div>
    </header>
  </div>
</div>