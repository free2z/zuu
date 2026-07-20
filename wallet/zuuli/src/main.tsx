import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/common/ErrorBoundary";
import "./index.css";

/**
 * Minimal, dependency-free fallback shown only if the ENTIRE app throws during
 * render. Styled with plain inline styles (no Tailwind/shadcn) because a crash
 * here means we can't trust any higher-level component to be mountable. Its job
 * is purely to keep the webview from going permanently blank and to let the
 * user recover with a reload — so a stored malicious comment can no longer
 * white-screen the whole zpage for every viewer.
 */
function RootFallback() {
  return (
    <div
      role="alert"
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "1rem",
        padding: "2rem",
        background: "#0a0a0f",
        color: "#e5e5ea",
        fontFamily: "system-ui, sans-serif",
        textAlign: "center",
      }}
    >
      <h1 style={{ fontSize: "1.25rem", fontWeight: 600 }}>
        Something went wrong
      </h1>
      <p style={{ maxWidth: "28rem", color: "#a1a1aa" }}>
        ZUULI hit an unexpected error. Reloading usually fixes it.
      </p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        style={{
          padding: "0.5rem 1rem",
          borderRadius: "0.75rem",
          border: "1px solid #3f3f46",
          background: "#6d28d9",
          color: "#fff",
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        Reload
      </button>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {/* Top-level boundary: no subtree can ever unmount the root. */}
    <ErrorBoundary fallback={<RootFallback />}>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
