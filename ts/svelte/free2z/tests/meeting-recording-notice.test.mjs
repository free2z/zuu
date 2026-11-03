import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  recordingNoticeFor,
  watchMeetingRecordingNotice,
} from "../src/lib/utils/meeting-recording-notice.ts";

const ROOT = path.resolve(import.meta.dirname, "..");

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

test("shows a notice while a recording is starting, active, or paused", () => {
  for (const recordingState of ["STARTING", "RECORDING", "PAUSED"]) {
    assert.equal(
      recordingNoticeFor({
        recordingState,
        viewType: "GROUP_CALL",
        stageStatus: "OFF_STAGE",
      })?.state,
      recordingState,
    );
  }
  assert.equal(
    recordingNoticeFor({
      recordingState: "INVOKED",
      viewType: "WEBINAR",
      stageStatus: "ON_STAGE",
    })?.state,
    "STARTING",
  );
  for (const recordingState of [
    "IDLE",
    "STOPPING",
    "UPLOADING",
    "UPLOADED",
    "FAILED",
    "",
    null,
    undefined,
  ]) {
    assert.equal(
      recordingNoticeFor({
        recordingState,
        viewType: "WEBINAR",
        stageStatus: "ON_STAGE",
      }),
      null,
      recordingState ?? "undefined",
    );
  }
});

test("a webinar or livestream emphasizes whoever is on stage", () => {
  for (const viewType of ["WEBINAR", "LIVESTREAM"]) {
    assert.deepEqual(
      recordingNoticeFor({
        recordingState: "RECORDING",
        viewType,
        stageStatus: "ON_STAGE",
      }),
      { state: "RECORDING", emphasis: "stage", onStage: true },
    );
    for (const stageStatus of [
      "OFF_STAGE",
      "REQUESTED_TO_JOIN_STAGE",
      "ACCEPTED_TO_JOIN_STAGE",
      undefined,
    ]) {
      assert.deepEqual(
        recordingNoticeFor({
          recordingState: "RECORDING",
          viewType,
          stageStatus,
        }),
        { state: "RECORDING", emphasis: "audience", onStage: false },
        `${viewType} ${stageStatus ?? "missing"}`,
      );
    }
  }
});

test("a room without a stage treats every participant as in the recording", () => {
  for (const viewType of [
    "GROUP_CALL",
    "AUDIO_ROOM",
    "CHAT",
    "WEBINAR1",
    "",
    undefined,
  ]) {
    assert.deepEqual(
      recordingNoticeFor({
        recordingState: "PAUSED",
        viewType,
        stageStatus: "OFF_STAGE",
      }),
      { state: "PAUSED", emphasis: "stage", onStage: false },
      viewType ?? "missing",
    );
  }
});

function meeting(initial = {}) {
  const recording = Object.assign(new EventEmitter(), {
    recordingState: initial.recordingState ?? "IDLE",
  });
  const stage = Object.assign(new EventEmitter(), {
    status: initial.stageStatus ?? "OFF_STAGE",
  });
  return {
    recording,
    stage,
    meta: { viewType: initial.viewType ?? "WEBINAR" },
    self: {
      config: { viewType: initial.selfViewType },
      stageStatus: initial.selfStageStatus,
    },
  };
}

test("the watch follows recording and stage updates and drops its listeners", () => {
  const current = meeting();
  const changes = [];
  const stop = watchMeetingRecordingNotice(current, (notice) => {
    changes.push(notice);
  });
  assert.deepEqual(changes, [null]);

  current.recording.recordingState = "STARTING";
  current.recording.emit("recordingUpdate", "STARTING");
  current.recording.emit("recordingUpdate", "STARTING");
  assert.deepEqual(changes, [
    null,
    { state: "STARTING", emphasis: "audience", onStage: false },
  ]);

  current.stage.status = "ON_STAGE";
  current.stage.emit("stageStatusUpdate", "ON_STAGE");
  current.recording.recordingState = "RECORDING";
  current.recording.emit("recordingUpdate", "RECORDING");
  current.recording.recordingState = "PAUSED";
  current.recording.emit("recordingUpdate", "PAUSED");
  current.recording.recordingState = "STOPPING";
  current.recording.emit("recordingUpdate", "STOPPING");
  assert.deepEqual(changes, [
    null,
    { state: "STARTING", emphasis: "audience", onStage: false },
    { state: "STARTING", emphasis: "stage", onStage: true },
    { state: "RECORDING", emphasis: "stage", onStage: true },
    { state: "PAUSED", emphasis: "stage", onStage: true },
    null,
  ]);

  stop();
  assert.equal(current.recording.listenerCount("recordingUpdate"), 0);
  assert.equal(current.stage.listenerCount("stageStatusUpdate"), 0);
  current.recording.recordingState = "RECORDING";
  current.recording.emit("recordingUpdate", "RECORDING");
  assert.equal(changes.length, 6);
});

test("an invoked server recording still shows while the SDK aggregate says idle", () => {
  const current = meeting({
    recordingState: "IDLE",
    viewType: "WEBINAR",
    stageStatus: "ON_STAGE",
  });
  current.recording.recordings = [{ state: "INVOKED" }];
  const changes = [];
  const stop = watchMeetingRecordingNotice(current, (notice) => {
    changes.push(notice);
  });
  assert.deepEqual(changes, [
    { state: "STARTING", emphasis: "stage", onStage: true },
  ]);
  stop();
});

test("a joined room that is already recording is announced immediately", () => {
  const current = meeting({
    recordingState: "RECORDING",
    viewType: "GROUP_CALL",
    stageStatus: "OFF_STAGE",
  });
  const changes = [];
  const stop = watchMeetingRecordingNotice(current, (notice) => {
    changes.push(notice);
  });
  assert.deepEqual(changes, [
    { state: "RECORDING", emphasis: "stage", onStage: false },
  ]);
  stop();
});

test("view type and stage status fall back to the local participant", () => {
  const current = meeting({
    recordingState: "RECORDING",
    viewType: undefined,
    selfViewType: "LIVESTREAM",
    stageStatus: undefined,
    selfStageStatus: "ON_STAGE",
  });
  current.meta.viewType = undefined;
  current.stage.status = undefined;
  const changes = [];
  const stop = watchMeetingRecordingNotice(current, (notice) => {
    changes.push(notice);
  });
  assert.deepEqual(changes, [
    { state: "RECORDING", emphasis: "stage", onStage: true },
  ]);
  stop();
});

test("every livestream type reaches the recording notice", () => {
  for (const type of ["broadcast", "subscribers-only", "ppv"]) {
    const page = read(`src/routes/[username]/${type}/+page.svelte`);
    assert.match(
      page,
      /LiveStreamPage/,
      `${type} must use the shared viewer that reads the recording flag`,
    );
  }
  const viewer = read("src/lib/components/stream/LiveStreamViewer.svelte");
  assert.match(viewer, /stream\.type === streamType && stream\.recording/);
  const priv = read("src/routes/[username]/private/[secret]/+page.svelte");
  assert.match(priv, /recording-visibility/);
  assert.match(
    priv,
    /<MeetingRecordingNotice\s+\{meeting\}\s+\{serverRecording\}\s*\/>/,
  );
});

test("every human meeting surface mounts the notice on that meeting", () => {
  const surfaces = [
    "src/lib/components/stream/LiveStreamViewer.svelte",
    "src/routes/[username]/dashboard/stream/+page.svelte",
    "src/routes/[username]/private/[secret]/+page.svelte",
  ];
  for (const file of surfaces) {
    const source = read(file);
    assert.match(
      source,
      /import MeetingRecordingNotice from /,
      `${file} must import the notice`,
    );
    assert.match(
      source,
      /<MeetingRecordingNotice\s+\{meeting\}[^>]*\/>/,
      `${file} must bind the notice to its meeting`,
    );
  }
});

test("host and private meetings pin the notice to the video, not the page header", () => {
  for (const file of [
    "src/routes/[username]/dashboard/stream/+page.svelte",
    "src/routes/[username]/private/[secret]/+page.svelte",
  ]) {
    const source = read(file);
    const region = source.match(
      /<div class="relative flex min-h-0 w-full flex-1 flex-col">[\s\S]*?<MeetingRecordingNotice \{meeting\}[^>]*\/>\s*<\/div>/,
    )?.[0];
    assert.ok(region, `${file} must wrap the meeting and the notice together`);
    assert.match(region, /<rtk-meeting\b/);
  }
});

test("the notice does not restore the native recording toggle", () => {
  const source = read("src/lib/utils/recording-controls.ts");
  assert.match(source, /rtk-recording-toggle/);
  const notice = read(
    "src/lib/components/stream/MeetingRecordingNotice.svelte",
  );
  assert.doesNotMatch(notice, /rtk-recording-toggle/);
  assert.match(notice, /role="status"/);
  assert.match(notice, /aria-live="polite"/);
});
