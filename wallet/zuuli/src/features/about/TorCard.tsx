import { useEffect, useState } from "react";
import { MESSAGE_KEYS } from "@/i18n/messages";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { isTauri } from "@/lib/platform";
import { torSet, torStatus, type TorStatus } from "@/lib/network";

export function TorCard() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<TorStatus>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const native = isTauri();
  useEffect(() => {
    if (!native) return;
    let live = true;
    const update = () => { void torStatus().then((s) => { if (live) setStatus((previous) => !previous || s.epoch >= previous.epoch ? s : previous); }).catch(() => { if (live) setFailed(true); }); };
    update();
    const timer = window.setInterval(update, 2000);
    return () => { live = false; window.clearInterval(timer); };
  }, [native]);
  async function change(enabled: boolean) {
    setBusy(true); setFailed(false);
    try { const next = await torSet(enabled); setStatus(previous => !previous || next.epoch >= previous.epoch ? next : previous); }
    catch { setFailed(true); }
    finally { setBusy(false); }
  }
  const state = !native ? "web" : status?.state ?? "loading";
  return <section className="my-6 min-w-0 space-y-3 rounded-lg border p-4" aria-labelledby="tor-title">
    <h2 id="tor-title" className="break-words text-lg font-semibold [overflow-wrap:anywhere]">{t(MESSAGE_KEYS.torTitle)}</h2>
    <p className="text-sm text-muted-foreground">{t(MESSAGE_KEYS.torScope)}</p>
    <p role="status" aria-live="polite">{failed ? t(MESSAGE_KEYS.torError) :
        state === "direct" ? t(MESSAGE_KEYS.torDirect) :
        state === "waiting" ? t(MESSAGE_KEYS.torWaiting) :
        state === "proxyConnected" ? t(MESSAGE_KEYS.torProxyConnected) :
        state === "degraded" ? t(MESSAGE_KEYS.torDegraded) :
        state === "suspended" ? t(MESSAGE_KEYS.torSuspended) :
        state === "web" ? t(MESSAGE_KEYS.torWeb) : t(MESSAGE_KEYS.torLoading)}</p>
    <Button disabled={!native || !status || busy} onClick={() => void change(!status?.enabled)}>
      {t(status?.enabled ? MESSAGE_KEYS.torDisable : MESSAGE_KEYS.torEnable)}
    </Button>
    {status?.enabled && <Button className="ms-2" variant="outline" disabled={busy} onClick={() => void change(true)}>{t(MESSAGE_KEYS.torReconnect)}</Button>}
    <details><summary className="cursor-pointer py-2">{t(MESSAGE_KEYS.torAdvanced)}</summary>
      <p className="break-words text-sm">{t(MESSAGE_KEYS.torDetails)}</p>
      <p className="mt-2 text-sm">{t(MESSAGE_KEYS.torMobile)}</p>
      {status && <p className="mt-2 font-mono text-xs">{t(MESSAGE_KEYS.torEpoch)}: {status.epoch}</p>}
    </details>
  </section>;
}
