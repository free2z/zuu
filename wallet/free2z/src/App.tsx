import { useTranslation } from "react-i18next";

export default function App() {
  const { t } = useTranslation();
  return (
    <main className="app-shell">
      <p className="app-shell__eyebrow">{t("app.name")}</p>
      <h1 className="app-shell__heading">{t("placeholder.heading")}</h1>
      <p className="app-shell__body">{t("placeholder.body")}</p>
      <p className="app-shell__tagline">{t("app.tagline")}</p>
    </main>
  );
}
