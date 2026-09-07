import React from "react";
import ReactDOM from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import {
  bootstrapReporter,
  boundaryReporter,
  installGlobalDiagnostics,
} from "@free2z/wallet-shared";
import App from "./App";
import { mountApplication, RootFallback } from "./app-bootstrap";
import { ErrorBoundary } from "./components/common/ErrorBoundary";
import { diagnostics } from "./lib/diagnostics";
import { installDocumentDirection } from "./lib/document-direction";
import { runWasmSpike } from "./lib/wasm-spike";
import "./index.css";

installDocumentDirection();

// Before the first `await`, so a rejection during locale bootstrap reaches a
// listener rather than nobody. A `void promise` whose rejection no handler ever
// observes is how #973 shipped a build that hung with nothing written down.
installGlobalDiagnostics(diagnostics, window);
diagnostics.breadcrumb("lifecycle", "app-start");

void mountApplication({
  root: ReactDOM.createRoot(document.getElementById("root")!),
  reportError: bootstrapReporter(diagnostics),
  renderApplication: (i18n) => (
    <React.StrictMode>
      <I18nextProvider i18n={i18n}>
        {/* Top-level boundary: no subtree can ever unmount the root. */}
        <ErrorBoundary
          fallback={<RootFallback />}
          onError={boundaryReporter(diagnostics)}
        >
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
