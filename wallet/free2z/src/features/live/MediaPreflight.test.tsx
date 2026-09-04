import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MediaPreflight } from "./MediaPreflight";
import type { MediaPreflightModel } from "./useMediaPreflight";

function model(overrides: Partial<MediaPreflightModel>): MediaPreflightModel {
  return {
    status: "idle",
    devices: [],
    selected: { audio: "", video: "" },
    stream: null,
    microphoneEnabled: false,
    cameraEnabled: true,
    requestPreview: vi.fn(async () => {}),
    selectDevice: vi.fn(async () => {}),
    toggleMicrophone: vi.fn(),
    toggleCamera: vi.fn(),
    release: vi.fn(),
    ...overrides,
  };
}

describe("MediaPreflight", () => {
  it("announces explicit intent and the mute default before requesting access", () => {
    const html = renderToStaticMarkup(<MediaPreflight model={model({})} />);
    expect(html).toContain("Access is requested only when you choose setup");
    expect(html).toContain("Your microphone starts muted");
    expect(html).toContain("Set up camera and microphone");
    expect(html).toContain("min-tap");
  });

  it("keeps visible and accessible camera/microphone truth aligned", () => {
    const html = renderToStaticMarkup(<MediaPreflight model={model({
      status: "ready",
      devices: [
        { kind: "videoinput", deviceId: "cam-1", label: "Front camera" },
        { kind: "audioinput", deviceId: "mic-1", label: "Built-in mic" },
      ],
      selected: { audio: "mic-1", video: "cam-1" },
    })} />);
    expect(html).toContain("Camera on. Microphone muted.");
    expect(html).toContain('aria-label="Turn on microphone"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('aria-label="Turn off camera"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-label="Local camera preview"');
    expect(html).toContain('muted=""');
    expect(html).toContain('for="go-live-camera"');
    expect(html).toContain('for="go-live-microphone"');
    expect(html).toContain("Front camera");
    expect(html).toContain("Built-in mic");
  });

  it.each([
    ["denied", "Allow access in system or browser settings"],
    ["no-device", "Connect both devices"],
    ["busy", "Close other apps using it"],
    ["removed", "Reconnect it or try the available replacement"],
  ] as const)("renders a live alert and concise %s recovery", (status, recovery) => {
    const html = renderToStaticMarkup(<MediaPreflight model={model({ status })} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain(recovery);
    expect(html).toContain("Try again");
  });
});
