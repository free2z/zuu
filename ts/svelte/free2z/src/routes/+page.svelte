<script lang="ts">
  import { formatDate } from "$lib/utils/date";
  import { onMount } from "svelte";
  import * as env from "$app/env/public";
  import { Radio, Ticket, Users } from "@lucide/svelte";
  import { dytePublicDiscoveryList } from "$lib/api/dyte/dyte";
  import type { PublicMeetingList } from "$lib/api/f2z.schemas";
  import { locale, tStore as t } from "$lib/i18n";
  import { translateCategory } from "$lib/components/mdEditor/categoryNames";
  import { isAuthenticated } from "$lib/stores/auth";
  import { Button } from "$lib/components/ui/button";
  import CreatorCard from "$lib/components/CreatorCard.svelte";
  import ZpageCard from "$lib/components/ZpageCard.svelte";
  import SmoothImage from "$lib/components/SmoothImage.svelte";
  import FeaturedImageFrame from "$lib/components/FeaturedImageFrame.svelte";
  import HomeCTA from "$lib/components/HomeCTA.svelte";
  import SeoHead from "$lib/components/SeoHead.svelte";
  import {
    CANONICAL_ORIGIN,
    createOrganizationJsonLd,
    createWebsiteJsonLd,
  } from "$lib/seo";
  import { CONVERSE_RSS_PATH } from "$lib/converse/feed-filters";
  import { extractPlainText } from "$lib/utils/markdown";
  import { trendingHref } from "$lib/trending.js";
  import { zpageCanonicalPath } from "$lib/zpage-path";
  import MobileFeed from "$lib/components/MobileFeed.svelte";
  import MobileIntro from "$lib/components/MobileIntro.svelte";
  import DesktopIntro from "$lib/components/DesktopIntro.svelte";
  import { blockedUsernames, isBlockedIn } from "$lib/stores/blocks";
  import { streamWatchPath } from "$lib/utils/stream-path";
  import {
    createLiveDiscoveryOptions,
    liveStreamsForCreator,
    resolveLiveDiscovery,
  } from "$lib/live-discovery.js";
  export let data: {
    authenticated: boolean;
    heroStory: any | null;
    trending: any[];
    trendingHasMore: boolean;
    trendingNext: string | null;
    popular: any[];
    creators: any[];
    latest: any[];
    latestHasMore: boolean;
    latestNext: string | null;
    latestLang: string;
    liveNow?: {
      results: PublicMeetingList[];
      selected_creators: string[];
      complete: boolean;
    };
  };

  const apiBase = (env.PUBLIC_API_BASE_URL || "").replace(/\/$/, "");
  const publicLiveOptions = createLiveDiscoveryOptions(apiBase);
  const LIVE_DISCOVERY_RETRY_DELAY_MS = 5_000;
  const canonicalOrigin =
    env.PUBLIC_CANONICAL_BASE_URL?.replace(/\/$/, "") || CANONICAL_ORIGIN;

  function buildImageUrl(imagePath?: string | null): string | null {
    if (!imagePath) return null;
    if (/^https?:\/\//i.test(imagePath)) return imagePath;
    const normalized = imagePath.startsWith("/") ? imagePath : `/${imagePath}`;
    const servedByUpload = normalized.startsWith("/uploadz/");
    const servedByStatic = normalized.startsWith("/djstatic/");
    return `${apiBase}${servedByUpload || servedByStatic ? "" : "/uploadz"}${normalized}`.replace(
      "/uploadz/uploadz",
      "/uploadz",
    );
  }

  function articleHref(a: any): string {
    const canonicalPath = zpageCanonicalPath(a || {});
    if (canonicalPath) return canonicalPath;
    const username = a?.creator?.username;
    if (a?.get_url) return a.get_url;
    if (username && a?.free2zaddr) return `/${username}/${a.free2zaddr}`;
    return "/";
  }

  function avatarUrl(c?: any): string | null {
    // `thumbnail` is a legacy convenience field that can fall back to the
    // original upload. The homepage avatar slot must only use the fixed-size
    // ladder rendition; missing processing is handled by initials below.
    return buildImageUrl(c?.avatar_image?.thumb);
  }

  function fmtDate(iso?: string): string {
    return formatDate(iso, $locale, undefined, "");
  }

  function truncated(text: string | undefined, len = 140): string {
    return extractPlainText(text || "", len).replace(/\.\.\.$/, "…");
  }

  const hero = data.heroStory;
  const heroImage = buildImageUrl(
    hero?.featured_image?.thumbnail || hero?.featured_image?.url,
  );
  const trending = data.trending || [];
  const popular = data.popular || [];
  //the homepage is cached and rendered without the reader's
  // session, so the hand-rolled hero and Popular Reads rows drop a blocked
  // author here (ZpageCard handles every card-rendered list on its own).
  $: heroVisible =
    !!hero && !isBlockedIn($blockedUsernames, hero?.creator?.username);
  $: visiblePopular = popular.filter(
    (p) => !isBlockedIn($blockedUsernames, p?.creator?.username),
  );
  let liveNow = data.liveNow;
  const creators = (() => {
    const all = data.creators || [];
    const seen = new Set();
    return all.filter((c) => {
      if (!c?.username || seen.has(c.username)) return false;
      seen.add(c.username);
      return true;
    });
  })();

  function livePrice(value: unknown): string {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return "";
    return new Intl.NumberFormat($locale, {
      maximumFractionDigits: 2,
    }).format(amount);
  }

  function liveTypeName(type: string): string {
    if (type === "broadcast") return $t("stream.types.broadcast", "Broadcast");
    if (type === "subscribers-only") {
      return $t("stream.types.subscribersOnly", "Subscribers");
    }
    return $t("stream.types.payPerView", "PPV");
  }

  $: liveCreatorsByUsername =
    liveNow === undefined
      ? undefined
      : liveNow.results.reduce((byUsername, stream) => {
          const streams = byUsername.get(stream.username) || [];
          streams.push(stream);
          byUsername.set(stream.username, streams);
          return byUsername;
        }, new Map<string, PublicMeetingList[]>());

  onMount(() => {
    let controller: AbortController | null = null;
    let retryTimer: number | null = null;
    let retryAttemptedSinceSuccess = false;
    let stopped = false;
    let refreshGeneration = 0;

    const refreshLiveNow = async () => {
      const generation = ++refreshGeneration;
      retryTimer = null;
      controller?.abort();
      controller = new AbortController();
      try {
        const response = await dytePublicDiscoveryList(
          publicLiveOptions,
          controller.signal,
        );
        if (stopped || generation !== refreshGeneration) return;
        liveNow = resolveLiveDiscovery(response);
        retryAttemptedSinceSuccess = false;
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") return;
        if (stopped || generation !== refreshGeneration) return;
        // Do not keep showing a rail whose live snapshot could be stale. An
        // unknown discovery state also returns cards to their normal polling.
        liveNow = undefined;
        console.warn("Homepage live-now refresh failed", error);
        if (!retryAttemptedSinceSuccess && !stopped) {
          retryAttemptedSinceSuccess = true;
          retryTimer = window.setTimeout(
            refreshLiveNow,
            LIVE_DISCOVERY_RETRY_DELAY_MS,
          );
        }
      }
    };

    // Fetch after hydration so a cached document cannot hide a stream that
    // started just before the visitor arrived.
    refreshLiveNow();
    const interval = window.setInterval(refreshLiveNow, 45_000);
    return () => {
      stopped = true;
      refreshGeneration += 1;
      window.clearInterval(interval);
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      controller?.abort();
    };
  });

  // Derive topics (tags + categories) from incoming items
  const topicCount = new Map<string, number>();
  function addTopic(t?: string) {
    if (!t) return;
    const key = t.trim();
    if (!key) return;
    topicCount.set(key, (topicCount.get(key) || 0) + 1);
  }
  [...trending, ...popular].forEach((a) => {
    (a?.tags || []).forEach((t: string) => addTopic(t));
    addTopic(a?.category);
  });
  const topics = Array.from(topicCount.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([t]) => t)
    .slice(0, 12);
</script>

<SeoHead
  title={$t("homepage.metaTitle", "Free2Z — Read. Publish. Get Discovered.")}
  description={$t(
    "homepage.metaDescription",
    "Independent publishing on Free2Z. Discover trending stories, follow original creators, publish your work, and receive direct support.",
  )}
  path="/"
  structuredData={[
    createOrganizationJsonLd(canonicalOrigin),
    createWebsiteJsonLd(canonicalOrigin),
  ]}
/>
<svelte:head>
  <!-- Feed autodiscovery for the global Converse microblog stream. Classic
       advertised it from the homepage (`Home.tsx:28-34`); the SvelteKit
       rewrite dropped it, so readers and aggregators had no way to find the
       feed from the site's front door. -->
  <link
    rel="alternate"
    type="application/rss+xml"
    title={$t("converse.rssTitle", "Free2Z Converse")}
    href={CONVERSE_RSS_PATH}
  />
  {#if heroImage}
    <!-- `media` scopes the preload to the widths that actually render the
		     hero. Without it a phone downloads a large image at high priority
		     for a `display: none` subtree, competing with the feed thumbnails it
		     can see. CSS hiding does not cancel a preload. -->
    <link
      rel="preload"
      as="image"
      href={heroImage}
      media="(min-width: 768px)"
      fetchpriority="high"
    />
  {/if}
</svelte:head>

<div
  data-testid="homepage-shell"
  class="mesh-gradient relative flex flex-1 flex-col gap-12 pt-4 pb-10 md:gap-16 md:pt-8 md:pb-16 lg:gap-24 lg:pt-12 lg:pb-24"
>
  {#if liveNow?.results.length}
    <section
      data-testid="homepage-live-now"
      class="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8"
      aria-labelledby="homepage-live-now-heading"
    >
      <div
        class="glass-card overflow-hidden rounded-2xl border border-red-500/20 bg-red-500/[0.03] p-4 sm:p-6"
      >
        <div class="mb-4 flex items-center justify-between gap-4">
          <div class="flex min-w-0 items-center gap-3">
            <span class="relative flex size-2 shrink-0">
              <span
                class="absolute inline-flex size-full animate-ping rounded-full bg-red-500 opacity-60"
              ></span>
              <span class="relative inline-flex size-2 rounded-full bg-red-500"
              ></span>
            </span>
            <h2
              id="homepage-live-now-heading"
              class="text-lg font-black tracking-tight sm:text-xl"
            >
              {$t("homepage.liveNow", "Live Now")}
            </h2>
          </div>
          <span
            class="shrink-0 font-mono text-[10px] font-bold tracking-widest text-red-500 uppercase"
            >{$t("stream.live", "LIVE")}</span
          >
        </div>

        <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {#each liveNow.results as stream (stream.username + ":" + stream.meeting_type)}
            <a
              data-testid="homepage-live-now-card"
              href={streamWatchPath(stream.username, stream.meeting_type)}
              class="group flex min-w-0 items-center gap-3 rounded-xl border border-border/60 bg-background/60 p-3 transition-colors hover:border-red-500/50 hover:bg-background"
              aria-label={$t(
                "homepage.watchLiveStream",
                "Watch {username}'s {type} stream",
                {
                  username: stream.username,
                  type: liveTypeName(stream.meeting_type),
                },
              )}
            >
              <div
                class="grid size-12 shrink-0 place-items-center overflow-hidden rounded-full border border-red-500/30 bg-muted"
              >
                {#if buildImageUrl(stream.avatar)}
                  <img
                    src={buildImageUrl(stream.avatar)}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    class="size-full object-cover"
                  />
                {:else}
                  <span class="text-sm font-bold text-muted-foreground"
                    >{stream.username?.slice(0, 2).toUpperCase()}</span
                  >
                {/if}
              </div>

              <div class="min-w-0 flex-1">
                <div class="flex min-w-0 items-center gap-2">
                  <span class="min-w-0 font-bold break-words"
                    >@{stream.username}</span
                  >
                  <span
                    class="relative inline-flex shrink-0 items-center rounded-md bg-red-600 px-1.5 py-0.5 text-[10px] font-bold text-white"
                  >
                    <span class="relative mr-1 flex size-1.5">
                      <span
                        class="absolute inline-flex size-full animate-ping rounded-full bg-white opacity-75"
                      ></span>
                      <span
                        class="relative inline-flex size-1.5 rounded-full bg-white"
                      ></span>
                    </span>
                    {$t("stream.live", "LIVE")}
                  </span>
                </div>
                <div
                  class="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
                >
                  {#if stream.meeting_type === "broadcast"}
                    <Radio class="size-3.5 shrink-0" aria-hidden="true" />
                    <span>{$t("homepage.liveModeFree", "Free")}</span>
                  {:else if stream.meeting_type === "subscribers-only"}
                    <Users class="size-3.5 shrink-0" aria-hidden="true" />
                    <span
                      >{$t("homepage.liveModeSubscribers", "Subscribers")}</span
                    >
                  {:else}
                    <Ticket class="size-3.5 shrink-0" aria-hidden="true" />
                    <span>
                      {$t("stream.pricePerMinuteShort", "{amount} 2Z/min", {
                        amount: livePrice(stream.price_per_minute),
                      })}
                    </span>
                  {/if}
                </div>
              </div>
            </a>
          {/each}
        </div>
      </div>
    </section>
  {/if}

  <!-- Mobile feed (below md): a plain reverse-chronological list with search.
	     The magazine layout below is desktop-only — see /. Both trees
	     live in one route on purpose: a CSS breakpoint costs a few KB of HTML
	     but `display: none` creates no layers and no paint, and it stays
	     correct when a window is resized or a tablet rotated (which a
	     server-side User-Agent branch would not). -->
  <div class="flex flex-col md:hidden">
    {#if !data.authenticated && !$isAuthenticated}
      <MobileIntro />
    {/if}
    <MobileFeed
      initial={data.latest}
      heroStory={hero}
      {trending}
      trendingHasMore={data.trendingHasMore}
      trendingNextPageUrl={data.trendingNext}
      {creators}
      hasMore={data.latestHasMore}
      nextPageUrl={data.latestNext}
      lang={data.latestLang}
    />
  </div>

  <!-- Background Elements (decorative; desktop only) -->
  <div class="pointer-events-none absolute inset-0 overflow-hidden">
    <!-- Tech Grid Background -->
    <div
      class="absolute inset-0 bg-[linear-gradient(to_right,#8080800d_1px,transparent_1px),linear-gradient(to_bottom,#8080800d_1px,transparent_1px)] mask-[radial-gradient(ellipse_80%_68%_at_50%_0%,#000_72%,transparent_100%)] bg-size-[24px_24px] opacity-20 md:mask-[radial-gradient(ellipse_60%_50%_at_50%_0%,#000_70%,transparent_100%)] md:opacity-55"
    ></div>
    <!-- Animated gradient glow without an oversized blur-filter texture. -->
    <div
      class="glow-radial absolute -top-[140px] left-1/2 size-96 -translate-x-1/2 animate-pulse md:-top-[200px] md:size-[600px]"
    ></div>
  </div>

  {#if !data.authenticated && !$isAuthenticated}
    <DesktopIntro />
  {/if}

  <!-- Top Section: Featured & Popular (desktop) -->
  <section
    class="mx-auto hidden w-full max-w-7xl px-4 sm:px-6 md:block lg:px-8"
  >
    <div class="grid gap-10 lg:grid-cols-12 lg:gap-12">
      <!-- Featured Post (Left) -->
      <div class="lg:col-span-8">
        {#if heroVisible}
          {@const hav = avatarUrl(hero?.creator)}

          <div class="group flex flex-col gap-6">
            <!-- Header Meta -->
            <div
              class="flex items-center justify-between border-b border-dashed border-border/40 pb-4"
            >
              <div class="flex items-center gap-3">
                <div class="relative flex h-1.5 w-1.5">
                  <span
                    class="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-50"
                  ></span>
                  <span
                    class="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary"
                  ></span>
                </div>
                <span
                  class="font-mono text-xs font-bold tracking-widest text-primary uppercase"
                  >{$t("homepage.heroSection", "Featured Story")}</span
                >
              </div>
              <span class="font-mono text-xs text-muted-foreground"
                >{fmtDate(hero.created_at)}</span
              >
            </div>

            <div
              class="relative aspect-2/1 w-full overflow-hidden rounded-2xl border border-border/50 bg-muted/20 shadow-sm transition-colors group-hover:border-primary/20"
            >
              <a href={articleHref(hero)} class="group/img block h-full w-full">
                {#if heroImage}
                  <FeaturedImageFrame
                    src={heroImage}
                    alt={hero?.title}
                    loading="eager"
                    fetchpriority="high"
                    showStatus
                    class="h-full w-full"
                  />
                  <div
                    class="absolute inset-0 bg-linear-to-t from-background/10 to-transparent"
                  ></div>
                {:else}
                  <div
                    class="flex h-full w-full items-center justify-center bg-muted/30"
                  >
                    <svg
                      class="h-20 w-20 text-muted-foreground/10"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="1.5"
                        d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                      />
                    </svg>
                  </div>
                {/if}
              </a>

              <!-- Floating Author Badge -->
              <a
                href="/{hero?.creator?.username}"
                class="group/author absolute bottom-4 left-4 z-10 flex items-center gap-3 rounded-2xl border border-border bg-background/90 py-1.5 pr-5 pl-1.5 shadow-lg backdrop-blur-md transition-transform hover:scale-105"
              >
                <div
                  class="h-8 w-8 overflow-hidden rounded-full border border-primary/20 bg-muted"
                >
                  <SmoothImage
                    src={hav}
                    alt={hero?.creator?.username}
                    class="h-full w-full"
                  />
                </div>
                <div class="flex flex-col gap-0.5 leading-none">
                  <span
                    class="text-[10px] font-bold tracking-wider text-muted-foreground uppercase"
                    >{$t("meta.createdBy", "by")}</span
                  >
                  <span
                    class="text-xs font-bold text-foreground transition-colors group-hover/author:text-primary"
                    >{hero?.creator?.full_name || hero?.creator?.username}</span
                  >
                </div>
              </a>
            </div>

            <div class="space-y-4">
              <a href={articleHref(hero)} class="group/title block space-y-3">
                <div
                  class="mb-2 inline-flex items-center rounded border border-primary/10 bg-primary/5 px-2 py-1 text-[10px] font-bold tracking-wider text-primary uppercase"
                >
                  {hero.category
                    ? translateCategory(hero.category, $t)
                    : $t("homepage.storyFallback", "Story")}
                </div>

                <h1
                  class="line-clamp-2 pb-1 text-4xl leading-[1.05] font-black tracking-tight transition-colors group-hover/title:text-primary sm:text-5xl lg:text-6xl"
                >
                  {hero?.title}
                </h1>

                {#if hero?.description || hero?.content}
                  <p
                    class="line-clamp-3 max-w-3xl text-lg leading-relaxed font-light text-muted-foreground sm:text-xl"
                  >
                    {truncated(hero?.description || hero?.content, 220)}
                  </p>
                {/if}
              </a>

              <!-- Action Area -->
              <div class="pt-2">
                <a
                  href={articleHref(hero)}
                  class="inline-flex min-h-11 items-center gap-2 font-bold text-primary transition-all duration-300 group-hover:gap-4"
                >
                  <span class="relative text-sm tracking-wide uppercase">
                    {$t("homepage.readFullStory", "Read Full Story")}
                    <span
                      class="absolute -bottom-1 left-0 h-0.5 w-0 bg-primary transition-all duration-300 group-hover:w-full"
                    ></span>
                  </span>
                  <svg
                    class="h-5 w-5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    ><path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                      d="M17 8l4 4m0 0l-4 4m4-4H3"
                    /></svg
                  >
                </a>
              </div>
            </div>
          </div>
        {:else}
          <div class="animate-pulse space-y-6">
            <div
              class="flex justify-between border-b border-dashed border-border/40 pb-4"
            >
              <div class="h-4 w-32 rounded bg-muted"></div>
              <div class="h-4 w-24 rounded bg-muted"></div>
            </div>
            <div class="aspect-2/1 w-full rounded-2xl bg-muted"></div>
            <div class="space-y-4">
              <div class="h-16 w-3/4 rounded-xl bg-muted"></div>
              <div class="h-24 w-full rounded-xl bg-muted"></div>
            </div>
          </div>
        {/if}
      </div>

      <!-- Popular Reads (Right) -->
      <div class="space-y-6 lg:col-span-4 lg:space-y-8 lg:pl-4">
        <div
          class="flex items-center justify-between border-b border-border pb-2"
        >
          <h2 class="flex items-center gap-2 text-xl font-black tracking-tight">
            <span class="text-primary">#</span>
            {$t("homepage.popularReads", "Popular Reads")}
          </h2>
          <!--
						: this used to be an in-page `#trending` jump, which scrolled to
						the "Community Favorites" grid — a different list than Popular Reads.
						It now opens the paginated trending view sorted by the same
						recency-decayed popularity this column is built from.
					-->
          <Button
            variant="ghost"
            href={trendingHref({ sort: "popular" })}
            size="sm"
            class="min-h-11 gap-1 px-2 text-xs font-bold tracking-wider text-muted-foreground uppercase hover:text-primary sm:min-h-8"
          >
            {$t("homepage.viewMore", "View More")}
            <svg
              class="h-3 w-3"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              ><path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M17 8l4 4m0 0l-4 4m4-4H3"
              /></svg
            >
          </Button>
        </div>

        <div class="flex flex-col gap-2">
          {#each visiblePopular.slice(0, 5) as p, i}
            {@const thumb = buildImageUrl(
              p?.featured_image?.thumbnail || p?.featured_image?.url,
            )}
            <a
              href={articleHref(p)}
              class="group relative flex items-center gap-4 rounded-xl border border-transparent p-3 transition-all duration-300 hover:border-primary/5 hover:bg-muted/40"
            >
              <!-- Thumbnail -->
              <div
                class="relative h-20 w-20 shrink-0 overflow-hidden rounded-lg border border-border/40 bg-muted shadow-sm transition-all group-hover:shadow-md"
              >
                {#if thumb}
                  <FeaturedImageFrame
                    src={thumb}
                    padding="vivid"
                    fit="contain"
                    alt={p.title}
                    loading="lazy"
                    class="h-full w-full"
                  />
                {:else}
                  <div
                    class="flex h-full w-full items-center justify-center bg-muted/50"
                  >
                    <svg
                      class="h-6 w-6 text-muted-foreground/20"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="1.5"
                        d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                      />
                    </svg>
                  </div>
                {/if}
              </div>

              <!-- Content -->
              <div class="min-w-0 flex-1 space-y-1.5">
                <div
                  class="flex items-center gap-2 text-[10px] font-bold tracking-wider uppercase"
                >
                  <span
                    class="text-primary transition-colors dark:group-hover:text-white"
                    >{p.category
                      ? translateCategory(p.category, $t)
                      : $t("homepage.storyFallback", "Story")}</span
                  >
                  <span class="text-muted-foreground/40">•</span>
                  <span class="text-muted-foreground"
                    >{fmtDate(p.created_at)}</span
                  >
                </div>

                <h3
                  class="line-clamp-2 text-sm leading-snug font-bold transition-colors group-hover:text-primary"
                >
                  {p.title}
                </h3>

                <div class="flex items-center gap-2 pt-0.5">
                  <div
                    class="h-5 w-5 shrink-0 overflow-hidden rounded-full border border-border bg-muted"
                  >
                    {#if avatarUrl(p.creator)}
                      <SmoothImage
                        src={avatarUrl(p.creator)}
                        alt=""
                        loading="lazy"
                        class="h-full w-full"
                      />
                    {/if}
                  </div>
                  <span
                    class="truncate text-xs font-medium text-muted-foreground transition-colors group-hover:text-foreground"
                  >
                    {p?.creator?.full_name || p?.creator?.username}
                  </span>
                </div>
              </div>
            </a>
          {/each}
        </div>

        <!-- Topics Quick Links -->
        {#if topics.length}
          <div class="border-t border-dashed border-border pt-6">
            <h3
              class="mb-4 flex items-center gap-2 text-[10px] font-black tracking-widest text-muted-foreground uppercase"
            >
              <svg
                class="h-3 w-3"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                ><path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14"
                /></svg
              >
              {$t("homepage.trending", "Trending")}
            </h3>
            <div class="flex flex-wrap gap-2">
              {#each topics.slice(0, 8) as topic}
                <a
                  href="/search?q={encodeURIComponent(topic)}"
                  class="inline-flex min-h-11 items-center rounded-md border border-transparent bg-muted/50 px-2.5 py-1 text-xs font-medium transition-colors hover:border-primary/20 hover:bg-primary/10 hover:text-primary sm:min-h-0"
                >
                  #{translateCategory(topic, $t)}
                </a>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    </div>
  </section>

  <!-- Topics -->
  {#if topics.length}
    <section class="mx-auto hidden max-w-7xl px-4 sm:px-6 md:block lg:px-8">
      <div
        class="glass-card relative overflow-hidden rounded-2xl border border-primary/10 p-6 sm:p-12"
      >
        <!-- Static gradient glow avoids a continuously repainted blur layer. -->
        <div
          class="glow-radial pointer-events-none absolute top-0 right-0 -mt-32 -mr-32 size-96 opacity-70"
        ></div>

        <div
          class="relative z-10 flex flex-col gap-8 lg:flex-row lg:items-start lg:gap-12"
        >
          <div class="space-y-6 lg:w-1/3">
            <div
              class="inline-flex w-fit items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3 py-1"
            >
              <svg
                class="h-3 w-3 text-primary"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                ><path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width="2"
                  d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"
                /></svg
              >
              <span
                class="text-[10px] font-bold tracking-widest text-primary uppercase"
                >{$t("homepage.discover", "Discover")}</span
              >
            </div>

            <!--
							Two-key split, not one string: the second half is the only
							accent-colored word on this surface, so it has to stay its own
							element. Locales that need a different word order can move the
							emphasis by translating `homepage.exploreByTopicLead` to the
							empty string and putting the whole phrase in
							`homepage.exploreByTopicAccent`.
						-->
            <h2 class="text-3xl font-black tracking-tighter">
              {$t("homepage.exploreByTopicLead", "Explore by")}
              <span class="text-primary"
                >{$t("homepage.exploreByTopicAccent", "Topic")}</span
              >
            </h2>
            <p class="text-lg leading-relaxed text-muted-foreground">
              {$t(
                "homepage.topicsDescription",
                "Dive into the conversations that matter. Find exactly what you're looking for across our diverse ecosystem.",
              )}
            </p>
          </div>

          <div class="flex flex-wrap content-start gap-3 lg:w-2/3">
            {#each topics as topic}
              <a
                href="/search?q={encodeURIComponent(topic)}"
                class="inline-flex min-h-11 items-center rounded-lg border border-border bg-background/50 px-4 py-2 text-sm font-medium transition-all duration-300 hover:border-primary/50 hover:bg-primary/5 hover:text-primary"
              >
                #{translateCategory(topic, $t)}
              </a>
            {/each}
          </div>
        </div>
      </div>
    </section>
  {/if}

  <!-- Trending Grid -->
  <section
    id="trending"
    class="relative mx-auto hidden max-w-7xl px-4 sm:px-6 md:block lg:px-8"
  >
    <!-- Background decorative elements -->
    <div
      class="glow-radial pointer-events-none absolute top-20 left-0 -z-10 h-3/4 w-1/4 opacity-50"
    ></div>

    <div
      class="mb-8 flex flex-col justify-between gap-6 sm:mb-12 sm:flex-row sm:items-end sm:gap-8"
    >
      <div class="max-w-2xl space-y-4">
        <div
          class="inline-flex w-fit items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3 py-1"
        >
          <span class="relative flex h-2 w-2">
            <span
              class="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-50"
            ></span>
            <span class="relative inline-flex h-2 w-2 rounded-full bg-primary"
            ></span>
          </span>
          <span
            class="text-[10px] font-bold tracking-widest text-primary uppercase"
            >{$t("homepage.trendingNow", "Trending Now")}</span
          >
        </div>

        <div>
          <h2
            class="text-3xl font-black tracking-tighter sm:text-4xl lg:text-5xl"
          >
            {$t("homepage.communityFavoritesLead", "Community")}
            <span class="text-primary"
              >{$t("homepage.communityFavoritesAccent", "Favorites")}</span
            >
          </h2>
          <p class="mt-4 text-lg leading-relaxed text-muted-foreground">
            {$t(
              "homepage.trendingDescription",
              "The stories, articles, and updates capturing the attention of the Free2Z community right now.",
            )}
          </p>
        </div>
      </div>

      <!--
				: pointed at bare /search, which renders the empty "Start your
				search" state — a button promising trending content landed on a blank
				search box. /trending is the paginated version of this very grid.
			-->
      <Button
        variant="outline"
        href={trendingHref()}
        class="group min-h-11 shrink-0 gap-2 sm:min-h-9"
      >
        {$t("homepage.exploreTrending", "Explore All Trending")}
        <svg
          class="h-4 w-4 transition-transform group-hover:translate-x-1"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          ><path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M17 8l4 4m0 0l-4 4m4-4H3"
          /></svg
        >
      </Button>
    </div>

    <div class="grid gap-x-8 gap-y-8 sm:grid-cols-2 sm:gap-y-12 lg:grid-cols-3">
      {#each trending.slice(0, 9) as a, index (a.free2zaddr)}
        <div class={index >= 6 ? "hidden sm:block" : ""}>
          <ZpageCard story={a} />
        </div>
      {/each}
    </div>
  </section>

  <!-- Creators Spotlight -->
  {#if creators.length}
    <section
      class="relative mx-auto hidden max-w-7xl px-4 sm:px-6 md:block lg:px-8"
    >
      <!-- Decorative background element -->
      <div
        class="glow-linear pointer-events-none absolute top-0 right-0 -z-10 h-full w-1/3"
      ></div>

      <div
        class="mb-8 flex flex-col justify-between gap-6 sm:mb-12 sm:flex-row sm:items-end"
      >
        <div class="max-w-2xl space-y-4">
          <div
            class="inline-flex w-fit items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3 py-1"
          >
            <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-primary"
            ></span>
            <span
              class="text-[10px] font-bold tracking-widest text-primary uppercase"
              >{$t("homepage.community", "Community")}</span
            >
          </div>

          <div>
            <h2
              class="text-3xl font-black tracking-tighter sm:text-4xl lg:text-5xl"
            >
              {$t("homepage.featuredCreatorsLead", "Featured")}
              <span class="text-primary"
                >{$t("homepage.featuredCreatorsAccent", "Creators")}</span
              >
            </h2>
            <p class="mt-4 text-lg leading-relaxed text-muted-foreground">
              {$t(
                "homepage.featuredCreatorsDescription",
                "Discover the innovative voices and independent storytellers shaping the future of content on Free2Z.",
              )}
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          href="/creators"
          class="group min-h-11 shrink-0 gap-2 sm:min-h-9"
        >
          {$t("homepage.viewCreatorDirectory", "View Creator Directory")}
          <svg
            class="h-4 w-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            ><path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M17 8l4 4m0 0l-4 4m4-4H3"
            /></svg
          >
        </Button>
      </div>

      <div
        class="grid gap-6 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 lg:gap-8 xl:grid-cols-5"
      >
        {#each creators as creator, index (creator.username)}
          <div
            class={index >= 5
              ? "group relative hidden min-w-0 sm:block"
              : "group relative min-w-0"}
          >
            <div
              class="pointer-events-none absolute -inset-px rounded-xl bg-linear-to-b from-primary/30 to-transparent opacity-0 transition duration-500 group-hover:opacity-100"
            ></div>
            <CreatorCard
              {creator}
              {avatarUrl}
              {buildImageUrl}
              {fmtDate}
              liveStreams={liveStreamsForCreator(
                liveNow,
                liveCreatorsByUsername,
                creator.username,
              )}
            />
          </div>
        {/each}
      </div>
    </section>
  {/if}
  {#if !data.authenticated && !$isAuthenticated}
    <!-- Desktop only. On mobile the same pitch is one tap away at the TOP of the
	     feed via MobileIntro, which is where people actually are; repeating it
	     past 120 article rows reaches nobody. -->
    <div class="hidden md:block">
      <HomeCTA />
    </div>
  {/if}
</div>
