/**
 * Mirror the signed-in free2z session into the native slot
 * (`src-tauri/src/session.rs`).
 *
 * ## Why the renderer publishes, rather than Rust reading
 *
 * The Knox token lives here: `lib/api/http.ts` holds it, in memory and in
 * `localStorage`, and authenticates every free2z call with it. Nothing native
 * can read that, and nothing should have to — the one native caller that needs
 * a session is the intent authority, which handles
 * `issue-device-credential-v2` (ADR 0017 §4.1) and has no argument to carry
 * one on, because its request arrives from the operating system rather than
 * from this webview.
 *
 * So this publishes, and the native side only ever receives:
 * `free2z_session_sync` answers `()`, so nothing here — and nothing that
 * reaches this origin — can read a session back out of the wallet process.
 *
 * ## It publishes the signed-out state too
 *
 * Silence is not "signed out": on a cold start the wallet may be handed an
 * intent before this module has run at all, and the native slot waits for the
 * first publication rather than assuming one. So this publishes once at
 * startup whatever the answer is, and again on every change.
 */

import { getToken, onTokenChange } from "@/lib/api/http";
import { isTauri } from "@/lib/platform";

/** The app-crate command. No `plugin:` prefix, and no capability grants it. */
export const FREE2Z_SESSION_COMMAND = "free2z_session_sync";

/** What a publication needs, so a test can drive it without a Tauri host. */
export interface NativeSessionDeps {
  readonly invoke: (command: string, args: unknown) => Promise<unknown>;
  readonly token: () => string | null;
  readonly subscribe: (listener: (token: string | null) => void) => () => void;
  readonly onFailure?: (error: unknown) => void;
}

/**
 * Publish `token`, and make the **last value asked for** the one the wallet
 * ends up holding.
 *
 * Two independent hazards, and a generation counter alone answers neither:
 *
 * 1. **Concurrency.** `invoke` is asynchronous, so two publications overlap and
 *    the *native write happens inside the call*. A slow "signed in" issued
 *    before a fast "signed out" lands after it, and the wallet is left holding
 *    a live session the user ended — checking a generation *after* the await
 *    cannot undo a write that already happened.
 * 2. **Staleness.** A publication that has been overtaken before it is even
 *    dispatched should not be sent at all.
 *
 * So publications are **serialized through a single-slot queue**: one call is
 * in flight at a time, and while one is in flight only the newest pending
 * value is kept. A value that is overtaken while it waits is dropped, and the
 * final `invoke` is always the newest value — so the wallet's slot converges on
 * what the renderer last said, regardless of which call was slow.
 */
export function createNativeSessionPublisher(deps: NativeSessionDeps) {
  /** The newest value asked for that has not been dispatched yet. */
  let pending: { token: string | null } | null = null;
  /** Resolves when the queue drains; one drain runs at a time. */
  let draining: Promise<void> | null = null;

  async function drain(): Promise<void> {
    while (pending !== null) {
      const next = pending;
      pending = null;
      try {
        await deps.invoke(FREE2Z_SESSION_COMMAND, { args: { token: next.token } });
      } catch (error) {
        // A wallet that cannot be told about the session is one that will
        // refuse a publication later with `INTENT_HANDLE_UNAVAILABLE`, which is
        // the honest outcome. It must not break sign-in.
        deps.onFailure?.(error);
      }
    }
    draining = null;
  }

  return function publish(token: string | null): Promise<void> {
    // Replaces, rather than queues: an older value that has not been sent is a
    // value nobody wants written any more.
    pending = { token };
    draining ??= drain();
    return draining;
  };
}

/**
 * Start mirroring. Returns an unsubscribe function.
 *
 * A no-op outside Tauri: there is no wallet process to tell, and the dynamic
 * import would fail in a browser build.
 */
export function installNativeSessionMirror(
  deps?: Partial<NativeSessionDeps>,
): () => void {
  if (!isTauri() && deps?.invoke === undefined) return () => {};
  const invoke =
    deps?.invoke ??
    (async (command: string, args: unknown) => {
      const core = await import("@tauri-apps/api/core");
      return core.invoke(command, args as Record<string, unknown>);
    });
  const token = deps?.token ?? getToken;
  const subscribe = deps?.subscribe ?? onTokenChange;
  const publish = createNativeSessionPublisher({
    invoke,
    token,
    subscribe,
    onFailure: deps?.onFailure,
  });
  // Once at startup — including `null`, which is how "signed out" is stated.
  void publish(token());
  return subscribe((next) => void publish(next));
}
