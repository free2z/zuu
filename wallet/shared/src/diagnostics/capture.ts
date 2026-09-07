import type { DiagnosticsStore } from "./store";

/**
 * The window-shaped surface the installer needs.
 *
 * Narrowed to what is used so a test can pass an `EventTarget` and so nothing
 * here can reach for a global by accident.
 */
export interface DiagnosticsGlobalTarget {
  addEventListener(
    type: string,
    listener: (event: Event) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: (event: Event) => void,
    options?: boolean | EventListenerOptions,
  ): void;
}

interface ErrorEventLike {
  readonly error?: unknown;
  readonly message?: unknown;
}

interface RejectionEventLike {
  readonly reason?: unknown;
}

/**
 * Recover the thrown value from an `error` event.
 *
 * `event.error` is absent for a cross-origin script error, where the engine
 * gives only `"Script error."`. Recording that is still worth doing — it says a
 * script failed and which breadcrumbs preceded it — so a stand-in is
 * synthesized rather than the event being dropped.
 */
function errorFromEvent(event: Event): unknown {
  const candidate = event as unknown as ErrorEventLike;
  if (candidate.error !== undefined && candidate.error !== null) {
    return candidate.error;
  }
  const message =
    typeof candidate.message === "string" ? candidate.message : "";
  return { name: "ErrorEvent", message };
}

function reasonFromEvent(event: Event): unknown {
  const candidate = event as unknown as RejectionEventLike;
  return candidate.reason;
}

/**
 * Install the two handlers that would have made #973 a report instead of a
 * permanent skeleton.
 *
 * `unhandledrejection` is the one that matters here: the TestFlight build hung
 * because `void reconcile()` discarded a rejection, and nothing in the process
 * was listening for the rejections that `void` throws away. A boundary catches
 * render throws and a `.catch()` catches a specific call; this catches the ones
 * nobody wrote a handler for, which is the class that reaches users.
 *
 * The handlers never call `preventDefault()`. Recording a failure must not
 * change whether the engine reports it, or a console that would have shown the
 * cause goes quiet in exchange for a buffer entry.
 *
 * @returns a function that removes both handlers.
 */
export function installGlobalDiagnostics(
  store: DiagnosticsStore,
  target: DiagnosticsGlobalTarget,
): () => void {
  const onError = (event: Event) => {
    // A handler that throws while handling a throw is an unbounded loop, and
    // this one runs inside the engine's own error path. It swallows.
    try {
      store.record("uncaught-error", errorFromEvent(event));
    } catch {
      /* nothing here can be reported anywhere */
    }
  };

  const onRejection = (event: Event) => {
    try {
      store.record("unhandled-rejection", reasonFromEvent(event));
    } catch {
      /* as above */
    }
  };

  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);

  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}

/**
 * The `onError` an app's root `ErrorBoundary` should be given.
 *
 * React does not route render throws through `window.onerror`, so a boundary
 * that only renders a fallback leaves no record of why the fallback appeared.
 */
export function boundaryReporter(
  store: DiagnosticsStore,
): (error: unknown) => void {
  return (error: unknown) => {
    try {
      store.record("render-error", error);
    } catch {
      /* see installGlobalDiagnostics */
    }
  };
}

/**
 * The `reportError` an app's `mountApplication` should be given.
 *
 * Bootstrap failures happen before any UI exists, so this is the only path that
 * can explain a `RootFallback`.
 */
export function bootstrapReporter(
  store: DiagnosticsStore,
): (message: string, error: unknown) => void {
  return (_message: string, error: unknown) => {
    try {
      store.record("bootstrap-error", error);
    } catch {
      /* see installGlobalDiagnostics */
    }
  };
}
