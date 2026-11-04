/** Route history refreshes must never hold the authoritative balance queue. */
export function createAccountRouteRefresh(options: {
  username: () => string;
  refresh: (username: string) => Promise<void>;
  navigation?: () => Promise<void> | null;
  timeoutMs?: number;
  retryDelaysMs?: readonly number[];
}) {
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let active: AbortController | null = null;
  let dirty = false;
  let retries = 0;
  const retryDelays = options.retryDelaysMs ?? [1000, 3000];

  function schedule(delay = 100) {
    if (timer || active) return;
    const epoch = generation;
    timer = setTimeout(async () => {
      timer = null;
      const username = options.username();
      if (!username || epoch !== generation) return;
      const controller = new AbortController();
      active = controller;
      dirty = false;
      const timeout = setTimeout(
        () =>
          controller.abort(
            new DOMException("Billing refresh timed out", "TimeoutError"),
          ),
        options.timeoutMs ?? 15_000,
      );
      let abort: (() => void) | undefined;
      let failed = false;
      try {
        // SvelteKit invalidation has no caller cancellation signal. Bound our
        // worker and attach handlers immediately; its late completion cannot
        // settle a replacement account or operation.
        await new Promise<void>((resolve, reject) => {
          abort = () => reject(controller.signal.reason);
          controller.signal.addEventListener("abort", abort, { once: true });
          if (controller.signal.aborted) return abort();
          Promise.resolve()
            .then(async () => {
              let navigation: Promise<void> | null | undefined;
              while ((navigation = options.navigation?.())) {
                await navigation;
                if (
                  controller.signal.aborted ||
                  epoch !== generation ||
                  options.username() !== username
                )
                  throw new Error("Billing refresh superseded");
              }
              if (
                controller.signal.aborted ||
                epoch !== generation ||
                options.username() !== username
              )
                throw new Error("Billing refresh superseded");
              return options.refresh(username);
            })
            .then(
              () =>
                controller.signal.aborted
                  ? reject(controller.signal.reason)
                  : resolve(),
              reject,
            );
        });
      } catch {
        failed = true;
      } finally {
        clearTimeout(timeout);
        if (abort) controller.signal.removeEventListener("abort", abort);
        if (active === controller && epoch === generation) {
          active = null;
          if (options.username() !== username) return;
          if (dirty) {
            retries = 0;
            schedule();
          } else if (failed && retries < retryDelays.length) {
            schedule(retryDelays[retries++]);
          } else {
            retries = 0;
          }
        }
      }
    }, delay);
  }

  function request() {
    if (!options.username()) return;
    dirty = true;
    retries = 0;
    schedule();
  }
  function reset() {
    generation += 1;
    if (timer) clearTimeout(timer);
    timer = null;
    active?.abort(new DOMException("Account changed", "AbortError"));
    active = null;
    dirty = false;
    retries = 0;
  }
  return { request, reset };
}
