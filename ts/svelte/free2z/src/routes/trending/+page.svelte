<script lang="ts">
  import { tStore as t } from "$lib/i18n";
  import PageHeader from "$lib/components/PageHeader.svelte";
  import SeoHead from "$lib/components/SeoHead.svelte";
  import ZpageCard from "$lib/components/ZpageCard.svelte";
  import { Button } from "$lib/components/ui/button";
  import {
    DEFAULT_TRENDING_SORT,
    TRENDING_PAGE_SIZE,
    totalPages,
    trendingHref,
  } from "$lib/trending.js";

  export let data;

  $: pages = totalPages(data.count, TRENDING_PAGE_SIZE);
  // A degraded (upstream-failed) render is served as HTTP 200, so it must never
  // be the version a crawler indexes for /trending.
  $: isCanonicalView =
    data.page === 1 && data.sort === DEFAULT_TRENDING_SORT && !data.failed;
  $: sortLabel =
    data.sort === "popular"
      ? $t("trending.sortPopular", "Popular")
      : $t("trending.sortUpdated", "Recently updated");
</script>

<!--
  Only the canonical entry point (/trending, default sort, page 1) is indexable.
  The deeper pages and the alternate sort are re-orderings of zpage URLs the
  sitemap already lists individually — `follow` keeps them crawlable so those
  pages still get discovered, `noindex` keeps ~550 near-duplicate list pages out
  of the index.
-->
<SeoHead
  title="Trending on Free2Z"
  description="The stories, articles, and updates capturing the attention of the Free2Z community right now."
  path={trendingHref({ sort: data.sort, page: data.page })}
  imageAlt="Trending pages on Free2Z"
  robots={isCanonicalView ? undefined : "noindex, follow"}
/>

<PageHeader
  title="Trending"
  titleSuffix="."
  subtitle={$t(
    "trending.subtitle",
    "The stories, articles, and updates capturing the attention of the Free2Z community right now.",
  )}
/>

<main class="container mx-auto max-w-7xl px-4 py-10">
  <!-- Sort switcher. Plain links, so this works without JS and each view is
       linkable/bookmarkable. -->
  <div class="mb-8 flex flex-wrap items-center gap-2">
    <a
      href={trendingHref({ sort: "updated" })}
      aria-current={data.sort === "updated" ? "page" : undefined}
      class="inline-flex min-h-11 items-center rounded-lg border px-4 py-2 text-sm font-bold transition-colors sm:min-h-9 {data.sort ===
      'updated'
        ? 'border-primary bg-primary/10 text-primary'
        : 'border-border text-muted-foreground hover:text-primary'}"
    >
      {$t("trending.sortUpdated", "Recently updated")}
    </a>
    <a
      href={trendingHref({ sort: "popular" })}
      aria-current={data.sort === "popular" ? "page" : undefined}
      class="inline-flex min-h-11 items-center rounded-lg border px-4 py-2 text-sm font-bold transition-colors sm:min-h-9 {data.sort ===
      'popular'
        ? 'border-primary bg-primary/10 text-primary'
        : 'border-border text-muted-foreground hover:text-primary'}"
    >
      {$t("trending.sortPopular", "Popular")}
    </a>
  </div>

  {#if data.stories.length}
    <!--
      `compactOnMobile` is what /search, the public profile and the pages
      dashboard already pass. /trending was the one list still rendering the
      full magazine card at phone width — a 176px cover plus a reserved 3.5rem
      title box and a reserved blurb box per story, so one page of 24 came to
      roughly 10,000px of scrolling on a 320px screen. Below `sm` each story is
      now one compact horizontal row; the desktop grid is untouched.
    -->
    <div class="grid gap-x-8 gap-y-4 sm:grid-cols-2 sm:gap-y-12 lg:grid-cols-3">
      {#each data.stories as story (story.free2zaddr)}
        <ZpageCard {story} compactOnMobile={true} />
      {/each}
    </div>

    <!--
      Prev / label / Next do not fit on one 320px line (measured: they overflow
      the container by 16px), so the label drops to its own centred second line
      below `sm` and rejoins the row above it.
    -->
    <nav
      class="mt-12 flex flex-wrap items-center justify-between gap-y-4 border-t border-dashed border-border pt-8"
      aria-label={$t("trending.pagination", "Trending pagination")}
    >
      {#if data.hasPrevious}
        <Button
          variant="outline"
          href={trendingHref({ sort: data.sort, page: data.page - 1 })}
          class="min-h-11 sm:min-h-9"
        >
          {$t("trending.previous", "← Previous")}
        </Button>
      {:else}
        <span></span>
      {/if}

      <span
        class="order-last w-full text-center text-xs font-bold tracking-widest text-muted-foreground uppercase sm:order-none sm:w-auto"
      >
        {sortLabel} · {$t("trending.pageOf", "Page {page} of {total}", {
          page: data.page,
          total: pages,
        })}
      </span>

      {#if data.hasNext}
        <Button
          variant="outline"
          href={trendingHref({ sort: data.sort, page: data.page + 1 })}
          class="min-h-11 sm:min-h-9"
        >
          {$t("trending.next", "Next →")}
        </Button>
      {:else}
        <span></span>
      {/if}
    </nav>
  {:else}
    <div
      class="rounded-2xl border border-dashed border-border py-20 text-center"
    >
      <p class="text-lg text-muted-foreground">
        {data.failed
          ? $t(
              "trending.unavailable",
              "Trending pages are unavailable right now. Please try again shortly.",
            )
          : $t("trending.empty", "Nothing here yet — check back soon.")}
      </p>
      <Button variant="outline" href="/" class="mt-6 min-h-11 sm:min-h-9">
        {$t("trending.backHome", "Back to homepage")}
      </Button>
    </div>
  {/if}
</main>
