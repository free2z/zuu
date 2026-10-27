<script lang="ts">
  import { LocalizedError } from "$lib/i18n-message";
  import type { PageData } from "./$types";
  import { onMount, onDestroy } from "svelte";
  import { get } from "svelte/store";
  import { browser } from "$app/env";
  import { beforeNavigate } from "$app/navigation";
  import { authStore, currentUser } from "$lib/stores/auth";
  import { goto } from "$app/navigation";
  import {
    AlreadyLiveElsewhereError,
    StreamService,
    type PublicStreamType,
  } from "$lib/services/stream";
  import {
    HOST_SEAT_RECHECK_MS,
    classifyHostSeat,
    newHostSession,
    openHostSeatChannel,
    startHostSeatHeartbeat,
  } from "$lib/utils/host-seat.js";
  import { initRtkMeeting } from "$lib/utils/rtk-manager";
  import {
    liveStreamStore,
    participantCount,
    isConnected,
  } from "$lib/stores/liveStreamStore";
  import type { StreamType } from "$lib/stores/liveStreamStore";
  import { defineCustomElements } from "@cloudflare/realtimekit-ui/loader";
  import {
    provideRtkDesignSystem,
    generateConfig,
  } from "@cloudflare/realtimekit-ui";
  import {
    Users,
    Radio,
    Video,
    Lock,
    WifiOff,
    Mic,
    Settings,
    Copy,
    Check,
    MonitorSmartphone,
    ArrowRightLeft,
    RefreshCw,
  } from "@lucide/svelte";
  import TuziMark from "$lib/components/TuziMark.svelte";
  import { Button, buttonVariants } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Label } from "$lib/components/ui/label";
  import { createMediaQuery } from "$lib/utils/media-query";
  import * as Dialog from "$lib/components/ui/dialog";
  import * as Drawer from "$lib/components/ui/drawer";
  import * as Select from "$lib/components/ui/select/index.js";
  import AudioRecorder from "$lib/components/stream/AudioRecorder.svelte";
  import HostRecordingControls from "$lib/components/stream/HostRecordingControls.svelte";
  import { withoutNativeRecording } from "$lib/utils/recording-controls";
  import RtkAudioHealth from "$lib/components/stream/RtkAudioHealth.svelte";
  import { captureAccountToast, toast } from "$lib/toast.js";
  import PageHeader from "$lib/components/PageHeader.svelte";
  import { formatLocalizedNumber, locale, tStore as t } from "$lib/i18n";
  import { ppvJoinThreshold } from "$lib/ppv-join-threshold.js";
  import { getRtkTranslator } from "$lib/rtk-i18n";
  import { copyToClipboard } from "$lib/utils/clipboard";
  import { streamWatchPath } from "$lib/utils/stream-path";
  import { cn } from "$lib/utils.js";

  export let data: PageData;

  $: username = data.username;
  // We can use the currentUser store directly as it was in the component
  $: user = $currentUser;
  let authGuardReady = false;
  $: meeting = $liveStreamStore.meeting;
  $: connected = $isConnected;
  $: count = $participantCount;
  $: isOffline = $liveStreamStore.isOffline;

  function formatDecimal(value: number) {
    return new Intl.NumberFormat($locale, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }).format(value);
  }

  let streamType: StreamType = "broadcast";
  let ppvPrice: number = 1;
  type AudienceMode = {
    value: StreamType;
    icon: "broadcast" | "subscribers" | "ppv" | "private";
    accent: {
      selected: string;
      idle: string;
      iconSelected: string;
      iconIdle: string;
      detail: string;
    };
    titleKey: string;
    titleFallback: string;
    descriptionKey: string;
    descriptionFallback: string;
    summaryKey: string;
    summaryFallback: string;
    costKey: string;
    costFallback: string;
  };

  const audienceModes: AudienceMode[] = [
    {
      value: "broadcast",
      icon: "broadcast",
      accent: {
        selected: "border-primary bg-primary/5 ring-primary/10",
        idle: "border-border bg-card hover:border-primary/50 hover:bg-card",
        iconSelected: "bg-primary text-primary-foreground",
        iconIdle:
          "bg-muted text-muted-foreground group-hover:bg-primary/20 group-hover:text-primary",
        detail: "border-primary/20 bg-primary/5",
      },
      titleKey: "dashboard.stream.types.broadcast.title",
      titleFallback: "Broadcast",
      descriptionKey: "dashboard.stream.types.broadcast.description",
      descriptionFallback: "Public and free for everyone. Maximize your reach.",
      summaryKey: "dashboard.stream.types.broadcast.summary",
      summaryFallback:
        "Creator pays about 1 2Z per 2 minutes per viewer session.",
      costKey: "dashboard.stream.types.broadcast.cost",
      costFallback:
        "Cost: about 1 2Z per 2 minutes for each viewer session — a session of a minute or less is free, and a reconnect starts a new session.",
    },
    {
      value: "subscribers-only",
      icon: "subscribers",
      accent: {
        selected: "border-purple-500 bg-purple-500/5 ring-purple-500/10",
        idle: "border-border bg-card hover:border-purple-500/50 hover:bg-card",
        iconSelected: "bg-purple-500 text-white",
        iconIdle:
          "bg-muted text-muted-foreground group-hover:bg-purple-500/20 group-hover:text-purple-500",
        detail: "border-purple-500/20 bg-purple-500/5",
      },
      titleKey: "dashboard.stream.types.subscribers.title",
      titleFallback: "Subscribers",
      descriptionKey: "dashboard.stream.types.subscribers.description",
      descriptionFallback: "Exclusive content for your monthly supporters.",
      summaryKey: "dashboard.stream.types.subscribers.summary",
      summaryFallback: "Free — no 2Z is charged.",
      costKey: "dashboard.stream.types.subscribers.cost",
      costFallback: "Free — no 2Z is charged.",
    },
    {
      value: "ppv",
      icon: "ppv",
      accent: {
        selected: "border-green-500 bg-green-500/5 ring-green-500/10",
        idle: "border-border bg-card hover:border-green-500/50 hover:bg-card",
        iconSelected: "bg-green-500 text-white",
        iconIdle:
          "bg-muted text-muted-foreground group-hover:bg-green-500/20 group-hover:text-green-500",
        detail: "border-green-500/20 bg-green-500/5",
      },
      titleKey: "dashboard.stream.types.ppv.title",
      titleFallback: "Pay Per View",
      descriptionKey: "dashboard.stream.types.ppv.description",
      descriptionFallback: "Monetize directly. Viewers pay per minute.",
      summaryKey: "dashboard.stream.types.ppv.summary",
      summaryFallback: "Viewers pay; you set the per-minute price.",
      costKey: "dashboard.stream.types.ppv.cost",
      costFallback:
        "Viewers pay, not you: viewers need a 30-minute entry reserve plus the platform fee to join. Once admitted, they pay your per-minute price for time watched (rounded up to a whole 2Z) plus about 1 2Z per 2 minutes of platform fee — a session of a minute or less carries no platform fee.",
    },
    {
      value: "private",
      icon: "private",
      accent: {
        selected: "border-orange-500 bg-orange-500/5 ring-orange-500/10",
        idle: "border-border bg-card hover:border-orange-500/50 hover:bg-card",
        iconSelected: "bg-orange-500 text-white",
        iconIdle:
          "bg-muted text-muted-foreground group-hover:bg-orange-500/20 group-hover:text-orange-500",
        detail: "border-orange-500/20 bg-orange-500/5",
      },
      titleKey: "dashboard.stream.types.private.title",
      titleFallback: "Private",
      descriptionKey: "dashboard.stream.types.private.description",
      descriptionFallback: "One-on-one private call. Generate a secret link.",
      summaryKey: "dashboard.stream.types.private.summary",
      summaryFallback: "Free — no 2Z is charged.",
      costKey: "dashboard.stream.types.private.cost",
      costFallback: "Free — no 2Z is charged.",
    },
  ];
  $: selectedAudience =
    audienceModes.find((mode) => mode.value === streamType) ?? audienceModes[0];
  $: joinThreshold = ppvJoinThreshold(ppvPrice);
  let loading = false;
  let error: string | null = null;
  let privateResumeAvailable = false;
  let cleanup: (() => void | Promise<void>) | null = null;
  let isLeaving = false;
  let meetingEl: HTMLElement;
  let hostMeetingError = false;
  // Wait for the web component's initial preset setup before attaching the
  // meeting, so its native Record toggle is never mounted for a host.
  function hostMeeting(node: HTMLElement, current: typeof meeting) {
    let generation = 0;
    async function apply(next: typeof meeting) {
      const ownGeneration = ++generation;
      const element = node as HTMLElement & {
        componentOnReady(): Promise<unknown>;
        loadConfigFromPreset: boolean;
        config: unknown;
        meeting: typeof meeting;
      };
      try {
        await element.componentOnReady();
        if (ownGeneration !== generation || !next) return;
        element.loadConfigFromPreset = streamType === "private";
        const config = generateConfig(next.self.config, next).config;
        element.config =
          streamType === "private" ? config : withoutNativeRecording(config);
        element.meeting = next;
        hostMeetingError = false;
      } catch {
        if (ownGeneration === generation) hostMeetingError = true;
      }
    }
    void apply(current);
    return {
      update: apply,
      destroy() {
        generation++;
      },
    };
  }
  let linkCopied = false;
  let linkCopiedTimeout: ReturnType<typeof setTimeout>;
  let destroyed = false;

  // The broadcaster seat. One tab per creator publishes; the server
  // enforces it (409 `already_live_elsewhere`) and this tab mirrors it:
  //   checking   -- asking the server (and sibling tabs) who holds the seat;
  //   free       -- nobody: the normal Go live form;
  //   elsewhere  -- another tab/device is live: offer a deliberate take-over;
  //   live       -- this tab holds the seat and renews it;
  //   superseded -- another tab/device took it over; this tab has left.
  type SeatState = "checking" | "free" | "elsewhere" | "live" | "superseded";
  let seatState: SeatState = "checking";
  let elsewhereType: PublicStreamType | null = null;
  // One id per page load, never persisted: see newHostSession().
  // Rotated after every release (see endSeat) so a release still in flight
  // can never clear the seat a retry from this same tab just took.
  let hostSession = browser ? newHostSession() : "";
  let seatChannel: ReturnType<typeof openHostSeatChannel> | null = null;
  let stopHeartbeat: (() => void) | null = null;
  let recheckTimer: ReturnType<typeof setInterval> | undefined;
  let superseded = false;

  type HostOwner = { id: number; username: string; generation: number };
  let accountGeneration = 0;
  let account: { id: number; username: string } | null = null;
  let startController: AbortController | null = null;
  type OwnedSeat = { actor: HostOwner; session: string };
  let seatOwner: OwnedSeat | null = null;
  // One creator can hold only one seat. Keep that abandoned grant until its
  // actor returns, rather than losing it when we cannot release with B's auth.
  let abandonedSeat: OwnedSeat | null = null;
  let releaseInFlight: { actor: HostOwner; promise: Promise<void> } | null =
    null;
  let ownedMeeting: unknown = null;

  function isSameAccount(owner: HostOwner) {
    // A response can outlive this component and its subscription. Read the
    // live store before issuing a release with the browser's current session.
    const actor = get(currentUser);
    return (
      !!actor && actor.id === owner.id && actor.username === owner.username
    );
  }

  function isCurrentOwner(owner: HostOwner) {
    return (
      !destroyed &&
      owner.generation === accountGeneration &&
      isSameAccount(owner) &&
      data.username === owner.username
    );
  }

  function captureOwner(): HostOwner | null {
    if (!account || account.username !== data.username || destroyed)
      return null;
    return { ...account, generation: accountGeneration };
  }

  function releaseOwnedSeat(seat: OwnedSeat, keepalive = false) {
    if (!isSameAccount(seat.actor)) {
      if (!destroyed) abandonedSeat = seat;
      return;
    }
    const request = StreamService.releaseHostSeat(
      seat.actor.username,
      seat.session,
      { keepalive },
    );
    const previous = releaseInFlight?.promise;
    const pending = {
      actor: seat.actor,
      promise: previous
        ? Promise.all([previous, request]).then(() => {})
        : request,
    };
    releaseInFlight = pending;
    void pending.promise.finally(() => {
      if (releaseInFlight === pending) releaseInFlight = null;
    });
  }

  async function waitForOwnedRelease(owner: HostOwner) {
    const pending = releaseInFlight;
    if (
      pending &&
      pending.actor.id === owner.id &&
      pending.actor.username === owner.username
    ) {
      await pending.promise;
    }
  }

  // A synchronous subscription observes A -> B -> A even when Svelte batches
  // both changes into one render. A later return to A never revives its work.
  const unsubscribeAccount = browser
    ? currentUser.subscribe((creator) => {
        const next = creator
          ? { id: creator.id, username: creator.username }
          : null;
        if (account?.id === next?.id && account?.username === next?.username)
          return;
        account = next;
        accountGeneration++;
        startController?.abort();
        startController = null;
        endSeat();
        if (abandonedSeat && isSameAccount(abandonedSeat.actor)) {
          const released = abandonedSeat;
          abandonedSeat = null;
          releaseOwnedSeat(released);
        }
        clearInterval(recheckTimer);
        seatChannel?.close();
        seatChannel = null;
        const leave = cleanup;
        cleanup = null;
        if (ownedMeeting && get(liveStreamStore).meeting === ownedMeeting) {
          liveStreamStore.reset();
        }
        ownedMeeting = null;
        if (leave) void Promise.resolve(leave()).catch(console.warn);
        hostSession = newHostSession();
        seatState = "checking";
        elsewhereType = null;
        superseded = false;
        loading = false;
        error = null;
        privateResumeAvailable = false;
        isLeaving = false;
        linkCopied = false;
        clearTimeout(linkCopiedTimeout);
      })
    : () => {};

  $: streamSharePath =
    streamType === "private" ? null : streamWatchPath(username, streamType);

  // Stream Settings
  let videoQuality = "720p";
  let qualityOptions: { value: string; label: string }[] = [];
  $: videoQualityLabel =
    qualityOptions.find((o) => o.value === videoQuality)?.label ??
    $t("dashboard.stream.quality.hd", "HD (720p)");

  // A transient auth failure leaves the store unresolved while its bounded
  // retries run. Only an authoritative anonymous result may redirect here;
  // the server-side owner check remains the source of truth for this route.
  $: if (
    browser &&
    authGuardReady &&
    !destroyed &&
    ($authStore.status === "anonymous" ||
      ($authStore.status === "authenticated" &&
        user !== null &&
        user.username !== username))
  ) {
    authGuardReady = false;
    goto("/");
  }
  const isDesktop = createMediaQuery("(min-width: 768px)");
  let settingsOpen = false;

  $: if (meetingEl) {
    provideRtkDesignSystem(meetingEl, {
      theme: "dark",
      borderRadius: "rounded",
      borderWidth: "thin",
      colors: {
        brand: {
          300: "#bef264", // Lime-300
          400: "#a3e635", // Lime-400
          500: "#84cc16", // Lime-500 (Primary)
          600: "#65a30d", // Lime-600
          700: "#4d7c0f", // Lime-700
        },
        background: {
          1000: "#060f06", // Black Green (App Secondary BG)
          900: "#0a160a",
          800: "#112211",
          700: "#1a2e1a",
          600: "#243a24",
        },
        text: "#ffffff",
        "text-on-brand": "#000000",
        "video-bg": "#060f06",
        danger: "#ef4444", // Red-500
        success: "#84cc16", // Lime-500
        warning: "#eab308", // Yellow-500
      },
    });
  }

  $: qualityOptions = [
    { value: "360p", label: $t("dashboard.stream.quality.low", "Low (360p)") },
    {
      value: "480p",
      label: $t("dashboard.stream.quality.standard", "Standard (480p)"),
    },
    { value: "720p", label: $t("dashboard.stream.quality.hd", "HD (720p)") },
    {
      value: "1080p",
      label: $t("dashboard.stream.quality.fullHd", "Full HD (1080p)"),
    },
  ];

  function isPublicType(value: unknown): value is PublicStreamType {
    return (
      value === "broadcast" || value === "subscribers-only" || value === "ppv"
    );
  }

  function showLiveElsewhere(type: unknown) {
    if (seatState === "live") return;
    seatState = "elsewhere";
    elsewhereType = isPublicType(type) ? type : elsewhereType;
    clearInterval(recheckTimer);
    // Keep the panel honest: when the other tab ends (or its seat lapses)
    // this one goes back to the normal form without a reload.
    recheckTimer = setInterval(() => void refreshSeat(), HOST_SEAT_RECHECK_MS);
  }

  function showSeatFree() {
    clearInterval(recheckTimer);
    recheckTimer = undefined;
    elsewhereType = null;
    if (seatState === "checking" || seatState === "elsewhere") {
      seatState = "free";
    }
  }

  async function refreshSeat() {
    const owner = captureOwner();
    if (!owner || seatState === "live") return;
    try {
      await waitForOwnedRelease(owner);
      if (!isCurrentOwner(owner)) return;
      const status = await StreamService.fetchHostSeat(owner.username);
      // Re-read after the await: this tab may have gone live meanwhile.
      if (!isCurrentOwner(owner) || (seatState as SeatState) === "live") return;
      if (classifyHostSeat(status, hostSession) === "elsewhere") {
        showLiveElsewhere(status.meeting_type);
      } else if (seatState !== "superseded") {
        showSeatFree();
      }
    } catch (err) {
      // Unknown is not "live elsewhere": the server still refuses a second
      // broadcast, so fall back to the form rather than blocking it.
      if (!isCurrentOwner(owner)) return;
      console.warn("Could not read the broadcaster seat:", err);
      if (seatState === "checking") seatState = "free";
    }
  }

  function initSeat() {
    const owner = captureOwner();
    if (!browser || !owner || seatChannel) return;
    seatChannel = openHostSeatChannel({
      username: owner.username,
      session: hostSession,
      isLive: () => (seatState === "live" ? streamType : null),
      onPeerLive: (message) => {
        if (isCurrentOwner(owner)) showLiveElsewhere(message.meetingType);
      },
      onPeerEnded: () => {
        if (isCurrentOwner(owner)) void refreshSeat();
      },
      onTakeover: (message) => {
        if (!isCurrentOwner(owner)) return;
        if (seatState === "live") {
          void handleSuperseded();
        } else {
          showLiveElsewhere(message.meetingType);
        }
      },
    });
    // A live sibling tab in this browser answers at once; the server answers
    // for every other device.
    seatChannel.query();
    void refreshSeat();
  }

  function beginSeat(
    type: StreamType,
    tookOver: boolean,
    owner: HostOwner,
    session: string,
  ) {
    seatOwner = { actor: owner, session };
    seatState = "live";
    superseded = false;
    elsewhereType = null;
    clearInterval(recheckTimer);
    recheckTimer = undefined;
    if (tookOver) seatChannel?.announceTakeover(type);
    seatChannel?.announceLive(type);
    stopHeartbeat?.();
    stopHeartbeat = startHostSeatHeartbeat({
      beat: () => StreamService.heartbeatHostSeat(owner.username, session),
      onSuperseded: () => {
        if (isCurrentOwner(owner)) void handleSuperseded();
      },
    });
  }

  function endSeat({ keepalive = false }: { keepalive?: boolean } = {}) {
    stopHeartbeat?.();
    stopHeartbeat = null;
    if (seatState !== "live") return;
    seatState = "free";
    seatChannel?.announceEnded();
    const released = seatOwner;
    seatOwner = null;
    // The next start from this tab is a NEW seat. Reusing the id would let
    // this unawaited release land after a retry had resumed it, and the
    // retry's next heartbeat would read as a take-over (codex review).
    hostSession = newHostSession();
    // A release uses the browser's current credentials. Never send A's
    // request with B's session; without heartbeats the existing lease expires.
    if (released) releaseOwnedSeat(released, keepalive);
  }

  // Another tab or device took the broadcast over. Leave the room at once --
  // two publishers is exactly what the seat exists to prevent -- and say so.
  async function handleSuperseded() {
    const owner = captureOwner();
    if (!owner || superseded) return;
    superseded = true;
    startController?.abort();
    stopHeartbeat?.();
    stopHeartbeat = null;
    seatState = "superseded";
    isLeaving = true;
    if (cleanup) {
      const leave = cleanup;
      cleanup = null;
      try {
        await leave();
      } catch (err) {
        console.warn("Leaving the room after a take-over failed:", err);
      }
    }
    if (!isCurrentOwner(owner)) return;
    isLeaving = false;
    toast.info(
      $t(
        "dashboard.stream.seat.supersededToast",
        "Your broadcast moved to another tab or device.",
      ),
    );
  }

  function handlePageHide() {
    // A reload or a closed tab gives the seat back right away, so the next
    // page load is not told it is "live elsewhere" by its own ghost. If this
    // never arrives, the seat lapses after a minute without heartbeats.
    endSeat({ keepalive: true });
  }

  function handleBeforeUnload(event: BeforeUnloadEvent) {
    if (!connected || isLeaving) return;
    event.preventDefault();
    event.returnValue = "";
    return "";
  }

  function handleOnline() {
    liveStreamStore.setOffline(false);
    toast.success(
      $t("dashboard.stream.connectionRestored", "Connection restored!"),
    );
  }

  function handleOffline() {
    liveStreamStore.setOffline(true);
    toast.error(
      $t(
        "dashboard.stream.offlineWarning",
        "You are offline. The stream may be interrupted.",
      ),
    );
  }

  beforeNavigate(({ cancel, to }) => {
    if (connected && !isLeaving) {
      if (
        !confirm(
          $t(
            "dashboard.stream.leaveConfirmation",
            "The stream is active. Are you sure you want to leave? This will end the stream.",
          ),
        )
      ) {
        cancel();
      } else {
        if (to) {
          cancel();
          isLeaving = true;

          const owner = captureOwner();
          const cleanupAndNavigate = async () => {
            const leave = cleanup;
            cleanup = null;
            if (leave) await leave();
            if (owner && isCurrentOwner(owner)) goto(to.url);
          };
          cleanupAndNavigate();
        } else {
          isLeaving = true;
        }
      }
    }
  });

  onMount(async () => {
    defineCustomElements();

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    // Initial check
    if (!navigator.onLine) {
      handleOffline();
    }

    // Server-side protection is in +page.server.ts. Wait for the shared auth
    // bootstrap before applying the client-side fallback: on a cold tab the
    // store starts as `unknown`, and redirecting on that transient value can
    // discard a valid SSR-authorized dashboard while /api/auth/user/ is still
    // resolving.
    await authStore.checkAuth({ silent: true });
    if (destroyed) return;
    authGuardReady = true;
    window.addEventListener("pagehide", handlePageHide);
  });

  // The seat check needs the signed-in creator, which may resolve after
  // mount on a cold tab.
  $: if (browser && authGuardReady && user && user.username === username) {
    initSeat();
  }

  onDestroy(() => {
    destroyed = true;
    unsubscribeAccount();
    startController?.abort();
    authGuardReady = false;
    endSeat();
    clearInterval(recheckTimer);
    seatChannel?.close();
    seatChannel = null;
    if (cleanup) void Promise.resolve(cleanup()).catch(console.warn);
    clearTimeout(linkCopiedTimeout);
    if (browser) {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("pagehide", handlePageHide);
    }
  });

  async function startStream({ takeover = false } = {}) {
    const owner = captureOwner();
    if (!owner || !user || loading) return;

    if (!user.can_stream) {
      error = $t(
        "dashboard.stream.insufficientTuzis",
        "You need at least 150 2Z to start a live stream.",
      );
      return;
    }

    loading = true;
    error = null;
    privateResumeAvailable = false;

    // A take-over continues the broadcast that is already live, so it is
    // that stream's type -- not whatever card this tab had selected (which
    // may be Private: that must never turn "Take over here" into a new
    // private room). Resolved before anything branches on the type.
    if (takeover && elsewhereType) streamType = elsewhereType;
    if (takeover && streamType === "private") {
      // The live type is unknown; never guess it into a private room.
      loading = false;
      void refreshSeat();
      return;
    }

    const startType = streamType;
    const session = hostSession;
    const quality = videoQuality;
    const price = ppvPrice;
    const controller = new AbortController();
    const operationNotice = captureAccountToast();
    startController = controller;
    const isCurrentStart = () =>
      isCurrentOwner(owner) &&
      operationNotice.isCurrent() &&
      startController === controller;

    try {
      if (startType === "private") {
        // Private stream flow
        const { secret } = await StreamService.createPrivateStream(
          owner.username,
        );
        if (!isCurrentStart()) return;

        // Copy link to clipboard
        const url = `${window.location.origin}/${owner.username}/private/${secret}`;
        try {
          await navigator.clipboard.writeText(url);
          if (!isCurrentStart()) return;
          operationNotice.success(
            $t(
              "dashboard.stream.secretLinkCopied",
              "Secret link copied to the clipboard!",
            ),
          );
        } catch (e) {
          if (!isCurrentStart()) return;
          console.error("Failed to copy link", e);
          operationNotice.error(
            $t(
              "dashboard.stream.copyLinkOnNextPage",
              "The stream was created. Select “Copy Link” on the next page.",
            ),
          );
        }

        if (!isCurrentStart()) return;
        await goto(`/${owner.username}/private/${secret}`);
        return;
      }

      // A returning actor's old lease must be released before asking for a
      // fresh seat; a different session cannot resume the abandoned grant.
      await waitForOwnedRelease(owner);
      if (!isCurrentStart()) return;

      // 1. Initialize Stream via API. The server decides who broadcasts:
      // a seat held by another tab is a 409 unless this is a take-over.
      let auth_token: string;
      try {
        ({ auth_token } = await StreamService.initStream(
          owner.username,
          startType,
          {
            pricePerMinute: startType === "ppv" ? price : undefined,
            role: "host",
            hostSession: session,
            takeover,
          },
        ));
      } catch (err) {
        if (!isCurrentStart()) return;
        if (err instanceof AlreadyLiveElsewhereError) {
          showLiveElsewhere(err.meetingType);
          return;
        }
        throw err;
      }
      // The page may have been left while the start was in flight. The
      // server has granted a seat nobody here will renew or use: give it
      // back instead of starting a heartbeat for a destroyed component.
      if (!isCurrentStart()) {
        releaseOwnedSeat({ actor: owner, session });
        return;
      }
      beginSeat(startType, takeover, owner, session);

      // Helper to get constraints
      const getVideoConstraints = (quality: string) => {
        switch (quality) {
          case "1080p":
            return { height: { ideal: 1080 }, width: { ideal: 1920 } };
          case "720p":
            return { height: { ideal: 720 }, width: { ideal: 1280 } };
          case "480p":
            return { height: { ideal: 480 }, width: { ideal: 854 } };
          case "360p":
            return { height: { ideal: 360 }, width: { ideal: 640 } };
          default:
            return { height: { ideal: 720 }, width: { ideal: 1280 } };
        }
      };

      // 2. Initialize RealtimeKit Meeting
      const { cleanup: cleanupFn, meeting: meetingInstance } =
        await initRtkMeeting({
          authToken: auth_token,
          streamType: startType,
          isHost: true,
          signal: controller.signal,
          defaults: {
            audio: true,
            video: true,
            mediaConfiguration: {
              video: getVideoConstraints(quality),
            },
          },
        });
      // The seat may have moved while RealtimeKit was initializing (a camera
      // permission prompt can take as long as the user likes), or the page
      // may be gone. Either way this tab must not end up holding a host
      // meeting it has no seat for: dispose of it instead of rendering it.
      if (superseded || !isCurrentStart()) {
        await cleanupFn();
        return;
      }
      cleanup = cleanupFn;
      ownedMeeting = meetingInstance;

      if (meetingInstance) {
        meetingInstance.self.on(
          "roomLeft",
          async ({ state }: { state: string }) => {
            // Leaving because another tab took over is not "stream ended":
            // handleSuperseded() owns that exit and its message.
            if (superseded || !isCurrentStart()) return;
            if (state === "left" || state === "ended") {
              isLeaving = true;
              endSeat();
              const leave = cleanup;
              cleanup = null;
              if (leave) await leave();
              if (!isCurrentStart()) return;
              operationNotice.success(
                $t("dashboard.stream.ended", "Stream ended."),
              );
              goto(`/${owner.username}/dashboard/pages`);
            }
          },
        );
      }

      operationNotice.success(
        $t(
          "dashboard.stream.started",
          "The stream started successfully. You are live!",
        ),
      );
    } catch (err: any) {
      if (!isCurrentStart() || controller.signal.aborted) return;
      console.error("Failed to start stream:", err);
      // The seat may have been taken before the room join failed; this tab is
      // not broadcasting, so give it back rather than lock out a retry.
      endSeat();
      error =
        startType === "private" && err instanceof LocalizedError
          ? err.message
          : $t("dashboard.stream.startFailed", "Failed to start the stream.");
      privateResumeAvailable =
        startType === "private" &&
        err instanceof LocalizedError &&
        err.code.startsWith("privateCall.recording");
      operationNotice.error(error);
    } finally {
      if (isCurrentStart()) loading = false;
    }
  }

  async function returnToPrivateCall() {
    const owner = captureOwner();
    if (!owner || loading || !privateResumeAvailable) return;
    const notice = captureAccountToast();
    loading = true;
    try {
      const { secret } = await StreamService.currentPrivateStream(
        owner.username,
      );
      if (!isCurrentOwner(owner) || !notice.isCurrent()) return;
      await goto(`/${owner.username}/private/${secret}`);
    } catch {
      if (isCurrentOwner(owner) && notice.isCurrent()) {
        notice.error(
          $t(
            "privateCall.resumeFailed",
            "The current call could not be opened. Retry in a moment.",
          ),
        );
      }
    } finally {
      if (isCurrentOwner(owner)) loading = false;
    }
  }

  async function copyStreamLink() {
    const owner = captureOwner();
    const sharePath = streamSharePath;
    if (!owner || !sharePath || !browser) return;
    const operationNotice = captureAccountToast();
    const isCurrentCopy = () =>
      isCurrentOwner(owner) &&
      operationNotice.isCurrent() &&
      streamSharePath === sharePath;

    const copied = await copyToClipboard(
      new URL(sharePath, window.location.origin).toString(),
    );
    if (!isCurrentCopy()) return;
    if (copied) {
      linkCopied = true;
      operationNotice.success(
        $t(
          "dashboard.stream.viewerLinkCopied",
          "Viewer link copied to the clipboard!",
        ),
      );
      clearTimeout(linkCopiedTimeout);
      linkCopiedTimeout = setTimeout(() => {
        if (isCurrentCopy()) linkCopied = false;
      }, 2000);
    } else {
      operationNotice.error(
        $t(
          "dashboard.stream.viewerLinkCopyFailed",
          "Failed to copy the viewer link.",
        ),
      );
    }
  }
</script>

<svelte:head>
  <title
    >{$t("dashboard.stream.metaTitle", "Stream Dashboard - {username}", {
      username: username || "",
    })}</title
  >
</svelte:head>

<svelte:window on:beforeunload={handleBeforeUnload} />

<div class="flex w-full flex-1 flex-col">
  {#if !connected && !meeting}
    <PageHeader
      title={$t("dashboard.pages.goLive", "Go live")}
      titleSuffix="."
      subtitle={$t(
        "dashboard.stream.subtitle",
        "Choose your audience and start streaming.",
      )}
      onBack={() => goto(`/${username}/dashboard/pages`)}
    />
  {/if}

  <div
    class={!connected && !meeting
      ? "mx-auto flex w-full max-w-7xl flex-1 flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8"
      : "flex h-screen w-full flex-col"}
  >
    <div class="relative flex h-full w-full flex-col">
      <!-- Connection/Offline Status -->
      {#if isOffline}
        <div
          class="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm"
        >
          <div
            class="flex animate-in flex-col items-center gap-4 rounded-xl border border-destructive bg-card p-6 text-center shadow-lg duration-300 fade-in zoom-in"
          >
            <div
              class="mb-2 flex h-16 w-16 animate-pulse items-center justify-center rounded-full bg-destructive/20 text-destructive"
            >
              <WifiOff class="h-8 w-8" />
            </div>
            <h3 class="text-xl font-bold text-destructive">
              {$t("dashboard.stream.connectionLost", "Connection Lost")}
            </h3>
            <p class="max-w-xs text-muted-foreground">
              {$t(
                "dashboard.stream.offlineDescription",
                "You are currently offline. The stream may be interrupted for viewers.",
              )}
            </p>
          </div>
        </div>
      {/if}

      {#if !connected && !meeting}
        <!-- Setup Form -->
        <div class="flex w-full flex-1 flex-col justify-center">
          {#if !user?.can_stream}
            <div
              class="mx-auto max-w-2xl rounded-xl border border-yellow-500/20 bg-yellow-500/10 p-6 text-center text-yellow-600 dark:text-yellow-400"
            >
              <p class="text-lg font-medium">
                {$t(
                  "dashboard.stream.insufficientTuzis",
                  "You need at least 150 2Z to start a live stream.",
                )}
              </p>
              <p class="mt-2 text-sm opacity-80">
                {$t(
                  "dashboard.stream.earnMoreTuzis",
                  "Earn more 2Z by engaging with the community.",
                )}
              </p>
            </div>
          {:else}
            <div class="mx-auto w-full max-w-5xl space-y-8">
              <!-- Stream Settings & Audio Check -->
              <div class="flex justify-end">
                {#if $isDesktop}
                  <Dialog.Root bind:open={settingsOpen}>
                    <Dialog.Trigger
                      class={buttonVariants({ variant: "outline", size: "sm" })}
                    >
                      <Settings size={16} class="mr-2" />
                      {$t("dashboard.stream.settings", "Settings")}
                    </Dialog.Trigger>
                    <Dialog.Content class="sm:max-w-[425px]">
                      <Dialog.Header>
                        <Dialog.Title
                          >{$t(
                            "dashboard.stream.settingsTitle",
                            "Stream Settings",
                          )}</Dialog.Title
                        >
                        <Dialog.Description>
                          {$t(
                            "dashboard.stream.settingsDescription",
                            "Configure your stream quality and test your audio.",
                          )}
                        </Dialog.Description>
                      </Dialog.Header>
                      <div class="space-y-6 py-4">
                        <div class="space-y-3">
                          <Label
                            >{$t(
                              "dashboard.stream.videoQuality",
                              "Video Quality",
                            )}</Label
                          >
                          <Select.Root type="single" bind:value={videoQuality}>
                            <Select.Trigger class="w-full">
                              {videoQualityLabel}
                            </Select.Trigger>
                            <Select.Content>
                              {#each qualityOptions as option}
                                <Select.Item
                                  value={option.value}
                                  label={option.label}
                                >
                                  {option.label}
                                </Select.Item>
                              {/each}
                            </Select.Content>
                          </Select.Root>
                          <p class="text-xs text-muted-foreground">
                            {$t(
                              "dashboard.stream.qualityHint",
                              "Higher quality requires a better internet connection.",
                            )}
                          </p>
                        </div>
                        <div class="space-y-3">
                          <AudioRecorder />
                        </div>
                      </div>
                    </Dialog.Content>
                  </Dialog.Root>
                {:else}
                  <Drawer.Root bind:open={settingsOpen}>
                    <Drawer.Trigger
                      class={buttonVariants({ variant: "outline", size: "sm" })}
                    >
                      <Settings size={16} class="mr-2" />
                      {$t("dashboard.stream.settings", "Settings")}
                    </Drawer.Trigger>
                    <Drawer.Content>
                      <Drawer.Header class="text-left">
                        <Drawer.Title
                          >{$t(
                            "dashboard.stream.settingsTitle",
                            "Stream Settings",
                          )}</Drawer.Title
                        >
                        <Drawer.Description>
                          {$t(
                            "dashboard.stream.settingsDescription",
                            "Configure your stream quality and test your audio.",
                          )}
                        </Drawer.Description>
                      </Drawer.Header>
                      <div class="space-y-6 px-4 py-4">
                        <div class="space-y-3">
                          <Label
                            >{$t(
                              "dashboard.stream.videoQuality",
                              "Video Quality",
                            )}</Label
                          >
                          <Select.Root type="single" bind:value={videoQuality}>
                            <Select.Trigger class="w-full">
                              {videoQualityLabel}
                            </Select.Trigger>
                            <Select.Content>
                              {#each qualityOptions as option}
                                <Select.Item
                                  value={option.value}
                                  label={option.label}
                                >
                                  {option.label}
                                </Select.Item>
                              {/each}
                            </Select.Content>
                          </Select.Root>
                          <p class="text-xs text-muted-foreground">
                            {$t(
                              "dashboard.stream.qualityHint",
                              "Higher quality requires a better internet connection.",
                            )}
                          </p>
                        </div>
                        <div class="space-y-3">
                          <AudioRecorder />
                        </div>
                      </div>
                      <Drawer.Footer class="pt-2">
                        <Drawer.Close
                          class={buttonVariants({ variant: "outline" })}
                          >{$t("common.close", "Close")}</Drawer.Close
                        >
                      </Drawer.Footer>
                    </Drawer.Content>
                  </Drawer.Root>
                {/if}
              </div>

              <!-- Stream Type Selection -->
              <!--
                The cost line under each card is the creator-facing contract
                and must track the billing in
                py/dj/apps/dyte/views.py (meeting.participantLeft):
                  duration_minutes = ceil(seconds / 60)          (rounds up)
                  platform_fee     = duration_minutes // 2       (0 under 2 min)
                  creator_fee      = ceil(price_per_minute * duration_minutes)
                broadcast bills the creator the platform fee per non-creator
                participant; ppv bills the *viewer* platform_fee + creator_fee;
                subscribers-only and private have no billing branch at all.

                The copy says "about 1 2Z every 2 minutes" rather than an exact
                formula on purpose: the fee rounds minutes UP and then the
                2-minute blocks DOWN, so 3:30 costs 2 2Z but 2:01 costs 1. An
                exact-sounding promise would be wrong at one end or the other;
                what IS always true is the free window, so that is stated
                outright. There is no longer a 1 2Z minimum: issue  removed
                the max(..., 1) floor, so a drive-by connect costs the creator
                nothing.

                MIND THE BOUNDARY when translating. The free window is
                "a minute or less", NOT "under two minutes": ceil() pushes 1:30
                to duration_minutes 2, which bills 1 2Z. 0:60 is the last free
                session; 1:01 is the first that costs anything. Do not tighten
                this wording without re-reading calculate_platform_fee().

                Orange/warning styling is reserved for the one mode where the
                creator actually spends (broadcast).
              -->
              <fieldset class="w-full min-w-0">
                <legend
                  class="mb-3 text-sm font-semibold text-muted-foreground"
                >
                  {$t("dashboard.stream.audienceLabel", "Choose your audience")}
                </legend>
                <div
                  data-testid="stream-audience-grid"
                  class="grid grid-cols-1 items-stretch gap-4 sm:grid-cols-2 xl:grid-cols-4"
                >
                  {#each audienceModes as mode (mode.value)}
                    {@const selected = streamType === mode.value}
                    <label
                      for={`stream-audience-${mode.value}`}
                      data-testid={`stream-audience-card-${mode.value}`}
                      data-audience-card={mode.value}
                      class={cn(
                        buttonVariants({ variant: "outline" }),
                        "group relative flex h-full w-full min-w-0 flex-col items-start justify-start rounded-xl border-2 p-5 text-left whitespace-normal transition-colors duration-200 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 hover:shadow-lg",
                        selected ? mode.accent.selected : mode.accent.idle,
                      )}
                    >
                      <input
                        id={`stream-audience-${mode.value}`}
                        class="sr-only"
                        type="radio"
                        name="stream-audience"
                        value={mode.value}
                        bind:group={streamType}
                        aria-labelledby={`stream-audience-title-${mode.value}`}
                        aria-describedby={`stream-audience-description-${mode.value} stream-audience-summary-${mode.value}`}
                      />
                      <span
                        data-audience-selection-slot
                        class="absolute top-4 right-4 flex size-6 shrink-0 items-center justify-center"
                        aria-hidden="true"
                      >
                        {#if selected}
                          <span
                            class={`flex size-5 items-center justify-center rounded-full ${mode.accent.iconSelected}`}
                          >
                            <Check size={14} />
                          </span>
                        {/if}
                      </span>

                      <div
                        class="flex min-h-12 w-full min-w-0 items-center gap-3 pr-8"
                      >
                        <div
                          data-audience-icon
                          class={`flex size-12 shrink-0 items-center justify-center rounded-full p-3 transition-colors ${selected ? mode.accent.iconSelected : mode.accent.iconIdle}`}
                        >
                          {#if mode.icon === "broadcast"}
                            <Radio size={24} />
                          {:else if mode.icon === "subscribers"}
                            <Users size={24} />
                          {:else if mode.icon === "ppv"}
                            <TuziMark size={24} />
                          {:else}
                            <Lock size={24} />
                          {/if}
                        </div>
                        <h3
                          id={`stream-audience-title-${mode.value}`}
                          data-audience-title
                          class="min-w-0 flex-1 text-base font-bold break-words whitespace-normal"
                        >
                          {$t(mode.titleKey, mode.titleFallback)}
                        </h3>
                      </div>

                      <p
                        id={`stream-audience-description-${mode.value}`}
                        data-audience-description
                        class="mt-4 w-full min-w-0 text-sm leading-relaxed break-words whitespace-normal text-muted-foreground"
                      >
                        {$t(mode.descriptionKey, mode.descriptionFallback)}
                      </p>
                      <p
                        id={`stream-audience-summary-${mode.value}`}
                        data-audience-summary
                        class={`mt-3 w-full min-w-0 text-xs font-medium break-words whitespace-normal ${mode.value === "broadcast" ? "text-orange-500" : "text-muted-foreground"}`}
                      >
                        {#if mode.value === "broadcast"}
                          <span class="mr-1 text-base leading-none">⚠️</span>
                        {/if}
                        {$t(mode.summaryKey, mode.summaryFallback)}
                      </p>
                    </label>
                  {/each}
                </div>
              </fieldset>

              <!-- Keep the full billing contract visible after a selection. The
                   cards use short summaries so this detail remains readable at
                   every responsive width, including enlarged text. -->
              <div
                data-testid="stream-audience-detail"
                class={`rounded-xl border p-5 ${selectedAudience.accent.detail}`}
              >
                <div class="flex min-w-0 items-start gap-3">
                  <div class="min-w-0 flex-1">
                    <h3 class="text-base font-semibold">
                      {$t(
                        "dashboard.stream.selectedAudience",
                        "Selected audience: {audience}",
                        {
                          audience: $t(
                            selectedAudience.titleKey,
                            selectedAudience.titleFallback,
                          ),
                        },
                      )}
                    </h3>
                    <p
                      data-audience-cost-detail
                      class={`mt-2 min-w-0 text-sm leading-relaxed break-words whitespace-normal ${streamType === "broadcast" ? "text-orange-500" : "text-muted-foreground"}`}
                    >
                      {#if streamType === "broadcast"}
                        <span class="mr-1 text-base leading-none">⚠️</span>
                      {/if}
                      {$t(
                        selectedAudience.costKey,
                        selectedAudience.costFallback,
                      )}
                    </p>
                  </div>
                </div>
              </div>

              <!-- PPV Settings -->
              {#if streamType === "ppv"}
                <div
                  class="mx-auto max-w-md animate-in rounded-xl border border-border bg-card p-6 shadow-sm fade-in slide-in-from-top-2"
                >
                  <span
                    class="mb-3 block text-sm font-semibold tracking-wider text-muted-foreground uppercase"
                    >{$t(
                      "dashboard.stream.pricePerMinute",
                      "Price per minute (2Z)",
                    )}</span
                  >
                  <div class="relative">
                    <!-- 20px, not the lucide-default 16: a two-character mark
                         needs the extra size to read next to the text-lg value.
                         It still clears the input's pl-10 (12px + 20px < 40px). -->
                    <TuziMark
                      class="absolute top-1/2 left-3 z-10 -translate-y-1/2 text-muted-foreground"
                      size={20}
                    />
                    <Input
                      type="number"
                      min="0.1"
                      max="9999.99"
                      step="0.1"
                      bind:value={ppvPrice}
                      class="w-full bg-background py-6 pr-4 pl-10 font-mono text-lg"
                      placeholder={formatDecimal(1)}
                    />
                  </div>
                  {#if joinThreshold !== null}
                    <p class="mt-3 text-sm text-muted-foreground">
                      {$t(
                        "dashboard.stream.ppvJoinThreshold",
                        "At {price} 2Z/min, viewers need at least {threshold} 2Z to join.",
                        {
                          price: formatLocalizedNumber(ppvPrice),
                          threshold: formatLocalizedNumber(joinThreshold),
                        },
                      )}
                    </p>
                  {/if}
                </div>
              {/if}

              {#if error}
                <div
                  class="mx-auto flex max-w-2xl animate-in items-center justify-center gap-2 rounded-lg border border-destructive/20 bg-destructive/10 p-4 text-center text-sm text-destructive fade-in"
                >
                  <span>⚠️</span>
                  {error}
                </div>
                {#if privateResumeAvailable}
                  <Button
                    variant="secondary"
                    disabled={loading}
                    onclick={returnToPrivateCall}
                  >
                    {$t(
                      "privateCall.returnToCurrent",
                      "Return to current call",
                    )}
                  </Button>
                {/if}
              {/if}

              {#if seatState === "elsewhere" || seatState === "superseded"}
                <!--: never a silent second broadcast. The only way to
                     go live from here while another tab or device holds the
                     seat is the deliberate take-over below. -->
                <div
                  data-testid="stream-seat-panel"
                  data-seat-state={seatState}
                  role="status"
                  aria-live="polite"
                  class="mx-auto flex w-full max-w-2xl animate-in flex-col items-center gap-5 rounded-2xl border border-primary/30 bg-primary/5 p-6 text-center fade-in sm:p-8"
                >
                  <div
                    class="flex size-14 items-center justify-center rounded-full bg-primary/15 text-primary"
                  >
                    {#if seatState === "elsewhere"}
                      <MonitorSmartphone size={28} />
                    {:else}
                      <ArrowRightLeft size={28} />
                    {/if}
                  </div>
                  <div class="space-y-2">
                    <h2 class="text-xl font-bold">
                      {#if seatState === "elsewhere"}
                        {$t(
                          "dashboard.stream.seat.elsewhereTitle",
                          "You're already live in another tab or device",
                        )}
                      {:else}
                        {$t(
                          "dashboard.stream.seat.supersededTitle",
                          "Your broadcast moved to another tab or device",
                        )}
                      {/if}
                    </h2>
                    <p
                      class="mx-auto max-w-prose text-sm leading-relaxed text-muted-foreground"
                    >
                      {#if seatState === "elsewhere"}
                        {#if elsewhereType}
                          {$t(
                            "dashboard.stream.seat.elsewhereTypedDescription",
                            "Your {audience} stream is running somewhere else. Taking it over moves the broadcast here: the other tab stops broadcasting and your viewers stay connected.",
                            {
                              audience: $t(
                                audienceModes.find(
                                  (mode) => mode.value === elsewhereType,
                                )?.titleKey ?? "",
                                audienceModes.find(
                                  (mode) => mode.value === elsewhereType,
                                )?.titleFallback ?? elsewhereType,
                              ),
                            },
                          )}
                        {:else}
                          {$t(
                            "dashboard.stream.seat.elsewhereDescription",
                            "Your stream is running somewhere else. Taking it over moves the broadcast here: the other tab stops broadcasting and your viewers stay connected.",
                          )}
                        {/if}
                      {:else}
                        {$t(
                          "dashboard.stream.seat.supersededDescription",
                          "This tab stopped broadcasting so there is only ever one. Your stream keeps going from the other tab or device.",
                        )}
                      {/if}
                    </p>
                  </div>
                  {#if error}
                    <p class="text-sm text-destructive">{error}</p>
                  {/if}
                  <div
                    class="flex w-full flex-col-reverse items-stretch justify-center gap-3 sm:flex-row sm:items-center"
                  >
                    {#if seatState === "elsewhere"}
                      <Button
                        variant="outline"
                        disabled={loading}
                        onclick={() => void refreshSeat()}
                      >
                        <RefreshCw size={16} class="mr-2" />
                        {$t("dashboard.stream.seat.checkAgain", "Check again")}
                      </Button>
                    {:else}
                      <Button
                        variant="outline"
                        href={`/${username}/dashboard/pages`}
                      >
                        {$t(
                          "dashboard.stream.seat.backToDashboard",
                          "Back to dashboard",
                        )}
                      </Button>
                    {/if}
                    <Button
                      data-testid="stream-seat-takeover"
                      disabled={loading}
                      onclick={() => void startStream({ takeover: true })}
                    >
                      {#if loading}
                        <span
                          class="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground/30 border-t-primary-foreground"
                        ></span>
                        {$t("dashboard.stream.seat.takingOver", "Taking over…")}
                      {:else}
                        <ArrowRightLeft size={16} class="mr-2" />
                        {seatState === "elsewhere"
                          ? $t(
                              "dashboard.stream.seat.takeOver",
                              "Take over here",
                            )
                          : $t(
                              "dashboard.stream.seat.takeBack",
                              "Take it back here",
                            )}
                      {/if}
                    </Button>
                  </div>
                </div>
              {:else}
                <div class="flex justify-center pt-8">
                  <Button
                    class="flex w-full max-w-md items-center justify-center gap-3 rounded-xl bg-primary py-6 text-lg font-bold text-primary-foreground shadow-lg shadow-primary/20 transition-all hover:-translate-y-0.5 hover:bg-primary/90 hover:shadow-primary/40 disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
                    data-testid="stream-start"
                    disabled={loading || seatState === "checking"}
                    onclick={() => void startStream()}
                  >
                    {#if seatState === "checking" && !loading}
                      <div
                        class="h-5 w-5 animate-spin rounded-full border-2 border-white/30 border-t-white"
                      ></div>
                      <span
                        >{$t(
                          "dashboard.stream.seat.checking",
                          "Checking live status…",
                        )}</span
                      >
                    {:else if loading}
                      <div
                        class="h-5 w-5 animate-spin rounded-full border-2 border-white/30 border-t-white"
                      ></div>
                      <span
                        >{$t(
                          "dashboard.stream.starting",
                          "Starting Stream...",
                        )}</span
                      >
                    {:else}
                      <Video size={24} />
                      <span
                        >{streamType === "broadcast"
                          ? $t(
                              "dashboard.stream.startBroadcast",
                              "Start Broadcast",
                            )
                          : $t(
                              "dashboard.stream.startStream",
                              "Start Stream",
                            )}</span
                      >
                    {/if}
                  </Button>
                </div>
              {/if}
            </div>
          {/if}
        </div>
      {:else if meeting}
        <!-- RealtimeKit Meeting Interface -->
        <div
          class="relative flex h-full min-h-0 w-full flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#060f06] shadow-2xl"
        >
          <div
            data-testid="stream-host-header"
            class="flex shrink-0 flex-wrap items-center gap-2 border-b border-white/10 px-3 py-2 sm:px-4"
          >
            <div class="flex shrink-0 items-center gap-2">
              <div
                class="flex items-center gap-2 rounded-full border border-white/10 bg-black/40 px-3 py-1.5 text-white shadow-lg backdrop-blur-md"
              >
                <div
                  class="h-2 w-2 animate-pulse rounded-full bg-red-500"
                ></div>
                <span class="text-xs font-bold tracking-wider"
                  >{$t("dashboard.stream.live", "LIVE")}</span
                >
                <span class="h-3 w-px bg-white/20"></span>
                <div class="flex items-center gap-1.5">
                  <Users size={14} class="text-zinc-300" />
                  <span class="font-mono text-sm font-medium"
                    >{formatLocalizedNumber(count, $locale)}</span
                  >
                </div>
              </div>
            </div>

            <!-- Copy only, deliberately no "open in a new tab": opening
               the public page from the broadcaster's own browser is one more
               way to put a second copy of them into the room. -->
            {#if streamSharePath}
              <div class="flex shrink-0 items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  class="border border-white/10 bg-black/50 text-white backdrop-blur-sm hover:bg-black/70"
                  onclick={copyStreamLink}
                >
                  {#if linkCopied}
                    <Check size={16} />
                    {$t("dashboard.stream.viewerLinkCopiedShort", "Copied")}
                  {:else}
                    <Copy size={16} />
                    {$t("dashboard.stream.copyViewerLink", "Copy viewer link")}
                  {/if}
                </Button>
              </div>
            {/if}

            {#if streamType !== "private" && meeting.self.permissions.canRecord}
              <HostRecordingControls {username} {hostSession} />
            {/if}
          </div>

          <!-- @ts-ignore -->
          <rtk-meeting
            bind:this={meetingEl}
            mode="fill"
            use:hostMeeting={meeting}
            show-setup-screen={true}
            t={getRtkTranslator($locale)}
            class="min-h-0 w-full flex-1"
          ></rtk-meeting>
          {#if hostMeetingError}
            <div
              role="alert"
              class="shrink-0 bg-red-950 p-3 text-sm text-white"
            >
              {$t(
                "dashboard.stream.recordingControls.interfaceError",
                "The stream controls could not load. Reload this page to reconnect.",
              )}
            </div>
          {/if}
          <RtkAudioHealth {meeting} mode="host" />
        </div>
      {/if}
    </div>
  </div>
</div>
