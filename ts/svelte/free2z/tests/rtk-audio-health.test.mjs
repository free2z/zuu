//live audio "dies off". Two layers are pinned here.
//
// 1. The ROOT CAUSE we can prove from code: the RealtimeKit UI Kit we shipped
//    (1.2.0) played remote audio through an `RTKAudio` helper whose
//    `addTrack(id, track)` was a no-op when an entry with that id already
//    existed. After a reconnect the SDK re-emits `audioUpdate` for the same
//    participant with a NEW MediaStreamTrack (the old one has ended), and 1.x
//    kept playing the dead one: silence until a full page reload. UI Kit 2.0.0
//    fixed it ("Fixed missing audio after reconnection due to stale tracks not
//    being replaced"). The test below runs the RTKAudio class copied out of the
//    lazy entry the browser ACTUALLY loads, so a downgrade, a lockfile drift or
//    a vendor regression all go red here.
//
// 2. Our own liveness watch (`src/lib/utils/rtk-audio-health.ts`), which
//    notices a dead or persistently muted track and recovers through public
//    SDK calls, never by touching tracks itself.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  AUDIO_POLL_INTERVAL_MS,
  AUDIO_STALL_GRACE_MS,
  deadTrackReason,
  intentFrom,
  watchRtkAudio,
} from "../src/lib/utils/rtk-audio-health.ts";

const ROOT = path.resolve(import.meta.dirname, "..");

// ---------------------------------------------------------------------------
// 1. The shipped UI Kit replaces a participant's stale audio track.
// ---------------------------------------------------------------------------

function uiKitDir() {
  // The package's `exports` map hides package.json from require.resolve.
  return path.join(ROOT, "node_modules/@cloudflare/realtimekit-ui");
}

/** Pull `class RTKAudio {... }` out of the shipped lazy entry by brace depth. */
function extractRtkAudioClass() {
  const entry = path.join(
    uiKitDir(),
    "dist/esm/rtk-participants-audio.entry.js",
  );
  const source = fs.readFileSync(entry, "utf8");
  const start = source.indexOf("class RTKAudio {");
  assert.notEqual(
    start,
    -1,
    `${entry} no longer defines RTKAudio; re-derive this test from the new UI Kit`,
  );
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, i + 1);
  }
  throw new Error("unbalanced RTKAudio class body");
}

class FakeMediaStream {
  constructor() {
    this.tracks = [];
  }
  addTrack(track) {
    if (!this.tracks.includes(track)) this.tracks.push(track);
  }
  removeTrack(track) {
    this.tracks = this.tracks.filter((t) => t !== track);
  }
  getAudioTracks() {
    return [...this.tracks];
  }
}

function loadShippedRtkAudio() {
  const body = extractRtkAudioClass();
  // The class references two free names: `MediaStream` and `isFirefox`
  // (only from setDevice). `document` is untouched when an element is passed.
  const factory = new Function(
    "MediaStream",
    "isFirefox",
    `${body}\nreturn RTKAudio;`,
  );
  return factory(FakeMediaStream, () => false);
}

function fakeMeeting() {
  return {
    __internals__: {
      logger: { error() {}, warn() {}, info() {} },
    },
  };
}

function fakeAudioElement() {
  return {
    autoplay: false,
    srcObject: null,
    playCalls: 0,
    play() {
      this.playCalls += 1;
      return Promise.resolve();
    },
  };
}

test("the shipped UI Kit is a 2.x release (the stale-track fix landed in 2.0.0)", () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(uiKitDir(), "package.json"), "utf8"),
  );
  const major = Number(pkg.version.split(".")[0]);
  assert.ok(
    major >= 2,
    `@cloudflare/realtimekit-ui ${pkg.version} predates the reconnect audio fix`,
  );
});

test("a participant's audio track replaced on reconnect is the one that plays", () => {
  const RTKAudio = loadShippedRtkAudio();
  const element = fakeAudioElement();
  const audio = new RTKAudio(fakeMeeting(), element);

  const beforeReconnect = { id: "track-before", readyState: "live" };
  audio.addTrack("audio-host", beforeReconnect);

  // The SFU session dropped and recovered: the old consumer's track ended and
  // the SDK re-emits audioUpdate for the SAME participant with a new track.
  beforeReconnect.readyState = "ended";
  const afterReconnect = { id: "track-after", readyState: "live" };
  audio.addTrack("audio-host", afterReconnect);

  const playing = element.srcObject.getAudioTracks();
  assert.deepEqual(
    playing.map((t) => t.id),
    ["track-after"],
    "the audio element must play the reconnected track, not the ended one " +
      "(UI Kit 1.x kept the ended track: the #2284 dropout)",
  );
  audio.addTrack("audio-host", afterReconnect);
  assert.deepEqual(
    element.srcObject.getAudioTracks().map((track) => track.id),
    ["track-after"],
    "a repeated reconnect event must not duplicate the playing track",
  );
  audio.removeTrack("audio-host");
  assert.deepEqual(
    element.srcObject.getAudioTracks(),
    [],
    "removing the participant releases its replacement track",
  );
});

test("screenshare audio and mic audio of one participant stay independent", () => {
  const RTKAudio = loadShippedRtkAudio();
  const element = fakeAudioElement();
  const audio = new RTKAudio(fakeMeeting(), element);
  audio.addTrack("audio-host", { id: "mic" });
  audio.addTrack("screenshare-host", { id: "screen" });
  audio.removeTrack("screenshare-host");
  assert.deepEqual(
    element.srcObject.getAudioTracks().map((t) => t.id),
    ["mic"],
  );
});

test("Core and UI Kit are pinned to the same 2.x major, as upstream builds them", () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
  );
  const core = pkg.dependencies["@cloudflare/realtimekit"];
  const ui = pkg.dependencies["@cloudflare/realtimekit-ui"];
  assert.match(
    core,
    /^2\.\d+\.\d+$/,
    `core must be an exact 2.x pin, got ${core}`,
  );
  assert.match(ui, /^2\.\d+\.\d+$/, `ui must be an exact 2.x pin, got ${ui}`);
  assert.equal(core, ui, "upstream releases Core and UI Kit in lockstep");
  // There is no `@cloudflare/realtimekit-web` on npm (checked 2026-09-28);
  // the quickstart snippet that names it is wrong, see.
  assert.equal(pkg.dependencies["@cloudflare/realtimekit-web"], undefined);
});

// ---------------------------------------------------------------------------
// 2. The liveness watch.
// ---------------------------------------------------------------------------

class FakeEmitter {
  constructor() {
    this.listeners = new Map();
  }
  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
  }
  off(event, fn) {
    this.listeners.get(event)?.delete(fn);
  }
  emit(event, ...args) {
    for (const fn of this.listeners.get(event) ?? []) fn(...args);
  }
  count() {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }
}

function liveTrack() {
  return { readyState: "live", muted: false, enabled: true };
}

const MIC = { deviceId: "mic-1", kind: "audioinput" };

/**
 * A stand-in for Core 2.0.2's `meeting.self`, faithful where it matters
 * (checked against node_modules/@cloudflare/realtimekit/dist/index.es.js):
 *
 * - `audioEnabled` is a GETTER over the track: live && enabled. A track that
 *   dies silently flips it to false with no event, exactly like a mute.
 * - `disableAudio()` / `enableAudio()` only toggle `enabled` on the SAME
 *   track (muteTrack/unmuteTrack); `enableAudio()` acquires a track only
 *   when none exists. They cannot revive a suspended source.
 * - `setDevice(device)` stops the current track and acquires a fresh one
 *   (AudioMediaHandler.onSetDevice), muted if the old one was not enabled.
 */
function fakeRtkMeeting({ selfTrack = liveTrack(), participants = [] } = {}) {
  const self = Object.assign(new FakeEmitter(), {
    audioTrack: selfTrack,
    calls: [],
    // What getUserMedia yields on the next acquisition.
    acquire: liveTrack,
    announce() {
      this.emit("audioUpdate", {
        audioEnabled: this.audioEnabled,
        audioTrack: this.audioTrack,
      });
    },
    async disableAudio() {
      this.calls.push("disableAudio");
      if (this.audioTrack) this.audioTrack.enabled = false;
      this.announce();
    },
    async enableAudio() {
      this.calls.push("enableAudio");
      if (this.audioTrack) this.audioTrack.enabled = true;
      else this.audioTrack = this.acquire();
      this.announce();
    },
    getCurrentDevices() {
      return { audio: MIC };
    },
    async getAudioDevices() {
      return [MIC];
    },
    async setDevice(device) {
      this.calls.push(`setDevice:${device.deviceId}`);
      const wasEnabled = this.audioEnabled;
      if (this.audioTrack) this.audioTrack.readyState = "ended";
      const next = this.acquire();
      if (!wasEnabled) next.enabled = false;
      this.audioTrack = next;
      this.announce();
    },
  });
  // A real getter (Object.assign would have copied a one-time snapshot).
  Object.defineProperty(self, "audioEnabled", {
    get() {
      const t = this.audioTrack;
      return !!t && t.readyState === "live" && t.enabled !== false;
    },
  });
  const joined = Object.assign(new FakeEmitter(), {
    list: participants,
    toArray() {
      return [...this.list];
    },
  });
  return { self, participants: { joined } };
}

function fakeClock() {
  let t = 0;
  const intervals = new Set();
  return {
    now: () => t,
    setInterval(fn) {
      intervals.add(fn);
      return fn;
    },
    clearInterval(fn) {
      intervals.delete(fn);
    },
    /** Advance time, firing the poll once per interval like a real timer. */
    advance(ms) {
      const end = t + ms;
      while (t < end) {
        t = Math.min(end, t + AUDIO_POLL_INTERVAL_MS);
        for (const fn of intervals) fn();
      }
    },
    active: () => intervals.size,
  };
}

// Worst-case detection latency: the first poll that SEES the bad track starts
// the grace period, and that poll can be up to one interval late.
const DETECT_MS = AUDIO_STALL_GRACE_MS + AUDIO_POLL_INTERVAL_MS;

const flush = async () => {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

function watch(meeting, clock, options) {
  const seen = [];
  const handle = watchRtkAudio(meeting, {
    ...options,
    now: clock.now,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    onChange: (h) => seen.push(h),
  });
  return {
    seen,
    stop: () => handle.stop(),
    restartMic: () => handle.restartMic(),
    unmuteMic: () => handle.unmuteMic(),
    latest: () => seen.at(-1),
  };
}

test("deadTrackReason distinguishes missing, ended and muted tracks", () => {
  assert.equal(deadTrackReason(undefined), "missing");
  assert.equal(deadTrackReason({ readyState: "ended", muted: false }), "ended");
  assert.equal(deadTrackReason({ readyState: "live", muted: true }), "muted");
  assert.equal(deadTrackReason(liveTrack()), null);
});

test("a brief microphone mute inside the grace period is not reported", () => {
  const clock = fakeClock();
  const meeting = fakeRtkMeeting();
  const w = watch(meeting, clock, { watchSelf: true });
  meeting.self.audioTrack.muted = true;
  clock.advance(AUDIO_STALL_GRACE_MS - AUDIO_POLL_INTERVAL_MS);
  meeting.self.audioTrack.muted = false;
  clock.advance(AUDIO_STALL_GRACE_MS * 2);
  assert.equal(w.latest().self.status, "ok");
  assert.deepEqual(meeting.self.calls, [], "no restart for a blip");
  w.stop();
});

test("a microphone track that ENDS silently is caught although audioEnabled reads false", async () => {
  // Core 2.0.2's audioEnabled getter is false for an ended track, and
  // MediaStreamTrack.stop() dispatches no `ended` and the SDK no
  // `audioUpdate`. A watch keyed on audioEnabled reads this as a mute.
  const clock = fakeClock();
  const meeting = fakeRtkMeeting();
  const w = watch(meeting, clock, { watchSelf: true });
  meeting.self.audioTrack.readyState = "ended";
  assert.equal(meeting.self.audioEnabled, false, "the SDK getter flips");
  clock.advance(DETECT_MS);
  assert.deepEqual(w.latest().self, { status: "stalled", reason: "ended" });
  w.stop();
});

test("an ended microphone is reported; the restart re-acquires it MUTED and one click unmutes", async () => {
  const clock = fakeClock();
  const meeting = fakeRtkMeeting();
  const w = watch(meeting, clock, { watchSelf: true });
  meeting.self.audioTrack.readyState = "ended";
  clock.advance(DETECT_MS);
  await flush();
  assert.deepEqual(meeting.self.calls, [], "nothing automatic");
  assert.deepEqual(w.latest().self, { status: "stalled", reason: "ended" });

  await w.restartMic();
  // Core's replacement for an ended track arrives disabled. We do NOT
  // unmute it on the person's behalf; we ask.
  assert.deepEqual(meeting.self.calls, ["setDevice:mic-1"]);
  assert.equal(meeting.self.audioEnabled, false);
  assert.equal(w.latest().self.status, "unmute");

  await w.unmuteMic();
  assert.deepEqual(meeting.self.calls, ["setDevice:mic-1", "enableAudio"]);
  assert.equal(meeting.self.audioEnabled, true);
  assert.equal(w.latest().self.status, "ok");
  w.stop();
});

test("a deliberate mute (SDK announces audioEnabled:false) is 'off', never a fault", () => {
  const clock = fakeClock();
  const meeting = fakeRtkMeeting();
  const w = watch(meeting, clock, { watchSelf: true });
  void meeting.self.disableAudio(); // what the control-bar mic button calls
  meeting.self.calls.length = 0;
  clock.advance(DETECT_MS * 3);
  assert.equal(w.latest().self.status, "off");
  assert.deepEqual(meeting.self.calls, []);
  w.stop();
});

test("joining with the microphone off is 'off'", () => {
  const clock = fakeClock();
  const meeting = fakeRtkMeeting({ selfTrack: null });
  const w = watch(meeting, clock, { watchSelf: true });
  clock.advance(DETECT_MS * 3);
  assert.equal(w.latest().self.status, "off");
  assert.deepEqual(meeting.self.calls, []);
  w.stop();
});

test("a viewer is told when the broadcaster's audio track dies, and it clears on a new track", () => {
  const clock = fakeClock();
  const host = {
    id: "host",
    name: "Host",
    audioEnabled: true,
    audioTrack: liveTrack(),
  };
  const meeting = fakeRtkMeeting({ participants: [host] });
  const w = watch(meeting, clock, { watchRemote: true });
  assert.deepEqual(w.latest().remote, []);

  host.audioTrack.readyState = "ended";
  clock.advance(DETECT_MS);
  assert.deepEqual(w.latest().remote, [
    { id: "host", name: "Host", reason: "ended" },
  ]);

  // The SDK re-subscribed: a fresh track arrives with audioUpdate.
  host.audioTrack = liveTrack();
  meeting.participants.joined.emit("audioUpdate", host);
  assert.deepEqual(w.latest().remote, [], "clears immediately on the event");
  w.stop();
});

test("a participant the SDK never subscribed to (no track) is not reported", () => {
  const clock = fakeClock();
  const unsubscribed = { id: "p9", audioEnabled: true, audioTrack: undefined };
  const meeting = fakeRtkMeeting({ participants: [unsubscribed] });
  const w = watch(meeting, clock, { watchRemote: true });
  clock.advance(DETECT_MS * 3);
  assert.deepEqual(w.latest().remote, []);
  w.stop();
});

test("a broadcaster who muted themself is not a viewer-side fault", () => {
  const clock = fakeClock();
  const host = {
    id: "host",
    audioEnabled: false,
    audioTrack: undefined,
  };
  const meeting = fakeRtkMeeting({ participants: [host] });
  const w = watch(meeting, clock, { watchRemote: true });
  clock.advance(DETECT_MS * 3);
  assert.deepEqual(w.latest().remote, []);
  w.stop();
});

test("viewer mode never restarts the local microphone", () => {
  const clock = fakeClock();
  const meeting = fakeRtkMeeting();
  meeting.self.audioTrack.muted = true;
  const w = watch(meeting, clock, { watchRemote: true });
  clock.advance(DETECT_MS * 3);
  assert.deepEqual(meeting.self.calls, []);
  assert.equal(w.latest().self.status, "ok", "self is not watched");
  w.stop();
});

test("a microphone permission revoked mid-call is reported, not read as a mute", async () => {
  const clock = fakeClock();
  const meeting = fakeRtkMeeting();
  const w = watch(meeting, clock, { watchSelf: true });
  // What the SDK does: emit the error, then turn audio off (announced).
  meeting.self.emit("mediaPermissionError", { kind: "audio" });
  meeting.self.audioTrack = undefined;
  meeting.self.announce();
  clock.advance(DETECT_MS * 2);
  await flush();
  assert.deepEqual(w.latest().self, {
    status: "stalled",
    reason: "permission",
  });
  assert.deepEqual(meeting.self.calls, [], "no restart loop against a denial");

  // The person re-allowed the mic and restarted it: a live track clears it.
  await w.restartMic();
  assert.equal(w.latest().self.status, "unmute");
  await w.unmuteMic();
  assert.equal(w.latest().self.status, "ok");

  // A video-only permission error is not a microphone problem.
  meeting.self.emit("mediaPermissionError", { kind: "video" });
  assert.equal(w.latest().self.status, "ok");
  w.stop();
});

/** Make getAudioDevices() hang until the test releases it. */
function deferDeviceEnumeration(meeting) {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const original = meeting.self.getAudioDevices.bind(meeting.self);
  meeting.self.getAudioDevices = async () => {
    await gate;
    return original();
  };
  return () => release();
}

/**
 * Make setDevice() hang on acquisition, in Core 2.0.2's order: snapshot the
 * old track's enabled state, stop and REMOVE the old track, then await
 * getUserMedia (AudioMediaHandler.onSetDevice).
 */
function deferAcquisition(meeting) {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const self = meeting.self;
  self.setDevice = async function (device) {
    this.calls.push(`setDevice:${device.deviceId}`);
    const wasEnabled = this.audioEnabled;
    if (this.audioTrack) this.audioTrack.readyState = "ended";
    this.audioTrack = undefined;
    await gate;
    const next = this.acquire();
    if (!wasEnabled) next.enabled = false;
    this.audioTrack = next;
    this.announce();
  };
  return () => release();
}

test("there is NO automatic microphone restart, however long the stall", async () => {
  // Any automatic re-acquire opens a window in which Core 2.0.2 has torn the
  // old track down and a mute press cannot be told apart from our own calls,
  // so it could resume broadcasting after the person muted. Report instead.
  const clock = fakeClock();
  const meeting = fakeRtkMeeting();
  const w = watch(meeting, clock, { watchSelf: true });
  meeting.self.audioTrack.muted = true;
  clock.advance(DETECT_MS * 10);
  await flush();
  assert.deepEqual(meeting.self.calls, []);
  assert.deepEqual(w.latest().self, { status: "stalled", reason: "muted" });
  w.stop();
});

test("the manual restart RE-ACQUIRES a suspended mic through setDevice, muted first", async () => {
  const clock = fakeClock();
  const meeting = fakeRtkMeeting();
  const w = watch(meeting, clock, { watchSelf: true });
  const suspended = meeting.self.audioTrack;
  suspended.muted = true;
  clock.advance(DETECT_MS);
  await w.restartMic();
  // Mute first so the replacement is acquired muted (see restartMicrophone).
  assert.deepEqual(meeting.self.calls, ["disableAudio", "setDevice:mic-1"]);
  assert.notEqual(meeting.self.audioTrack, suspended, "a fresh capture track");
  assert.equal(suspended.readyState, "ended", "the suspended one was stopped");
  assert.equal(meeting.self.audioEnabled, false, "nothing re-opened for them");
  assert.equal(w.latest().self.status, "unmute");

  await w.unmuteMic();
  assert.equal(meeting.self.audioEnabled, true);
  assert.equal(w.latest().self.status, "ok");
  w.stop();
});

test("a restart that re-acquires another dead source is reported again once unmuted, not looped", async () => {
  const clock = fakeClock();
  const meeting = fakeRtkMeeting();
  meeting.self.acquire = () => ({ ...liveTrack(), muted: true });
  const w = watch(meeting, clock, { watchSelf: true });
  meeting.self.audioTrack.muted = true;
  clock.advance(DETECT_MS);
  await w.restartMic();
  await w.unmuteMic();
  clock.advance(DETECT_MS * 3);
  await flush();
  assert.deepEqual(w.latest().self, { status: "stalled", reason: "muted" });
  assert.deepEqual(meeting.self.calls, [
    "disableAudio",
    "setDevice:mic-1",
    "enableAudio",
  ]);
  w.stop();
});

test("a restart whose re-acquire FAILS is reported, not mistaken for a mute", async () => {
  const clock = fakeClock();
  const meeting = fakeRtkMeeting();
  // What Core does when getUserMedia rejects inside setDevice: it tears the
  // track down, swallows the error, and emits audioUpdate(false).
  meeting.self.setDevice = async function () {
    this.calls.push("setDevice:failed");
    this.audioTrack = undefined;
    this.announce();
  };
  meeting.self.enableAudio = async function () {
    this.calls.push("enableAudio:failed");
    this.announce();
  };
  const w = watch(meeting, clock, { watchSelf: true });
  meeting.self.audioTrack.muted = true;
  clock.advance(DETECT_MS);
  await w.restartMic();
  clock.advance(DETECT_MS);
  assert.deepEqual(w.latest().self, { status: "stalled", reason: "missing" });
  w.stop();
});

test("muting before a pending restart acts is honoured: no capture, no unmute", async () => {
  const clock = fakeClock();
  const meeting = fakeRtkMeeting();
  const release = deferDeviceEnumeration(meeting);
  const w = watch(meeting, clock, { watchSelf: true });
  meeting.self.audioTrack.muted = true; // suspended source, still "enabled"
  clock.advance(DETECT_MS);
  const pending = w.restartMic();
  assert.equal(w.latest().self.status, "recovering");

  await meeting.self.disableAudio(); // the control bar's mute
  meeting.self.calls.length = 0;
  release();
  await pending;

  assert.deepEqual(meeting.self.calls, [], "no re-open, no unmute");
  assert.equal(meeting.self.audioEnabled, false);
  assert.equal(w.latest().self.status, "off");
  w.stop();
});

test("stopping the watch while a restart is pending makes no further SDK calls", async () => {
  const clock = fakeClock();
  const meeting = fakeRtkMeeting();
  const release = deferDeviceEnumeration(meeting);
  const w = watch(meeting, clock, { watchSelf: true });
  meeting.self.audioTrack.muted = true;
  clock.advance(DETECT_MS);
  const pending = w.restartMic();
  w.stop(); // page left / meeting cleaned up
  release();
  await pending;
  assert.deepEqual(meeting.self.calls, [], "no capture after teardown");
});

test("a microphone acquired after the watch stopped is not left capturing", async () => {
  const clock = fakeClock();
  const meeting = fakeRtkMeeting();
  const release = deferAcquisition(meeting);
  meeting.self.acquire = () => ({
    ...liveTrack(),
    stop() {
      this.readyState = "ended";
    },
  });
  const w = watch(meeting, clock, { watchSelf: true });
  meeting.self.audioTrack.muted = true;
  clock.advance(DETECT_MS);
  const pending = w.restartMic();
  await flush();
  w.stop(); // the page left the room / was taken over mid-acquisition
  release();
  await pending;
  await flush();
  assert.equal(meeting.self.audioEnabled, false);
  assert.ok(!meeting.self.calls.includes("enableAudio"));
  assert.equal(
    meeting.self.audioTrack.readyState,
    "ended",
    "the orphaned late track is stopped, so the mic indicator goes off",
  );
});

test("a mute lost during acquisition cannot be overridden: the replacement always arrives muted", async () => {
  const clock = fakeClock();
  const meeting = fakeRtkMeeting();
  const release = deferAcquisition(meeting);
  const w = watch(meeting, clock, { watchSelf: true });
  meeting.self.audioTrack.muted = true; // suspended, still "enabled"
  clock.advance(DETECT_MS);
  const pending = w.restartMic();
  await flush();
  // Worst case, per Core 2.0.2: the old track is already gone, so a host
  // force-mute here is a no-op that emits NOTHING.
  meeting.self.disableAudio = async function () {
    this.calls.push("force-mute:lost");
  };
  release();
  await pending;
  await flush();
  assert.equal(meeting.self.audioEnabled, false, "not broadcasting");
  assert.equal(
    w.latest().self.status,
    "unmute",
    "only an explicit click re-opens",
  );
  w.stop();
});

test("an unmute the SDK silently fails keeps offering the click, never reports ok", async () => {
  const clock = fakeClock();
  const meeting = fakeRtkMeeting();
  const w = watch(meeting, clock, { watchSelf: true });
  meeting.self.audioTrack.readyState = "ended";
  clock.advance(DETECT_MS);
  await w.restartMic();
  assert.equal(w.latest().self.status, "unmute");
  // Core 2.0.2: shareMic() fails, the track is disabled again, no event.
  meeting.self.enableAudio = async function () {
    this.calls.push("enableAudio:swallowed");
  };
  await w.unmuteMic();
  clock.advance(DETECT_MS);
  assert.equal(meeting.self.audioEnabled, false);
  assert.equal(w.latest().self.status, "unmute");
  w.stop();
});

test("a muted replacement that dies before Unmute goes back to offering the restart", async () => {
  const clock = fakeClock();
  const meeting = fakeRtkMeeting();
  const w = watch(meeting, clock, { watchSelf: true });
  meeting.self.audioTrack.readyState = "ended";
  clock.advance(DETECT_MS);
  await w.restartMic();
  assert.equal(w.latest().self.status, "unmute");
  meeting.self.audioTrack.readyState = "ended"; // silently, again
  clock.advance(AUDIO_POLL_INTERVAL_MS);
  assert.deepEqual(w.latest().self, { status: "stalled", reason: "ended" });
  w.stop();
});

test("with no nameable microphone the restart fails loudly instead of acquiring enabled", async () => {
  const clock = fakeClock();
  const meeting = fakeRtkMeeting();
  meeting.self.getAudioDevices = async () => [];
  const w = watch(meeting, clock, { watchSelf: true });
  meeting.self.audioTrack.readyState = "ended";
  clock.advance(DETECT_MS);
  await w.restartMic();
  clock.advance(DETECT_MS);
  assert.deepEqual(meeting.self.calls, [], "no enableAudio fallback");
  assert.equal(w.latest().self.status, "stalled");
  w.stop();
});

test("a timed-out restart never admits a second, overlapping acquisition", async () => {
  const clock = fakeClock();
  const meeting = fakeRtkMeeting();
  const release = deferAcquisition(meeting);
  const w = watch(meeting, clock, { watchSelf: true, restartTimeoutMs: 20 });
  meeting.self.audioTrack.muted = true;
  clock.advance(DETECT_MS);
  await w.restartMic(); // returns on the UI timeout; acquisition still pending
  assert.equal(
    w.latest().self.status,
    "waiting",
    "says why, offers no no-op button",
  );
  await w.restartMic(); // must be refused while the first is in flight
  assert.equal(
    meeting.self.calls.filter((c) => c.startsWith("setDevice")).length,
    1,
  );
  release();
  await flush();
  await w.restartMic(); // settled: a new restart is allowed again
  assert.equal(
    meeting.self.calls.filter((c) => c.startsWith("setDevice")).length,
    2,
  );
  w.stop();
});

test("a restart stuck on acquisition (unanswered prompt) stops the spinner and says what it is waiting for", async () => {
  const clock = fakeClock();
  const meeting = fakeRtkMeeting();
  deferAcquisition(meeting); // never released
  const w = watch(meeting, clock, { watchSelf: true, restartTimeoutMs: 20 });
  meeting.self.audioTrack.muted = true;
  clock.advance(DETECT_MS);
  const pending = w.restartMic();
  assert.equal(w.latest().self.status, "recovering");
  await pending; // resolves on the timeout, not on the SDK
  clock.advance(DETECT_MS);
  assert.equal(w.latest().self.status, "waiting");
  w.stop();
});

test("intentFrom reads a mute only from a live, disabled track", () => {
  const live = { readyState: "live", muted: false, enabled: true };
  assert.equal(
    intentFrom({ audioEnabled: true, audioTrack: live }, false),
    true,
  );
  assert.equal(
    intentFrom(
      { audioEnabled: false, audioTrack: { ...live, enabled: false } },
      true,
    ),
    false,
    "muteTrack(): live track, enabled=false",
  );
  assert.equal(
    intentFrom(
      { audioEnabled: false, audioTrack: { ...live, readyState: "ended" } },
      true,
    ),
    true,
    "a dead track is not a mute",
  );
  assert.equal(intentFrom({ audioEnabled: false }, true), true, "no track");
  assert.equal(intentFrom(undefined, true), true);
});

test("stop() detaches every SDK listener and the poll", () => {
  const clock = fakeClock();
  const meeting = fakeRtkMeeting();
  const w = watch(meeting, clock, { watchSelf: true, watchRemote: true });
  assert.ok(meeting.self.count() > 0);
  assert.ok(meeting.participants.joined.count() > 0);
  assert.equal(clock.active(), 1);
  w.stop();
  assert.equal(meeting.self.count(), 0);
  assert.equal(meeting.participants.joined.count(), 0);
  assert.equal(clock.active(), 0);
  const before = w.seen.length;
  meeting.self.audioTrack.readyState = "ended";
  meeting.self.emit("audioUpdate");
  assert.equal(w.seen.length, before, "no report after stop");
});

// ---------------------------------------------------------------------------
// 3. Wiring: every surface that joins a RealtimeKit room renders the watch.
// ---------------------------------------------------------------------------

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

for (const [file, mode] of [
  ["src/routes/[username]/dashboard/stream/+page.svelte", /mode=["']host["']/],
  [
    "src/lib/components/stream/LiveStreamViewer.svelte",
    /mode=\{isHost \? ["']host["'] : ["']viewer["']\}/,
  ],
  ["src/routes/[username]/private/[secret]/+page.svelte", /mode=["']call["']/],
]) {
  test(`${file} renders RtkAudioHealth for its meeting`, () => {
    const source = read(file);
    const element = source.match(/<RtkAudioHealth\b[\s\S]*?\/>/)?.[0];
    assert.ok(element, "RtkAudioHealth is not rendered");
    assert.match(element, /\{meeting\}/);
    assert.match(element, mode);
  });
}

test("the viewer's audio-reconnect action is the existing full rejoin", () => {
  const element = read(
    "src/lib/components/stream/LiveStreamViewer.svelte",
  ).match(/<RtkAudioHealth\b[\s\S]*?\/>/)?.[0];
  assert.match(element, /onReconnect=\{handleRetry\}/);
});

test("rtk-manager uses the Core 2 leave() API", () => {
  const source = read("src/lib/utils/rtk-manager.ts");
  assert.doesNotMatch(source, /\.leaveRoom\s*\(/);
  assert.match(source, /meeting\.leave\(\)/);
});
