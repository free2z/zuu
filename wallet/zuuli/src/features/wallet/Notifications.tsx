import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MESSAGE_KEYS } from "@/i18n/messages";
import { Button } from "@/components/ui/button";
import { notificationCommand, listenForNotificationChanges, type NotificationStatus } from "@/lib/notifications/bridge";
import { useWallet } from "@/store/wallet";

export function Notifications() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<NotificationStatus>({ state: "off", wake: false });
  const [busy, setBusy] = useState(true);
  const generation = useRef(0);
  const mounted = useRef(true);
  async function run(command: Parameters<typeof notificationCommand>[0]) {
    const attempt = ++generation.current;
    setBusy(true);
    const result = await notificationCommand(command);
    if (!mounted.current || generation.current !== attempt) return;
    setStatus(result); setBusy(false);
    // A verified wake only asks the existing authorized wallet store to refresh.
    // It cannot unlock, start spending or establish that a payment happened.
    if (result.wake) {
      void useWallet.getState().refreshSync();
      void useWallet.getState().refreshBalance();
    }
  }
  useEffect(() => {
    mounted.current = true;
    void run("status");
    let stop: (() => void) | undefined;
    let disposed = false;
    void listenForNotificationChanges(() => void run("status")).then((unlisten) => {
      if (disposed) unlisten(); else stop = unlisten;
    }).catch(() => undefined);
    const resume = () => { if (document.visibilityState === "visible") void run("reconcile"); };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);
    return () => { disposed = true; stop?.(); mounted.current = false; ++generation.current; document.removeEventListener("visibilitychange", resume); window.removeEventListener("focus", resume); };
  }, []);
  const blocked = status.state === "unsupported" || status.state === "unconfigured";
  return <section className="space-y-3 rounded-xl border p-4" aria-label={t(MESSAGE_KEYS.notificationsTitle)}>
    <h2 className="font-semibold">{t(MESSAGE_KEYS.notificationsTitle)}</h2>
    <p className="text-sm text-muted-foreground">{t(MESSAGE_KEYS.notificationsPrivacy)}</p>
    <p className="text-sm text-muted-foreground">{t(MESSAGE_KEYS.notificationsLimit)}</p>
    <div role="status" className="text-sm">
      {busy ? t(MESSAGE_KEYS.commonLoading) : null}
      {!busy && status.state === "unsupported" ? <p>{t(MESSAGE_KEYS.notificationsUnsupported)}</p> : null}
      {!busy && status.state === "unconfigured" ? <p>{t(MESSAGE_KEYS.notificationsUnconfigured)}</p> : null}
      {!busy && status.state === "off" ? <p>{t(MESSAGE_KEYS.notificationsOff)}</p> : null}
      {!busy && status.state === "denied" ? <p>{t(MESSAGE_KEYS.notificationsDenied)}</p> : null}
      {!busy && status.state === "waiting-token" ? <p>{t(MESSAGE_KEYS.notificationsWaiting)}</p> : null}
      {!busy && status.state === "enabled" ? <p>{t(MESSAGE_KEYS.notificationsEnabled)}</p> : null}
      {!busy && status.state === "queued" ? <p>{t(MESSAGE_KEYS.notificationsQueued)}</p> : null}
      {!busy && status.state === "expired" ? <p>{t(MESSAGE_KEYS.notificationsExpired)}</p> : null}
      {!busy && status.state === "revocation-pending" ? <p>{t(MESSAGE_KEYS.notificationsRevoking)}</p> : null}
      {!busy && (status.state === "offline" || status.state === "unavailable") ? <p>{t(MESSAGE_KEYS.notificationsUnavailable)}</p> : null}
      {!busy && status.wake ? <p>{t(MESSAGE_KEYS.notificationsVerified)}</p> : null}
    </div>
    <div className="flex flex-wrap gap-2">
      <Button disabled={busy || blocked} onClick={() => void run("enable")}>{t(MESSAGE_KEYS.notificationsEnable)}</Button>
      <Button variant="outline" disabled={busy || blocked || status.state === "off"} onClick={() => void run("disable")}>{t(MESSAGE_KEYS.notificationsDisable)}</Button>
      <Button variant="outline" disabled={busy || !(status.state === "enabled" || status.state === "queued")} onClick={() => void run("test_wake")}>{t(MESSAGE_KEYS.notificationsTest)}</Button>
    </div>
  </section>;
}
