// Status polling for the publication export dialog.
//
// The dialog used to poll with a bare `setInterval` and, on ANY failed poll,
// call `clearInterval` and nothing else: `job.status` stayed "running", no
// error was set, and the spinner turned forever. One transient 502 — which a
// rolling deploy makes likely while a long export is in flight — was enough.
// It also treated every failure of the initial "latest job" lookup as "no
// export yet", so a 500 offered "Start export" over a job already running.
//
// This module is the policy, kept free of Svelte so it can be exercised
// directly: a poll failure is retried with exponential backoff, and after
// `maxConsecutiveFailures` in a row the poller STOPS and says so through
// `onGiveUp`, so the UI can show a visible, retryable error. A success resets
// the failure count.

export type ExportJobStatus = string | null | undefined;

/** Normal cadence between status polls while a job is queued or running. */
export const POLL_INTERVAL_MS = 2_000;
/** Ceiling on the backoff delay after repeated failures. */
export const MAX_POLL_BACKOFF_MS = 30_000;
/** Consecutive failed polls after which polling gives up visibly. */
export const MAX_CONSECUTIVE_POLL_FAILURES = 4;
/**
 * Deadline for ONE status request. The browser fetch has no timeout of its
 * own (the mutator only bounds SSR) and the backend allows an hour, so a
 * request that stalls mid-deploy would otherwise never settle — and a poller
 * that waits for it would never retry and never give up. A request past this
 * is aborted and counted as a failure.
 */
export const POLL_REQUEST_TIMEOUT_MS = 15_000;

export class PollTimeoutError extends Error {
  constructor(ms: number) {
    super(`Export status request timed out after ${ms}ms`);
    this.name = "PollTimeoutError";
  }
}

export function isActiveExportStatus(status: ExportJobStatus): boolean {
  return status === "queued" || status === "running";
}

/**
 * Delay before the next poll, given how many polls in a row have failed.
 * 0 failures → the normal cadence; then 2x, 4x, 8x … capped.
 */
export function nextPollDelay(
  consecutiveFailures: number,
  baseMs: number = POLL_INTERVAL_MS,
  maxMs: number = MAX_POLL_BACKOFF_MS,
): number {
  const n = Math.max(0, Math.floor(consecutiveFailures));
  return Math.min(maxMs, baseMs * 2 ** n);
}

/**
 * The initial "latest export" lookup answers 404 when the creator has never
 * exported. That — and only that — means "none". Anything else (5xx, a
 * network error, a timeout) means we do not know, and the dialog must not
 * pretend there is no job.
 */
export function classifyLatestJobError(err: unknown): "none" | "failed" {
  const status = (err as { status?: unknown } | null | undefined)?.status;
  return status === 404 ? "none" : "failed";
}

type Timer = unknown;

/**
 * Run `run(signal)` bounded by `ms`. On the deadline the controller is
 * aborted with a PollTimeoutError and the promise rejects with it, even if
 * `run` ignores its signal — so a stalled request can never leave the caller
 * waiting forever. Aborting `controller` from outside (unmount, stop) rejects
 * too and drops the deadline timer.
 */
export function withDeadline<T>(
  run: (signal: AbortSignal) => Promise<T>,
  ms: number,
  controller: AbortController = new AbortController(),
  schedule: (fn: () => void, ms: number) => Timer = (fn, t) =>
    setTimeout(fn, t),
  cancel: (timer: Timer) => void = (timer) =>
    clearTimeout(timer as ReturnType<typeof setTimeout>),
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const deadline = schedule(() => {
      const err = new PollTimeoutError(ms);
      controller.abort(err);
      reject(err);
    }, ms);
    controller.signal.addEventListener("abort", () => {
      cancel(deadline);
      reject(controller.signal.reason);
    });
    run(controller.signal).then(
      (value) => {
        cancel(deadline);
        resolve(value);
      },
      (err) => {
        cancel(deadline);
        reject(err);
      },
    );
  });
}

export interface ExportPollerOptions<J extends { status?: ExportJobStatus }> {
  /** `signal` is aborted on timeout and on stop()/restart. */
  fetchJob: (
    jobId: string,
    signal: AbortSignal,
  ) => Promise<J | null | undefined>;
  /** Every successful poll result. */
  onUpdate: (job: J) => void;
  /** A poll failed and another attempt is scheduled (`failures` so far). */
  onRetry?: (failures: number, err: unknown) => void;
  /** `maxConsecutiveFailures` polls in a row failed; polling has stopped. */
  onGiveUp: (err: unknown) => void;
  maxConsecutiveFailures?: number;
  baseMs?: number;
  maxMs?: number;
  requestTimeoutMs?: number;
  schedule?: (fn: () => void, ms: number) => Timer;
  cancel?: (timer: Timer) => void;
}

export interface ExportPoller {
  /**
   * (Re)start polling `jobId` from a clean failure count. `immediate` checks
   * right away instead of after one interval (the "Check again" button).
   */
  start: (jobId: string, opts?: { immediate?: boolean }) => void;
  stop: () => void;
  readonly active: boolean;
}

export function createExportPoller<J extends { status?: ExportJobStatus }>(
  options: ExportPollerOptions<J>,
): ExportPoller {
  const {
    fetchJob,
    onUpdate,
    onRetry,
    onGiveUp,
    maxConsecutiveFailures = MAX_CONSECUTIVE_POLL_FAILURES,
    baseMs = POLL_INTERVAL_MS,
    maxMs = MAX_POLL_BACKOFF_MS,
    requestTimeoutMs = POLL_REQUEST_TIMEOUT_MS,
    schedule = (fn, ms) => setTimeout(fn, ms),
    cancel = (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  } = options;

  let timer: Timer | null = null;
  // Bumped on every start/stop so a response that lands after the poller was
  // stopped (dialog closed) or restarted (new job) is discarded, not applied.
  let generation = 0;
  let failures = 0;
  let running = false;
  let inflight: AbortController | null = null;

  function clearTimer() {
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
  }

  function stop() {
    generation += 1;
    running = false;
    clearTimer();
    inflight?.abort();
    inflight = null;
  }

  /**
   * fetchJob bounded by `requestTimeoutMs`. Settles on the deadline even if
   * fetchJob ignores its signal, so a stalled request can never wedge polling.
   */
  function fetchWithDeadline(jobId: string): Promise<J | null | undefined> {
    const controller = new AbortController();
    inflight = controller;
    return withDeadline(
      (signal) => fetchJob(jobId, signal),
      requestTimeoutMs,
      controller,
      schedule,
      cancel,
    ).finally(() => {
      if (inflight === controller) inflight = null;
    });
  }

  function scheduleNext(jobId: string, gen: number, delay: number) {
    timer = schedule(() => {
      timer = null;
      void tick(jobId, gen);
    }, delay);
  }

  async function tick(jobId: string, gen: number) {
    let updated: J | null | undefined;
    try {
      updated = await fetchWithDeadline(jobId);
    } catch (err) {
      if (gen !== generation) return;
      failures += 1;
      if (failures >= maxConsecutiveFailures) {
        running = false;
        onGiveUp(err);
        return;
      }
      onRetry?.(failures, err);
      scheduleNext(jobId, gen, nextPollDelay(failures, baseMs, maxMs));
      return;
    }
    if (gen !== generation) return;
    failures = 0;
    if (updated) {
      onUpdate(updated);
      if (!isActiveExportStatus(updated.status)) {
        running = false;
        return;
      }
    }
    scheduleNext(jobId, gen, nextPollDelay(0, baseMs, maxMs));
  }

  function start(jobId: string, opts: { immediate?: boolean } = {}) {
    stop();
    failures = 0;
    running = true;
    scheduleNext(
      jobId,
      generation,
      opts.immediate ? 0 : nextPollDelay(0, baseMs, maxMs),
    );
  }

  return {
    start,
    stop,
    get active() {
      return running;
    },
  };
}
