<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { get } from "svelte/store";
  import { goto } from "$app/navigation";
  import { page } from "$lib/kit-stores";
  import { authStore } from "$lib/stores/auth";
  import { liveStreamStore } from "$lib/stores/liveStreamStore";
  import { StreamService } from "$lib/services/stream";
  import { initRtkMeeting } from "$lib/utils/rtk-manager";
  import type RealtimeKitClient from "@cloudflare/realtimekit";
  import { generateConfig } from "@cloudflare/realtimekit-ui";
  import { withoutNativeRecording } from "$lib/utils/recording-controls";
  import HostRecordingControls from "$lib/components/stream/HostRecordingControls.svelte";
  import { defineCustomElements } from "@cloudflare/realtimekit-ui/loader";
  import { Loader2, Copy, Check, AlertCircle } from "@lucide/svelte";
  import Button from "$lib/components/ui/button/button.svelte";
  import { toast, captureAccountToast } from "$lib/toast.js";
  import { locale, tStore as t } from "$lib/i18n";
  import { getRtkTranslator } from "$lib/rtk-i18n";
  import RtkAudioHealth from "$lib/components/stream/RtkAudioHealth.svelte";

  let meeting: RealtimeKitClient | null = null;
  let hostMeetingError = false;
  const abort = new AbortController();
  // Disable native recording before attaching the meeting: its provider-default
  // recorder does not use Free2Z's deployed capture route.
  function recordingSafeMeeting(node: HTMLElement, current: RealtimeKitClient) {
    let generation = 0;
    async function apply(next: RealtimeKitClient) {
      const ownGeneration = ++generation;
      const element = node as HTMLElement & {
        componentOnReady(): Promise<unknown>;
        loadConfigFromPreset: boolean;
        config: unknown;
        meeting: RealtimeKitClient;
      };
      try {
        await element.componentOnReady();
        if (ownGeneration !== generation || abort.signal.aborted) return;
        element.loadConfigFromPreset = false;
        element.config = withoutNativeRecording(
          generateConfig(next.self.config, next).config,
        );
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

  let loading = true;
  let error: string | null = null;
  let cleanup: (() => void) | null = null;
  let copied = false;
  let encrypted = false;
  let callNeedsReload = false;
  let boundRoom: { username: string; secret: string } | null = null;

  $: username = $page.params.username;
  $: secret = $page.params.secret;
  $: currentUser = $authStore.creator;
  $: isOwner = Boolean(
    currentUser?.username &&
    username &&
    currentUser.username.toLowerCase() === username.toLowerCase(),
  );

  $: if (
    boundRoom &&
    (boundRoom.username !== username || boundRoom.secret !== secret)
  ) {
    invalidateCall();
  }

  let accountGeneration = 0;
  let unsubscribeAccount: (() => void) | null = null;
  function accountKey() {
    const actor = get(authStore).creator;
    return actor ? `${actor.id}:${actor.username}` : null;
  }

  function invalidateCall(accountChanged = false) {
    abort.abort();
    callNeedsReload = true;
    loading = false;
    if (accountChanged) {
      error = $t(
        "privateCall.accountChanged",
        "Your account changed. Reload to join this call with the current account.",
      );
    }
    const leave = cleanup;
    cleanup = null;
    // Local capabilities must disappear even if the provider never finishes leaving.
    if (meeting && get(liveStreamStore).meeting === meeting) {
      liveStreamStore.reset();
    }
    meeting = null;
    if (leave) void Promise.resolve(leave()).catch(console.warn);
  }

  onMount(() => {
    let boundAccount = accountKey();
    let joinStarted = false;
    defineCustomElements();
    // Bootstrap can retry a failed session read. Join only after it resolves;
    // subsequent synchronous identity changes invalidate all issued credentials.
    unsubscribeAccount = authStore.subscribe((state) => {
      const next = accountKey();
      if (next !== boundAccount) {
        boundAccount = next;
        accountGeneration++;
        if (joinStarted) invalidateCall(true);
      }
      if (
        !joinStarted &&
        state.status === "authenticated" &&
        state.creator &&
        !abort.signal.aborted
      ) {
        joinStarted = true;
        void joinPrivateStream();
      } else if (!joinStarted && state.status === "anonymous") {
        loading = false;
        error = $t(
          "privateCall.errors.joinFailed",
          "Failed to join the private call.",
        );
      }
    });
    if (get(authStore).status === "unknown") {
      void authStore.checkAuth({ silent: true }).catch(() => {
        if (abort.signal.aborted) return;
        loading = false;
        error = $t(
          "privateCall.errors.joinFailed",
          "Failed to join the private call.",
        );
      });
    }
  });

  onDestroy(() => {
    abort.abort();
    unsubscribeAccount?.();
    if (cleanup) cleanup();
  });

  async function joinPrivateStream() {
    const operationNotice = captureAccountToast();
    if (!username || !secret) {
      error = $t(
        "privateCall.errors.missingCredentials",
        "The username or secret link is missing.",
      );
      loading = false;
      return;
    }

    loading = true;
    error = null;

    const actor = accountKey();
    const generation = accountGeneration;
    const room = { username: username!, secret: secret! };
    boundRoom = room;
    const actorUsername = get(authStore).creator?.username;
    const ownerAtJoin = Boolean(
      actorUsername &&
      actorUsername.toLowerCase() === room.username.toLowerCase(),
    );
    const isCurrentJoin = () => {
      const params = get(page).params;
      return (
        !abort.signal.aborted &&
        generation === accountGeneration &&
        actor === accountKey() &&
        params.username === room.username &&
        params.secret === room.secret
      );
    };

    try {
      // Bind recording controls to the same room as this token, even if the
      // route changes while joining or SvelteKit reuses this page component.
      // 1. Get Auth Token
      const { auth_token, e2ee } = await StreamService.joinPrivateStream(
        room.username,
        room.secret,
        abort.signal,
      );

      if (!isCurrentJoin()) {
        if (!abort.signal.aborted) invalidateCall();
        return;
      }
      encrypted = e2ee === true;

      // 2. Initialize Meeting
      const { cleanup: cleanupFn, meeting: meetingInstance } =
        await initRtkMeeting({
          authToken: auth_token,
          signal: abort.signal,
          streamType: "private",
          isHost: ownerAtJoin, // Owner joins as host; non-owners join as participants for this private stream.
          // The exact behavior of the 'private' stream type is defined by initRtkMeeting and should
          // remain consistent with how "Private (Beta)" is presented in the UI (e.g., 1-on-1 behavior).
          defaults: {
            audio: true,
            video: true,
          },
        });
      if (!isCurrentJoin()) {
        cleanupFn();
        if (!abort.signal.aborted) invalidateCall();
        return;
      }
      cleanup = cleanupFn;
      meeting = meetingInstance;

      if (meetingInstance) {
        meetingInstance.self.on(
          "roomLeft",
          async ({ state }: { state: string }) => {
            if (!isCurrentJoin() || callNeedsReload) return;
            if (state === "left" || state === "ended") {
              if (cleanup) {
                const leave = cleanup;
                cleanup = null;
                await leave();
              }
              if (!isCurrentJoin()) return;
              operationNotice.success($t("privateCall.ended", "Call ended"));
              if (ownerAtJoin) {
                goto(`/${room.username}/dashboard/pages`);
              } else {
                goto(`/${room.username}`);
              }
            }
          },
        );
      }
    } catch (err: any) {
      if (!isCurrentJoin()) return;
      console.error("Failed to join stream:", err);
      error = $t(
        "privateCall.errors.joinFailed",
        "Failed to join the private call.",
      );
    } finally {
      loading = false;
    }
  }

  async function copyToClipboard() {
    const operationNotice = captureAccountToast();
    const url = window.location.href;
    try {
      await navigator.clipboard.writeText(url);
      copied = true;
      operationNotice.success(
        $t("privateCall.linkCopied", "Secret URL copied to the clipboard"),
      );
      setTimeout(() => (copied = false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
      operationNotice.error(
        $t("privateCall.errors.copyFailed", "Failed to copy the URL"),
      );
    }
  }
</script>

<svelte:head>
  <title
    >{$t("privateCall.metaTitle", "Private call with {username} · Free2Z", {
      username: username || "",
    })}</title
  >
  <meta
    name="description"
    content={$t(
      "privateCall.metaDescription",
      "Join a private Free2Z call with {username}.",
      { username: username || "" },
    )}
  />
</svelte:head>

<div class="flex h-screen w-full flex-col bg-black">
  {#if loading}
    <div
      class="flex flex-1 flex-col items-center justify-center gap-4 text-white"
    >
      <Loader2 class="h-10 w-10 animate-spin" />
      <p>{$t("privateCall.initializing", "Initializing private call...")}</p>
    </div>
  {:else if error || callNeedsReload}
    <div
      class="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center text-white"
    >
      <div
        class="mb-2 flex h-16 w-16 items-center justify-center rounded-full bg-red-500/20 text-red-500"
      >
        <AlertCircle class="h-8 w-8" />
      </div>
      <h3 class="text-xl font-bold">
        {$t("privateCall.unableToJoin", "Unable to Join")}
      </h3>
      <p class="text-gray-300">
        {error ||
          $t(
            "privateCall.linkChanged",
            "The private call link changed. Reload to join the selected call.",
          )}
      </p>
      <Button
        class="mt-4 rounded-full bg-white/10 px-6 py-2 font-medium text-white hover:bg-white/20"
        onclick={() => window.location.reload()}
      >
        {$t("privateCall.tryAgain", "Try Again")}
      </Button>
    </div>
  {:else if meeting}
    <div class="relative flex min-h-0 flex-1 flex-col">
      <div
        data-testid="private-call-header"
        class="flex shrink-0 flex-wrap items-center gap-2 border-b border-white/10 px-3 py-2"
      >
        <Button variant="secondary" size="sm" onclick={copyToClipboard}>
          {#if copied}
            <Check class="mr-2 h-4 w-4" />
            {$t("privateCall.copied", "Copied")}
          {:else}
            <Copy class="mr-2 h-4 w-4" />
            {$t("privateCall.copyLink", "Copy Link")}
          {/if}
        </Button>
        {#if isOwner && boundRoom && boundRoom.username === username && boundRoom.secret === secret && !encrypted && meeting.self.permissions.canRecord}
          <HostRecordingControls
            username={boundRoom.username}
            privateSecret={boundRoom.secret}
          />
        {/if}
      </div>
      <!-- @ts-ignore -->
      <rtk-meeting
        mode="fill"
        use:recordingSafeMeeting={meeting}
        show-setup-screen={true}
        t={getRtkTranslator($locale)}
        class="min-h-0 w-full flex-1"
      ></rtk-meeting>
      <RtkAudioHealth
        {meeting}
        mode="call"
        onReconnect={() => window.location.reload()}
      />

      {#if hostMeetingError}
        <div role="alert" class="shrink-0 bg-red-950 p-3 text-sm text-white">
          {$t(
            "dashboard.stream.recordingControls.interfaceError",
            "The meeting interface could not be prepared. Reload before starting a recording.",
          )}
        </div>
      {/if}
    </div>
  {/if}
</div>
