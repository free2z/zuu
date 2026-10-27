<script lang="ts">
  import { formatDate } from "$lib/utils/date";
  import * as env from "$app/env/public";
  import { Card, CardContent, CardFooter } from "$lib/components/ui/card";
  import SmoothImage from "$lib/components/SmoothImage.svelte";
  import FeaturedImageFrame from "$lib/components/FeaturedImageFrame.svelte";
  import { extractPlainText } from "$lib/utils/markdown";
  import { locale, tStore as t } from "$lib/i18n";
  import { translateCategory } from "$lib/components/mdEditor/categoryNames";
  import TagChips from "$lib/components/TagChips.svelte";
  import { articleVariantHref } from "$lib/zpage-language.js";
  import { zpageCanonicalPath } from "$lib/zpage-path";
  import { blockedUsernames, isBlockedIn } from "$lib/stores/blocks";

  export let story: any;
  export let compactOnMobile = false;
  /** Keep the compact horizontal layout at every mobile width. */
  export let mobileHorizontal = false;
  export let featured = false;
  /** Homepage-only editorial row. Other compact cards retain their responsive grid layout. */
  export let editorialFeed = false;
  /** Dashboard-only destination for unpublished pages; public cards keep their canonical URL. */
  export let privateHref: string | null = null;

  const apiBase = (env.PUBLIC_API_BASE_URL || "").replace(/\/$/, "");

  function buildImageUrl(imagePath?: string | null): string | null {
    if (!imagePath) return null;
    if (/^https?:\/\//i.test(imagePath)) return imagePath;
    const normalized = imagePath.startsWith("/") ? imagePath : `/${imagePath}`;
    return `${apiBase}${normalized.startsWith("/uploadz/") ? "" : "/uploadz"}${normalized}`.replace(
      "/uploadz/uploadz",
      "/uploadz",
    );
  }

  function articleHref(a: any): string {
    if (privateHref) return privateHref;
    const href = zpageCanonicalPath(a || {}) || a?.get_url || "/";
    if (a?.actual_language && a.actual_language !== a?.source_language) {
      // `articleVariantHref`, not `articleTranslationHref`: the throwing form
      // would take out the whole list render for one row whose
      // `actual_language` is `und` or otherwise unnameable.
      return articleVariantHref(href, a.actual_language);
    }
    return href;
  }

  function avatarUrl(c: any): string | null {
    const img = c?.avatar_image?.thumbnail || c?.avatar_image?.url;
    return buildImageUrl(img);
  }

  function fmtDate(iso?: string): string {
    return formatDate(iso, $locale, undefined, "");
  }

  function truncated(text: string | undefined, len = 140): string {
    return extractPlainText(text || "", len).replace(/\.\.\.$/, "…");
  }

  $: img = buildImageUrl(
    story?.featured_image?.thumbnail || story?.featured_image?.url,
  );
  $: hav = avatarUrl(story?.creator);
  //a list rendered without the reader's session (cached homepage,
  // SSR feeds) can still carry a page by an account they blocked.
  $: hiddenByBlock =
    !privateHref && isBlockedIn($blockedUsernames, story?.creator?.username);
</script>

{#if hiddenByBlock}
  <article
    class="flex min-h-24 items-center justify-center rounded-lg border border-dashed border-(--f2z-border-primary) p-4 text-center text-sm text-muted-foreground"
    data-testid="zpage-card-blocked"
  >
    {$t(
      "moderation.block.hiddenPage",
      "Hidden because you blocked @{username}.",
      { username: story?.creator?.username },
    )}
  </article>
{:else if editorialFeed}
  <article
    class="group flex min-h-36 gap-3.5 border-b border-(--f2z-border-primary) py-4"
  >
    <a
      href={articleHref(story)}
      class="relative block h-28 w-24 shrink-0 overflow-hidden rounded-lg bg-(--f2z-bg-secondary) focus-visible:ring-2 focus-visible:ring-(--f2z-accent-primary)/40 focus-visible:outline-none"
      aria-label={story.title}
    >
      {#if img}
        <FeaturedImageFrame
          src={img}
          padding="vivid"
          fit="contain"
          alt={story.title}
          loading="lazy"
          class="h-full w-full"
        />
      {:else}
        <div
          class="flex h-full w-full items-center justify-center bg-(--f2z-bg-secondary)"
        >
          <svg
            class="size-8 text-(--f2z-text-tertiary)"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="1.25"
              d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2 1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2Z"
            />
          </svg>
        </div>
      {/if}
    </a>

    <div class="flex min-w-0 flex-1 flex-col">
      <div class="flex min-w-0 items-center gap-1.5 text-[11px] leading-4">
        {#if story?.category}
          <span class="truncate font-semibold text-(--f2z-accent-primary)">
            {translateCategory(story.category, $t)}
          </span>
          <span class="text-(--f2z-text-tertiary)" aria-hidden="true">·</span>
        {/if}
        <time
          class="shrink-0 text-(--f2z-text-muted)"
          datetime={story.created_at}
        >
          {fmtDate(story.created_at)}
        </time>
      </div>

      <a
        href={articleHref(story)}
        class="mt-1 block rounded-sm text-(--f2z-text-primary) no-underline focus-visible:ring-2 focus-visible:ring-(--f2z-accent-primary)/40 focus-visible:outline-none"
      >
        <h3
          class="line-clamp-3 text-[0.98rem] leading-5 font-semibold tracking-[-0.01em] transition-colors group-hover:text-(--f2z-accent-primary)"
        >
          {story.title}
        </h3>
      </a>

      <a
        href="/{story?.creator?.username}"
        class="mt-auto flex min-h-11 min-w-0 items-center gap-2 self-start rounded-sm text-xs text-(--f2z-text-muted) no-underline transition-colors hover:text-(--f2z-text-primary) focus-visible:ring-2 focus-visible:ring-(--f2z-accent-primary)/40 focus-visible:outline-none"
      >
        <div
          class="size-5 shrink-0 overflow-hidden rounded-full bg-(--f2z-bg-tertiary)"
        >
          {#if hav}
            <SmoothImage
              src={hav}
              alt=""
              loading="lazy"
              class="h-full w-full"
            />
          {/if}
        </div>
        <span class="truncate"
          >{story?.creator?.full_name || `@${story?.creator?.username}`}</span
        >
      </a>
    </div>
  </article>
{:else}
  <Card
    data-testid="zpage-card"
    class={`group relative flex h-full overflow-hidden rounded-xl border border-primary/10 p-0 transition-all duration-200 hover:border-primary/30 ${mobileHorizontal ? `h-32 max-h-32 min-h-32 flex-row border-(--f2z-border-primary) bg-(--f2z-bg-secondary)/90 shadow-xs hover:shadow-md ${featured ? "border-(--f2z-accent-primary)/35" : ""}` : compactOnMobile ? "min-h-28 flex-row sm:min-h-0 sm:flex-col" : "flex-col"} ${mobileHorizontal ? "" : "glass-card"}`}
  >
    <!-- Card Image with Tech Overlay (Link) -->
    <a
      href={articleHref(story)}
      class={`relative block shrink-0 overflow-hidden bg-muted ${mobileHorizontal ? "w-[clamp(6.5rem,28vw,8.5rem)]" : compactOnMobile ? "w-24 sm:h-44 sm:w-full" : "h-44 w-full"}`}
    >
      {#if img}
        <FeaturedImageFrame
          src={img}
          alt={story.title}
          loading="lazy"
          class="h-full w-full"
        />
        <div
          class="absolute inset-0 {mobileHorizontal
            ? 'bg-linear-to-r from-background/5 via-transparent to-background/35'
            : 'bg-linear-to-t from-background/90 via-transparent to-transparent'} opacity-60"
        ></div>
      {:else}
        <div class="flex h-full w-full items-center justify-center bg-muted/50">
          <!-- Placeholder Tech Pattern -->
          <svg
            class="h-12 w-12 text-primary/10"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="1"
              d="M19.428 15.428a2 2 0 00-1.022-.547l-2.384-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z"
            />
          </svg>
        </div>
      {/if}

      <!-- Never over a compact thumbnail. That image is 96px wide
             (`compactOnMobile`, below sm) or clamp(6.5rem,28vw,8.5rem)
             (`mobileHorizontal`), and "TECHNOLOGY" in this chip measures
             ~110px — so the badge escaped the image and sat on top of the
             title. The compact layouts carry the category as text in the meta
             line instead. -->
      {#if story?.category && !mobileHorizontal}
        <div
          class="absolute top-3 right-3 {compactOnMobile
            ? 'hidden sm:block'
            : ''} rounded-md border border-primary/20 bg-background/80 px-2.5 py-1 font-mono text-[10px] font-bold tracking-wider text-primary uppercase shadow-sm backdrop-blur-md"
        >
          {translateCategory(story.category, $t)}
        </div>
      {/if}
      {#if featured}
        <span
          class="featured-story-label absolute top-2 left-2 z-10 rounded-sm bg-(--f2z-accent-primary)/90 px-1.5 py-0.5 text-[9px] font-bold tracking-[0.08em] whitespace-nowrap text-(--f2z-bg-primary) uppercase shadow-xs"
        >
          <span class="featured-story-label-full"
            >{$t("homepage.heroSection", "Featured Story")}</span
          >
          <span class="featured-story-label-short"
            >{$t("homepage.featuredLabel", "Featured")}</span
          >
        </span>
      {/if}
    </a>

    <!-- Card Body -->
    <CardContent
      class={`relative flex min-h-0 flex-1 flex-col overflow-hidden ${mobileHorizontal ? "min-w-0 p-2.5" : compactOnMobile ? "min-w-0 p-3 sm:p-5 sm:pb-0" : "p-5 pb-0"}`}
    >
      <!-- Date Badge -->
      <div
        class={`${mobileHorizontal ? "mb-1" : "mb-1.5 sm:mb-2"} flex items-center justify-between`}
      >
        <span
          class={`${mobileHorizontal ? "text-[11px] leading-none" : compactOnMobile ? "text-[11px] leading-none sm:text-xs sm:leading-normal" : "text-xs"} flex items-center gap-1.5 text-muted-foreground`}
        >
          <span
            class="h-1.5 w-1.5 shrink-0 rounded-full bg-primary/40 transition-colors group-hover:bg-primary"
          ></span>
          <span class="whitespace-nowrap">{fmtDate(story.created_at)}</span>
          {#if (mobileHorizontal || compactOnMobile) && story?.category}
            <span
              class="{compactOnMobile && !mobileHorizontal
                ? 'sm:hidden '
                : ''}text-muted-foreground/50"
              aria-hidden="true">·</span
            >
            <span
              class="{compactOnMobile && !mobileHorizontal
                ? 'sm:hidden '
                : ''}truncate font-semibold text-primary"
              >{translateCategory(story.category, $t)}</span
            >
          {/if}
        </span>
      </div>

      <a
        href={articleHref(story)}
        class={`block min-h-0 flex-1 overflow-hidden ${mobileHorizontal ? "" : "sm:mb-4"}`}
      >
        <h3
          class={`${mobileHorizontal ? "text-sm leading-tight" : compactOnMobile ? "text-sm leading-tight sm:text-xl sm:leading-snug" : "text-xl leading-snug"} ${mobileHorizontal ? "mb-1" : "mb-1.5"} line-clamp-2 font-bold tracking-tight transition-colors group-hover:text-primary ${mobileHorizontal ? "" : "sm:mb-2"} ${mobileHorizontal ? "" : compactOnMobile ? "sm:min-h-[3.5rem]" : "min-h-[3.5rem]"}`}
        >
          {story.title}
        </h3>

        <!-- Reserve a fixed blurb area so every card is the same height and
                 the footer lines up regardless of title/description length.
                 On compact mobile the reservation only applies at sm+. -->
        <div
          class={mobileHorizontal
            ? "min-h-0"
            : compactOnMobile
              ? "sm:min-h-[2.5rem]"
              : "min-h-[2.5rem]"}
        >
          {#if story?.description || story?.content}
            <p
              class={`${mobileHorizontal ? "text-[11px] leading-4 text-(--f2z-text-secondary)" : compactOnMobile ? "text-xs leading-snug sm:text-sm sm:leading-relaxed" : "text-sm leading-relaxed"} line-clamp-1 text-muted-foreground opacity-80`}
            >
              {truncated(story?.description || story?.content, 100)}
            </p>
          {/if}
        </div>
      </a>

      <!-- Tags. The row reserves its height whether or not this story has
             any, so a tagged card and an untagged one stay the same height and
             the footers still line up across a grid. Hidden on the compact
             layouts, which have no vertical room to spend. -->
      {#if !mobileHorizontal}
        <!-- `shrink-0` is load-bearing: the title/blurb link above is
                 `flex-1` inside an `overflow-hidden` column, so without it the
                 row is squeezed to zero height and the chips render invisibly
                 rather than not at all. -->
        <div
          class={`${compactOnMobile ? "hidden sm:block" : "block"} min-h-6 shrink-0 pb-1`}
        >
          <TagChips tags={story?.tags} limit={3} />
        </div>
      {/if}

      <!-- `compactOnMobile` hides the CardFooter below sm, and the footer is
             where the byline lives — so on a phone every compact card was
             anonymous. This row stands in at that width and disappears at sm:
             where the real footer returns. -->
      {#if (mobileHorizontal || compactOnMobile) && story?.creator}
        <a
          href="/{story.creator.username}"
          class="mt-auto flex min-h-6 min-w-0 items-center gap-1.5 rounded-sm text-[11px] text-(--f2z-text-muted) no-underline transition-colors hover:text-(--f2z-text-primary) focus-visible:ring-2 focus-visible:ring-(--f2z-accent-primary)/40 focus-visible:outline-none {compactOnMobile &&
          !mobileHorizontal
            ? 'sm:hidden'
            : ''}"
        >
          <span
            class="size-4 shrink-0 overflow-hidden rounded-full bg-(--f2z-bg-tertiary)"
          >
            {#if hav}<SmoothImage
                src={hav}
                alt=""
                loading="lazy"
                class="h-full w-full"
              />{/if}
          </span>
          <span class="truncate"
            >{story.creator.full_name || `@${story.creator.username}`}</span
          >
        </a>
      {/if}
    </CardContent>
    <!-- Footer: Author & Action -->
    <CardFooter
      class={`${mobileHorizontal ? "hidden" : compactOnMobile ? "hidden sm:flex" : "flex"} mt-auto items-center justify-between gap-3 border-t border-primary/10 px-5 pt-3 pb-5`}
    >
      <a
        href="/{story?.creator?.username}"
        class="group/author z-10 flex min-h-11 items-center gap-2"
      >
        <div
          class="relative h-8 w-8 overflow-hidden rounded-md border border-primary/20 transition-colors group-hover/author:border-primary/50"
        >
          <SmoothImage
            src={hav}
            alt={story?.creator?.username}
            loading="lazy"
            class="h-full w-full"
          />
        </div>
        <div class="flex flex-col">
          {#if story?.creator?.full_name}
            <span
              class="line-clamp-1 text-xs font-bold text-foreground transition-colors group-hover/author:text-primary"
            >
              {story.creator.full_name}
            </span>
            <span class="line-clamp-1 text-[10px] text-muted-foreground">
              @{story.creator.username}
            </span>
          {:else}
            <span
              class="line-clamp-1 text-xs font-bold text-foreground transition-colors group-hover/author:text-primary"
            >
              @{story.creator.username}
            </span>
          {/if}
        </div>
      </a>

      <a
        href={articleHref(story)}
        class="flex min-h-11 min-w-11 items-center justify-end gap-1 font-mono text-[10px] font-bold text-primary decoration-primary/50 underline-offset-4 opacity-60 transition-all duration-300 group-hover:gap-1.5 group-hover:opacity-100 hover:underline"
      >
        {$t("common.meta.read", "Read")}
        <svg
          class="h-3.5 w-3.5"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M14 5l7 7m0 0l-7 7m7-7H3"
          />
        </svg>
      </a>
    </CardFooter>
    <!-- Hover Glow Border Helper -->
    <div
      class="pointer-events-none absolute inset-0 rounded-xl border border-primary/0 transition-colors duration-200 group-hover:border-primary/20"
    ></div>
  </Card>
{/if}

<style>
  .featured-story-label-short {
    display: none;
  }

  @media (max-width: 419px) {
    .featured-story-label-full {
      display: none;
    }

    .featured-story-label-short {
      display: inline;
    }
  }
</style>
