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
import { listenForAuthorityAnswers } from "./lib/bridge/appLinkTransport";
import { diagnostics } from "./lib/diagnostics";
import { installDocumentDirection } from "./lib/document-direction";
import "./index.css";

// Before anything renders, so `<html dir>` is never briefly wrong under a
// locale whose script runs the other way. `src/i18n/index.ts` sets `<html
// lang>`; the observer installed here derives `dir` from it thereafter.
installDocumentDirection();

// Before the first `await`, so a rejection during locale bootstrap reaches a
// listener rather than nobody. A `void promise` whose rejection no handler ever
// observes is how #973 shipped a build that hung with nothing written down.
installGlobalDiagnostics(diagnostics, window);
diagnostics.breadcrumb("lifecycle", "app-start");

// ZUULI's answers to a tip arrive as a link to this app. Listening from the
// start, rather than when a tip is sent, means an answer is never missed for
// want of a listener. A no-op outside a native mobile build.
listenForAuthorityAnswers();

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
