import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { MESSAGE_KEYS } from "@/i18n/messages";
import {
  watchMeetingRecordingNotice,
  type RecordingNotice,
  type RecordingNoticeMeeting,
} from "./recording-notice";

export function MeetingRecordingNotice({
  meeting,
}: {
  meeting: RecordingNoticeMeeting;
}) {
  const { t } = useTranslation();
  const [notice, setNotice] = useState<RecordingNotice | null>(null);

  useEffect(() => {
    if (!meeting.recording?.addListener) return;
    return watchMeetingRecordingNotice(meeting, setNotice);
  }, [meeting]);

  if (!notice) return null;

  const text = notice.onStage
    ? notice.state === "STARTING"
      ? t(MESSAGE_KEYS.liveRecordingStageStarting)
      : notice.state === "PAUSED"
        ? t(MESSAGE_KEYS.liveRecordingStagePaused)
        : t(MESSAGE_KEYS.liveRecordingStageRecording)
    : notice.state === "STARTING"
      ? t(MESSAGE_KEYS.liveRecordingStarting)
      : notice.state === "PAUSED"
        ? t(MESSAGE_KEYS.liveRecordingPaused)
        : t(MESSAGE_KEYS.liveRecordingActive);

  const onStageBar = notice.emphasis === "stage";

  return (
    <div
      data-testid="meeting-recording-notice"
      data-emphasis={notice.emphasis}
      data-state={notice.state}
      data-on-stage={notice.onStage ? "true" : "false"}
      className={
        onStageBar
          ? "pointer-events-none absolute inset-x-0 top-0 z-40 flex justify-center"
          : "pointer-events-none absolute inset-x-0 top-3 z-40 flex justify-center px-3"
      }
    >
      <div
        role="status"
        aria-live="polite"
        className={
          onStageBar
            ? "flex w-full items-center justify-center gap-2 bg-red-600 px-3 py-2 text-center text-sm font-semibold leading-snug text-white shadow-md"
            : "flex max-w-full items-center gap-2 rounded-full border border-red-300/50 bg-red-950/95 px-3 py-1.5 text-center text-sm font-medium leading-snug text-red-50 shadow-lg"
        }
      >
        <span
          className={
            onStageBar
              ? "h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-white"
              : "h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-red-500"
          }
          aria-hidden
        />
        <span>{text}</span>
      </div>
    </div>
  );
}
