import {
  DiagnosticsStore,
  createEnvironment,
  localStoragePersistence,
} from "@free2z/wallet-shared";
import { BUILD_INFO } from "./build-info";

/**
 * The wallet authority's frontend diagnostics buffer.
 *
 * Breadcrumbs use a closed vocabulary; error names, messages and bundle frames
 * are allowlist-filtered before storage. Ordinary prose cannot be distinguished
 * from error prose, so call sites must not interpolate private content.
 *
 * About displays the full frontend report and the separately bounded native
 * panic report. Feedback uses this store only through a reduced rendering of
 * failure kinds and counts: no error text, frames, filenames or native records.
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
      app: "zuuli",
      version: BUILD_INFO.version,
      build: String(BUILD_INFO.build),
      userAgent: userAgent(),
    }),
    persistence: local ? localStoragePersistence(local) : null,
  });
}

/** The process-wide buffer. */
export const diagnostics = createDiagnosticsStore();
