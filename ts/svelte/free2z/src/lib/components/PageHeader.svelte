<script>
  import { Button } from "$lib/components/ui/button";
  import ArrowLeft from "@lucide/svelte/icons/arrow-left";
  import { tStore as t } from "$lib/i18n";

  export let title = "";
  export let titleSuffix = "";
  export let subtitle = "";
  export let showBackButton = true;
  export let onBack = () => history.back();
</script>

<div class="border-b border-border bg-card/30">
  <div class="container mx-auto max-w-7xl px-4 pt-8 pb-8 md:pt-12 md:pb-12">
    <header
      class="flex flex-col items-start justify-between gap-6 md:flex-row md:items-end"
    >
      <div class="space-y-4">
        {#if showBackButton}
          <Button
            onclick={onBack}
            variant="outline"
            class="group mb-2 flex items-center gap-2 text-muted-foreground transition-colors hover:text-foreground"
            aria-label={$t("navigation.goBack", "Go back")}
          >
            <ArrowLeft
              class="h-5 w-5 transition-transform group-hover:-translate-x-1"
            />
            <span class="text-xs font-bold tracking-widest uppercase"
              >{$t("auth.back", "Back")}</span
            >
          </Button>
        {/if}

        <h1
          class="text-5xl leading-[0.9] font-black tracking-tighter uppercase md:text-7xl"
        >
          {title}<span class="text-primary">{titleSuffix}</span>
        </h1>
      </div>
      <div class="max-w-md">
        <p
          class="border-l-2 border-primary/50 pl-4 text-lg leading-relaxed font-medium text-muted-foreground md:text-xl"
        >
          {subtitle}
        </p>
      </div>
    </header>
  </div>
</div>
