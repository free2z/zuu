/**
 * Participant-facing recording indication.
 *
 * The host starts a recording through Free2Z. RealtimeKit mirrors that onto
 * every client's `meeting.recording`, so guests do not poll the owner-only
 * status endpoint. Webinar and livestream rooms record the stage: someone
 * whose stage status is ON_STAGE gets the stronger notice, and everyone else
 * in the room still sees that a recording is on. A group or audio room has
 * no audience split — every participant is in the recorded picture.
 *
 * The app copy of this decision lives in
 * `wallet/free2z/src/features/live/recording-notice.ts`.
 */

export const RECORDING_NOTICE_STATES = [
  "STARTING",
  "RECORDING",
  "PAUSED",
] as const;

export type RecordingNoticeState = (typeof RECORDING_NOTICE_STATES)[number];

/** `stage` is the recorded picture. `audience` is watching a staged room. */
export type RecordingNoticeEmphasis = "stage" | "audience";

export interface RecordingNotice {
  state: RecordingNoticeState;
  emphasis: RecordingNoticeEmphasis;
  /** True only when this participant is ON_STAGE in a webinar or livestream. */
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
  meta?: { viewType?: string };
  self?: {
    config?: { viewType?: string };
    permissions?: { viewType?: string };
    stageStatus?: string;
  };
}

export function meetingViewType(
  meeting: RecordingNoticeMeeting,
): string | undefined {
  const candidates = [
    meeting.meta?.viewType,
    meeting.self?.config?.viewType,
    meeting.self?.permissions?.viewType,
  ];
  return candidates.find(
    (value) => typeof value === "string" && value.length > 0,
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
