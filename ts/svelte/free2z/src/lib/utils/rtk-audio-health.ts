/**
 * Liveness watch for RealtimeKit audio.
 *
 * THIS MODULE NEVER ROUTES OR PLAYS AUDIO. Remote audio is played by the UI
 * Kit's own `<rtk-participants-audio>` (mounted inside `<rtk-meeting>`), which
 * also owns the "allow audio playback" autoplay dialog and output-device
 * (`setSinkId`) switching. Local capture is owned by the Core SDK, which
 * already re-acquires an `ended` microphone track and follows device changes
 * (`defaults.autoSwitchAudioDevice`, default on). Hand-rolled routing next to
 * those would be a second owner of the same MediaStreamTracks — the class of
 * bug this issue is about — so the job here is only to NOTICE when audio has
 * silently died and say so. Recovery is offered, never imposed: the banner's
 * "Restart microphone" re-acquires through public SDK calls
 * (`self.setDevice()`), never by touching tracks. There is deliberately NO
 * automatic microphone restart — three review rounds showed that any
 * automatic re-acquire opens an asynchronous window in which Core 2.0.2 has
 * torn the old track down and a mute press cannot be told apart from our own
 * calls, so it could resume broadcasting after the person muted.
 *
 * Why it exists at all: every recovery path above can fail without an event
 * we could otherwise see. A track can sit `muted` forever (the OS or another
 * app took the microphone; RTP stopped arriving after an SFU blip), or end
 * without firing `ended` (`MediaStreamTrack.stop()` does not dispatch it). So
 * the watch POLLS track state rather than trusting events, and only reports a
 * stall once it has persisted past a grace period, so an ordinary one-second
 * network hiccup never paints a warning.
 *
 * Framework-free and dependency-free so it runs under `node --test` and in a
 * real browser against real MediaStreamTracks.
 */

/** A stall must persist this long before it is reported. */
export const AUDIO_STALL_GRACE_MS = 4_000;
/** How often track state is re-read, independent of any event firing. */
export const AUDIO_POLL_INTERVAL_MS = 1_000;
/** How long the banner waits on a manual restart before offering it again. */
export const MIC_RESTART_TIMEOUT_MS = 15_000;

export type DeadTrackReason = "missing" | "ended" | "muted";
export type SelfStallReason = DeadTrackReason | "permission";

/** The subset of MediaStreamTrack this module reads. */
export interface TrackLike {
  readyState: string;
  muted: boolean;
  enabled?: boolean;
  stop?(): void;
}

/** The subset of MediaDeviceInfo this module passes back to the SDK. */
export interface DeviceLike {
  deviceId: string;
  kind: string;
}

interface Emitter {
  on(event: string, listener: (...args: any[]) => void): unknown;
  off?(event: string, listener: (...args: any[]) => void): unknown;
  removeListener?(event: string, listener: (...args: any[]) => void): unknown;
}

export interface ParticipantLike {
  id: string;
  name?: string;
  audioEnabled: boolean;
  audioTrack?: TrackLike | null;
}

/** The subset of the RealtimeKit client this module reads. */
export interface MeetingLike {
  self: Emitter & {
    /**
     * NOT the user's intent. Core 2.0.2 derives it from the capture track:
     * `!!track && track.readyState === "live" && track.enabled`, so a track
     * that dies silently flips it to false exactly as a mute click does.
     */
    audioEnabled: boolean;
    audioTrack?: TrackLike | null;
    /** The untransformed capture track (Core exposes both). */
    rawAudioTrack?: TrackLike | null;
    enableAudio(): Promise<void> | void;
    disableAudio(): Promise<void> | void;
    getCurrentDevices?(): { audio?: DeviceLike | null };
    getAudioDevices?(): Promise<DeviceLike[]>;
    setDevice?(device: DeviceLike): Promise<void>;
  };
  participants: {
    joined: Emitter & { toArray(): ParticipantLike[] };
  };
}

export type SelfAudioStatus =
  | "ok"
  | "off"
  | "stalled"
  | "recovering"
  /** A restart re-acquired the mic MUTED; one click to unmute. */
  | "unmute"
  /**
   * A restart outlived its UI timeout and the SDK call is still pending,
   * almost always an unanswered browser permission prompt. A second
   * acquisition is refused until it settles, so there is no button.
   */
  | "waiting";

export interface AudioHealth {
  self: { status: SelfAudioStatus; reason: SelfStallReason | null };
  /** Remote participants whose audio is enabled but whose track is dead. */
  remote: { id: string; name: string; reason: DeadTrackReason }[];
}

export interface WatchOptions {
  onChange: (health: AudioHealth) => void;
  /** Watch this client's own microphone (broadcaster / call participant). */
  watchSelf?: boolean;
  /** Watch the audio this client receives (viewer / call participant). */
  watchRemote?: boolean;
  /**
   * Give up WAITING for a manual restart after this long (an unanswered
   * permission prompt can hold getUserMedia open forever). The SDK call is
   * not cancellable; if it completes later, the mute/teardown checks still
   * run against it.
   */
  restartTimeoutMs?: number;
  graceMs?: number;
  pollMs?: number;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: any) => void;
}

/**
 * Why a track cannot be carrying audio right now, or `null` if it can.
 *
 * `muted` is included deliberately: for a remote WebRTC track it means RTP
 * stopped arriving, and for a local capture track it means the source is
 * suspended (another app, an OS interruption, a sleeping Bluetooth headset).
 * Either way nobody is hearing anything. Only a PERSISTENT mute is reported;
 * the grace period absorbs the brief ones.
 */
export function deadTrackReason(
  track: TrackLike | null | undefined,
): DeadTrackReason | null {
  if (!track) return "missing";
  if (track.readyState === "ended") return "ended";
  if (track.muted) return "muted";
  return null;
}

/**
 * Re-acquire the local microphone through the SDK.
 *
 * `disableAudio()` + `enableAudio()` is NOT a restart in Core 2.0.2: with a
 * track present they only toggle `track.enabled` on the SAME capture track,
 * so a source the OS suspended stays suspended. `self.setDevice(device)` is
 * the public call that stops the current track and runs getUserMedia again
 * (AudioMediaHandler.onSetDevice), then re-produces it to the SFU. We pass
 * the device currently in use, or, if it vanished (unplugged headset), the
 * system default / first microphone. Only if no device can be named do we
 * fall back to `enableAudio()`, which acquires a track when none exists.
 *
 * `mayProceed` is consulted before EVERY call that can open or unmute the
 * microphone. Device enumeration is asynchronous; if the person mutes, or the
 * watch is stopped (page left), in the meantime, the restart must not go on
 * to capture and publish audio they did not consent to.
 *
 * `ownCall` wraps each SDK mutation so a caller can tell the `audioUpdate`
 * events those calls emit apart from the person's own clicks.
 *
 * Nothing here touches a MediaStreamTrack directly.
 */
export interface RestartHooks {
  mayProceed?: () => boolean;
  ownCall?: <T>(call: () => Promise<T>) => Promise<T>;
}

export async function restartMicrophone(
  meeting: MeetingLike,
  { mayProceed = () => true, ownCall = (call) => call() }: RestartHooks = {},
): Promise<void> {
  const self = meeting.self;
  let target: DeviceLike | undefined;
  if (typeof self.setDevice === "function") {
    const current = self.getCurrentDevices?.().audio ?? null;
    let devices: DeviceLike[] = [];
    try {
      devices = (await self.getAudioDevices?.()) ?? [];
    } catch {
      devices = [];
    }
    const inputs = devices.filter((d) => d.kind === "audioinput");
    target =
      inputs.find((d) => current && d.deviceId === current.deviceId) ??
      inputs.find((d) => d.deviceId === "default") ??
      inputs[0];
  }
  if (!mayProceed()) return;
  if (target && self.setDevice) {
    // Mute FIRST, so the replacement is acquired muted. onSetDevice creates
    // the new track with `enabled` copied from the old one's state
    // (`getAudioTrack(!trackEnabled)`) and removes the old track BEFORE it
    // awaits getUserMedia; a mute (or host force-mute) in that window is
    // a no-op on no track, and Core then emits nothing. Had the old track
    // been enabled, the replacement would resume broadcasting over that
    // mute. Muted in, muted out: re-opening the mic is always one explicit
    // click afterwards (the banner's "Unmute", or the SDK's mic button).
    if (self.audioEnabled) await ownCall(async () => self.disableAudio());
    if (!mayProceed()) return;
    const setDevice = self.setDevice.bind(self);
    await ownCall(() => setDevice(target));
    return;
  }
  // No device could be named. We do NOT fall back to enableAudio(): with no
  // track it acquires one ENABLED, across the same window in which a mute
  // is lost. Fail, and let the banner keep offering the restart.
  throw new Error("No microphone could be found to restart.");
}

/**
 * What an SDK `audioUpdate` says about what the PERSON wants.
 *
 * `audioEnabled: true` is always "on". `false` is ambiguous in Core 2.0.2,
 * because `audioEnabled` is computed from the track: a mute (control bar,
 * host force-mute, `self.disableAudio()`) calls `muteTrack()`, which keeps a
 * LIVE track with `enabled = false`; a dead or failed capture reports false
 * with no track or an ended one. Only the first is intent. The one other
 * source of "live, disabled" is `setDevice()` replacing an ended track (see
 * restartMicrophone), which only happens inside the person's own restart,
 * while intent inference is suspended.
 */
export function intentFrom(
  payload:
    { audioEnabled?: boolean; audioTrack?: TrackLike | null } | undefined,
  previous: boolean,
): boolean {
  if (payload?.audioEnabled === true) return true;
  if (payload?.audioEnabled === false) {
    const track = payload.audioTrack;
    if (track && track.readyState === "live" && track.enabled === false) {
      return false;
    }
  }
  return previous;
}

function detach(emitter: Emitter, event: string, fn: (...a: any[]) => void) {
  if (typeof emitter.off === "function") emitter.off(event, fn);
  else if (typeof emitter.removeListener === "function") {
    emitter.removeListener(event, fn);
  }
}

/**
 * Start watching. Call `stop()` before the meeting is left or the component
 * that shows the result is destroyed.
 */
export interface AudioWatch {
  stop(): void;
  /** Re-acquire the microphone now (the banner's "Restart microphone"). */
  restartMic(): Promise<void>;
  /** Unmute after a restart that re-acquired muted (the banner's "Unmute"). */
  unmuteMic(): Promise<void>;
}

export function watchRtkAudio(
  meeting: MeetingLike,
  options: WatchOptions,
): AudioWatch {
  const {
    onChange,
    watchSelf = false,
    watchRemote = false,
    graceMs = AUDIO_STALL_GRACE_MS,
    pollMs = AUDIO_POLL_INTERVAL_MS,
    restartTimeoutMs = MIC_RESTART_TIMEOUT_MS,
    now = () => Date.now(),
    setInterval: setIntervalFn = (fn, ms) => globalThis.setInterval(fn, ms),
    clearInterval: clearIntervalFn = (handle) =>
      globalThis.clearInterval(handle),
  } = options;

  // When each currently-bad track first went bad. A key disappears the moment
  // its track is healthy again, which is what makes a stall an "episode".
  const badSince = new Map<string, number>();
  let recovering = false;
  // >0 while the person's restart is inside an SDK call: the audioUpdate
  // events those calls emit are the SDK's, not a mute/unmute click.
  let inOwnCall = 0;
  // The SDK reports a revoked/denied microphone as `mediaPermissionError` and
  // then turns audio OFF, which would otherwise read as a deliberate mute.
  let permissionDenied = false;
  // The track that was current when the denial arrived. Only a DIFFERENT live
  // track (the person re-allowed the mic and it was re-acquired) clears it;
  // the SDK emits the error before it tears the old track down.
  let deniedTrack: TrackLike | null | undefined;
  // What the PERSON wants, as last announced by the SDK's own `audioUpdate`
  // (a mute/unmute click, a host force-mute, a permission teardown all emit
  // it). A track dying silently emits nothing, so this stays true and the
  // dead track is caught below instead of being read as a mute.
  let micWanted = meeting.self.audioEnabled;
  // Set when the person's restart ended with a live but MUTED replacement.
  let awaitingUnmute = false;
  // The restart's SDK work, until it SETTLES. A UI timeout stops the
  // spinner but never admits a second, overlapping acquisition.
  let inFlight: Promise<void> | null = null;
  let stopped = false;
  let last = "";

  function badFor(key: string, reason: DeadTrackReason | null, t: number) {
    if (reason === null) {
      badSince.delete(key);
      return false;
    }
    if (!badSince.has(key)) badSince.set(key, t);
    return t - (badSince.get(key) as number) >= graceMs;
  }

  /**
   * The banner's "Restart microphone": an explicit request for the mic to be
   * on. Waiting is bounded; the SDK work itself is not cancellable, so its
   * completion is checked whenever it lands.
   */
  async function restart() {
    if (recovering || inFlight || stopped) return;
    micWanted = true;
    recovering = true;
    const before = meeting.self.audioTrack;
    evaluate();

    const work = restartMicrophone(meeting, {
      mayProceed: () => !stopped && micWanted,
      ownCall: async (call) => {
        inOwnCall += 1;
        try {
          return await call();
        } finally {
          inOwnCall -= 1;
        }
      },
    })
      .catch(() => {
        // Reported as a stall by the next evaluation.
      })
      .then(async () => {
        if (!stopped) {
          // Intent after the restart (on time or late) is whatever the SDK
          // now shows: the replacement was acquired muted, so the mic stays
          // closed until the person's next click.
          micWanted = intentFrom(
            {
              audioEnabled: meeting.self.audioEnabled,
              audioTrack: meeting.self.audioTrack,
            },
            true,
          );
          // Offer "Unmute" only for a replacement WE caused; a mute the
          // person pressed before we acted is simply "off".
          awaitingUnmute = !micWanted && meeting.self.audioTrack !== before;
          badSince.delete("self");
          evaluate();
          return;
        }
        // The page left the room (or was taken over, ) while
        // acquisition was pending. leave() has already destructed Core's
        // media handler, so the late replacement has no owner left: stop it,
        // or the browser keeps capturing (mic indicator on) until unload.
        // This is the one place we touch a track directly, and only one that
        // Core has already abandoned. Core 2.0.2 has no public "stop capture"
        // for self.
        if (stopped) {
          for (const track of [
            meeting.self.audioTrack,
            meeting.self.rawAudioTrack,
          ]) {
            if (
              track &&
              track !== before &&
              track.readyState === "live" &&
              typeof track.stop === "function"
            ) {
              track.stop();
            }
          }
        }
      })
      .finally(() => {
        inFlight = null;
        if (!stopped) evaluate();
      });
    inFlight = work;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, restartTimeoutMs);
    });
    try {
      await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
      recovering = false;
      // A fresh grace period for the re-acquired track.
      badSince.delete("self");
      evaluate();
    }
  }

  function evaluate() {
    if (stopped) return;
    const t = now();
    const health: AudioHealth = {
      self: { status: "ok", reason: null },
      remote: [],
    };

    if (watchSelf) {
      if (
        permissionDenied &&
        meeting.self.audioTrack !== deniedTrack &&
        deadTrackReason(meeting.self.audioTrack) === null
      ) {
        permissionDenied = false;
        deniedTrack = undefined;
      }
      if (recovering) {
        health.self.status = "recovering";
      } else if (inFlight) {
        health.self.status = "waiting";
      } else if (permissionDenied) {
        // getUserMedia would fail the same way until the person changes the
        // browser/OS permission; the banner says so.
        health.self = { status: "stalled", reason: "permission" };
      } else if (
        !micWanted &&
        awaitingUnmute &&
        (deadTrackReason(meeting.self.audioTrack) === "ended" ||
          deadTrackReason(meeting.self.audioTrack) === "missing")
      ) {
        // The muted replacement died before it was unmuted: unmuting an
        // ended track does nothing in Core, so go back to offering the
        // restart instead of an "Unmute" that can never work.
        awaitingUnmute = false;
        micWanted = true;
        health.self = {
          status: "stalled",
          reason: deadTrackReason(meeting.self.audioTrack),
        };
      } else if (!micWanted) {
        // Deliberately muted (or never unmuted): not a fault. The SDK's own
        // control bar already shows the mic-off state.
        badSince.delete("self");
        health.self.status = awaitingUnmute ? "unmute" : "off";
      } else {
        const reason = deadTrackReason(meeting.self.audioTrack);
        if (badFor("self", reason, t) && reason !== null) {
          health.self = { status: "stalled", reason };
        }
      }
    }

    if (watchRemote) {
      const seen = new Set<string>();
      for (const participant of meeting.participants.joined.toArray()) {
        const key = `remote:${participant.id}`;
        seen.add(key);
        // A participant with NO track is not a fault: Core subscribes to
        // audio only for its selected active peers (maxActiveParticipants
        // + 4), so the rest of `joined` legitimately has no audioTrack.
        // Only a track we were given that then ended or went silent counts.
        const trackReason = participant.audioEnabled
          ? deadTrackReason(participant.audioTrack)
          : null;
        const reason = trackReason === "missing" ? null : trackReason;
        if (badFor(key, reason, t) && reason !== null) {
          health.remote.push({
            id: participant.id,
            name: participant.name ?? "",
            reason,
          });
        }
      }
      for (const key of [...badSince.keys()]) {
        if (key.startsWith("remote:") && !seen.has(key)) badSince.delete(key);
      }
    }

    const serialized = JSON.stringify(health);
    if (serialized !== last) {
      last = serialized;
      onChange(health);
    }
  }

  const listeners: [Emitter, string, (...a: any[]) => void][] = [];
  function listen(emitter: Emitter, event: string) {
    const fn = () => evaluate();
    emitter.on(event, fn);
    listeners.push([emitter, event, fn]);
  }

  if (watchSelf) {
    const onPermissionError = (payload?: { kind?: string }) => {
      if (payload?.kind === "audio") {
        permissionDenied = true;
        deniedTrack = meeting.self.audioTrack;
        evaluate();
      }
    };
    meeting.self.on("mediaPermissionError", onPermissionError);
    listeners.push([meeting.self, "mediaPermissionError", onPermissionError]);
    const onSelfAudioUpdate = (payload?: {
      audioEnabled?: boolean;
      audioTrack?: TrackLike | null;
    }) => {
      if (inOwnCall === 0) {
        micWanted = intentFrom(payload, micWanted);
        awaitingUnmute = false;
      }
      evaluate();
    };
    meeting.self.on("audioUpdate", onSelfAudioUpdate);
    listeners.push([meeting.self, "audioUpdate", onSelfAudioUpdate]);
    listen(meeting.self, "deviceListUpdate");
    listen(meeting.self, "roomJoined");
  }
  if (watchRemote) {
    listen(meeting.participants.joined, "audioUpdate");
    listen(meeting.participants.joined, "participantJoined");
    listen(meeting.participants.joined, "participantLeft");
  }

  const onVisibility = () => evaluate();
  const doc = (globalThis as { document?: Document }).document;
  doc?.addEventListener("visibilitychange", onVisibility);

  const interval = setIntervalFn(evaluate, pollMs);
  evaluate();

  return {
    stop() {
      stopped = true;
      clearIntervalFn(interval);
      doc?.removeEventListener("visibilitychange", onVisibility);
      for (const [emitter, event, fn] of listeners) detach(emitter, event, fn);
      listeners.length = 0;
    },
    restartMic: restart,
    async unmuteMic() {
      if (stopped) return;
      awaitingUnmute = false;
      micWanted = true;
      inOwnCall += 1;
      try {
        await meeting.self.enableAudio();
      } catch {
        // Checked below.
      } finally {
        inOwnCall -= 1;
      }
      // A resolved enableAudio() is not proof: Core 2.0.2 swallows a
      // shareMic() failure, disables the track again and emits nothing.
      // Keep offering the click rather than reporting "ok" over silence.
      if (!stopped && !meeting.self.audioEnabled) {
        micWanted = false;
        awaitingUnmute = true;
      }
      evaluate();
    },
  };
}
