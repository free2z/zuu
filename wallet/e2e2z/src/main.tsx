// The e2e2z entry point.
//
// This used to be a bare `void initializeAppI18n().then(render)` — no `.catch`,
// no boundary, no fallback — while ZUULI and free2z both mounted through
// `mountApplication` inside an `ErrorBoundary`. It diverged when messaging was
// moved out in #904 phase 3, and #973 is why that divergence is closed rather
// than noted: the app shipped a build that rendered nothing but a loading
// skeleton, and the two failures it could not report were the same failure
// twice. A rejected locale bootstrap left an empty `<div id="root">` with the
// rejection swallowed by the `void`; a rejected bridge read left a permanent
// skeleton with the rejection swallowed by another `void`.
//
// Between them, `mountApplication` and the boundary cover both React exits:
// `mountApplication` catches a bootstrap **rejection** and renders
// `RootFallback`, and the boundary catches a render-time **throw** anywhere in
// the subtree. That matters more here than in the other two apps, because this
// one is a single screen with nowhere to navigate — a subtree that unmounts the
// root leaves the user with nothing and no way back.
//
// Both of those exits now also *record* what happened, and
// `installGlobalDiagnostics` covers the third — a throw or rejection that
// reaches the event loop with no React frame on the stack at all. Rendering a
// recovery card says the app failed; the diagnostics buffer is what lets
// someone holding the phone say why.

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
import "./index.css";

const container = document.getElementById("root");
if (!container) throw new Error("the application root element is missing");

// Before anything renders, so `<html dir>` is never briefly wrong under a
// locale whose script runs the other way. `src/i18n/index.ts` sets `<html
// lang>`; the observer installed here derives `dir` from it thereafter.
installDocumentDirection();

// Before the first `await`, so a rejection during locale bootstrap reaches a
// listener rather than nobody.
installGlobalDiagnostics(diagnostics, window);
diagnostics.breadcrumb("lifecycle", "app-start");

void mountApplication({
  root: ReactDOM.createRoot(container),
  reportError: bootstrapReporter(diagnostics),
  renderApplication: (i18n) => {
    diagnostics.breadcrumb("lifecycle", "locale-ready");
    return (
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
    );
  },
});
