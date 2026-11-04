import { createAbortSignalWithTimeout } from "../abort-signal.js";
export const RECORDING_POLL_MS = 10_000;
/** Single-flight control/poll loop; never writes RealtimeKit's private state. */
export type RecordingStatus =
  | "IDLE"
  | "INVOKED"
  | "RECORDING"
  | "PAUSED"
  | "STOPPING"
  | "UPLOADING"
  | "UPLOADED"
  | "FAILED"
  | "ERRORED";
export type RecordingView = {
  state: RecordingStatus | null;
  busy: boolean;
  error: boolean;
};
export function recordingControls(
  request: (
    action: "status" | "start" | "stop",
    signal: AbortSignal,
  ) => Promise<{ state: RecordingStatus }>,
  onChange: (value: RecordingView) => void,
) {
  let stopped = false;
  let failures = 0;
  let busy = false;
  let state: RecordingStatus | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = new AbortController();
  async function run(action: "status" | "start" | "stop") {
    if (stopped || busy) return;
    busy = true;
    clearTimeout(timer);
    onChange({ state, busy, error: false });
    const deadline = createAbortSignalWithTimeout(
      abort.signal,
      action === "status" ? 12_000 : 40_000,
    );
    let rejectOnAbort: () => void = () => {};
    const timedOut = new Promise<never>((_, reject) => {
      rejectOnAbort = () => reject(deadline.signal.reason);
      deadline.signal.addEventListener("abort", rejectOnAbort, { once: true });
    });
    try {
      const result = await Promise.race([
        request(action, deadline.signal),
        timedOut,
      ]);
      failures = 0;
      if (stopped) return;
      state = result.state;
      busy = false;
      onChange({ state, busy, error: false });
    } catch {
      if (stopped) return;
      busy = false;
      failures++;
      // Last known state cannot authorize a new start after a failed probe.
      state = null;
      onChange({ state, busy, error: true });
    } finally {
      deadline.cleanup();
      deadline.signal.removeEventListener("abort", rejectOnAbort);
      if (!stopped)
        timer = setTimeout(
          () => void run("status"),
          failures
            ? Math.min(60_000, 15_000 * 2 ** (failures - 1))
            : RECORDING_POLL_MS,
        );
    }
  }
  void run("status");
  return {
    run,
    stop() {
      stopped = true;
      abort.abort();
      clearTimeout(timer);
    },
  };
}

/** Remove native record controls from all sizes/menus of a generated UI config. */
export function withoutNativeRecording<T>(value: T): T {
  if (Array.isArray(value)) {
    return value
      .filter(
        (child) =>
          child !== "rtk-recording-toggle" &&
          !(Array.isArray(child) && child[0] === "rtk-recording-toggle"),
      )
      .map((child) => withoutNativeRecording(child)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !key.startsWith("rtk-recording-toggle"))
        .map(([key, child]) => [key, withoutNativeRecording(child)]),
    ) as T;
  }
  return value;
}
