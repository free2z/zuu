import { describe, expect, it, vi } from "vitest";
import {
  captureConstraints,
  captureDevices,
  statusForCaptureError,
  startAfterMediaConfirmation,
  stopMediaStream,
} from "./media-preflight";

function device(
  kind: MediaDeviceKind,
  deviceId: string,
  label = "",
): MediaDeviceInfo {
  return { kind, deviceId, label, groupId: "group", toJSON: () => ({}) };
}

describe("media preflight primitives", () => {
  it("enumerates only capture devices with stable private fallback labels", () => {
    expect(captureDevices([
      device("audiooutput", "speaker"),
      device("videoinput", "front"),
      device("videoinput", "rear", "Rear camera"),
      device("audioinput", "built-in"),
    ])).toEqual([
      { kind: "videoinput", deviceId: "front", label: "Camera 1" },
      { kind: "videoinput", deviceId: "rear", label: "Rear camera" },
      { kind: "audioinput", deviceId: "built-in", label: "Microphone 1" },
    ]);
  });

  it("requests exact selected IDs and never weakens them to ideal hints", () => {
    expect(captureConstraints({ audio: "mic-2", video: "cam-2" })).toEqual({
      audio: { deviceId: { exact: "mic-2" } },
      video: { deviceId: { exact: "cam-2" } },
    });
    expect(captureConstraints({ audio: "", video: "" })).toEqual({
      audio: true,
      video: true,
    });
  });

  it.each([
    ["NotAllowedError", "denied"],
    ["SecurityError", "denied"],
    ["NotFoundError", "no-device"],
    ["OverconstrainedError", "no-device"],
    ["NotReadableError", "busy"],
    ["AbortError", "busy"],
    ["UnknownError", "failed"],
  ] as const)("maps %s to a focused recovery state", (name, expected) => {
    expect(statusForCaptureError({ name })).toBe(expected);
  });

  it("stops every acquired track, not only the first audio and video tracks", () => {
    const tracks = Array.from({ length: 5 }, () => ({ stop: vi.fn() }));
    stopMediaStream({ getTracks: () => tracks } as unknown as MediaStream);
    for (const track of tracks) expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it("continues releasing tracks if a malformed platform track throws", () => {
    const later = vi.fn();
    const stream = {
      getTracks: () => [
        { stop: () => { throw new Error("broken track"); } },
        { stop: later },
      ],
    } as unknown as MediaStream;
    expect(() => stopMediaStream(stream)).not.toThrow();
    expect(later).toHaveBeenCalledTimes(1);
  });

  it("never provisions before confirmation and releases before a successful start", async () => {
    const order: string[] = [];
    const release = vi.fn(() => order.push("release"));
    const provision = vi.fn(async () => {
      order.push("provision");
      return "ticket";
    });

    await expect(startAfterMediaConfirmation({
      confirmed: false,
      release,
      provision,
    })).rejects.toThrow("must be confirmed");
    expect(release).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();

    await expect(startAfterMediaConfirmation({
      confirmed: true,
      release,
      provision,
    })).resolves.toBe("ticket");
    expect(order).toEqual(["release", "provision"]);
  });

  it("has already released all capture when provisioning fails", async () => {
    const release = vi.fn();
    const provision = vi.fn(async () => {
      throw new Error("backend unavailable");
    });
    await expect(startAfterMediaConfirmation({
      confirmed: true,
      release,
      provision,
    })).rejects.toThrow("backend unavailable");
    expect(release).toHaveBeenCalledTimes(1);
    expect(provision).toHaveBeenCalledTimes(1);
  });
});
