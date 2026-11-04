/**
 * Load something once, retrying a failure with backoff and then giving up
 * ( verification round, codex adversarial review).
 *
 * The root layout lazy-loads the translation jobs notifier. Its first version
 * reset a "loading" flag in the import's `catch`, which the reactive
 * statement that started the import tracked — so a missing deployment chunk
 * or a dead network re-imported in a tight loop for the life of the tab.
 * Here a failure waits (`delaysMs[i]` before retry `i + 1`), and after the
 * last delay is used up the loader stays `gaveUp` until `reset()`.
 */
export interface RetryingLoader<T> {
  /** Start loading, unless already loading, loaded, or given up. */
  start: () => void;
  /** Forget a give-up (for a deliberate recovery, e.g. a new sign-in). */
  reset: () => void;
  /** Cancel a pending retry (component teardown). */
  stop: () => void;
  readonly attempts: number;
  readonly gaveUp: boolean;
}

export function createRetryingLoader<T>(
  load: () => Promise<T>,
  onLoaded: (value: T) => void,
  {
    delaysMs = [2_000, 8_000, 30_000],
    setTimer = (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimer = (handle: unknown) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
  }: {
    delaysMs?: readonly number[];
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
  } = {},
): RetryingLoader<T> {
  let state: "idle" | "busy" | "done" | "gaveUp" = "idle";
  let attempts = 0;
  let timer: unknown = null;
  let stopped = false;

  function attempt() {
    timer = null;
    if (stopped) return;
    attempts += 1;
    load().then(
      (value) => {
        if (stopped) return;
        state = "done";
        onLoaded(value);
      },
      () => {
        if (stopped) return;
        const delay = delaysMs[attempts - 1];
        if (delay === undefined) {
          state = "gaveUp";
          return;
        }
        timer = setTimer(attempt, delay);
      },
    );
  }

  return {
    start() {
      if (state !== "idle") return;
      stopped = false;
      state = "busy";
      attempt();
    },
    reset() {
      if (state !== "gaveUp") return;
      state = "idle";
      attempts = 0;
    },
    stop() {
      stopped = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
      if (state === "busy") state = "idle";
    },
    get attempts() {
      return attempts;
    },
    get gaveUp() {
      return state === "gaveUp";
    },
  };
}
