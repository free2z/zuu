import React from "react";
import ReactDOM from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import App from "./App";
import { mountApplication, RootFallback } from "./app-bootstrap";
import { ErrorBoundary } from "./components/common/ErrorBoundary";
import { installDocumentDirection } from "./lib/document-direction";
import "./index.css";

// Before anything renders, so `<html dir>` is never briefly wrong under a
// locale whose script runs the other way. `src/i18n/index.ts` sets `<html
// lang>`; the observer installed here derives `dir` from it thereafter.
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
