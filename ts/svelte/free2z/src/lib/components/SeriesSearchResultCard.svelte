<script lang="ts">
  import { ArrowUpRight, Layers3 } from "@lucide/svelte";
  import type { PublicSeries } from "$lib/types/search";
  import { zpageCanonicalPath } from "$lib/zpage-path";

  export let series: PublicSeries;

  $: orderedPages = [...(series?.pageorder_set || [])].sort(
    (a, b) => a.order - b.order,
  );
  $: firstPage = orderedPages[0]?.page;
  $: creatorName = firstPage?.creator?.username || "";
  $: href =
    zpageCanonicalPath(firstPage || {}) ||
    firstPage?.get_url?.replace("/zpage/", "/") ||
    "/";
</script>

<a
  {href}
  aria-label="Open series {series?.name || 'Untitled series'}"
  class="group flex min-w-0 items-center gap-4 rounded-xl border border-(--f2z-border-primary) bg-(--f2z-bg-secondary) p-4 transition-[border-color,background-color,transform,box-shadow] hover:-translate-y-0.5 hover:border-(--f2z-accent-primary)/60 hover:shadow-lg hover:shadow-black/5 focus-visible:border-(--f2z-accent-primary) focus-visible:ring-3 focus-visible:ring-(--f2z-accent-primary)/15 focus-visible:outline-none dark:hover:bg-(--f2z-bg-tertiary)/55 dark:hover:shadow-black/20"
>
  <span
    class="grid size-12 shrink-0 place-items-center rounded-xl border border-(--f2z-accent-primary)/20 bg-(--f2z-accent-primary)/8 text-(--f2z-accent-primary)"
  >
    <Layers3 class="size-5" />
  </span>

  <div class="min-w-0 flex-1">
    <h3
      class="truncate font-semibold text-(--f2z-text-primary) transition-colors group-hover:text-(--f2z-accent-primary)"
    >
      {series?.name || "Untitled series"}
    </h3>
    <p class="mt-1 truncate text-xs text-(--f2z-text-muted)">
      {orderedPages.length}
      {orderedPages.length === 1 ? "page" : "pages"}{creatorName
        ? ` · by @${creatorName}`
        : ""}
    </p>
  </div>

  <span
    class="grid size-8 shrink-0 place-items-center rounded-full border border-(--f2z-border-primary) text-(--f2z-text-muted) transition-all group-hover:border-(--f2z-accent-primary) group-hover:bg-(--f2z-accent-primary) group-hover:text-primary-foreground"
  >
    <ArrowUpRight class="size-4" />
  </span>
</a>
