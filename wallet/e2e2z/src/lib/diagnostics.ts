import {
  DiagnosticsStore,
  createEnvironment,
  localStoragePersistence,
} from "@free2z/wallet-shared";
import release from "../../release.json";

/**
 * This surface's frontend diagnostics buffer, created before capture handlers
 * are installed in main.tsx. The shared package owns redaction and persistence;
 * this module supplies the application identity and storage port.
 *
 * The diagnostics panel displays frontend failures and reads the separately
 * bounded native panic report through an argument-free managed-state command.
 * Copy/share exports the displayed report only on the user's explicit action.
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
