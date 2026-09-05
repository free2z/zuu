import React from "react";
import ReactDOM from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import App from "./App";
import { initializeAppI18n } from "./i18n";
import { installDocumentDirection } from "./lib/document-direction";
import "./index.css";

const container = document.getElementById("root");
if (!container) throw new Error("the application root element is missing");

// Before anything renders, so `<html dir>` is never briefly wrong under a
// locale whose script runs the other way. `src/i18n/index.ts` sets `<html
// lang>`; the observer installed here derives `dir` from it thereafter.
installDocumentDirection();

void initializeAppI18n().then((i18n) => {
  ReactDOM.createRoot(container).render(
    <React.StrictMode>
      <I18nextProvider i18n={i18n}>
        <App />
      </I18nextProvider>
    </React.StrictMode>,
  );
});
