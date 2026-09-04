import React from "react";
import ReactDOM from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import App from "./App";
import { initializeAppI18n } from "./i18n";
import "./index.css";

const container = document.getElementById("root");
if (!container) throw new Error("the application root element is missing");

void initializeAppI18n().then((i18n) => {
  ReactDOM.createRoot(container).render(
    <React.StrictMode>
      <I18nextProvider i18n={i18n}>
        <App />
      </I18nextProvider>
    </React.StrictMode>,
  );
});
