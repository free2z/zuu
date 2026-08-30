import { useEffect, useRef } from "react";
import {
  Camera,
  CameraOff,
  Loader2,
  Mic,
  MicOff,
  RefreshCw,
  Settings,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import type { MediaPreflightModel } from "./useMediaPreflight";

const FAILURE_COPY = {
  denied: {
    title: "Camera or microphone access was denied.",
    recovery: "Allow access in system or browser settings, then try again.",
  },
  "no-device": {
    title: "A camera and microphone are required.",
    recovery: "Connect both devices, then try again.",
  },
  busy: {
    title: "A camera or microphone is busy.",
    recovery: "Close other apps using it, then try again.",
  },
  removed: {
    title: "The selected camera or microphone was removed.",
    recovery: "Reconnect it or choose another device, then try again.",
  },
  unsupported: {
    title: "Camera preview is unavailable here.",
    recovery: "Use a supported browser or the current ZUULI app.",
  },
  failed: {
    title: "The camera preview could not start.",
    recovery: "Check the devices and try again.",
  },
} as const;

export function MediaPreflight({
  model,
  disabled = false,
}: {
  model: MediaPreflightModel;
  disabled?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const microphones = model.devices.filter(
    (device) => device.kind === "audioinput",
  );
  const cameras = model.devices.filter(
    (device) => device.kind === "videoinput",
  );

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = model.stream;
    if (model.stream) void video.play().catch(() => {});
    return () => {
      video.pause();
      video.srcObject = null;
    };
  }, [model.stream]);

  if (model.status === "idle") {
    return (
      <section
        aria-labelledby="media-check-heading"
        className="space-y-3 rounded-xl border border-border bg-background/40 p-3"
      >
        <div className="space-y-1">
          <h3 id="media-check-heading" className="text-sm font-medium">
            Camera and microphone check
          </h3>
          <p className="text-xs text-muted-foreground">
            Access is requested only when you choose setup. Your microphone
            starts muted.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          className="w-full"
          disabled={disabled}
          onClick={() => void model.requestPreview()}
        >
          <Settings aria-hidden />
          Set up camera and microphone
        </Button>
      </section>
    );
  }

  if (model.status === "requesting") {
    return (
      <section
        aria-labelledby="media-check-heading"
        className="rounded-xl border border-border bg-background/40 p-4 text-center"
      >
        <h3 id="media-check-heading" className="sr-only">
          Camera and microphone check
        </h3>
        <div
          role="status"
          aria-live="polite"
          className="flex min-h-11 items-center justify-center gap-2 text-sm text-muted-foreground"
        >
          <Loader2 className="animate-spin" aria-hidden />
          Checking camera and microphone…
        </div>
      </section>
    );
  }

  if (model.status !== "ready") {
    const copy = FAILURE_COPY[model.status];
    return (
      <section
        aria-labelledby="media-check-heading"
        className="space-y-3 rounded-xl border border-destructive/40 bg-destructive/10 p-3"
      >
        <div role="alert" className="space-y-1 text-sm">
          <h3 id="media-check-heading" className="font-medium">{copy.title}</h3>
          <p className="text-xs text-muted-foreground">{copy.recovery}</p>
        </div>
        {model.status !== "unsupported" ? (
          <Button
            type="button"
            variant="outline"
            className="w-full"
            disabled={disabled}
            onClick={() => void model.requestPreview()}
          >
            <RefreshCw aria-hidden />
            Try again
          </Button>
        ) : null}
      </section>
    );
  }

  return (
    <section
      aria-labelledby="media-check-heading"
      className="space-y-3 rounded-xl border border-border bg-background/40 p-3"
    >
      <div className="space-y-1">
        <h3 id="media-check-heading" className="text-sm font-medium">
          Preview ready
        </h3>
        <p
          role="status"
          aria-live="polite"
          className="text-xs text-muted-foreground"
        >
          Camera {model.cameraEnabled ? "on" : "off"}. Microphone{" "}
          {model.microphoneEnabled ? "on" : "muted"}.
        </p>
      </div>

      <div className="relative overflow-hidden rounded-lg border border-border bg-black">
        <video
          ref={videoRef}
          aria-label="Local camera preview"
          autoPlay
          muted
          playsInline
          className="aspect-video w-full object-cover"
        />
        {!model.cameraEnabled ? (
          <div className="absolute inset-0 grid place-items-center bg-card text-sm text-muted-foreground">
            Camera off
          </div>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Button
          type="button"
          variant="outline"
          aria-pressed={model.microphoneEnabled}
          aria-label={
            model.microphoneEnabled ? "Mute microphone" : "Turn on microphone"
          }
          disabled={disabled}
          onClick={model.toggleMicrophone}
        >
          {model.microphoneEnabled ? (
            <Mic aria-hidden />
          ) : (
            <MicOff aria-hidden />
          )}
          {model.microphoneEnabled ? "Mic on" : "Mic muted"}
        </Button>
        <Button
          type="button"
          variant="outline"
          aria-pressed={model.cameraEnabled}
          aria-label={
            model.cameraEnabled ? "Turn off camera" : "Turn on camera"
          }
          disabled={disabled}
          onClick={model.toggleCamera}
        >
          {model.cameraEnabled ? (
            <Camera aria-hidden />
          ) : (
            <CameraOff aria-hidden />
          )}
          {model.cameraEnabled ? "Camera on" : "Camera off"}
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="min-w-0 space-y-1.5">
          <Label htmlFor="go-live-camera">Camera</Label>
          <select
            id="go-live-camera"
            value={model.selected.video}
            disabled={disabled}
            onChange={(event) =>
              void model.selectDevice("videoinput", event.target.value)
            }
            className="min-tap w-full min-w-0 rounded-md border border-border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {cameras.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label}
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-0 space-y-1.5">
          <Label htmlFor="go-live-microphone">Microphone</Label>
          <select
            id="go-live-microphone"
            value={model.selected.audio}
            disabled={disabled}
            onChange={(event) =>
              void model.selectDevice("audioinput", event.target.value)
            }
            className="min-tap w-full min-w-0 rounded-md border border-border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {microphones.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label}
              </option>
            ))}
          </select>
        </div>
      </div>
    </section>
  );
}
