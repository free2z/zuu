import { useCallback, useEffect, useRef, useState } from "react";
import {
  captureConstraints,
  captureDevices,
  EMPTY_DEVICE_SELECTION,
  statusForCaptureError,
  stopMediaStream,
  type CaptureDevice,
  type CaptureDeviceKind,
  type MediaPreflightStatus,
  type SelectedCaptureDevices,
} from "./media-preflight";

type MediaDevicesLike = Pick<
  MediaDevices,
  "enumerateDevices" | "getUserMedia" | "addEventListener" | "removeEventListener"
>;

export interface UseMediaPreflightOptions {
  active: boolean;
  /** Test seam; production always resolves this from navigator.mediaDevices. */
  mediaDevices?: MediaDevicesLike | null;
}

export interface MediaPreflightModel {
  status: MediaPreflightStatus;
  devices: CaptureDevice[];
  selected: SelectedCaptureDevices;
  stream: MediaStream | null;
  microphoneEnabled: boolean;
  cameraEnabled: boolean;
  requestPreview: () => Promise<void>;
  selectDevice: (kind: CaptureDeviceKind, deviceId: string) => Promise<void>;
  toggleMicrophone: () => void;
  toggleCamera: () => void;
  release: () => void;
}

function defaultMediaDevices(): MediaDevicesLike | null {
  return typeof navigator === "undefined" ? null : navigator.mediaDevices ?? null;
}

const STALE_DEVICE_REFRESH = Symbol("stale-device-refresh");

export function useMediaPreflight({
  active,
  mediaDevices = defaultMediaDevices(),
}: UseMediaPreflightOptions): MediaPreflightModel {
  const [status, setStatus] = useState<MediaPreflightStatus>("idle");
  const [devices, setDevices] = useState<CaptureDevice[]>([]);
  const [selected, setSelected] = useState<SelectedCaptureDevices>(
    EMPTY_DEVICE_SELECTION,
  );
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [microphoneEnabled, setMicrophoneEnabled] = useState(false);
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const activeRef = useRef(active);
  const requestGeneration = useRef(0);
  const enumerationSequence = useRef(0);
  const streamRef = useRef<MediaStream | null>(null);
  const provisionalStreamsRef = useRef(new Map<number, MediaStream>());
  const selectedRef = useRef(selected);
  const endedListenersRef = useRef<Array<{
    track: MediaStreamTrack;
    listener: () => void;
  }>>([]);

  activeRef.current = active;
  selectedRef.current = selected;

  const detachEndedListeners = useCallback(() => {
    for (const { track, listener } of endedListenersRef.current) {
      track.removeEventListener("ended", listener);
    }
    endedListenersRef.current = [];
  }, []);

  const stopCurrentStream = useCallback(() => {
    detachEndedListeners();
    stopMediaStream(streamRef.current);
    streamRef.current = null;
    setStream(null);
  }, [detachEndedListeners]);

  const stopProvisionalStreams = useCallback(() => {
    for (const provisional of provisionalStreamsRef.current.values()) {
      stopMediaStream(provisional);
    }
    provisionalStreamsRef.current.clear();
  }, []);

  const invalidateAndStop = useCallback(() => {
    requestGeneration.current += 1;
    stopProvisionalStreams();
    stopCurrentStream();
  }, [stopCurrentStream, stopProvisionalStreams]);

  const release = useCallback(() => {
    invalidateAndStop();
    setStatus("idle");
    setMicrophoneEnabled(false);
    setCameraEnabled(true);
  }, [invalidateAndStop]);

  const refreshDevices = useCallback(async (expectedGeneration: number) => {
    if (!mediaDevices) return null;
    const sequence = ++enumerationSequence.current;
    try {
      const next = captureDevices(await mediaDevices.enumerateDevices());
      if (
        !activeRef.current ||
        expectedGeneration !== requestGeneration.current
      ) {
        return null;
      }
      if (sequence !== enumerationSequence.current) {
        return STALE_DEVICE_REFRESH;
      }
      const sanitizedSelection = {
        audio: !selectedRef.current.audio || next.some(
          (device) => device.kind === "audioinput" &&
            device.deviceId === selectedRef.current.audio,
        )
          ? selectedRef.current.audio
          : next.find((device) => device.kind === "audioinput")?.deviceId ?? "",
        video: !selectedRef.current.video || next.some(
          (device) => device.kind === "videoinput" &&
            device.deviceId === selectedRef.current.video,
        )
          ? selectedRef.current.video
          : next.find((device) => device.kind === "videoinput")?.deviceId ?? "",
      };
      selectedRef.current = sanitizedSelection;
      setSelected(sanitizedSelection);
      setDevices(next);
      return next;
    } catch {
      if (
        activeRef.current &&
        expectedGeneration === requestGeneration.current &&
        sequence !== enumerationSequence.current
      ) {
        return STALE_DEVICE_REFRESH;
      }
      // Some WebViews expose getUserMedia but withhold enumeration. Capture can
      // still proceed with the platform defaults, so enumeration is optional.
      return null;
    }
  }, [mediaDevices]);

  const refreshLatestDevices = useCallback(async (expectedGeneration: number) => {
    while (
      activeRef.current &&
      expectedGeneration === requestGeneration.current
    ) {
      const refreshed = await refreshDevices(expectedGeneration);
      if (refreshed !== STALE_DEVICE_REFRESH) return refreshed;
    }
    return null;
  }, [refreshDevices]);

  const installStream = useCallback((next: MediaStream) => {
    stopCurrentStream();
    streamRef.current = next;

    // A local camera preview is visible, but microphone capture defaults muted
    // and the video element itself is muted to prevent local echo.
    next.getAudioTracks().forEach((track) => {
      track.enabled = false;
    });
    next.getVideoTracks().forEach((track) => {
      track.enabled = true;
    });

    const onEnded = (kind: string) => {
      if (!activeRef.current || streamRef.current !== next) return;
      const nextSelection = kind === "audio"
        ? { ...selectedRef.current, audio: "" }
        : { ...selectedRef.current, video: "" };
      selectedRef.current = nextSelection;
      setSelected(nextSelection);
      invalidateAndStop();
      setStatus("removed");
      setMicrophoneEnabled(false);
      setCameraEnabled(false);
      void refreshDevices(requestGeneration.current);
    };
    endedListenersRef.current = next.getTracks().map((track) => {
      const listener = () => onEnded(track.kind);
      track.addEventListener("ended", listener);
      return { track, listener };
    });

    setStream(next);
    setMicrophoneEnabled(false);
    setCameraEnabled(true);
    setStatus("ready");
  }, [invalidateAndStop, refreshDevices, stopCurrentStream]);

  const acquire = useCallback(async (
    selection: SelectedCaptureDevices,
  ) => {
    if (!mediaDevices) {
      setStatus("unsupported");
      return;
    }

    const generation = ++requestGeneration.current;
    // Reacquisition transfers ownership: no previous or provisional stream may
    // survive a replacement request that later fails or resolves out of order.
    stopProvisionalStreams();
    stopCurrentStream();
    setStatus("requesting");
    try {
      const acquired = await mediaDevices.getUserMedia(
        captureConstraints(selection),
      );
      if (!activeRef.current || generation !== requestGeneration.current) {
        stopMediaStream(acquired);
        return;
      }
      const hasAudio = acquired.getAudioTracks().length > 0;
      const hasVideo = acquired.getVideoTracks().length > 0;
      if (!hasAudio || !hasVideo) {
        stopMediaStream(acquired);
        if (activeRef.current && generation === requestGeneration.current) {
          setStatus("no-device");
        }
        return;
      }

      // Own the result before any further await. Cancel/unmount can now release
      // it synchronously even if enumerateDevices hangs forever.
      provisionalStreamsRef.current.set(generation, acquired);
      const refreshed = await refreshLatestDevices(generation);
      if (provisionalStreamsRef.current.get(generation) !== acquired) {
        // A cancel or newer request already stopped and removed this stream.
        return;
      }
      provisionalStreamsRef.current.delete(generation);
      if (!activeRef.current || generation !== requestGeneration.current) {
        stopMediaStream(acquired);
        return;
      }

      const audioId =
        selection.audio ||
        acquired.getAudioTracks()[0]?.getSettings().deviceId ||
        "";
      const videoId =
        selection.video ||
        acquired.getVideoTracks()[0]?.getSettings().deviceId ||
        "";
      const captureEnded = acquired.getTracks().some(
        (track) => track.readyState === "ended",
      );
      const refreshedAudioDevices = refreshed?.filter(
        (device) => device.kind === "audioinput",
      ) ?? [];
      const refreshedVideoDevices = refreshed?.filter(
        (device) => device.kind === "videoinput",
      ) ?? [];
      const selectedDeviceMissing = refreshed !== null && (
        (audioId !== "" && refreshedAudioDevices.length > 0 &&
          !refreshedAudioDevices.some((device) => device.deviceId === audioId)) ||
        (videoId !== "" && refreshedVideoDevices.length > 0 &&
          !refreshedVideoDevices.some((device) => device.deviceId === videoId))
      );
      if (captureEnded || selectedDeviceMissing) {
        stopMediaStream(acquired);
        if (activeRef.current && generation === requestGeneration.current) {
          setStatus("removed");
          setMicrophoneEnabled(false);
          setCameraEnabled(false);
        }
        return;
      }
      const nextSelection = { audio: audioId, video: videoId };
      selectedRef.current = nextSelection;
      setSelected(nextSelection);
      installStream(acquired);
    } catch (error) {
      if (activeRef.current && generation === requestGeneration.current) {
        stopCurrentStream();
        const errorStatus = statusForCaptureError(error);
        if (errorStatus === "no-device") {
          const refreshed = await refreshLatestDevices(generation);
          if (
            refreshed === null &&
            activeRef.current &&
            generation === requestGeneration.current
          ) {
            // An exact ID can become invalid between enumeration and capture.
            // If re-enumeration is unavailable, forget both exact constraints
            // so the next explicit retry can use platform defaults.
            selectedRef.current = EMPTY_DEVICE_SELECTION;
            setSelected(EMPTY_DEVICE_SELECTION);
          }
        }
        if (activeRef.current && generation === requestGeneration.current) {
          setStatus(errorStatus);
        }
      }
    }
  }, [
    installStream,
    mediaDevices,
    refreshLatestDevices,
    stopCurrentStream,
    stopProvisionalStreams,
  ]);

  const requestPreview = useCallback(
    () => acquire(selectedRef.current),
    [acquire],
  );

  const selectDevice = useCallback(async (
    kind: CaptureDeviceKind,
    deviceId: string,
  ) => {
    const next = kind === "audioinput"
      ? { ...selectedRef.current, audio: deviceId }
      : { ...selectedRef.current, video: deviceId };
    selectedRef.current = next;
    setSelected(next);
    await acquire(next);
  }, [acquire]);

  const toggleMicrophone = useCallback(() => {
    setMicrophoneEnabled((enabled) => {
      const next = !enabled;
      streamRef.current?.getAudioTracks().forEach((track) => {
        track.enabled = next;
      });
      return next;
    });
  }, []);

  const toggleCamera = useCallback(() => {
    setCameraEnabled((enabled) => {
      const next = !enabled;
      streamRef.current?.getVideoTracks().forEach((track) => {
        track.enabled = next;
      });
      return next;
    });
  }, []);

  useEffect(() => {
    activeRef.current = active;
    if (!active) {
      invalidateAndStop();
      setStatus("idle");
      return;
    }
    if (!mediaDevices) {
      setStatus("unsupported");
      return;
    }

    void refreshDevices(requestGeneration.current);
    const onDeviceChange = async () => {
      const expectedGeneration = requestGeneration.current;
      const current = streamRef.current;
      const selectionBeforeRefresh = selectedRef.current;
      const audioId =
        selectionBeforeRefresh.audio ||
        current?.getAudioTracks()[0]?.getSettings().deviceId;
      const videoId =
        selectionBeforeRefresh.video ||
        current?.getVideoTracks()[0]?.getSettings().deviceId;
      const next = await refreshDevices(expectedGeneration);
      if (
        !Array.isArray(next) ||
        !current ||
        !activeRef.current ||
        expectedGeneration !== requestGeneration.current
      ) {
        return;
      }

      const audioGone = !audioId || !next.some(
        (device) => device.kind === "audioinput" && device.deviceId === audioId,
      );
      const videoGone = !videoId || !next.some(
        (device) => device.kind === "videoinput" && device.deviceId === videoId,
      );
      if (audioGone || videoGone) {
        const nextSelection = selectedRef.current;
        selectedRef.current = nextSelection;
        setSelected(nextSelection);
        invalidateAndStop();
        setStatus("removed");
        setMicrophoneEnabled(false);
        setCameraEnabled(false);
      }
    };
    mediaDevices.addEventListener?.("devicechange", onDeviceChange);

    return () => {
      activeRef.current = false;
      enumerationSequence.current += 1;
      mediaDevices.removeEventListener?.("devicechange", onDeviceChange);
      invalidateAndStop();
    };
  }, [active, invalidateAndStop, mediaDevices, refreshDevices]);

  return {
    status,
    devices,
    selected,
    stream,
    microphoneEnabled,
    cameraEnabled,
    requestPreview,
    selectDevice,
    toggleMicrophone,
    toggleCamera,
    release,
  };
}
