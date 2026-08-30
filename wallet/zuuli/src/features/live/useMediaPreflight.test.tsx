import { act } from "react";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useMediaPreflight,
  type MediaPreflightModel,
  type UseMediaPreflightOptions,
} from "./useMediaPreflight";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function mediaDevice(kind: MediaDeviceKind, deviceId: string, label: string): MediaDeviceInfo {
  return { kind, deviceId, label, groupId: "group", toJSON: () => ({}) };
}

function fakeTrack(kind: "audio" | "video", deviceId: string) {
  const listeners = new Set<() => void>();
  return {
    kind,
    enabled: true,
    stop: vi.fn(),
    getSettings: () => ({ deviceId }),
    addEventListener: vi.fn((event: string, listener: () => void) => {
      if (event === "ended") listeners.add(listener);
    }),
    removeEventListener: vi.fn((event: string, listener: () => void) => {
      if (event === "ended") listeners.delete(listener);
    }),
    end: () => [...listeners].forEach((listener) => listener()),
  };
}

function fakeStream(audioId = "mic-1", videoId = "cam-1", extras = 0) {
  const audio = [fakeTrack("audio", audioId)];
  const video = [fakeTrack("video", videoId)];
  for (let index = 0; index < extras; index += 1) {
    audio.push(fakeTrack("audio", `${audioId}-extra-${index}`));
    video.push(fakeTrack("video", `${videoId}-extra-${index}`));
  }
  return {
    audio,
    video,
    stream: {
      getTracks: () => [...audio, ...video],
      getAudioTracks: () => audio,
      getVideoTracks: () => video,
    } as unknown as MediaStream,
  };
}

class FakeMediaDevices {
  devices: MediaDeviceInfo[] = [
    mediaDevice("audioinput", "mic-1", "Built-in mic"),
    mediaDevice("audioinput", "mic-2", "USB mic"),
    mediaDevice("videoinput", "cam-1", "Front camera"),
    mediaDevice("videoinput", "cam-2", "Rear camera"),
  ];
  enumerateDevices = vi.fn(async () => this.devices);
  getUserMedia = vi.fn<MediaDevices["getUserMedia"]>();
  listeners = new Set<() => void | Promise<void>>();
  addEventListener = vi.fn((event: string, listener: EventListenerOrEventListenerObject) => {
    if (event === "devicechange") this.listeners.add(listener as () => void);
  });
  removeEventListener = vi.fn((event: string, listener: EventListenerOrEventListenerObject) => {
    if (event === "devicechange") this.listeners.delete(listener as () => void);
  });
  async changeDevices(devices: MediaDeviceInfo[]) {
    this.devices = devices;
    await Promise.all([...this.listeners].map((listener) => listener()));
  }
}

let root: Root;
let container: HTMLElement;
let restoreGlobals: () => void;
let latest: MediaPreflightModel;

function Harness(props: UseMediaPreflightOptions) {
  latest = useMediaPreflight(props);
  return null;
}

beforeEach(async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id='root'></div></body></html>",
  );
  Object.defineProperty(window, "location", {
    configurable: true,
    value: new URL("http://localhost/"),
  });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window,
    document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  }
  restoreGlobals = () => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  };
  container = document.getElementById("root") as unknown as HTMLElement;
  const { createRoot } = await import("react-dom/client");
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  restoreGlobals?.();
});

async function render(mediaDevices: FakeMediaDevices, active = true) {
  await act(async () => {
    root.render(
      <Harness
        active={active}
        mediaDevices={mediaDevices as unknown as UseMediaPreflightOptions["mediaDevices"]}
      />,
    );
  });
}

describe("useMediaPreflight", () => {
  it("enumerates without prompting and applies explicit safe mute defaults", async () => {
    const media = new FakeMediaDevices();
    const capture = fakeStream(undefined, undefined, 1);
    media.getUserMedia.mockResolvedValue(capture.stream);
    await render(media);

    expect(media.enumerateDevices).toHaveBeenCalled();
    expect(media.getUserMedia).not.toHaveBeenCalled();
    expect(latest.status).toBe("idle");

    await act(async () => latest.requestPreview());
    expect(media.getUserMedia).toHaveBeenCalledWith({ audio: true, video: true });
    expect(latest.status).toBe("ready");
    expect(latest.selected).toEqual({ audio: "mic-1", video: "cam-1" });
    for (const track of capture.audio) expect(track.enabled).toBe(false);
    for (const track of capture.video) expect(track.enabled).toBe(true);

    await act(async () => latest.toggleMicrophone());
    await act(async () => latest.toggleCamera());
    for (const track of capture.audio) expect(track.enabled).toBe(true);
    for (const track of capture.video) expect(track.enabled).toBe(false);
  });

  it("reacquires exact selected device IDs and releases every old track", async () => {
    const media = new FakeMediaDevices();
    const first = fakeStream();
    const second = fakeStream("mic-2", "cam-1", 1);
    media.getUserMedia
      .mockResolvedValueOnce(first.stream)
      .mockResolvedValueOnce(second.stream);
    await render(media);
    await act(async () => latest.requestPreview());
    await act(async () => latest.selectDevice("audioinput", "mic-2"));

    expect(media.getUserMedia).toHaveBeenLastCalledWith({
      audio: { deviceId: { exact: "mic-2" } },
      video: { deviceId: { exact: "cam-1" } },
    });
    first.stream.getTracks().forEach((track) => {
      expect(track.stop).toHaveBeenCalledTimes(1);
      expect(track.removeEventListener).toHaveBeenCalledWith("ended", expect.any(Function));
    });
  });

  it("stops stale out-of-order captures and keeps only the newest request", async () => {
    const media = new FakeMediaDevices();
    const older = deferred<MediaStream>();
    const newer = deferred<MediaStream>();
    const oldStream = fakeStream("mic-1", "cam-1");
    const newStream = fakeStream("mic-2", "cam-2");
    media.getUserMedia
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    await render(media);

    let olderRequest!: Promise<void>;
    let newerRequest!: Promise<void>;
    await act(async () => {
      olderRequest = latest.requestPreview();
      newerRequest = latest.selectDevice("audioinput", "mic-2");
      newer.resolve(newStream.stream);
      await newerRequest;
    });
    expect(latest.stream).toBe(newStream.stream);

    await act(async () => {
      older.resolve(oldStream.stream);
      await olderRequest;
    });
    oldStream.stream.getTracks().forEach((track) => {
      expect(track.stop).toHaveBeenCalledTimes(1);
    });
    expect(latest.stream).toBe(newStream.stream);
  });

  it("stops a late permission result after cancel and removes device listeners", async () => {
    const media = new FakeMediaDevices();
    const pending = deferred<MediaStream>();
    const capture = fakeStream();
    media.getUserMedia.mockReturnValue(pending.promise);
    await render(media);
    let request!: Promise<void>;
    await act(async () => {
      request = latest.requestPreview();
    });
    await act(async () => latest.release());
    pending.resolve(capture.stream);
    await act(async () => request);

    capture.stream.getTracks().forEach((track) => {
      expect(track.stop).toHaveBeenCalledTimes(1);
    });
    expect(latest.status).toBe("idle");
    await act(async () => root.unmount());
    expect(media.removeEventListener).toHaveBeenCalledWith(
      "devicechange",
      expect.any(Function),
    );
  });

  it("immediately stops a provisional capture when enumeration hangs after permission", async () => {
    const media = new FakeMediaDevices();
    const initialEnumeration = deferred<MediaDeviceInfo[]>();
    const postCaptureEnumeration = deferred<MediaDeviceInfo[]>();
    const capture = fakeStream();
    media.enumerateDevices
      .mockReturnValueOnce(initialEnumeration.promise)
      .mockReturnValueOnce(postCaptureEnumeration.promise);
    media.getUserMedia.mockResolvedValue(capture.stream);
    await render(media);
    initialEnumeration.resolve(media.devices);
    await act(async () => initialEnumeration.promise);

    let request!: Promise<void>;
    await act(async () => {
      request = latest.requestPreview();
      await vi.waitFor(() => expect(media.enumerateDevices).toHaveBeenCalledTimes(2));
    });
    await act(async () => latest.release());
    capture.stream.getTracks().forEach((track) => {
      expect(track.stop).toHaveBeenCalledTimes(1);
    });

    postCaptureEnumeration.resolve(media.devices);
    await act(async () => request);
    capture.stream.getTracks().forEach((track) => {
      expect(track.stop).toHaveBeenCalledTimes(1);
    });
    expect(latest.status).toBe("idle");
  });

  it("releases the current preview when replacement acquisition fails", async () => {
    const media = new FakeMediaDevices();
    const current = fakeStream();
    media.getUserMedia
      .mockResolvedValueOnce(current.stream)
      .mockRejectedValueOnce({ name: "NotReadableError" });
    await render(media);
    await act(async () => latest.requestPreview());
    await act(async () => latest.selectDevice("videoinput", "cam-2"));

    expect(latest.status).toBe("busy");
    expect(latest.stream).toBeNull();
    current.stream.getTracks().forEach((track) => {
      expect(track.stop).toHaveBeenCalledTimes(1);
    });
  });

  it("resets a removed selected device to an available exact replacement", async () => {
    const media = new FakeMediaDevices();
    const current = fakeStream();
    const replacement = fakeStream("mic-1", "cam-2");
    media.getUserMedia
      .mockResolvedValueOnce(current.stream)
      .mockResolvedValueOnce(replacement.stream);
    await render(media);
    await act(async () => latest.requestPreview());
    await act(async () => {
      await media.changeDevices(
        media.devices.filter((device) => device.deviceId !== "cam-1"),
      );
    });

    expect(latest.status).toBe("removed");
    expect(latest.selected).toEqual({ audio: "mic-1", video: "cam-2" });
    await act(async () => latest.requestPreview());
    expect(media.getUserMedia).toHaveBeenLastCalledWith({
      audio: { deviceId: { exact: "mic-1" } },
      video: { deviceId: { exact: "cam-2" } },
    });
    expect(latest.status).toBe("ready");
    expect(latest.stream).toBe(replacement.stream);
  });

  it("keeps the newest device enumeration when device changes resolve out of order", async () => {
    const media = new FakeMediaDevices();
    const capture = fakeStream();
    media.getUserMedia.mockResolvedValue(capture.stream);
    await render(media);
    await act(async () => latest.requestPreview());

    const older = deferred<MediaDeviceInfo[]>();
    const newer = deferred<MediaDeviceInfo[]>();
    media.enumerateDevices
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    let olderChange!: Promise<unknown[]>;
    let newerChange!: Promise<unknown[]>;
    await act(async () => {
      olderChange = Promise.all([...media.listeners].map((listener) => listener()));
      newerChange = Promise.all([...media.listeners].map((listener) => listener()));
      newer.resolve([
        mediaDevice("audioinput", "mic-1", "Newest mic"),
        mediaDevice("videoinput", "cam-1", "Newest camera"),
        mediaDevice("videoinput", "cam-3", "Newest alternate"),
      ]);
      await newerChange;
    });
    await act(async () => {
      older.resolve([
        mediaDevice("audioinput", "mic-1", "Stale mic"),
        mediaDevice("videoinput", "cam-1", "Stale camera"),
        mediaDevice("videoinput", "cam-2", "Stale alternate"),
      ]);
      await olderChange;
    });

    expect(latest.devices.map((device) => device.label)).toEqual([
      "Newest mic",
      "Newest camera",
      "Newest alternate",
    ]);
  });

  it("direct ready-state unmount releases every track and ended listener", async () => {
    const media = new FakeMediaDevices();
    const capture = fakeStream(undefined, undefined, 2);
    media.getUserMedia.mockResolvedValue(capture.stream);
    await render(media);
    await act(async () => latest.requestPreview());
    await act(async () => root.unmount());

    capture.stream.getTracks().forEach((track) => {
      expect(track.stop).toHaveBeenCalledTimes(1);
      expect(track.removeEventListener).toHaveBeenCalledWith(
        "ended",
        expect.any(Function),
      );
    });
    expect(media.removeEventListener).toHaveBeenCalledWith(
      "devicechange",
      expect.any(Function),
    );
  });

  it("direct unmount releases a provisional stream while enumeration is pending", async () => {
    const media = new FakeMediaDevices();
    const initialEnumeration = deferred<MediaDeviceInfo[]>();
    const postCaptureEnumeration = deferred<MediaDeviceInfo[]>();
    const capture = fakeStream(undefined, undefined, 1);
    media.enumerateDevices
      .mockReturnValueOnce(initialEnumeration.promise)
      .mockReturnValueOnce(postCaptureEnumeration.promise);
    media.getUserMedia.mockResolvedValue(capture.stream);
    await render(media);
    initialEnumeration.resolve(media.devices);
    await act(async () => initialEnumeration.promise);

    let request!: Promise<void>;
    await act(async () => {
      request = latest.requestPreview();
      await vi.waitFor(() => expect(media.enumerateDevices).toHaveBeenCalledTimes(2));
    });
    await act(async () => root.unmount());
    capture.stream.getTracks().forEach((track) => {
      expect(track.stop).toHaveBeenCalledTimes(1);
    });

    postCaptureEnumeration.resolve(media.devices);
    await request;
    capture.stream.getTracks().forEach((track) => {
      expect(track.stop).toHaveBeenCalledTimes(1);
    });
  });

  it("fails closed and releases all tracks when an active track ends", async () => {
    const media = new FakeMediaDevices();
    const capture = fakeStream(undefined, undefined, 1);
    media.getUserMedia.mockResolvedValue(capture.stream);
    await render(media);
    await act(async () => latest.requestPreview());
    await act(async () => capture.video[0].end());

    expect(latest.status).toBe("removed");
    expect(latest.stream).toBeNull();
    expect(latest.selected.video).toBe("");
    capture.stream.getTracks().forEach((track) => {
      expect(track.stop).toHaveBeenCalledTimes(1);
    });
  });

  it("detects selected-device removal and exposes denial, no-device, and busy states", async () => {
    const media = new FakeMediaDevices();
    const capture = fakeStream();
    media.getUserMedia.mockResolvedValueOnce(capture.stream);
    await render(media);
    await act(async () => latest.requestPreview());
    await act(async () => {
      await media.changeDevices(
        media.devices.filter((device) => device.deviceId !== "cam-1"),
      );
    });
    expect(latest.status).toBe("removed");

    for (const [name, expected] of [
      ["NotAllowedError", "denied"],
      ["NotFoundError", "no-device"],
      ["NotReadableError", "busy"],
    ] as const) {
      media.getUserMedia.mockRejectedValueOnce({ name });
      await act(async () => latest.requestPreview());
      expect(latest.status).toBe(expected);
    }
  });
});
