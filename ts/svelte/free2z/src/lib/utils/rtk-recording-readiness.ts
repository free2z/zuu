/** Report an unconfirmed recording start without changing provider state. */
export const RECORDING_START_GRACE_MS = 30_000;

export interface RecordingLike {
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

export function watchRecordingReadiness(
  recording: RecordingLike,
  onChange: (delayed: boolean) => void,
  visibility?: Pick<Document, "addEventListener" | "removeEventListener">,
) {
  let startedAt: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let delayed = false;

  function report(next: boolean) {
    if (next !== delayed) {
      delayed = next;
      onChange(next);
    }
  }

  function check(state = recording.recordingState) {
    if (stopped) return;
    clearTimeout(timer);
    timer = undefined;
    if (state !== "STARTING") {
      startedAt = null;
      report(false);
      return;
    }
    startedAt ??= Date.now();
    const remaining = RECORDING_START_GRACE_MS - (Date.now() - startedAt);
    if (remaining <= 0) report(true);
    else timer = setTimeout(() => check(), remaining);
  }

  // Re-read on return to a backgrounded tab; throttled timers must not grant
  // another thirty seconds after the host returns.
  const onVisibility = () => check();
  recording.addListener("recordingUpdate", check);
  visibility?.addEventListener("visibilitychange", onVisibility);
  check();
  return () => {
    stopped = true;
    clearTimeout(timer);
    recording.removeListener("recordingUpdate", check);
    visibility?.removeEventListener("visibilitychange", onVisibility);
  };
}
