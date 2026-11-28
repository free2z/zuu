import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { renderDiagnosticsReport } from "@free2z/wallet-shared";
import { diagnostics } from "@/lib/diagnostics";
import { MESSAGE_KEYS } from "@/i18n/messages";
import { Button } from "@/components/ui/button";
import { readNativeDiagnostics } from "@/lib/native-diagnostics";

export default function DiagnosticsFeature() {
  const { t } = useTranslation();
  const [frontend, setFrontend] = useState(() => renderDiagnosticsReport(diagnostics));
  const [status, setStatus] = useState<"" | "copied" | "failed">("");
  const [native, setNative] = useState<string | null>(null);
  function refresh() {
    setFrontend(renderDiagnosticsReport(diagnostics));
    void readNativeDiagnostics().then(setNative);
  }
  useEffect(() => { refresh(); }, []);
  const nativeReport = native ?? t(MESSAGE_KEYS.diagnosticsNativeUnavailable);
  const report = `${frontend}

${nativeReport}`;
  async function exportReport(share: boolean) {
    try {
      if (share && navigator.share) await navigator.share({ title: t(MESSAGE_KEYS.diagnosticsTitle), text: report });
      else {
        await navigator.clipboard.writeText(report);
        setStatus("copied");
      }
    } catch { setStatus("failed"); }
  }
  return <section className="min-w-0 space-y-4 p-4" data-diagnostics-panel aria-label={t(MESSAGE_KEYS.diagnosticsTitle)}>
    <h2 className="break-words text-lg font-semibold">{t(MESSAGE_KEYS.diagnosticsTitle)}</h2>
    <p className="break-words text-sm text-muted-foreground">{t(MESSAGE_KEYS.diagnosticsDescription)}</p>
    <p className="break-words text-sm" data-native-diagnostics-state>{native ?? t(MESSAGE_KEYS.diagnosticsNativeUnavailable)}</p>
    <div className="flex flex-wrap gap-2">
      <Button className="h-auto min-h-11 max-w-full whitespace-normal break-words" onClick={() => void exportReport(false)}>{t(MESSAGE_KEYS.diagnosticsCopy)}</Button>
      <Button className="h-auto min-h-11 max-w-full whitespace-normal break-words" onClick={() => void exportReport(true)}>{t(MESSAGE_KEYS.diagnosticsShare)}</Button>
      <Button className="h-auto min-h-11 max-w-full whitespace-normal break-words" onClick={refresh}>{t(MESSAGE_KEYS.diagnosticsRefresh)}</Button>
      <Button className="h-auto min-h-11 max-w-full whitespace-normal break-words" onClick={() => { diagnostics.clear(); refresh(); setStatus(""); }}>{t(MESSAGE_KEYS.diagnosticsClear)}</Button>
    </div>
    <p aria-live="polite">{status === "copied" ? t(MESSAGE_KEYS.diagnosticsCopied) : status === "failed" ? t(MESSAGE_KEYS.diagnosticsFailed) : ""}</p>
    <pre className="min-w-0 whitespace-pre-wrap break-words rounded border border-border p-3 text-xs [overflow-wrap:anywhere]" data-diagnostics-report dir="ltr">{report}</pre>
  </section>;
}
