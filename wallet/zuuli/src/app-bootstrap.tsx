import type { ReactNode } from "react";
import type { i18n } from "i18next";
import { initializeAppI18n } from "./i18n";

interface RootRenderer {
  render(children: ReactNode): void;
}

interface MountApplicationDependencies {
  root: RootRenderer;
  initializeI18n?: typeof initializeAppI18n;
  renderApplication: (instance: i18n) => ReactNode;
  reportError?: (message: string, error: unknown) => void;
}

/**
 * Minimal, dependency-free fallback shown only if the ENTIRE app throws during
 * render or locale bootstrap. The literal English copy is intentional: this
 * frame must remain mountable when catalog loading or i18next initialization
 * itself is the failing subsystem.
 */
export function RootFallback() {
  return (
    <div
      className="app-crash-frame"
      role="alert"
      style={{
        boxSizing: "border-box",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "1rem",
        padding:
          "calc(2rem + var(--safe-area-top)) calc(2rem + var(--safe-area-right)) calc(2rem + var(--safe-area-bottom)) calc(2rem + var(--safe-area-left))",
        background: "#121212",
        color: "#f5f5f5",
        fontFamily: "system-ui, sans-serif",
        textAlign: "center",
      }}
    >
      <h1 style={{ fontSize: "1.25rem", fontWeight: 600 }}>
        Something went wrong
      </h1>
      <p style={{ maxWidth: "28rem", color: "#a3a3a3" }}>
        ZUULI hit an unexpected error. Reloading usually fixes it.
      </p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        style={{
          minWidth: "44px",
          minHeight: "44px",
          padding: "0.5rem 1rem",
          borderRadius: "0.75rem",
          border: "1px solid #2b2b2b",
          background: "#9f78d9",
          color: "#141414",
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        Reload
      </button>
    </div>
  );
}

/** Mount the localized app, retaining a visible recovery path if it fails. */
export async function mountApplication({
  root,
  initializeI18n = initializeAppI18n,
  renderApplication,
  reportError = console.error,
}: MountApplicationDependencies): Promise<void> {
  try {
    const instance = await initializeI18n();
    root.render(renderApplication(instance));
  } catch (error) {
    reportError("ZUULI locale bootstrap failed", error);
    root.render(<RootFallback />);
  }
}
