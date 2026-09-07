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

import React from "react";
import ReactDOM from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import App from "./App";
import { mountApplication, RootFallback } from "./app-bootstrap";
import { ErrorBoundary } from "./components/common/ErrorBoundary";
import { installDocumentDirection } from "./lib/document-direction";
import "./index.css";

const container = document.getElementById("root");
if (!container) throw new Error("the application root element is missing");

// Before anything renders, so `<html dir>` is never briefly wrong under a
// locale whose script runs the other way. `src/i18n/index.ts` sets `<html
// lang>`; the observer installed here derives `dir` from it thereafter.
installDocumentDirection();

void mountApplication({
  root: ReactDOM.createRoot(container),
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
