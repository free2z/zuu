import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { wallet } from "@/lib/wallet/bridge";
import type { PhoneSnapshot, RecoveryPlan } from "@/lib/wallet/types";
import { MESSAGE_KEYS } from "@/i18n/messages";
import { useWallet } from "@/store/wallet";

/** No custody enters React state. Comparison metadata stays local to this view. */
export function PhoneMigration() {
  const { t } = useTranslation();
  const activeId = useWallet((s) => s.activeWalletId);
  const identities = useWallet((s) => s.wallets);
  const custodyState = useWallet((s) => s.status?.custodyState);
  const switchIdentity = useWallet((s) => s.switchWallet);
  const switching = useWallet((s) => s.switchingWalletId);
  const [snapshot, setSnapshot] = useState<PhoneSnapshot | null>(null);
  const [metadata, setMetadata] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [custodyError, setCustodyError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [checked, setChecked] = useState(false);
  const [newIdentity, setNewIdentity] = useState(false);
  const working = busy || switching !== null;
  const operation = useRef(false);
  const epoch = useRef(0);
  useEffect(() => {
    epoch.current++;
    setSnapshot(null); setChecked(false); setAcknowledged(false); setError(false); setCustodyError(null);
    return () => { epoch.current++; };
  }, [activeId]);
  useEffect(() => {
    const clearProof = () => { setChecked(false); setAcknowledged(false); };
    window.addEventListener("blur", clearProof);
    return () => window.removeEventListener("blur", clearProof);
  }, []);

  async function run(action: "read" | "verify" | "backup" | "recover") {
    if (operation.current || switching !== null) return;
    operation.current = true;
    const generation = epoch.current;
    setBusy(true); setError(false); setCustodyError(null); setChecked(false);
    try {
      let plan: RecoveryPlan | undefined;
      if (action === "backup") {
        plan = snapshot?.plan;
        if (!plan) throw new Error();
      } else if (action !== "read") {
        if (!metadata || metadata.length > 262144) throw new Error();
        plan = JSON.parse(metadata) as RecoveryPlan;
      }
      if (action === "recover") {
        const result = await wallet.recoverPhoneWallet(newIdentity ? null : activeId, plan!);
        await useWallet.getState().refreshWalletIdentity(result.walletId);
      } else if (action === "backup") {
        await wallet.showPhoneBackup(activeId, plan!);
      } else {
        const result = action === "read" ? await wallet.getPhoneSnapshot()
          : await wallet.verifyPhoneRecovery(activeId, plan!);
        if (generation !== epoch.current || document.visibilityState === "hidden") return;
        if (result.walletId !== useWallet.getState().activeWalletId) throw new Error();
        setSnapshot(result);

        setChecked(action === "verify" && result.recoveryUsable && result.syncCurrent && !result.pendingPayment);
      }
    } catch (cause) {
      if (generation === epoch.current) {
        setError(true);
        // Only fixed native categories reach the DOM, never backend diagnostics
        // or parser input (which can contain private comparison metadata).
        const message = typeof cause === "string" ? cause : cause instanceof Error ? cause.message : "";
        const category = /^key derivation error: secure custody: (missing|cancelled|locked|authentication_failed|corrupt|unavailable)$/.exec(message)?.[1];
        setCustodyError(category ?? null);
      }
    } finally { operation.current = false; setBusy(false); }
  }

  const reason = custodyError ?? custodyState;

  return <section className="mx-auto max-w-2xl space-y-5" aria-labelledby="phone-title">
    <h1 id="phone-title" className="text-2xl font-bold">{t(MESSAGE_KEYS.phoneTitle)}</h1>
    <p>{t(MESSAGE_KEYS.phoneLimitation)}</p>
    <p>{t(MESSAGE_KEYS.phonePreserve)}</p>
    {reason === "missing" || reason === "missingKey" ? <p role="alert">{t(MESSAGE_KEYS.phoneMissing)}</p> : null}
    {reason === "corrupt" ? <p role="alert">{t(MESSAGE_KEYS.phoneCorrupt)}</p> : null}
    {reason === "locked" || reason === "cancelled" || reason === "authentication_failed" ? <p role="alert">{t(MESSAGE_KEYS.phoneLocked)}</p> : null}
    {reason === "dataUnavailable" || reason === "unavailable" ? <p role="alert">{t(MESSAGE_KEYS.phoneFiles)}</p> : null}
    <label htmlFor="phone-wallet" className="block text-sm font-medium">{t(MESSAGE_KEYS.phoneWallet)}</label>
    <select id="phone-wallet" value={activeId ?? ""} disabled={working || identities.length === 0}
      className="min-tap w-full max-w-full rounded-md border border-border bg-background p-2 cursor-pointer disabled:cursor-default"
      onChange={(event) => { setChecked(false); setAcknowledged(false); void switchIdentity(event.target.value).catch(() => setError(true)); }}>
      {!activeId ? <option value="">—</option> : null}
      {identities.map((identity) => <option key={identity.id} value={identity.id}>{identity.name}</option>)}
    </select>
    <h2 className="text-lg font-semibold">{t(MESSAGE_KEYS.phoneOld)}</h2>
    <p>{t(MESSAGE_KEYS.phoneOldSteps)}</p>
    <Button className="h-auto min-h-11 max-w-full whitespace-normal break-words cursor-pointer disabled:cursor-default" disabled={working || !activeId} onClick={() => void run("read")}>{t(MESSAGE_KEYS.phoneInventory)}</Button>
    <Button className="h-auto min-h-11 max-w-full whitespace-normal break-words cursor-pointer disabled:cursor-default" variant="outline" disabled={working || !activeId || !snapshot} onClick={() => void run("backup")}>{t(MESSAGE_KEYS.phoneBackup)}</Button>
    {snapshot ? <textarea readOnly aria-label={t(MESSAGE_KEYS.phoneSource)} value={JSON.stringify(snapshot.plan, null, 2)} className="min-h-32 w-full rounded-md border border-border bg-background p-3 font-mono text-sm" /> : null}
    <h2 className="text-lg font-semibold">{t(MESSAGE_KEYS.phoneNew)}</h2>
    <p>{t(MESSAGE_KEYS.phoneNewSteps)}</p>
    <p>{t(MESSAGE_KEYS.phoneUnavailable)}</p>
    <label htmlFor="phone-metadata" className="block text-sm font-medium">{t(MESSAGE_KEYS.phoneMetadata)}</label>
    <Textarea id="phone-metadata" value={metadata} maxLength={262144} disabled={working}
      onChange={(e) => { setMetadata(e.target.value); setChecked(false); setAcknowledged(false); }}
      spellCheck={false} autoComplete="off" className="min-h-32 font-mono" />
    <p className="text-sm text-muted-foreground">{t(MESSAGE_KEYS.phoneMetadataNote)}</p>
    <label className={`min-tap flex items-start gap-3 ${working ? "cursor-default" : "cursor-pointer"}`}>
      <input type="checkbox" checked={acknowledged} disabled={working} className="mt-1 cursor-pointer disabled:cursor-default"
        onChange={(e) => setAcknowledged(e.target.checked)} />
      <span>{t(MESSAGE_KEYS.phoneConsent)}</span>
    </label>
    <label className={`min-tap flex items-start gap-3 ${working ? "cursor-default" : "cursor-pointer"}`}><input type="checkbox" checked={newIdentity} disabled={working} className="mt-1 cursor-pointer disabled:cursor-default"
      onChange={(e) => setNewIdentity(e.target.checked)} /><span>{t(MESSAGE_KEYS.phoneSeparate)}</span></label>
    <Button className="h-auto min-h-11 max-w-full whitespace-normal break-words cursor-pointer disabled:cursor-default" disabled={working || !acknowledged || !metadata} onClick={() => void run("recover")}>{t(MESSAGE_KEYS.phoneRecover)}</Button>
    <h2 className="text-lg font-semibold">{t(MESSAGE_KEYS.phoneChecks)}</h2>
    <p>{t(MESSAGE_KEYS.phoneCheckSteps)}</p>
    <Button className="h-auto min-h-11 max-w-full whitespace-normal break-words cursor-pointer disabled:cursor-default" disabled={working || !activeId || !metadata} onClick={() => void run("verify")}>{t(MESSAGE_KEYS.phoneVerify)}</Button>
    {snapshot ? <div className="space-y-2 break-all" aria-live="polite">
      <p>{t(MESSAGE_KEYS.phoneScope, { count: snapshot.walletCount })}</p>
      {snapshot.plan.accounts.map((account) => <p key={account.index} className="font-mono text-sm">
        {snapshot.plan.network} · ZIP32 {account.index} · {account.birthday} · {account.address}
      </p>)}
      <p>{checked ? t(MESSAGE_KEYS.phoneChecked) : t(MESSAGE_KEYS.phoneIncomplete)}</p>
    </div> : null}
    {error ? <p role="alert" className="text-destructive">{t(MESSAGE_KEYS.phoneError)}</p> : null}
    {error || (reason && !["none", "present", "unchecked"].includes(reason)) ? <Button
      className="h-auto min-h-11 max-w-full whitespace-normal break-words cursor-pointer disabled:cursor-default"
      disabled={working} onClick={() => {
        epoch.current++; setError(false); setCustodyError(null); setSnapshot(null); setChecked(false); setAcknowledged(false);
        void useWallet.getState().bootstrap();
      }}>{t(MESSAGE_KEYS.commonRetry)}</Button> : null}
    {working ? <p role="status">{t(MESSAGE_KEYS.commonLoading)}</p> : null}
    <p className="font-semibold">{t(MESSAGE_KEYS.phoneExternal)}</p>
    <h2 className="text-lg font-semibold">{t(MESSAGE_KEYS.phoneFamily)}</h2>
    <p>{t(MESSAGE_KEYS.phoneFamilySteps)}</p>
  </section>;
}
