<script lang="ts">
  import * as env from "$app/env/public";
  import { tStore as t } from "$lib/i18n";
  import PageHeader from "$lib/components/PageHeader.svelte";
  import SeoHead from "$lib/components/SeoHead.svelte";
  import ZpageCard from "$lib/components/ZpageCard.svelte";
  import { Button } from "$lib/components/ui/button";
  import {
    CANONICAL_ORIGIN,
    NOINDEX_FOLLOW_ROBOTS,
    compactText,
    createBreadcrumbJsonLd,
    toAbsoluteUrl,
  } from "$lib/seo";
  import { TAG_PAGE_SIZE, tagPageHref, totalTagPages } from "$lib/tag.js";

  export let data;

  const origin =
    env.PUBLIC_CANONICAL_BASE_URL?.replace(/\/$/, "") || CANONICAL_ORIGIN;

  $: pages = totalTagPages(data.count, TAG_PAGE_SIZE);
  $: hasPrevious = data.page > 1;
  $: hasNext = data.page < pages;
  $: selfPath = tagPageHref({ slug: data.slug, page: data.page });

  // Only page 1 of a tag that clears the quality gate is indexable.
  //
  //  * `?page=2…` is `noindex, follow` because it is a re-ordering of zPage
  //    URLs the sitemap already lists one by one — `follow` keeps them
  //    discoverable, `noindex` keeps a long tail of near-duplicate list pages
  //    out of the index. Same rule, same reason, as /trending.
  //  * A hub below the gate (`indexable: false`) renders normally for humans
  //    and still links out, but a two-page topic hub is a thin page and
  //    indexing it costs sitewide quality rather than earning traffic. This is
  //    what stops the long tail of one-off tags becoming thin-content debt.
  $: isIndexable = data.indexable && data.page === 1;

  // Every paginated slice is SELF-canonical. Pointing them all at page 1 would
  // be the `/search?tag=` mistake in a new place: a canonical that names a
  // different page's content is ignored, and `rel=prev`/`rel=next` is the
  // pagination signal that is actually about pagination.
  $: canonicalPathForPage = selfPath;

  $: description = compactText(
    data.count === 1
      ? `One page tagged ${data.name} on Free2Z.`
      : `${data.count} pages tagged ${data.name} on Free2Z. ` +
          `Browse independent writing, art and video from creators publishing about ${data.name}.`,
  );

  $: title =
    data.page > 1
      ? `${data.name} — page ${data.page} | Free2Z`
      : `${data.name} | Free2Z`;

  $: breadcrumb = createBreadcrumbJsonLd(origin, [
    { name: "Free2Z", path: "/" },
    { name: data.name, path: tagPageHref({ slug: data.slug }) },
  ]);
</script>

<SeoHead
  {title}
  {description}
  path={canonicalPathForPage}
  imageAlt={`Pages tagged ${data.name} on Free2Z`}
  robots={isIndexable ? undefined : NOINDEX_FOLLOW_ROBOTS}
  structuredData={breadcrumb}
/>

<svelte:head>
  <!--
    `rel=prev`/`rel=next` alongside a self-referential canonical. Google
    retired these as an *indexing* signal in 2019 but still reads them, and
    Bing never retired them at all; more to the point they are the only markup
    that says "this is a sequence" to anything that parses the page.
  -->
  {#if hasPrevious}
    <link
      rel="prev"
      href={toAbsoluteUrl(
        tagPageHref({ slug: data.slug, page: data.page - 1 }),
        origin,
      )}
    />
  {/if}
  {#if hasNext}
    <link
      rel="next"
      href={toAbsoluteUrl(
        tagPageHref({ slug: data.slug, page: data.page + 1 }),
        origin,
      )}
    />
  {/if}
</svelte:head>

<PageHeader title={data.name} titleSuffix="" subtitle={description} />

<main class="container mx-auto max-w-7xl px-4 py-10">
  <p
    class="mb-8 text-xs font-bold tracking-widest text-muted-foreground uppercase"
    data-testid="tag-hub-count"
  >
    {$t("tag.pageCount", "{count} pages", { count: data.count })}
    {#if data.names.length > 1}
      <!--
        The slug is deliberately lossy, so `t-shirts`, `t shirts` and
        `T/Shirts` share one URL. A still-live alias can also be disclosed here
        even when its casefold identity produces a different slug. Saying so
        is honest — and it is also the only place a reader can see why a page
        tagged with a variant spelling turned up here.
      -->
      <span class="normal-case"
        >· {$t("tag.alsoSpelled", "also spelled")}
        {data.names.slice(1).join(", ")}</span
      >
    {/if}
  </p>

  {#if data.results.length}
    <div class="grid gap-x-8 gap-y-4 sm:grid-cols-2 sm:gap-y-12 lg:grid-cols-3">
      {#each data.results as story (story.free2zaddr)}
        <ZpageCard {story} compactOnMobile={true} />
      {/each}
    </div>

    <nav
      class="mt-12 flex flex-wrap items-center justify-between gap-y-4 border-t border-dashed border-border pt-8"
      aria-label={$t("tag.pagination", "Tag pagination")}
    >
      {#if hasPrevious}
        <Button
          variant="outline"
          href={tagPageHref({ slug: data.slug, page: data.page - 1 })}
          class="min-h-11 sm:min-h-9"
        >
          {$t("tag.previous", "← Previous")}
        </Button>
      {:else}
        <span></span>
      {/if}

      <span
        class="order-last w-full text-center text-xs font-bold tracking-widest text-muted-foreground uppercase sm:order-none sm:w-auto"
      >
        {$t("tag.pageOf", "Page {page} of {total}", {
          page: data.page,
          total: pages,
        })}
      </span>

      {#if hasNext}
        <Button
          variant="outline"
          href={tagPageHref({ slug: data.slug, page: data.page + 1 })}
          class="min-h-11 sm:min-h-9"
        >
          {$t("tag.next", "Next →")}
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
        {$t("tag.empty", "Nothing here yet — check back soon.")}
      </p>
      <Button
        variant="outline"
        href="/trending"
        class="mt-6 min-h-11 sm:min-h-9"
      >
        {$t("tag.browseTrending", "Browse trending pages")}
      </Button>
    </div>
  {/if}
</main>
