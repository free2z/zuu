import {
  DiagnosticsStore,
  createEnvironment,
  localStoragePersistence,
} from "@free2z/wallet-shared";
import release from "../../release.json";

/**
 * This surface's diagnostics buffer.
 *
 * One per process, created before anything else runs so the handlers installed
 * in `main.tsx` have somewhere to write from the first tick. The behaviour is
 * entirely `@free2z/wallet-shared`'s — this file only says which app this is,
 * which build, and where the buffer survives a restart.
 *
 * ## Why e2e2z is the first surface to get a screen
 *
 * Because it is the one that shipped. `0.1.0 (2)` went to TestFlight, hung on
 * a loading skeleton, and left the tester and us with no way to learn why
 * (#973): the rejection that caused it was discarded by a `void`, and nothing
 * in the process was listening. Capture is installed in all three surfaces;
 * the screen exists here first because here it has a failure to explain.
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
      app: "e2e2z",
      version: release.version,
      build: String(release.build),
      userAgent: userAgent(),
    }),
    persistence: local ? localStoragePersistence(local) : null,
  });
}

/** The process-wide buffer. */
export const diagnostics = createDiagnosticsStore();
