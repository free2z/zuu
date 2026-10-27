<script context="module" lang="ts">
  const LIVE_WITH_COUNT_POLL_INTERVAL_MS = 15000;
  const LIVE_POLL_INTERVAL_MS = 30000;
  const INACTIVE_POLL_INTERVAL_MS = 60000;
  const MAX_POLL_JITTER_MS = 5000;
  const VIEWPORT_PREFETCH_DISTANCE_PX = 400;
  const VIEWPORT_ROOT_MARGIN = `${VIEWPORT_PREFETCH_DISTANCE_PX}px 0px`;

  // Spread polling and retry traffic across browser sessions after deploys or outages.
  const CLIENT_POLL_SEED = Math.floor(Math.random() * MAX_POLL_JITTER_MS);

  type ViewportCallback = (isNearViewport: boolean) => void;

  const viewportCallbacks = new WeakMap<Element, ViewportCallback>();
  const pendingInitialVisibilityChecks = new Set<Element>();
  let viewportObserver: IntersectionObserver | null = null;
  let observedTargetCount = 0;
  let initialVisibilityFrame: number | null = null;

  function getPollJitter(value: string) {
    let hash = 0;
    for (let index = 0; index < value.length; index += 1) {
      hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
    }
    return ((hash >>> 0) + CLIENT_POLL_SEED) % MAX_POLL_JITTER_MS;
  }

  function scheduleInitialVisibilityCheck(target: Element) {
    pendingInitialVisibilityChecks.add(target);

    if (initialVisibilityFrame !== null) {
      return;
    }

    initialVisibilityFrame = requestAnimationFrame(() => {
      initialVisibilityFrame = null;

      for (const pendingTarget of pendingInitialVisibilityChecks) {
        const callback = viewportCallbacks.get(pendingTarget);
        if (!callback) {
          continue;
        }

        const rect = pendingTarget.getBoundingClientRect();
        const hasLayoutBox = rect.width > 0 || rect.height > 0;
        const isNearViewport =
          hasLayoutBox &&
          rect.bottom >= -VIEWPORT_PREFETCH_DISTANCE_PX &&
          rect.top <= window.innerHeight + VIEWPORT_PREFETCH_DISTANCE_PX;

        callback(isNearViewport);
      }

      pendingInitialVisibilityChecks.clear();
    });
  }

  function observeViewport(target: Element, callback: ViewportCallback) {
    if (typeof IntersectionObserver === "undefined") {
      callback(true);
      return () => callback(false);
    }

    if (!viewportObserver) {
      viewportObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            viewportCallbacks.get(entry.target)?.(entry.isIntersecting);
          }
        },
        { rootMargin: VIEWPORT_ROOT_MARGIN },
      );
    }

    viewportCallbacks.set(target, callback);
    scheduleInitialVisibilityCheck(target);
    observedTargetCount += 1;
    viewportObserver.observe(target);

    return () => {
      viewportObserver?.unobserve(target);
      viewportCallbacks.delete(target);
      pendingInitialVisibilityChecks.delete(target);
      observedTargetCount -= 1;
      callback(false);

      if (observedTargetCount === 0) {
        viewportObserver?.disconnect();
        viewportObserver = null;
      }
    };
  }
</script>

<script lang="ts">
  import { onMount } from "svelte";
  import { derived, writable } from "svelte/store";
  import { createQuery } from "@tanstack/svelte-query";
  import {
    StreamService,
    liveStatusQueryKey,
    shouldRetryLiveStatusRequest,
  } from "$lib/services/stream";
  import type { LiveStatusResponse } from "$lib/services/stream";
  import StreamSelectionModal from "./StreamSelectionModal.svelte";
  import { Users } from "@lucide/svelte";
  import { fade } from "svelte/transition";
  import { goto } from "$app/navigation";
  import {
    formatLocalizedNumber,
    isSingularCount,
    locale,
    tStore as t,
  } from "$lib/i18n";
  import { streamWatchPath } from "$lib/utils/stream-path";

  export let username: string;
  export let showCount = true;
  export let size: "sm" | "md" | "lg" = "md";
  // Homepage creator cards receive the already-fetched public live list. A
  // defined value disables this component's per-card query while preserving
  // the standalone/profile indicator's existing polling behavior.
  export let initialStatus: LiveStatusResponse | null | undefined = undefined;

  let showModal = false;
  let pollingTarget: HTMLDivElement;

  const pollingEnabled = writable(false);
  const pollingConfig = writable({ username, showCount });
  const initialStatusState = writable<LiveStatusResponse | null | undefined>(
    initialStatus,
  );

  $: pollingConfig.set({ username, showCount });
  // `initialStatus` is supplied by the homepage after hydration. Make it a
  // query dependency so an SSR-unavailable page can stop an already-started
  // fallback observer as soon as authoritative discovery arrives.
  $: initialStatusState.set(initialStatus);

  const liveStatusOptions = derived(
    [pollingConfig, pollingEnabled, initialStatusState],
    ([$pollingConfig, $pollingEnabled, $initialStatus]) => ({
      queryKey: liveStatusQueryKey($pollingConfig.username),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        StreamService.fetchLiveStatus($pollingConfig.username, signal),
      enabled: Boolean(
        $initialStatus === undefined &&
        $pollingConfig.username &&
        $pollingEnabled,
      ),
      staleTime: 10000,
      gcTime: 5 * 60 * 1000,
      refetchInterval: (query: { state: { data?: LiveStatusResponse } }) => {
        const baseInterval = query.state.data?.is_live
          ? $pollingConfig.showCount
            ? LIVE_WITH_COUNT_POLL_INTERVAL_MS
            : LIVE_POLL_INTERVAL_MS
          : INACTIVE_POLL_INTERVAL_MS;

        return baseInterval + getPollJitter($pollingConfig.username);
      },
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      retry: shouldRetryLiveStatusRequest,
      retryDelay: (attemptIndex: number) =>
        Math.min(
          1000 * 2 ** attemptIndex + getPollJitter($pollingConfig.username),
          30000,
        ),
    }),
  );

  const liveStatusQuery = createQuery<LiveStatusResponse>(liveStatusOptions);

  $: status =
    initialStatus === undefined ? $liveStatusQuery.data : initialStatus;
  $: isLive = status?.is_live ?? false;
  $: participantCount = status?.participant_count;
  $: streams = status?.streams ?? [];

  function handleClick(e: MouseEvent | KeyboardEvent) {
    e.stopPropagation();
    e.preventDefault();

    if (streams.length > 1) {
      showModal = true;
    } else {
      goto(streamWatchPath(username, streams[0]?.type || "broadcast"));
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") {
      handleClick(e);
    }
  }

  onMount(() => {
    if (!pollingTarget) {
      pollingEnabled.set(true);
      return;
    }

    return observeViewport(pollingTarget, (isNearViewport) => {
      pollingEnabled.set(isNearViewport);
    });
  });

  const sizeClasses = {
    sm: "text-xs px-1.5 py-0.5",
    md: "text-sm px-2.5 py-0.5",
    lg: "text-base px-3 py-1",
  };
</script>

<div bind:this={pollingTarget} class="inline-block min-h-px min-w-px">
  {#if isLive}
    <div
      role="button"
      tabindex="0"
      aria-label={participantCount == null
        ? $t(
            "stream.openLiveUnknown",
            "Open {username}'s live stream; viewer count unavailable",
            { username },
          )
        : isSingularCount(participantCount, $locale)
          ? $t(
              "stream.openLiveOne",
              "Open {username}'s live stream with {count} viewer",
              {
                username,
                count: formatLocalizedNumber(participantCount, $locale),
              },
            )
          : $t(
              "stream.openLiveOther",
              "Open {username}'s live stream with {count} viewers",
              {
                username,
                count: formatLocalizedNumber(participantCount, $locale),
              },
            )}
      class="group inline-flex cursor-pointer items-center gap-2 transition-transform hover:scale-105"
      transition:fade
      on:click={handleClick}
      on:keydown={handleKeydown}
    >
      <div
        class={`relative inline-flex items-center rounded-md bg-red-600 font-bold text-white shadow-sm ${sizeClasses[size]}`}
      >
        <span class="relative mr-1.5 flex h-2 w-2">
          <span
            class="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-75"
          ></span>
          <span class="relative inline-flex h-2 w-2 rounded-full bg-white"
          ></span>
        </span>
        {$t("stream.live", "LIVE")}
      </div>

      {#if showCount && participantCount != null && participantCount > 0}
        <div
          class={`flex items-center gap-1 rounded-md border border-border bg-muted/50 font-medium text-muted-foreground backdrop-blur-sm ${size === "sm" ? "px-1.5 py-0.5 text-xs" : "px-2 py-0.5 text-sm"}`}
        >
          <Users size={size === "sm" ? 12 : 14} />
          <span>{formatLocalizedNumber(participantCount, $locale)}</span>
        </div>
      {/if}
    </div>

    <StreamSelectionModal bind:open={showModal} {username} {streams} />
  {/if}
</div>
