import {
  DiagnosticsStore,
  createEnvironment,
  localStoragePersistence,
} from "@free2z/wallet-shared";
import release from "../../release.json";

/**
 * The content surface's diagnostics buffer.
 *
 * ## Why this surface takes no native crash channel with it
 *
 * `src-tauri/src/lib.rs` registers no `invoke_handler` at all, and a unit test
 * fails the build if one appears: under the Wry frame-confusion defect (#367) a
 * remote subframe in this process resolves as the trusted main window, so the
 * property that keeps this surface safe is that there is no command to reach.
 * A `diagnostics_native_records` command would be a command, and this is
 * exactly the surface where third-party content is rendered. So capture here is
 * the renderer's own — the WebView's errors and rejections — and the native
 * half of the design (a Rust panic hook) is deliberately not wired in until
 * there is a channel that does not cost this property. See the pull request.
 *
 * There is no diagnostics screen here yet either; it belongs on a route, next
 * to a nav entry and inside `tests/viewport.pw.ts`'s route audit, which is its
 * own change.
 */

function storage() {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    // Reading `localStorage` itself throws when a WebView blocks site data.
    return null;
  }
}

function userAgent(): string {
  try {
    return typeof navigator === "undefined" ? "" : navigator.userAgent;
  } catch {
    return "";
  }
}

/** Build the store. Exported for tests; the app uses {@link diagnostics}. */
export function createDiagnosticsStore(): DiagnosticsStore {
  const local = storage();
  return new DiagnosticsStore({
    environment: createEnvironment({
      app: "free2z",
      version: release.version,
      build: String(release.build),
      userAgent: userAgent(),
    }),
    persistence: local ? localStoragePersistence(local) : null,
  });
}

/** The process-wide buffer. */
export const diagnostics = createDiagnosticsStore();
