export type MediaPreflightStatus =
  | "idle"
  | "requesting"
  | "ready"
  | "denied"
  | "no-device"
  | "busy"
  | "removed"
  | "unsupported"
  | "failed";

export type CaptureDeviceKind = "audioinput" | "videoinput";

export interface CaptureDevice {
  deviceId: string;
  kind: CaptureDeviceKind;
  label: string;
}

export interface SelectedCaptureDevices {
  audio: string;
  video: string;
}

export const EMPTY_DEVICE_SELECTION: SelectedCaptureDevices = {
  audio: "",
  video: "",
};

export function captureConstraints(
  selected: SelectedCaptureDevices,
): MediaStreamConstraints {
  return {
    audio: selected.audio
      ? { deviceId: { exact: selected.audio } }
      : true,
    video: selected.video
      ? { deviceId: { exact: selected.video } }
      : true,
  };
}

export function captureDevices(
  devices: readonly MediaDeviceInfo[],
): CaptureDevice[] {
  let camera = 0;
  let microphone = 0;
  const capture: CaptureDevice[] = [];

  for (const device of devices) {
    if (device.kind === "videoinput") {
      camera += 1;
      capture.push({
        deviceId: device.deviceId,
        kind: device.kind,
        label: device.label || `Camera ${camera}`,
      });
    }
    if (device.kind === "audioinput") {
      microphone += 1;
      capture.push({
        deviceId: device.deviceId,
        kind: device.kind,
        label: device.label || `Microphone ${microphone}`,
      });
    }
  }
  return capture;
}

export function stopMediaStream(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) {
    try {
      track.stop();
    } catch {
      // One malformed platform track must not prevent every remaining capture
      // track from being released.
    }
  }
}

export function statusForCaptureError(error: unknown): MediaPreflightStatus {
  const name = error instanceof DOMException
    ? error.name
    : typeof error === "object" && error !== null && "name" in error
      ? String(error.name)
      : "";

  if (name === "NotAllowedError" || name === "SecurityError") return "denied";
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "no-device";
  }
  if (name === "NotReadableError" || name === "AbortError") return "busy";
  return "failed";
}

export async function startAfterMediaConfirmation<T>({
  confirmed,
  release,
  provision,
}: {
  confirmed: boolean;
  release: () => void;
  provision: () => Promise<T>;
}): Promise<T> {
  if (!confirmed) {
    throw new Error("Media preview must be confirmed before starting");
  }
  // The local stream is never inherited by provisioning, including when the
  // backend rejects or never settles.
  release();
  return provision();
}
