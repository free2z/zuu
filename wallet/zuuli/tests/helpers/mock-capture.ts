import type { Page } from "@playwright/test";

export async function installMockCapture(page: Page) {
  await page.addInitScript(() => {
    const captureState = {
      requests: [] as MediaStreamConstraints[],
      stoppedTracks: 0,
    };
    Object.defineProperty(window, "__zuuliCapture", {
      configurable: true,
      value: captureState,
    });

    const deviceListeners = new Set<EventListenerOrEventListenerObject>();
    function track(kind: "audio" | "video", deviceId: string) {
      const ended = new Set<EventListenerOrEventListenerObject>();
      return {
        kind,
        enabled: true,
        label: kind === "audio" ? "Studio microphone" : "Front camera",
        stop() {
          captureState.stoppedTracks += 1;
        },
        getSettings() {
          return { deviceId };
        },
        addEventListener(event: string, listener: EventListenerOrEventListenerObject) {
          if (event === "ended") ended.add(listener);
        },
        removeEventListener(event: string, listener: EventListenerOrEventListenerObject) {
          if (event === "ended") ended.delete(listener);
        },
      };
    }

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        async enumerateDevices() {
          return [
            {
              kind: "videoinput",
              deviceId: "cam-1",
              groupId: "video",
              label: "Front camera",
              toJSON() { return {}; },
            },
            {
              kind: "audioinput",
              deviceId: "mic-1",
              groupId: "audio",
              label: "Studio microphone",
              toJSON() { return {}; },
            },
          ];
        },
        async getUserMedia(constraints: MediaStreamConstraints) {
          captureState.requests.push(constraints);
          const audio = track("audio", "mic-1");
          const video = track("video", "cam-1");
          return {
            getTracks: () => [audio, video],
            getAudioTracks: () => [audio],
            getVideoTracks: () => [video],
          };
        },
        addEventListener(event: string, listener: EventListenerOrEventListenerObject) {
          if (event === "devicechange") deviceListeners.add(listener);
        },
        removeEventListener(event: string, listener: EventListenerOrEventListenerObject) {
          if (event === "devicechange") deviceListeners.delete(listener);
        },
      },
    });

    Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
      configurable: true,
      get() { return (this as HTMLMediaElement & { __stream?: unknown }).__stream ?? null; },
      set(value) { (this as HTMLMediaElement & { __stream?: unknown }).__stream = value; },
    });
    HTMLMediaElement.prototype.play = async () => {};
    HTMLMediaElement.prototype.pause = () => {};
  });
}

export async function captureState(page: Page) {
  return page.evaluate(() => (
    window as Window & {
      __zuuliCapture: {
        requests: MediaStreamConstraints[];
        stoppedTracks: number;
      };
    }
  ).__zuuliCapture);
}
