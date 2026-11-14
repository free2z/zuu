import {
  DiagnosticsStore,
  createEnvironment,
  localStoragePersistence,
} from "@free2z/wallet-shared";
import release from "../../release.json";

/**
 * The content surface's frontend diagnostics buffer.
 *
 * The /diagnostics route displays and manually exports this bounded frontend
 * report. Native panic capture writes a separate bounded app-data file when
 * storage is available, but native readback is intentionally unavailable here.
 * No invoke handler, event channel or initialization script exposes that file:
 * under #367 a hostile remote subframe can resolve as the trusted main window.
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
