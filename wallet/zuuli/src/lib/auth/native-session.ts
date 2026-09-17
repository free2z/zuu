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
 * Publish `token`, dropping any answer that has been overtaken.
 *
 * Invocations are asynchronous and a sign-out can overtake a sign-in, so each
 * publication carries a generation and a late one is discarded rather than
 * written. Without that, a slow "signed in" landing after a fast "signed out"
 * would leave the wallet holding a session the user has ended.
 */
export function createNativeSessionPublisher(deps: NativeSessionDeps) {
  let issued = 0;
  let applied = 0;
  return async function publish(token: string | null): Promise<void> {
    const generation = (issued += 1);
    try {
      await deps.invoke(FREE2Z_SESSION_COMMAND, { args: { token } });
      if (generation > applied) applied = generation;
    } catch (error) {
      // A wallet that cannot be told about the session is one that will refuse
      // a publication later with `INTENT_HANDLE_UNAVAILABLE`, which is the
      // honest outcome. It must not break sign-in.
      deps.onFailure?.(error);
    }
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
