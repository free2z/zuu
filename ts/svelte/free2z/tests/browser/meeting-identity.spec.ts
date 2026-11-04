import { expect, test } from "@playwright/test";
import { devSourceModuleLoader } from "./dev-source-module";

const FIXTURE_LOADER = devSourceModuleLoader(
  "/tests/browser/meeting-identity-fixture.svelte",
);
const STORE_LOADER = devSourceModuleLoader(
  "/src/lib/stores/liveStreamStore.ts",
);

test.describe.configure({ timeout: 90_000 });

test("activeSpeaker updates keep one audio watch alive through an in-flight mic restart", async ({
  page,
}) => {
  await page.goto("/search", { waitUntil: "domcontentloaded" });
  await page.evaluate(
    async ({ fixtureLoader, storeLoader }) => {
      const svelteModule = "/tests/browser/svelte-runtime.ts";
      const [{ default: Fixture }, store, { mount }] = await Promise.all([
        new Function(fixtureLoader)(),
        new Function(storeLoader)(),
        import(/* @vite-ignore */ svelteModule),
      ]);
      const ctx = new AudioContext();
      const liveTrack = () =>
        ctx.createMediaStreamDestination().stream.getAudioTracks()[0];
      const listeners = new Map<string, Set<(...args: any[]) => void>>();
      const emitter = {
        on(event: string, listener: (...args: any[]) => void) {
          const group = listeners.get(event) ?? new Set();
          group.add(listener);
          listeners.set(event, group);
        },
        off(event: string, listener: (...args: any[]) => void) {
          listeners.get(event)?.delete(listener);
        },
        emit(event: string, ...args: any[]) {
          for (const listener of listeners.get(event) ?? []) listener(...args);
        },
        count(event: string) {
          return listeners.get(event)?.size ?? 0;
        },
      };
      const joined = Object.assign(emitter, { toArray: () => [] });
      const mic = { deviceId: "mic-1", kind: "audioinput" };
      let releaseAcquisition!: () => void;
      const acquisition = new Promise<void>((resolve) => {
        releaseAcquisition = resolve;
      });
      const self = Object.assign(emitter, {
        audioTrack: liveTrack() as MediaStreamTrack | undefined,
        async getAudioDevices() {
          return [mic];
        },
        getCurrentDevices() {
          return { audio: mic };
        },
        async setDevice() {
          await acquisition;
          const replacement = liveTrack();
          replacement.enabled = false;
          self.audioTrack = replacement;
          self.emit("audioUpdate", {
            audioEnabled: false,
            audioTrack: replacement,
          });
        },
        async enableAudio() {
          if (self.audioTrack) self.audioTrack.enabled = true;
          self.emit("audioUpdate", {
            audioEnabled: true,
            audioTrack: self.audioTrack,
          });
        },
      });
      Object.defineProperty(self, "audioEnabled", {
        get: () =>
          !!self.audioTrack &&
          self.audioTrack.readyState === "live" &&
          self.audioTrack.enabled,
      });
      const meeting = { self, participants: { joined, ...emitter } };
      document.body.innerHTML =
        '<main id="harness" style="position:relative;height:600px"></main>';
      mount(Fixture, { target: document.querySelector("#harness")! });
      store.liveStreamStore.init(meeting, "broadcast", true);
      store.bindRtkEvents(meeting);
      (window as any).__meetingIdentity = {
        emitter,
        joined,
        self,
        meeting,
        releaseAcquisition,
      };
    },
    { fixtureLoader: FIXTURE_LOADER, storeLoader: STORE_LOADER },
  );

  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__meetingIdentity.self.count("audioUpdate"),
      ),
    )
    .toBe(1);
  await page.evaluate(() => {
    const { self } = (window as any).__meetingIdentity;
    self.audioTrack.stop();
  });
  const stalled = page.locator('[data-rtk-audio-health-mic="stalled"]');
  await expect(stalled).toBeVisible({ timeout: 12_000 });
  const audioListeners = await page.evaluate(() =>
    (window as any).__meetingIdentity.self.count("audioUpdate"),
  );
  expect(audioListeners).toBe(1);
  await stalled.getByRole("button").click();

  await page.waitForTimeout(50);
  await page.evaluate(async (storeLoader) => {
    const store = await new Function(storeLoader)();
    const { meeting, releaseAcquisition } = (window as any).__meetingIdentity;
    for (let index = 0; index < 10; index++) {
      meeting.participants.emit("activeSpeaker", {
        peerId: `speaker-${index}`,
        volume: 1,
      });
      store.liveStreamStore.setConnectionStatus("connected");
    }
    releaseAcquisition();
  }, STORE_LOADER);
  await expect(
    page.locator('[data-rtk-audio-health-mic="unmute"]'),
  ).toBeVisible({
    timeout: 10_000,
  });
  expect(
    await page.evaluate(() =>
      (window as any).__meetingIdentity.self.count("audioUpdate"),
    ),
  ).toBe(audioListeners);
});
