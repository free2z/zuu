import { expect, test, type Page } from "@playwright/test";

import { devSourceModuleLoader } from "./dev-source-module";

// Through the guarded loader: the component imports `$lib/i18n`, which
// touches `$app/environment` and so races a Vite re-optimisation reload if
// imported bare (see dev-source-module.ts).
const HEALTH_COMPONENT_LOADER = devSourceModuleLoader(
  "/src/lib/components/stream/RtkAudioHealth.svelte",
);

/**
 *live audio "dies off". The node suite pins the watch's logic against
 * fake tracks; this spec runs the REAL component against REAL
 * MediaStreamTracks in Chromium, because the property that matters most is a
 * browser one: `MediaStreamTrack.stop()` ends a track WITHOUT dispatching
 * `ended`, so only a watch that polls `readyState` notices. The tracks come
 * from an AudioContext destination, which needs no microphone permission and
 * no fake-device flags.
 *
 * The meeting object is a stand-in for the RealtimeKit client exposing only
 * the fields the watch reads, modelled on Core 2.0.2's real behaviour:
 * `audioEnabled` is a getter over the track (live && enabled), enable/disable
 * only toggle `enabled` on the same track, and `setDevice()` stops the track
 * and acquires a new one. The UI Kit's own playback is covered by the last
 * test in this file.
 */
test.describe.configure({ timeout: 90_000 });

async function mountHealth(page: Page, mode: "host" | "viewer") {
  // A normal page first, so the root layout's stylesheet is present.
  await page.goto("/search");
  await page.evaluate(
    async ({ mode, loader }) => {
      const ctx = new AudioContext();
      const liveTrack = () =>
        ctx.createMediaStreamDestination().stream.getAudioTracks()[0];

      class Emitter {
        listeners = new Map<string, Set<(...a: unknown[]) => void>>();
        on(event: string, fn: (...a: unknown[]) => void) {
          if (!this.listeners.has(event)) this.listeners.set(event, new Set());
          this.listeners.get(event)!.add(fn);
        }
        off(event: string, fn: (...a: unknown[]) => void) {
          this.listeners.get(event)?.delete(fn);
        }
        emit(event: string, ...args: unknown[]) {
          for (const fn of this.listeners.get(event) ?? []) fn(...args);
        }
      }

      const state = {
        calls: [] as string[],
        reconnects: 0,
        // What the next acquisition yields: "dead" until a spec flips it.
        nextTrack: "dead" as "dead" | "live",
      };
      const mic = { deviceId: "mic-1", kind: "audioinput" };
      const self = Object.assign(new Emitter(), {
        audioTrack: liveTrack() as MediaStreamTrack | undefined,
        announce() {
          self.emit("audioUpdate", {
            audioEnabled: (self as any).audioEnabled,
            audioTrack: self.audioTrack,
          });
        },
        async enableAudio() {
          state.calls.push("enableAudio");
          if (self.audioTrack) self.audioTrack.enabled = true;
          self.announce();
        },
        getCurrentDevices: () => ({ audio: mic }),
        getAudioDevices: async () => [mic],
        async setDevice() {
          state.calls.push("setDevice");
          const wasEnabled = (self as any).audioEnabled;
          self.audioTrack?.stop();
          const track = liveTrack();
          if (state.nextTrack === "dead") track.stop();
          track.enabled = wasEnabled;
          self.audioTrack = track;
          self.announce();
        },
      });
      Object.defineProperty(self, "audioEnabled", {
        get: () =>
          !!self.audioTrack &&
          self.audioTrack.readyState === "live" &&
          self.audioTrack.enabled,
      });
      const host = {
        id: "host",
        name: "Host",
        audioEnabled: true,
        audioTrack: liveTrack(),
      };
      const joined = Object.assign(new Emitter(), {
        toArray: () => (mode === "viewer" ? [host] : []),
      });
      const meeting = { self, participants: { joined } };
      Object.assign(window, { __health: { state, self, host } });

      document.body.innerHTML =
        '<main id="harness" style="position:relative;height:600px"></main>';
      const svelteModule = "/@id/svelte";
      const [{ default: RtkAudioHealth }, { mount }] = await Promise.all([
        new Function(loader)(),
        import(/* @vite-ignore */ svelteModule),
      ]);
      mount(RtkAudioHealth, {
        target: document.querySelector("#harness")!,
        props: {
          meeting,
          mode,
          onReconnect: () => {
            state.reconnects += 1;
          },
        },
      });
    },
    { mode, loader: HEALTH_COMPONENT_LOADER },
  );
}

test("a healthy microphone shows nothing", async ({ page }) => {
  await mountHealth(page, "host");
  // Longer than grace + one poll: a false positive would have painted by now.
  await page.waitForTimeout(6_500);
  await expect(page.locator("[data-rtk-audio-health]")).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as any).__health.state.calls),
  ).toEqual([]);
});

test("a silently stopped microphone is reported; restart re-acquires it and unmute is one more click", async ({
  page,
}) => {
  await mountHealth(page, "host");

  // stop() ends the track and fires NO `ended` event.
  await page.evaluate(() => (window as any).__health.self.audioTrack.stop());

  const stalled = page.locator('[data-rtk-audio-health-mic="stalled"]');
  await expect(stalled).toBeVisible({ timeout: 20_000 });
  await expect(stalled).toHaveAttribute("role", "alert");
  // No automatic restart, ever: re-opening the mic is the person's call.
  // The banner's button is the only path (below).
  expect(
    await page.evaluate(() => (window as any).__health.state.calls),
  ).toEqual([]);

  // The device is back: the manual restart produces a live track. Core
  // re-acquires the replacement for an ENDED track muted, and we never
  // unmute on the person's behalf, so the banner asks for one more click.
  await page.evaluate(() => {
    (window as any).__health.state.nextTrack = "live";
  });
  await stalled.getByRole("button").click();
  const unmute = page.locator('[data-rtk-audio-health-mic="unmute"]');
  await expect(unmute).toBeVisible({ timeout: 10_000 });
  expect(
    await page.evaluate(() => (window as any).__health.state.calls),
  ).toEqual(["setDevice"]);

  await unmute.getByRole("button").click();
  await expect(page.locator("[data-rtk-audio-health]")).toHaveCount(0, {
    timeout: 10_000,
  });
  expect(
    await page.evaluate(() => (window as any).__health.state.calls),
  ).toEqual(["setDevice", "enableAudio"]);
});

test("a viewer whose incoming audio track dies is told, and can reconnect", async ({
  page,
}) => {
  await mountHealth(page, "viewer");
  await page.waitForTimeout(1_500);
  await expect(page.locator("[data-rtk-audio-health]")).toHaveCount(0);

  await page.evaluate(() => (window as any).__health.host.audioTrack.stop());

  const banner = page.locator("[data-rtk-audio-health-remote]");
  await expect(banner).toBeVisible({ timeout: 20_000 });
  await banner.getByRole("button").click();
  expect(
    await page.evaluate(() => (window as any).__health.state.reconnects),
  ).toBe(1);
  // A viewer never restarts a microphone it does not own.
  expect(
    await page.evaluate(() => (window as any).__health.state.calls),
  ).toEqual([]);
});

/**
 * The ROOT CAUSE, run through the real shipped UI Kit web component.
 *
 * `<rtk-participants-audio>` is what plays every remote participant inside
 * `<rtk-meeting>`. After an SFU/socket reconnect the SDK re-emits
 * `audioUpdate` for the same participant with a NEW track (the old one has
 * ended). UI Kit 1.x ignored the new track because an entry with that id
 * already existed, so the page played an ended track: silence until reload.
 * `preloadedAudioElem` is the component's documented property for supplying
 * the <audio> element, which is what lets this spec look at what is playing.
 */
test("the shipped rtk-participants-audio plays the replacement track after a reconnect", async ({
  page,
}) => {
  await page.goto("/search");
  const playing = await page.evaluate(async () => {
    const loaderModule = "/@id/@cloudflare/realtimekit-ui/loader";
    const { defineCustomElements } = await import(
      /* @vite-ignore */ loaderModule
    );
    await defineCustomElements();

    class Emitter {
      listeners = new Map<string, Set<(...a: unknown[]) => void>>();
      addListener(event: string, fn: (...a: unknown[]) => void) {
        if (!this.listeners.has(event)) this.listeners.set(event, new Set());
        this.listeners.get(event)!.add(fn);
        return this;
      }
      on(event: string, fn: (...a: unknown[]) => void) {
        return this.addListener(event, fn);
      }
      removeListener(event: string, fn: (...a: unknown[]) => void) {
        this.listeners.get(event)?.delete(fn);
        return this;
      }
      off(event: string, fn: (...a: unknown[]) => void) {
        return this.removeListener(event, fn);
      }
      emit(event: string, ...args: unknown[]) {
        for (const fn of this.listeners.get(event) ?? []) fn(...args);
      }
    }
    const joined = Object.assign(new Emitter(), { toArray: () => [] });
    const self = Object.assign(new Emitter(), {
      getCurrentDevices: () => ({ speaker: null }),
      permissions: {},
    });
    const logger = { error() {}, warn() {}, info() {}, debug() {}, log() {} };
    const meeting = {
      __internals__: { logger, browserSpecs: { isFirefox: () => false } },
      meta: { viewType: "WEBINAR" },
      self,
      participants: { joined },
    };

    const audio = document.createElement("audio");
    const element = document.createElement("rtk-participants-audio") as any;
    element.preloadedAudioElem = audio;
    element.meeting = meeting;
    document.body.appendChild(element);
    await element.componentOnReady?.();
    const deadline = Date.now() + 10_000;
    while (!joined.listeners.get("audioUpdate")?.size) {
      if (Date.now() > deadline) throw new Error("audioUpdate never bound");
      await new Promise((r) => setTimeout(r, 20));
    }

    const ctx = new AudioContext();
    const track = () =>
      ctx.createMediaStreamDestination().stream.getAudioTracks()[0];
    const before = track();
    joined.emit("audioUpdate", {
      id: "host",
      audioEnabled: true,
      audioTrack: before,
    });
    // Reconnect: the old consumer's track is gone and a new one arrives.
    before.stop();
    const after = track();
    joined.emit("audioUpdate", {
      id: "host",
      audioEnabled: true,
      audioTrack: after,
    });

    const tracks = (audio.srcObject as MediaStream).getAudioTracks();
    return tracks.map((t) => ({
      isReplacement: t === after,
      readyState: t.readyState,
    }));
  });

  expect(playing).toEqual([{ isReplacement: true, readyState: "live" }]);
});
