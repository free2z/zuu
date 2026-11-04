<script lang="ts">
  import { Check } from "@lucide/svelte";
  import { Card, CardContent } from "$lib/components/ui/card";
  import * as Avatar from "$lib/components/ui/avatar";
  import LiveIndicator from "$lib/components/stream/LiveIndicator.svelte";
  import { liveStatusFromStreams } from "$lib/live-discovery.js";
  import type { PublicMeetingList } from "$lib/api/f2z.schemas";
  import SmoothImage from "$lib/components/SmoothImage.svelte";
  import {
    formatLocalizedNumber,
    isSingularCount,
    locale,
    tStore as t,
  } from "$lib/i18n";

  export let creator: any;
  export let avatarUrl: (c?: any) => string | null;
  export let buildImageUrl: (imagePath?: string | null) => string | null;
  export let fmtDate: (iso?: string) => string;
  // `undefined` keeps the directory's standalone indicator behavior. The
  // The homepage passes every live mode for this creator, so the indicator can
  // open the existing stream-selection modal without per-card polling.
  export let liveStreams: PublicMeetingList[] | null | undefined = undefined;

  $: banner = buildImageUrl(
    creator.banner_image?.thumbnail || creator.banner_image?.url,
  );
  $: initialLiveStatus =
    liveStreams === undefined
      ? undefined
      : liveStreams === null
        ? null
        : liveStatusFromStreams(liveStreams);
</script>

<!--
	One hover cue, the border — not eight. This card used to stack a border
	change, a 2rem lift, an avatar glow, an avatar scale, a gradient shift, a
	scanline fade, a title colour change and a bottom rule all at once. None of
	it exists on touch, and none of it said anything the border did not.
-->
<Card
  data-testid="creator-card"
  class="group glass-card relative flex h-28 w-full min-w-0 flex-row overflow-hidden rounded-2xl border-border/40 p-0 transition-colors duration-300 hover:border-primary/50 sm:aspect-square sm:h-auto sm:flex-col"
>
  <a
    href={`/${creator.username}`}
    class="absolute inset-0 z-0"
    aria-label={$t("common.article.viewProfile", "View {name}'s profile", {
      name: creator.display_name || creator.username,
    })}
  ></a>

  <div
    class="pointer-events-none relative h-full w-[34%] shrink-0 overflow-hidden bg-muted sm:h-[35%] sm:w-full"
  >
    {#if banner}
      <SmoothImage
        src={banner}
        alt=""
        loading="lazy"
        class="absolute inset-0"
      />
    {/if}
    <div
      class="absolute inset-0 bg-linear-to-r from-transparent via-background/20 to-background/90 transition-all duration-500 sm:bg-linear-to-t sm:from-background/90 sm:via-transparent sm:to-black/20"
    ></div>
    <div
      class="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.25)_50%),linear-gradient(90deg,rgba(255,0,0,0.06),rgba(0,255,0,0.02),rgba(0,0,255,0.06))] bg-size-[100%_4px,4px_100%] opacity-[0.03] transition-opacity"
    ></div>
  </div>

  <div
    class="pointer-events-auto absolute top-2 left-2 z-20 sm:right-2 sm:left-auto"
  >
    <LiveIndicator
      username={creator.username}
      size="sm"
      showCount={false}
      initialStatus={initialLiveStatus}
    />
  </div>

  <CardContent
    class="pointer-events-none relative z-10 flex min-w-0 grow items-center p-3 pl-0 text-left sm:-mt-10 sm:flex-col sm:justify-between sm:px-4 sm:pt-0 sm:pb-4 sm:text-center"
  >
    <div class="flex w-full min-w-0 items-center gap-3 sm:flex-col sm:gap-3">
      <div class="group/avatar relative -ml-7 shrink-0 sm:ml-0">
        <!-- Static ring. It used to brighten on hover — one cue of eight. -->
        <div
          class="absolute -inset-1 rounded-full bg-linear-to-tr from-primary via-primary/50 to-blue-400 opacity-10 blur"
        ></div>

        <Avatar.Root
          class="relative h-16 w-16 border-4 border-background shadow-md sm:h-20 sm:w-20 dark:shadow-2xl"
        >
          <!-- A native <img>, NOT <Avatar.Image>. Creator avatars are stored
					     at source resolution (some are multi-megapixel), and bits-ui's
					     Avatar.Image resolves its src by constructing a detached
					     `new Image()` and assigning `.src` — which downloads regardless
					     of the DOM element's `loading` attribute. On a phone that
					     fetches every avatar in the `display: none` desktop subtree,
					     competing with the feed images the user can actually see.
					     A plain lazy <img> is never fetched while off-screen. -->
          {#if avatarUrl(creator)}
            <img
              src={avatarUrl(creator)}
              alt={creator.username}
              loading="lazy"
              decoding="async"
              class="aspect-square size-full object-cover"
            />
          {:else}
            <Avatar.Fallback class="bg-muted text-muted-foreground"
              >{creator.username.substring(0, 2).toUpperCase()}</Avatar.Fallback
            >
          {/if}
        </Avatar.Root>

        {#if creator.is_verified}
          <div class="absolute right-1 bottom-1">
            <div
              class="flex items-center justify-center rounded-full border-2 border-background bg-primary p-1 text-primary-foreground shadow-lg"
              role="img"
              aria-label={$t("creators.filters.verified", "Verified")}
            >
              <Check class="h-2 w-2 stroke-4" aria-hidden="true" />
            </div>
          </div>
        {/if}
      </div>

      <div class="min-w-0 flex-1 space-y-1 sm:w-full">
        <h3
          class="truncate text-sm font-black tracking-tight uppercase sm:line-clamp-2 sm:min-h-[2.5rem] sm:text-base sm:break-words sm:whitespace-normal"
        >
          {creator.display_name || creator.full_name || creator.username}
        </h3>

        <div class="flex min-w-0 flex-col items-start gap-1 sm:items-center">
          <span
            class="max-w-full truncate font-mono text-[11px] font-bold tracking-widest text-primary uppercase opacity-70"
          >
            @{creator.username}
          </span>

          <!--
						11px, not 9px: this is the only line on a phone that says how much
						a creator has published and when. `whitespace-nowrap` on each span
						with `flex-wrap` on the row keeps each fact whole — "120,345 posts"
						used to break as "120,345 / POSTS" with the separator dot orphaned,
						and the card then grew past its own h-28.
					-->
          <div
            class="flex max-w-full flex-wrap items-center gap-x-1.5 text-[11px] font-black text-muted-foreground uppercase sm:justify-center"
          >
            <span class="whitespace-nowrap opacity-80">
              {isSingularCount(creator.zpages || 0, $locale)
                ? $t("creators.postCountOne", "{count} post", {
                    count: formatLocalizedNumber(creator.zpages || 0, $locale),
                  })
                : $t("creators.postCountMany", "{count} posts", {
                    count: formatLocalizedNumber(creator.zpages || 0, $locale),
                  })}
            </span>
            {#if creator.last_post_at || creator.date_joined}
              <span
                class="h-0.5 w-0.5 shrink-0 rounded-full bg-muted-foreground/30"
              ></span>
              <span class="whitespace-nowrap opacity-60"
                >{fmtDate(creator.last_post_at || creator.date_joined)}</span
              >
            {/if}
          </div>
        </div>
      </div>
    </div>
  </CardContent>
</Card>
