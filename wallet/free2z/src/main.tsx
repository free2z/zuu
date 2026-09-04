import React from "react";
import ReactDOM from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import App from "./App";
import { mountApplication, RootFallback } from "./app-bootstrap";
import { ErrorBoundary } from "./components/common/ErrorBoundary";
import "./index.css";

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
