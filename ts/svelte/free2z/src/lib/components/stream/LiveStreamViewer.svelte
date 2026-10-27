<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { browser } from "$app/env";
  import { fade } from "svelte/transition";
  import {
    StreamService,
    PaymentRequiredError,
    liveStatusQueryKey,
    type StreamInfo,
  } from "$lib/services/stream";
  import { useQueryClient } from "@tanstack/svelte-query";
  import { initRtkMeeting } from "$lib/utils/rtk-manager";
  import { liveStreamStore } from "$lib/stores/liveStreamStore";
  import type { PublicStreamType } from "$lib/services/stream";
  import { defineCustomElements } from "@cloudflare/realtimekit-ui/loader";
  import {
    Loader2,
    AlertCircle,
    Lock,
    WifiOff,
    RefreshCw,
    VideoOff,
    MicOff,
    CameraOff,
  } from "@lucide/svelte";
  import Button from "../ui/button/button.svelte";
  import SubscribeToCreator from "./SubscribeToCreator.svelte";
  import PayPerViewPrompt from "./PayPerViewPrompt.svelte";
  import InlineRtkMeeting from "./InlineRtkMeeting.svelte";
  import RtkAudioHealth from "./RtkAudioHealth.svelte";
  import InsufficientFunds from "$lib/components/InsufficientFunds.svelte";
  import { createCreatorRetrieve } from "$lib/api/creator/creator";
  import { toast, captureAccountToast } from "$lib/toast.js";
  import { goto } from "$app/navigation";
  import { authStore } from "$lib/stores/auth";
  import {
    formatLocalizedNumber,
    isSingularCount,
    locale,
    tStore as t,
    type TranslationFunction,
  } from "$lib/i18n";
  import { getRtkTranslator } from "$lib/rtk-i18n";
  import { LocalizedError } from "$lib/i18n-message";
  import { streamWatchPath } from "$lib/utils/stream-path";
  import {
    compareDecimalText,
    formatDecimalText,
    type InsufficientFundsDetails,
  } from "$lib/insufficient-funds";

  export let username: string;
  export let expectedActorId: number | undefined = undefined;
  const originalViewerActorId = expectedActorId;
  // Only the three PUBLIC types: `/live/{username}` never renders a private
  // room (that lives at `/{username}/private/{secret}`), and its load function
  // 404s any other `?type=` before this component is built.
  export let streamType: PublicStreamType = "broadcast";
  // Never a publisher. This component renders every PUBLIC stream
  // page, and the creator opening their own is an audience member like any
  // other: before  it joined with the host preset, camera and mic on,
  // straight into the live broadcast it was only meant to preview (or, on a
  // room over a day old, rotated it and stranded every viewer). Broadcasting
  // happens only from the dashboard, which holds the broadcaster seat.
  const isHost = false;

  const queryClient = useQueryClient();

  let loading = true;
  let errorSource: unknown = null;
  let errorCode: string | null = null;
  let error: string | null = null;
  let warningSource: unknown = null;
  let warningCode: string | null = null;
  let warning: string | null = null;
  let isPaymentRequired = false;
  let insufficientFunds: InsufficientFundsDetails | null = null;
  let cleanup: (() => void | Promise<void>) | null = null;
  let destroyed = false;
  let joinController: AbortController | null = null;

  let showSubscribe = false;
  const actionToastIds = new Set<string | number>();
  function dismissActionToasts() {
    for (const id of actionToastIds) toast.dismiss(id);
    actionToastIds.clear();
  }
  function notifyStreamAction(...args: Parameters<typeof toast.info>) {
    if (!destroyed) actionToastIds.add(toast.info(...args));
  }
  let showPPV = false;
  let ppvPrice = "0";

  // Retry logic
  let retryCount = 0;
  const MAX_RETRIES = 5;
  let retryTimeout: NodeJS.Timeout;

  $: if (expectedActorId !== originalViewerActorId) {
    joinController?.abort();
    const previousCleanup = cleanup;
    cleanup = null;
    if (previousCleanup) void previousCleanup();
    clearTimeout(retryTimeout);
    loading = false;
    errorSource = new LocalizedError({
      key: "economy.signInAgain",
      fallback: "Sign in again before continuing.",
    });
  }

  // Alternative streams
  let otherStreams: StreamInfo[] = [];
  $: rtkTranslator = getRtkTranslator($locale);

  function formatAmount(value: string | number) {
    return formatDecimalText(value, $locale, 3);
  }

  function streamTypeLabel(type: StreamInfo["type"]) {
    if (type === "broadcast")
      return $t("stream.types.broadcast", "Public broadcast");
    if (type === "subscribers-only") {
      return $t("stream.types.subscribersOnly", "Subscribers only");
    }
    return $t("stream.types.payPerView", "Pay per view");
  }

  function viewerCount(count: number | undefined) {
    if (count == null) {
      return $t("stream.viewerCountUnknown", "Viewer count unavailable");
    }
    const formattedCount = formatLocalizedNumber(count, $locale);
    return isSingularCount(count, $locale)
      ? $t("stream.viewerCountOne", "{count} viewer", {
          count: formattedCount,
        })
      : $t("stream.viewerCountOther", "{count} viewers", {
          count: formattedCount,
        });
  }

  function localizedStreamError(
    value: unknown,
    code: string | null | undefined,
    translate: TranslationFunction,
  ) {
    if (value instanceof LocalizedError) {
      return translate(value.code, value.descriptor.fallback, value.params);
    }

    if (code?.startsWith("stream.errors.")) {
      return translate(code, typeof value === "string" ? value : undefined);
    }

    const message =
      value instanceof Error ? value.message : String(value || "");
    const normalized = message.toLowerCase();

    if (normalized.includes("not authorized")) {
      return translate(
        "stream.errors.notAuthorized",
        "You are not authorized to join this stream.",
      );
    }
    if (
      normalized.includes("not found") ||
      normalized.includes("does not exist")
    ) {
      return translate(
        "stream.errors.notFound",
        "This stream could not be found.",
      );
    }
    if (normalized.includes("not currently live")) {
      return translate(
        "stream.errors.notLive",
        "The creator is not currently live.",
      );
    }
    if (normalized.includes("disconnected")) {
      return translate(
        "stream.errors.disconnected",
        "Disconnected from the meeting.",
      );
    }
    if (normalized.includes("connection") || normalized.includes("network")) {
      return translate(
        "stream.errors.connectionFailed",
        "Connection to the meeting failed.",
      );
    }
    if (normalized.includes("audio")) {
      return translate(
        "stream.errors.audioFailed",
        "Audio could not be initialized.",
      );
    }
    return translate("stream.errors.joinFailed", "Failed to join stream.");
  }

  function localizedStreamWarning(
    value: unknown,
    code: string | null | undefined,
    translate: TranslationFunction,
  ) {
    if (code?.startsWith("stream.errors.")) {
      return translate(code, typeof value === "string" ? value : undefined);
    }

    const normalized = String(value || "").toLowerCase();
    if (
      normalized.includes("permission") ||
      normalized.includes("microphone") ||
      normalized.includes("camera")
    ) {
      return translate(
        "stream.mediaPermissionWarning",
        "Microphone or camera permission was denied. You joined without media. Check your browser settings.",
      );
    }
    return translate(
      "stream.mediaWarning",
      "Some media features are unavailable.",
    );
  }

  // Subscribe to store
  $: meeting = $liveStreamStore.meeting;
  $: connectionStatus = $liveStreamStore.connectionStatus;
  $: isOffline = $liveStreamStore.isOffline;
  $: storeError = $liveStreamStore.error;
  $: storeErrorCode = $liveStreamStore.errorCode;
  $: error = errorSource
    ? localizedStreamError(errorSource, errorCode, $t)
    : null;
  $: warning = warningSource
    ? localizedStreamWarning(warningSource, warningCode, $t)
    : null;

  // React to store errors
  $: if (storeError) {
    errorSource = storeError;
    errorCode = storeErrorCode;
    loading = false;
    // If we are disconnected unexpectedly, we might want to try auto-reconnecting
    if (
      connectionStatus === "disconnected" &&
      !isOffline &&
      retryCount < MAX_RETRIES
    ) {
      handleRetry();
    }
  }

  // React to stream end
  $: if (connectionStatus === "ended") {
    toast.info($t("stream.endedToast", "The stream has ended."));
    loading = false;
    errorSource = null;
    errorCode = null;
    void queryClient.invalidateQueries({
      queryKey: liveStatusQueryKey(username),
    });
  }

  const creatorQuery = createCreatorRetrieve(username);
  $: creator = $creatorQuery.data;
  $: isSubscribed = $authStore.creator?.star_ids
    ? creator?.id !== undefined &&
      $authStore.creator.star_ids.includes(creator.id)
    : Boolean($authStore.creator?.stars?.includes(username));

  function handleOnline() {
    liveStreamStore.setOffline(false);
    toast.success($t("stream.backOnline", "You are back online!"));
    if (error && !isPaymentRequired) {
      handleRetry();
    }
  }

  function handleOffline() {
    liveStreamStore.setOffline(true);
    toast.error(
      $t(
        "stream.offlineToast",
        "You are offline. Please check your connection.",
      ),
    );
  }

  onMount(async () => {
    // Register RealtimeKit web components
    defineCustomElements();

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    // Initial check
    if (!navigator.onLine) {
      handleOffline();
    }

    await joinStream();
  });

  // `onDestroy` is the ONE lifecycle hook Svelte also runs on the SERVER, at
  // the end of the SSR render. Reaching for `window` here therefore threw
  // `ReferenceError: window is not defined` on every server render of this
  // component *after* the markup was already produced, which SvelteKit turns
  // into a hard 500 — `/live/{username}` and `/{username}/broadcast` both
  // 500'd in production for months. `/{username}/ppv` and
  // `/{username}/subscribers-only` hid it by 302ing anonymous visitors to
  // /login before this component was ever built.
  //
  // The sibling creator-side page (`[username]/dashboard/stream/+page.svelte`)
  // registers the identical two listeners and has always carried this guard.
  onDestroy(() => {
    destroyed = true;
    joinController?.abort();
    dismissActionToasts();
    if (cleanup) cleanup();
    if (browser) {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    }
    clearTimeout(retryTimeout);
  });

  async function joinStream(retry = false) {
    if (destroyed || expectedActorId !== originalViewerActorId) return;
    joinController?.abort();
    const controller = new AbortController();
    joinController = controller;
    const { signal } = controller;
    clearTimeout(retryTimeout);
    const operationNotice = captureAccountToast();
    if (cleanup) {
      const previousCleanup = cleanup;
      cleanup = null;
      await previousCleanup();
      if (signal.aborted) return;
    }

    loading = true;
    if (!retry) {
      retryCount = 0;
    }

    errorSource = null;
    errorCode = null;
    warningSource = null;
    warningCode = null;
    isPaymentRequired = false;
    insufficientFunds = null;

    try {
      // 1. Get Auth Token
      const { auth_token } = await StreamService.initStream(
        username,
        streamType,
        { role: "viewer", expectedActorId: originalViewerActorId, signal },
      );

      if (signal.aborted) return;

      // 2. Initialize Meeting
      const result = await initRtkMeeting({
        authToken: auth_token,
        signal,
        streamType,
        isHost,
        defaults: {
          audio: isHost,
          video: isHost,
        },
      });
      if (signal.aborted) {
        await result.cleanup();
        return;
      }
      cleanup = result.cleanup;
      dismissActionToasts();
      warningSource = result.warning ?? null;
      warningCode = result.warningCode ?? null;
      void queryClient.invalidateQueries({
        queryKey: liveStatusQueryKey(username),
      });

      if (result.warning) {
        operationNotice.warning(
          localizedStreamWarning(result.warning, result.warningCode, $t),
        );
      }

      if (!retry) {
        operationNotice.success(
          $t("stream.joined", "Joined stream successfully!"),
        );
      }

      loading = false; // Ensure loading is false on success
    } catch (err: any) {
      if (signal.aborted) return;
      console.error("Failed to join stream:", err);
      errorSource = err;
      errorCode = null;
      isPaymentRequired = err instanceof PaymentRequiredError;
      insufficientFunds =
        err instanceof PaymentRequiredError ? err.funds : null;
      if (err instanceof LocalizedError && err.code === "economy.signInAgain") {
        clearTimeout(retryTimeout);
        loading = false;
        return;
      }

      if (streamType === "ppv" && isPaymentRequired) {
        const status = await StreamService.checkLiveStatus(username);
        if (signal.aborted) return;
        const stream = status.streams?.find((s) => s.type === "ppv");
        if (stream && stream.price_per_minute) {
          ppvPrice = String(stream.price_per_minute);
        }
        notifyStreamAction(
          $t("stream.paymentRequired", "Payment required to watch."),
          {
            action: {
              label: $t("stream.payNow", "Pay Now"),
              onClick: openPPV,
            },
          },
        );
      } else if (streamType === "subscribers-only" && isPaymentRequired) {
        notifyStreamAction(
          $t("stream.subscribersOnlyNotice", "Subscribers only stream."),
          {
            action: {
              label: isSubscribed
                ? $t("profile.subscribe.manage", "Manage subscription")
                : $t("profile.subscribe.subscribe", "Subscribe"),
              onClick: openSubscribe,
            },
          },
        );
      } else if (!isPaymentRequired) {
        // Check for other streams if current one failed
        try {
          const status = await StreamService.checkLiveStatus(username);
          if (signal.aborted) return;
          if (status.is_live && status.streams) {
            otherStreams = status.streams.filter((s) => s.type !== streamType);
          }
        } catch (e) {
          console.error("Failed to check alternative streams", e);
        }

        if (signal.aborted) return;
        if (retryCount < MAX_RETRIES) {
          // Auto-retry for non-payment errors (likely network or transient)
          const delay = Math.pow(2, retryCount) * 1000; // Exponential backoff
          console.log(
            `Retrying in ${delay}ms... (Attempt ${retryCount + 1}/${MAX_RETRIES})`,
          );
          retryCount++;
          retryTimeout = setTimeout(() => joinStream(true), delay);
          if (
            err instanceof LocalizedError &&
            err.code === "stream.errors.verificationUnavailable"
          )
            loading = false;
          return; // Keep ordinary transient retries in their loading state.
        } else {
          operationNotice.error(localizedStreamError(err, null, $t));
        }
      }
      // If we reached here without returning, we stop loading
      loading = false;
    }
  }

  function handleRetry() {
    clearTimeout(retryTimeout);
    joinStream();
  }

  function openSubscribe() {
    showSubscribe = true;
  }

  function openPPV() {
    showPPV = true;
  }
</script>

<div
  class="relative flex h-full min-h-0 w-full flex-col items-center justify-center overflow-hidden rounded-lg bg-black"
>
  {#if loading}
    <div
      class="flex max-h-full flex-col items-center gap-4 overflow-y-auto text-white"
      transition:fade
    >
      <Loader2 class="h-10 w-10 animate-spin text-primary" />
      <div class="flex flex-col items-center">
        <p class="font-medium">
          {retryCount > 0
            ? $t("stream.retryingConnection", "Retrying connection...")
            : $t("stream.joining", "Joining stream...")}
        </p>
        {#if retryCount > 0}
          <p class="text-sm text-gray-400">
            {$t("stream.retryAttempt", "Attempt {current}/{total}", {
              current: retryCount,
              total: MAX_RETRIES,
            })}
          </p>
          <Button
            variant="link"
            class="mt-2 h-auto p-0 text-xs"
            onclick={handleRetry}
          >
            {$t("stream.retryNow", "Retry Now")}
          </Button>
        {/if}
      </div>
    </div>
  {:else if isOffline}
    <div
      class="flex max-h-full max-w-md flex-col items-center gap-4 overflow-y-auto p-8 text-center text-white"
      transition:fade
    >
      <div
        class="mb-2 flex h-16 w-16 items-center justify-center rounded-full bg-yellow-500/20 text-yellow-500"
      >
        <WifiOff class="h-8 w-8" />
      </div>
      <h3 class="text-xl font-bold">
        {$t("stream.offlineTitle", "You are Offline")}
      </h3>
      <p class="text-gray-300">
        {$t(
          "stream.offlineDescription",
          "Please check your internet connection.",
        )}
      </p>
      <Button
        class="mt-4 rounded-full bg-white/10 px-6 py-2 font-medium text-white hover:bg-white/20"
        onclick={handleRetry}
      >
        <RefreshCw class="mr-2 h-4 w-4" />
        {$t("stream.reconnect", "Reconnect")}
      </Button>
    </div>
  {:else if connectionStatus === "ended"}
    <div
      class="flex max-h-full max-w-md flex-col items-center gap-4 overflow-y-auto p-8 text-center text-white"
      transition:fade
    >
      <div
        class="mb-2 flex h-16 w-16 items-center justify-center rounded-full bg-zinc-800 text-zinc-400"
      >
        <VideoOff class="h-8 w-8" />
      </div>
      <h3 class="text-xl font-bold">
        {$t("stream.endedTitle", "Stream Ended")}
      </h3>
      <p class="text-gray-300">
        {$t("stream.endedDescription", "The broadcast has finished.")}
      </p>
      <Button
        class="mt-4 rounded-full bg-white/10 px-6 py-2 font-medium text-white hover:bg-white/20"
        href={`/${username}`}
      >
        {$t("comments.viewProfile", "View profile")}
      </Button>
    </div>
  {:else if error}
    <div
      class="flex max-h-full max-w-md flex-col items-center gap-4 overflow-y-auto p-8 text-center text-white"
      transition:fade
    >
      <div
        class="mb-2 flex h-16 w-16 items-center justify-center rounded-full bg-red-500/20 text-red-500"
      >
        {#if isPaymentRequired}
          <Lock class="h-8 w-8" />
        {:else}
          <AlertCircle class="h-8 w-8" />
        {/if}
      </div>
      <h3 class="text-xl font-bold">
        {$t("stream.unableToJoin", "Unable to Join")}
      </h3>
      <p class="text-gray-300">{error}</p>

      {#if insufficientFunds}
        <div class="w-full max-w-md text-left">
          <InsufficientFunds funds={insufficientFunds} />
        </div>
      {/if}

      {#if streamType === "subscribers-only" && isPaymentRequired}
        <Button
          class="mt-4 rounded-full bg-blue-600 px-6 py-2 font-medium text-white hover:bg-blue-700"
          onclick={openSubscribe}
        >
          {isSubscribed
            ? $t("profile.subscribe.manage", "Manage subscription")
            : $t("profile.subscribe.title", "Subscribe to {username}", {
                username,
              })}
        </Button>
      {:else if streamType === "ppv" && isPaymentRequired}
        <div class="mt-4 flex w-full flex-col gap-2">
          <p class="text-sm text-gray-400">
            {$t(
              "stream.ppv.shortDescription",
              "This is a Pay-Per-View stream.",
            )}
          </p>
          <Button
            class="w-full rounded-full bg-green-600 px-6 py-2 font-medium text-white hover:bg-green-700"
            onclick={openPPV}
          >
            {compareDecimalText(ppvPrice, "0") > 0
              ? $t(
                  "stream.ppv.startWatchingRate",
                  "Start Watching ({amount} 2Z/min)",
                  { amount: formatAmount(ppvPrice) },
                )
              : $t("stream.ppv.startWatching", "Start Watching")}
          </Button>
        </div>
      {:else}
        <Button
          class="mt-4 rounded-full bg-white/10 px-6 py-2 font-medium text-white hover:bg-white/20"
          onclick={handleRetry}
        >
          <RefreshCw class="mr-2 h-4 w-4" />
          {$t("creators.retry", "Try again")}
        </Button>
      {/if}

      {#if otherStreams.length > 0}
        <div class="mt-6 w-full border-t border-white/10 pt-6">
          <h4 class="mb-3 text-sm font-medium text-gray-400">
            {$t("stream.otherActiveStreams", "Other active streams:")}
          </h4>
          <div class="flex flex-col gap-2">
            {#each otherStreams as stream}
              <Button
                class="w-full justify-start bg-white/5 text-white hover:bg-white/10"
                onclick={() => goto(streamWatchPath(username, stream.type))}
              >
                <span
                  >{$t("stream.watchAlternative", "Watch {type} ({viewers})", {
                    type: streamTypeLabel(stream.type),
                    viewers: viewerCount(stream.participant_count),
                  })}</span
                >
              </Button>
            {/each}
          </div>
        </div>
      {/if}
    </div>
  {:else if meeting}
    <InlineRtkMeeting {meeting} translator={rtkTranslator} />
    <RtkAudioHealth
      {meeting}
      mode={isHost ? "host" : "viewer"}
      onReconnect={handleRetry}
    />

    <!-- Persistent Warning for Host (e.g. Permission Denied) -->
    {#if warning && isHost}
      <div
        class="absolute top-4 left-1/2 z-50 flex max-w-[90%] -translate-x-1/2 items-center gap-3 rounded-lg bg-yellow-500/90 px-4 py-2 text-black shadow-lg backdrop-blur-sm"
        transition:fade
      >
        <div class="shrink-0">
          <MicOff class="h-5 w-5" />
        </div>
        <span class="text-sm font-medium">{warning}</span>
        <Button
          variant="ghost"
          size="icon"
          class="ml-2 h-6 w-6 rounded-full text-primary-foreground hover:bg-black/10"
          onclick={() => {
            warningSource = null;
            warningCode = null;
          }}
        >
          <span class="sr-only">{$t("navigation.dismiss", "Dismiss")}</span>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="lucide lucide-x"
            ><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg
          >
        </Button>
      </div>
    {/if}
  {/if}
</div>

{#if creator}
  <SubscribeToCreator
    {creator}
    bind:open={showSubscribe}
    onOpenChange={(open) => {
      showSubscribe = open;
      if (!open) {
        // Optional: retry joining if they closed the modal (assuming they might have subscribed)
        // But better to let them click "Try Again" or handle it in onSuccess if we added it.
        // For now, manual retry is fine.
      }
    }}
  />

  <PayPerViewPrompt
    price={ppvPrice}
    bind:open={showPPV}
    onSuccess={() => {
      joinStream();
    }}
  />
{/if}
