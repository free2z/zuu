<script lang="ts">
  /**
   * Tells the person in the room when audio has silently died, and offers the
   * one recovery that can help them. All detection and recovery live
   * in `$lib/utils/rtk-audio-health`; see that module for why this component
   * never touches a MediaStreamTrack or an <audio> element itself.
   *
   * - `host`: watches this client's microphone; the banner offers a restart
   *   (never automatic: the person decides when their mic re-opens).
   * - `viewer`: watches the audio this client receives. There is no local
   *   fix for a remote track, so the banner offers `onReconnect` (a rejoin).
   * - `call`: both.
   */
  import { MicOff, VolumeX, RefreshCw, Loader2 } from "@lucide/svelte";
  import { tStore as t } from "$lib/i18n";
  import {
    watchRtkAudio,
    type AudioHealth,
    type AudioWatch,
    type MeetingLike,
  } from "$lib/utils/rtk-audio-health";

  interface Props {
    meeting: unknown;
    mode: "host" | "viewer" | "call";
    onReconnect?: () => void;
  }

  let { meeting, mode, onReconnect }: Props = $props();

  let health = $state<AudioHealth | null>(null);
  // Not reactive state: only the button reads it, never the template.
  let watch: AudioWatch | null = null;

  $effect(() => {
    const current = meeting as MeetingLike | null;
    health = null;
    if (!current) return;
    const handle = watchRtkAudio(current, {
      watchSelf: mode !== "viewer",
      watchRemote: mode !== "host",
      onChange: (next) => {
        health = next;
      },
    });
    watch = handle;
    // The teardown stops the watch when the meeting changes or the component
    // is destroyed.
    return () => {
      handle.stop();
      if (watch === handle) watch = null;
    };
  });

  function restart() {
    // The watch owns the restart so it can tell a failed re-acquire (which
    // the SDK reports as `audioEnabled: false`) from the person muting.
    void watch?.restartMic();
  }

  function unmute() {
    void watch?.unmuteMic();
  }

  let micStalled = $derived(health?.self.status === "stalled");
  let micBlocked = $derived(health?.self.reason === "permission");
  // A person who denied the mic on purpose (a video-only broadcast) must be
  // able to put the permission banner away; it returns only if the state
  // changes and comes back.
  let permissionDismissed = $state(false);
  $effect(() => {
    if (!micBlocked) permissionDismissed = false;
  });
  let showMicStalled = $derived(
    micStalled && !(micBlocked && permissionDismissed),
  );
  let micRecovering = $derived(health?.self.status === "recovering");
  let micNeedsUnmute = $derived(health?.self.status === "unmute");
  let micWaiting = $derived(health?.self.status === "waiting");
  let remoteStalled = $derived((health?.remote.length ?? 0) > 0);
</script>

{#if showMicStalled || micRecovering || micNeedsUnmute || micWaiting || remoteStalled}
  <div
    class="pointer-events-none absolute inset-x-0 bottom-20 z-40 flex flex-col items-center gap-2 px-4"
    data-rtk-audio-health
  >
    {#if micWaiting}
      <div
        role="status"
        data-rtk-audio-health-mic="waiting"
        class="pointer-events-auto flex max-w-md items-center gap-3 rounded-lg bg-yellow-500/95 px-4 py-2 text-black shadow-lg"
      >
        <Loader2 class="h-5 w-5 shrink-0 animate-spin" aria-hidden="true" />
        <span class="text-sm font-medium">
          {$t(
            "stream.audio.micWaiting",
            "Still waiting for your microphone. Check your browser for a permission prompt.",
          )}
        </span>
      </div>
    {/if}

    {#if micNeedsUnmute}
      <div
        role="status"
        data-rtk-audio-health-mic="unmute"
        class="pointer-events-auto flex max-w-md items-center gap-3 rounded-lg bg-yellow-500/95 px-4 py-2 text-black shadow-lg"
      >
        <MicOff class="h-5 w-5 shrink-0" aria-hidden="true" />
        <span class="text-sm font-medium">
          {$t(
            "stream.audio.micReconnectedMuted",
            "Your microphone is back but muted. Unmute to be heard.",
          )}
        </span>
        <button
          type="button"
          class="shrink-0 rounded-md bg-black/80 px-3 py-1 text-sm font-semibold text-white hover:bg-black"
          onclick={unmute}
        >
          {$t("stream.audio.unmute", "Unmute")}
        </button>
      </div>
    {/if}

    {#if showMicStalled || micRecovering}
      <div
        role="alert"
        data-rtk-audio-health-mic={micRecovering ? "recovering" : "stalled"}
        class="pointer-events-auto flex max-w-md items-center gap-3 rounded-lg bg-yellow-500/95 px-4 py-2 text-black shadow-lg"
      >
        {#if micRecovering}
          <Loader2 class="h-5 w-5 shrink-0 animate-spin" aria-hidden="true" />
          <span class="text-sm font-medium">
            {$t("stream.audio.micRecovering", "Reconnecting your microphone…")}
          </span>
        {:else}
          <MicOff class="h-5 w-5 shrink-0" aria-hidden="true" />
          <span class="text-sm font-medium">
            {#if micBlocked}
              {$t(
                "stream.audio.micPermission",
                "Microphone access was blocked. Allow it in your browser settings, then restart the microphone.",
              )}
            {:else}
              {$t(
                "stream.audio.micStalled",
                "Your microphone stopped sending audio. Others can't hear you.",
              )}
            {/if}
          </span>
          <button
            type="button"
            class="shrink-0 rounded-md bg-black/80 px-3 py-1 text-sm font-semibold text-white hover:bg-black"
            onclick={restart}
          >
            {$t("stream.audio.restartMic", "Restart microphone")}
          </button>
          {#if micBlocked}
            <button
              type="button"
              class="shrink-0 rounded-md px-2 py-1 text-sm font-semibold hover:bg-black/10"
              onclick={() => (permissionDismissed = true)}
            >
              {$t("navigation.dismiss", "Dismiss")}
            </button>
          {/if}
        {/if}
      </div>
    {/if}

    {#if remoteStalled}
      <div
        role="alert"
        data-rtk-audio-health-remote
        class="pointer-events-auto flex max-w-md items-center gap-3 rounded-lg bg-yellow-500/95 px-4 py-2 text-black shadow-lg"
      >
        <VolumeX class="h-5 w-5 shrink-0" aria-hidden="true" />
        <span class="text-sm font-medium">
          {$t("stream.audio.remoteStalled", "The stream's audio stopped.")}
        </span>
        {#if onReconnect}
          <button
            type="button"
            class="flex shrink-0 items-center gap-1 rounded-md bg-black/80 px-3 py-1 text-sm font-semibold text-white hover:bg-black"
            onclick={() => onReconnect?.()}
          >
            <RefreshCw class="h-4 w-4" aria-hidden="true" />
            {$t("stream.audio.reconnect", "Reconnect audio")}
          </button>
        {/if}
      </div>
    {/if}
  </div>
{/if}
