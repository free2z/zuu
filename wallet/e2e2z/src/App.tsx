import { useTranslation } from "react-i18next";
import MessagesFeature from "./features/messages";

/**
 * e2e2z is one surface, so it is one screen and needs no router.
 *
 * In ZUULI messaging was `/messages/*` behind a sidebar, a top bar and a
 * sign-in gate. None of that came with it (#904 phase 3): a process whose only
 * job is messaging has nothing to navigate away to, and the chrome it used to
 * sit inside belongs to the app that still has other destinations.
 */
export default function App() {
  const { t } = useTranslation();
  return (
    <div className="app-viewport overflow-y-auto">
      <main className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
        <p className="eyebrow mb-6 text-muted-foreground">
          {t("app.name")} — {t("app.tagline")}
        </p>
        <MessagesFeature />
      </main>
    </div>
  );
}
