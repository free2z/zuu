<script lang="ts">
  import * as env from "$app/env/public";
  import { authStore } from "$lib/stores/auth";
  import LiveStreamViewer from "$lib/components/stream/LiveStreamViewer.svelte";
  import { Button } from "$lib/components/ui/button";
  import { ArrowLeft, Eye, Lock } from "@lucide/svelte";
  import { tStore as t } from "$lib/i18n";
  import SeoHead from "$lib/components/SeoHead.svelte";
  import {
    CANONICAL_ORIGIN,
    NOINDEX_FOLLOW_ROBOTS,
    compactText,
    toAbsoluteUrl,
  } from "$lib/seo";
  import { streamWatchPath } from "$lib/utils/stream-path";
  import { loginDestination } from "$lib/login-destination";
  import type { LivePageData } from "$lib/stream-types";

  export let data: LivePageData;

  const canonicalOrigin =
    env.PUBLIC_CANONICAL_BASE_URL?.replace(/\/$/, "") || CANONICAL_ORIGIN;
  const mediaOrigin =
    env.PUBLIC_API_BASE_URL?.replace(/\/$/, "") || canonicalOrigin;

  $: ({ username, type, creator, gatedPreview } = data);
  $: currentUser = $authStore.creator;
  // The creator on their own public page watches as a viewer; this
  // only decides whether to say so and point at the dashboard.
  $: isOwner =
    Boolean(currentUser?.username) &&
    currentUser?.username?.toLowerCase() === username?.toLowerCase();

  $: displayName = creator?.full_name || username;

  // SEO
  $: title = $t("live.metaTitle", "{name} is Live! - Free2Z", {
    name: displayName,
  });
  $: description = compactText(
    creator?.description,
    $t("live.metaDescription", "Watch {name}'s live stream on Free2Z.", {
      name: displayName,
    }),
  );

  $: bannerUrl =
    creator?.banner_image?.url ||
    creator?.banner_image?.thumbnail ||
    (typeof creator?.banner_image === "string" ? creator.banner_image : null);
  $: avatarUrl =
    creator?.avatar_image?.thumbnail ||
    creator?.avatar_image?.url ||
    (typeof creator?.avatar_image === "string" ? creator.avatar_image : null);
  $: ogImage = toAbsoluteUrl(
    bannerUrl || avatarUrl || "/brand/free2z-og.png?v=2",
    mediaOrigin,
  );
  // The username the DATABASE holds, not the casing the visitor typed:
  // `/SkYlAr/broadcast` and `/skylar/broadcast` are one page, and the Django
  // card tier has always canonicalised to `creator.username`. Falling back to
  // the path segment keeps a canonical on the wire if the payload ever lacks
  // the field.
  $: canonicalUsername = creator?.username || username;
  $: canonicalPath = streamWatchPath(canonicalUsername, type);
  //an anonymous unfurler on a protected stream gets the card and a
  // way in, never the viewer. Logging in returns to this same stream.
  $: gatedLoginHref = loginDestination(canonicalPath);
</script>

<SeoHead
  {title}
  {description}
  path={canonicalPath}
  type="video.other"
  image={ogImage}
  robots={NOINDEX_FOLLOW_ROBOTS}
  imageAlt={$t("live.ogImageAlt", "{name}'s live stream on Free2Z", {
    name: displayName,
  })}
/>

<div class="flex min-h-0 flex-1 flex-col bg-black">
  <!-- Header -->
  <div
    class="flex items-center justify-between gap-3 border-b border-zinc-800 bg-zinc-900 p-4"
  >
    <div class="flex items-center gap-4">
      <Button
        variant="ghost"
        size="sm"
        href={`/${username}`}
        class="text-zinc-400 hover:text-white"
      >
        <ArrowLeft class="mr-2 h-4 w-4" />
        {$t("live.backToProfile", "Back to Profile")}
      </Button>
      <div class="flex items-center gap-2">
        <div class="h-2 w-2 animate-pulse rounded-full bg-red-500"></div>
        <h1 class="text-lg font-bold text-white">
          {$t("live.isLive", "{name} is live", { name: displayName })}
        </h1>
      </div>
    </div>
    {#if isOwner}
      <a
        href={`/${username}/dashboard/stream`}
        data-testid="owner-viewer-notice"
        class="flex min-w-0 items-center gap-2 rounded-full border border-zinc-700 bg-zinc-800/80 px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:border-zinc-500 hover:text-white"
        title={$t(
          "live.ownerViewerNoticeHint",
          "This page never broadcasts. Your camera and microphone stay with your dashboard.",
        )}
      >
        <Eye class="h-3.5 w-3.5 shrink-0" />
        <span class="truncate">
          {$t("live.ownerViewerNotice", "Watching as a viewer")}
        </span>
        <span class="hidden text-zinc-500 sm:inline">·</span>
        <span class="hidden font-medium text-primary sm:inline">
          {$t("live.ownerManageStream", "Manage stream")}
        </span>
      </a>
    {/if}
  </div>

  <!-- Main Viewer -->
  <div
    class="public-meeting-frame relative min-h-0 w-full"
    data-public-meeting-frame
  >
    {#if gatedPreview}
      <div
        class="flex h-full flex-col items-center justify-center gap-4 p-6 text-center"
        data-testid="gated-stream-preview"
      >
        <Lock class="h-8 w-8 text-zinc-400" />
        <h2 class="text-xl font-semibold text-white">
          {type === "ppv"
            ? $t("live.gatedPreviewPpv", "Pay-per-view stream")
            : $t("live.gatedPreviewSubscribersOnly", "Subscribers-only stream")}
        </h2>
        <p class="max-w-md text-sm text-zinc-400">
          {$t("live.gatedPreviewBody", "Log in to watch {name}'s stream.", {
            name: displayName,
          })}
        </p>
        <Button href={gatedLoginHref}>
          {$t("live.gatedPreviewLogin", "Log in to watch")}
        </Button>
      </div>
    {:else}
      {#key `${username}-${type}`}
        <LiveStreamViewer
          {username}
          streamType={type}
          expectedActorId={data.viewerActorId}
        />
      {/key}
    {/if}
  </div>
</div>

<style>
  /*: `<rtk-meeting mode="fill">` is `height: 100%` against its parent, so
     a percentage chain that never reaches a DEFINITE height resolves to `auto`
     and the stage collapses to 0px while the 48px header and 64px controlbar
     survive. `min-h-*` does not establish a containing-block height. This frame
     is that definite height: viewport-relative so it tracks mobile browser
     chrome, floored so a short landscape viewport still gets a usable stage,
     and capped so a tall desktop display does not stretch the tile absurdly.
     8.5rem is the Free2Z nav + this page's live header budget.

     The `0px` fallbacks on `env()` are load-bearing, not decoration: an engine
     that rejects a bare `env()` drops the whole declaration, `height` falls
     back to `auto`, and the P0 returns with no other symptom. */
  .public-meeting-frame {
    height: clamp(
      12rem,
      calc(
        100dvh - 8.5rem - env(safe-area-inset-top, 0px) -
          env(safe-area-inset-bottom, 0px)
      ),
      56rem
    );
  }
</style>
