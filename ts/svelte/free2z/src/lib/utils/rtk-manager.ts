import { get } from "svelte/store";
import RealtimeKitClient from "@cloudflare/realtimekit";
import {
  liveStreamStore,
  bindRtkEvents,
  type StreamType,
} from "$lib/stores/liveStreamStore";
import { browser } from "$app/env";
import {
  defineMessage,
  LocalizedError,
  localizedError,
  translateMessage,
} from "$lib/i18n-message";

const RTK_MESSAGES = {
  mediaPermissionWarning: defineMessage(
    "stream.errors.mediaPermissionWarning",
    "Microphone or camera access was denied. You joined without media; check your browser settings.",
  ),
  disconnected: defineMessage(
    "stream.errors.disconnected",
    "Disconnected from the meeting.",
  ),
  connectionFailed: defineMessage(
    "stream.errors.connectionFailed",
    "Connection to the meeting failed.",
  ),
  connectFailed: defineMessage(
    "stream.errors.connectFailed",
    "Could not connect to the meeting.",
  ),
  mediaPermissionDenied: defineMessage(
    "stream.errors.mediaPermissionDenied",
    "Microphone or camera access was denied. Allow access in your browser settings.",
  ),
  network: defineMessage(
    "stream.errors.network",
    "A network error interrupted the connection. Check your internet connection.",
  ),
};

export interface RtkInitOptions {
  authToken: string;
  streamType: StreamType;
  isHost: boolean;
  defaults?: Record<string, unknown>;
  signal?: AbortSignal;
}

/**
 * Initializes a RealtimeKit meeting and connects it to the Svelte store.
 */
export async function initRtkMeeting(options: RtkInitOptions): Promise<{
  cleanup: () => Promise<void>;
  meeting: RealtimeKitClient | null;
  warning?: string;
  warningCode?: string;
}> {
  if (!browser)
    return { cleanup: async () => {}, meeting: null, warning: undefined };

  const { authToken, streamType, isHost, defaults, signal } = options;
  let warning: string | undefined;
  let warningCode: string | undefined;
  let meeting: RealtimeKitClient | null = null;

  try {
    signal?.throwIfAborted();
    liveStreamStore.setConnectionStatus("initializing");

    try {
      meeting = await RealtimeKitClient.init({
        authToken,
        defaults: {
          audio: false,
          video: false,
          ...defaults,
        },
      });
    } catch (initError: unknown) {
      const err = initError as { message?: string; name?: string };
      signal?.throwIfAborted();
      // Handle permission errors with graceful degradation for hosts
      if (
        isHost &&
        (err.message?.includes("Permission denied") ||
          err.name === "NotAllowedError")
      ) {
        console.warn(
          "Media permissions denied, attempting fallback to no-media initialization",
        );
        try {
          meeting = await RealtimeKitClient.init({
            authToken,
            defaults: {
              audio: false,
              video: false,
            },
          });
          warning = translateMessage(RTK_MESSAGES.mediaPermissionWarning);
          warningCode = RTK_MESSAGES.mediaPermissionWarning.key;
        } catch {
          throw initError; // Throw original error if fallback fails
        }
      } else {
        throw initError;
      }
    }

    if (signal?.aborted) {
      try {
        await meeting.leave();
      } catch {
        /* Abandoned provider must not affect another stream. */
      }
      signal.throwIfAborted();
    }

    // Initialize the store with the meeting instance
    liveStreamStore.init(meeting, streamType, isHost);

    // Bind events
    const unbindEvents = bindRtkEvents(meeting);

    // Listen for room disconnection
    meeting.self.on("roomLeft", ({ state }: { state: string }) => {
      if (signal?.aborted || get(liveStreamStore).meeting !== meeting) return;
      if (state === "disconnected") {
        liveStreamStore.setConnectionStatus("disconnected");
        liveStreamStore.setError(
          translateMessage(RTK_MESSAGES.disconnected),
          RTK_MESSAGES.disconnected.key,
        );
      } else if (state === "failed") {
        liveStreamStore.setConnectionStatus("failed");
        liveStreamStore.setError(
          translateMessage(RTK_MESSAGES.connectionFailed),
          RTK_MESSAGES.connectionFailed.key,
        );
      } else if (state === "ended") {
        liveStreamStore.setConnectionStatus("ended");
      }
    });

    // Listen for room join
    meeting.self.on("roomJoined", () => {
      if (signal?.aborted || get(liveStreamStore).meeting !== meeting) return;
      liveStreamStore.setConnectionStatus("connected");
    });

    // Listen for media permission errors during the call
    meeting.self.on("mediaPermissionError", ({ kind }: { kind: string }) => {
      console.warn(`Permission denied for ${kind}`);
    });

    // Set status to idle/ready (waiting for user to join via UI)
    liveStreamStore.setConnectionStatus("idle");

    // Return cleanup function and meeting instance
    return {
      cleanup: async () => {
        unbindEvents();
        // Revoke local meeting capabilities before waiting on a remote leave.
        // Cleanup from an old route cannot clear a newer meeting's state.
        if (get(liveStreamStore).meeting === meeting) liveStreamStore.reset();
        try {
          if (meeting) {
            // RealtimeKit Core 2.0 removed `leaveRoom()`; `leave()` is its
            // replacement (Web Core 2.0.0 release notes, 2026-06-18).
            await meeting.leave();
          }
        } catch (leaveError) {
          // Error 0003 "Failed to leave room". The room is being abandoned
          // either way; a failed leave must not strand the store (and every
          // component reading it) on a dead meeting.
          console.warn("RealtimeKit leave() failed:", leaveError);
        } finally {
          // A delayed leave from an old page must not reset its replacement.
          if (get(liveStreamStore).meeting === meeting) liveStreamStore.reset();
        }
      },
      meeting,
      warning,
      warningCode,
    };
  } catch (error: unknown) {
    if (signal?.aborted) throw error;
    console.error("Failed to initialize RealtimeKit meeting:", error);

    const err = error as { message?: string; name?: string; code?: string };
    let descriptor = RTK_MESSAGES.connectFailed;

    if (
      err.message?.includes("Permission denied") ||
      err.name === "NotAllowedError"
    ) {
      descriptor = RTK_MESSAGES.mediaPermissionDenied;
    } else if (
      // RealtimeKit ClientError codes (Error Codes doc, updated 2026-08-24):
      // 0011 HTTP network error, 0012 WebSocket network error, 0014 media
      // (ICE) connection failed.
      err.code === "0011" ||
      err.code === "0012" ||
      err.code === "0014" ||
      err.message?.includes("Network error") ||
      err.message?.includes("fetch") ||
      err.message?.includes("Failed to fetch")
    ) {
      descriptor = RTK_MESSAGES.network;
    }

    const localized =
      error instanceof LocalizedError
        ? error
        : localizedError(descriptor, undefined, error);
    liveStreamStore.setError(localized.message, localized.code);
    liveStreamStore.setConnectionStatus("failed");
    throw localized;
  }
}
