import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";

let vite;
let getHostStreamMediaOptions;
let liveStreamStore;
let bindRtkEvents;
let meetingStore;

before(async () => {
  vite = await createServer({
    appType: "custom",
    server: { hmr: false, middlewareMode: true },
  });
  ({ getHostStreamMediaOptions } = await vite.ssrLoadModule(
    "/src/lib/utils/stream-media-config.ts",
  ));
  ({ liveStreamStore, bindRtkEvents, meetingStore } = await vite.ssrLoadModule(
    "/src/lib/stores/liveStreamStore.ts",
  ));
});

after(async () => {
  await vite?.close();
});

test("host capture uses the RealtimeKit 2.0.3 camera and screenshare caps", () => {
  const options = getHostStreamMediaOptions("480p");
  assert.deepEqual(options.defaults.mediaConfiguration, {
    video: {
      height: { ideal: 480 },
      width: { ideal: 854 },
      frameRate: { ideal: 24 },
    },
    screenshare: {
      width: { max: 1280 },
      height: { max: 720 },
      frameRate: { ideal: 5, max: 15 },
    },
  });
  assert.deepEqual(options.overrides.simulcastConfig.encodings, [
    { rid: "f", maxBitrate: 1_200_000, maxFramerate: 24 },
    {
      rid: "h",
      maxBitrate: 400_000,
      maxFramerate: 24,
      scaleResolutionDownBy: 2,
    },
    {
      rid: "q",
      maxBitrate: 150_000,
      maxFramerate: 24,
      scaleResolutionDownBy: 4,
    },
  ]);
  assert.deepEqual(
    getHostStreamMediaOptions("unknown").defaults.mediaConfiguration.video,
    {
      height: { ideal: 720 },
      width: { ideal: 1280 },
      frameRate: { ideal: 24 },
    },
  );
});

test("meetingStore publishes only identity changes; activeSpeaker has no audio-level write", () => {
  liveStreamStore.reset();
  const client = {
    meta: {},
    participants: {
      joined: {
        toArray: () => [],
        on() {},
        off() {},
      },
      on(_event, callback) {
        this.activeSpeaker = callback;
      },
      off() {},
    },
  };
  const seen = [];
  const unsubscribe = meetingStore.subscribe((meeting) => seen.push(meeting));
  liveStreamStore.init(client, "broadcast", true);
  const unbind = bindRtkEvents(client);
  client.participants.activeSpeaker({ peerId: "host", volume: 1 });
  client.participants.activeSpeaker({ peerId: "host", volume: 1 });
  liveStreamStore.setConnectionStatus("connected");

  assert.deepEqual(seen, [null, client]);
  let state;
  const stopState = liveStreamStore.subscribe((next) => (state = next));
  assert.deepEqual(state.audioLevels, {});
  unbind();
  stopState();
  unsubscribe();
  liveStreamStore.reset();
});
