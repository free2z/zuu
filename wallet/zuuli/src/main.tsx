import React from "react";
import ReactDOM from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import App from "./App";
import { mountApplication, RootFallback } from "./app-bootstrap";
import { ErrorBoundary } from "./components/common/ErrorBoundary";
import { installDocumentDirection } from "./lib/document-direction";
import { runWasmSpike } from "./lib/wasm-spike";
import "./index.css";

installDocumentDirection();

void mountApplication({
  root: ReactDOM.createRoot(document.getElementById("root")!),
  renderApplication: (i18n) => (
    <React.StrictMode>
      <I18nextProvider i18n={i18n}>
        {/* Top-level boundary: no subtree can ever unmount the root. */}
        <ErrorBoundary fallback={<RootFallback />}>
          <App />
        </ErrorBoundary>
      </I18nextProvider>
    </React.StrictMode>
  ),
});

// This is a build/runtime integration proof, not a user-facing feature. The
// browser test observes the marker, which means a stale or merely emitted WASM
// file cannot satisfy the contract without being instantiated and called.
void runWasmSpike()
  .then((value) => {
    if (value !== 42) throw new Error(`unexpected WASM spike result: ${value}`);
    document.documentElement.dataset.wasmSpike = String(value);
  })
  .catch((error: unknown) => {
    console.error("The ZUU WASM integration proof failed", error);
  });
