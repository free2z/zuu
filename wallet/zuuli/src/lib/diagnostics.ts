import {
  DiagnosticsStore,
  createEnvironment,
  localStoragePersistence,
} from "@free2z/wallet-shared";
import { BUILD_INFO } from "./build-info";

/**
 * The wallet authority's diagnostics buffer.
 *
 * ## Why the wallet gets the same buffer as the other two
 *
 * Because the failure mode is the same and the privacy bar is higher, not
 * lower. What makes it safe to run here is that the buffer holds no field a
 * caller controls: breadcrumbs come from a closed vocabulary, and the only free
 * text is an error's own name, message and stack, each reduced by
 * `@free2z/wallet-shared`'s allow-list before it is stored. A seed, a spending
 * key or an address is not a shape that survives that.
 *
 * ## What this does not do yet
 *
 * ZUULI has no diagnostics screen in this increment — capture lands in all
 * three surfaces, the screen lands first in e2e2z, which is the one that
 * shipped and hung (#973). The right home here is the existing About screen
 * next to `FeedbackComposer`, and `lib/feedback.ts`'s
 * `captureFeedbackDiagnostics()` is the seam that was left for it: its comment
 * says diagnostics stay unavailable "until a future separately reviewed
 * allowlist can prove a safe schema end to end", and that allowlist is what
 * this store now is. Wiring the two together is a change to the feedback
 * handoff's own review rules and belongs in its own pull request.
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
