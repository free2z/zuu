/**
 * Same decision as the website helper
 * `ts/svelte/free2z/src/lib/utils/meeting-recording-notice.ts`.
 *
 * Webinar and livestream rooms record the stage, so ON_STAGE is the stronger
 * notice. Everyone else in those rooms still sees that recording is on. A
 * group or audio room has no audience split.
 */

export const RECORDING_NOTICE_STATES = ["STARTING", "RECORDING", "PAUSED"] as const;

export type RecordingNoticeState = (typeof RECORDING_NOTICE_STATES)[number];

export type RecordingNoticeEmphasis = "stage" | "audience";

export interface RecordingNotice {
  state: RecordingNoticeState;
  emphasis: RecordingNoticeEmphasis;
  onStage: boolean;
}

const STAGED_VIEW_TYPES = new Set(["LIVESTREAM", "WEBINAR"]);

export interface RecordingListenerTarget {
  recordingState: string;
  addListener(
    event: "recordingUpdate",
    listener: (state: string) => void,
  ): unknown;
  removeListener(
    event: "recordingUpdate",
    listener: (state: string) => void,
  ): unknown;
}

export interface StageListenerTarget {
  status?: string;
  addListener(
    event: "stageStatusUpdate",
    listener: (status: string) => void,
  ): unknown;
  removeListener(
    event: "stageStatusUpdate",
    listener: (status: string) => void,
  ): unknown;
}

export interface RecordingNoticeMeeting {
  recording: RecordingListenerTarget;
  stage?: StageListenerTarget;
  // RealtimeKit's preset classes are not weak `{ viewType?: string }` objects.
  // Read the field when it is present instead of requiring that shape.
  meta?: object;
  self?: {
    config?: object;
    permissions?: object;
    stageStatus?: string;
  };
}

function textProp(value: object | undefined, key: string): string | undefined {
  if (!value || !(key in value)) return undefined;
  const found = (value as Record<string, unknown>)[key];
  return typeof found === "string" && found.length > 0 ? found : undefined;
}

export function meetingViewType(
  meeting: RecordingNoticeMeeting,
): string | undefined {
  return (
    textProp(meeting.meta, "viewType") ??
    textProp(meeting.self?.config, "viewType") ??
    textProp(meeting.self?.permissions, "viewType")
  );
}

export function meetingStageStatus(
  meeting: RecordingNoticeMeeting,
): string | undefined {
  const candidates = [meeting.stage?.status, meeting.self?.stageStatus];
  return candidates.find(
    (value) => typeof value === "string" && value.length > 0,
  );
}

export function recordingNoticeFor(input: {
  recordingState?: string | null;
  viewType?: string | null;
  stageStatus?: string | null;
}): RecordingNotice | null {
  const state = input.recordingState;
  if (state !== "STARTING" && state !== "RECORDING" && state !== "PAUSED") {
    return null;
  }
  const staged = STAGED_VIEW_TYPES.has(input.viewType ?? "");
  const onStage = staged && input.stageStatus === "ON_STAGE";
  return {
    state,
    onStage,
    emphasis: !staged || onStage ? "stage" : "audience",
  };
}

export function watchMeetingRecordingNotice(
  meeting: RecordingNoticeMeeting,
  onChange: (notice: RecordingNotice | null) => void,
): () => void {
  let lastKey = "";
  let stopped = false;

  function publish() {
    if (stopped) return;
    const notice = recordingNoticeFor({
      recordingState: meeting.recording.recordingState,
      viewType: meetingViewType(meeting),
      stageStatus: meetingStageStatus(meeting),
    });
    const key = notice
      ? `${notice.emphasis}:${notice.onStage}:${notice.state}`
      : "hidden";
    if (key === lastKey) return;
    lastKey = key;
    onChange(notice);
  }

  const onRecording = () => publish();
  const onStage = () => publish();
  meeting.recording.addListener("recordingUpdate", onRecording);
  meeting.stage?.addListener("stageStatusUpdate", onStage);
  publish();
  return () => {
    stopped = true;
    meeting.recording.removeListener("recordingUpdate", onRecording);
    meeting.stage?.removeListener("stageStatusUpdate", onStage);
  };
}
