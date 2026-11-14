import { useTranslation as useUiTranslation } from "react-i18next";
import { MESSAGE_KEYS } from "@/i18n/messages";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { wallet } from "@/lib/wallet/bridge";
import type { LegacyImportPreview } from "@/lib/wallet/types";
import { useWallet } from "@/store/wallet";

function Diagnostics({ messages }: { messages: string[] }) {
  const { t: uiT } = useUiTranslation();

  if (messages.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
      {messages.map((message, index) => (
        <li key={`${index}:${message}`}>
          {uiT(MESSAGE_KEYS.legacyDiagnostics)}
        </li>
      ))}
    </ul>
  );
}

function ReadyPreview({ preview }: { preview: LegacyImportPreview }) {
  const { t: uiT } = useUiTranslation();

  const accounts = preview.wallets.reduce(
    (total, candidate) => total + candidate.accountCount,
    0,
  );
  const custody = preview.wallets.filter(
    (candidate) => candidate.encryptedCustodyPresent,
  ).length;
  const sidecars = preview.wallets.filter(
    (candidate) => candidate.walPresent || candidate.shmPresent,
  ).length;

  return (
    <div data-preview-state="ready">
      <p className="text-sm font-medium text-foreground">
        {uiT(MESSAGE_KEYS.legacyInspected, {
          count: preview.wallets.length,
        })}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {uiT(MESSAGE_KEYS.legacySummary, {
          layout: preview.layout,
          accounts,
          custody,
          sidecars,
        })}
      </p>
      <Diagnostics messages={preview.diagnostics} />
    </div>
  );
}

function PreviewResult({ preview }: { preview: LegacyImportPreview }) {
  const { t: uiT } = useUiTranslation();

  if (preview.state === "ready") return <ReadyPreview preview={preview} />;
  if (preview.state === "blocked") {
    return (
      <div data-preview-state="blocked">
        <p className="text-sm font-medium text-foreground">
          {uiT(MESSAGE_KEYS.componentsLayoutLegacyWalletNoticePreviewBlocked)}
        </p>
        <Diagnostics messages={preview.diagnostics} />
      </div>
    );
  }
  if (preview.state === "absent") {
    return (
      <div data-preview-state="absent">
        <p className="text-sm font-medium text-foreground">
          {uiT(
            MESSAGE_KEYS.componentsLayoutLegacyWalletNoticeNoEarlierWalletDataFound,
          )}
        </p>
        <Diagnostics messages={preview.diagnostics} />
      </div>
    );
  }
  return (
    <div data-preview-state="unsupported">
      <p className="text-sm font-medium text-foreground">
        {uiT(
          MESSAGE_KEYS.componentsLayoutLegacyWalletNoticePreviewUnavailableOnThisPlatform,
        )}
      </p>
      <Diagnostics messages={preview.diagnostics} />
    </div>
  );
}

export function LegacyWalletNotice() {
  const { t: uiT } = useUiTranslation();

  const { t } = useTranslation();
  const legacy = useWallet((state) => state.status?.legacyAppData);
  const authorityActive = legacy?.state === "importPending";
  const [preview, setPreview] = useState<LegacyImportPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const sequence = useRef(0);
  const activeRequest = useRef<number | null>(null);
  const authority = useRef(authorityActive);

  if (authority.current && !authorityActive) {
    sequence.current += 1;
    activeRequest.current = null;
  }
  authority.current = authorityActive;

  useEffect(() => {
    if (!authorityActive) {
      setPreview(null);
      setFailed(false);
      setLoading(false);
    }
  }, [authorityActive]);

  useEffect(
    () => () => {
      authority.current = false;
      sequence.current += 1;
      activeRequest.current = null;
    },
    [],
  );

  if (!authorityActive) return null;

  const inspect = async () => {
    if (activeRequest.current !== null) return;
    const request = sequence.current + 1;
    sequence.current = request;
    activeRequest.current = request;
    setLoading(true);
    setFailed(false);
    try {
      const result = await wallet.previewLegacyWalletImport();
      if (activeRequest.current === request) {
        setPreview(result);
      }
    } catch {
      if (activeRequest.current === request) {
        setPreview(null);
        setFailed(true);
      }
    } finally {
      if (activeRequest.current === request) {
        activeRequest.current = null;
        setLoading(false);
      }
    }
  };

  return (
    <section
      role="status"
      aria-label={t(MESSAGE_KEYS.legacyWalletLabel)}
      aria-live="polite"
      className="border-b border-warning/30 bg-warning/10 px-4 py-3 md:px-8"
    >
      <div className="mx-auto flex w-full max-w-6xl items-start gap-3">
        <TriangleAlert
          className="mt-0.5 h-5 w-5 shrink-0 text-warning"
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          {!preview && !failed ? (
            <>
              <p className="text-sm font-medium text-foreground">
                {t(MESSAGE_KEYS.legacyWalletTitle)}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t(MESSAGE_KEYS.legacyWalletDescription)}
              </p>
            </>
          ) : null}
          {preview ? <PreviewResult preview={preview} /> : null}
          {failed ? (
            <div data-preview-state="failed">
              <p className="text-sm font-medium text-foreground">
                {uiT(
                  MESSAGE_KEYS.componentsLayoutLegacyWalletNoticePreviewCouldNotBeCompleted,
                )}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {uiT(
                  MESSAGE_KEYS.componentsLayoutLegacyWalletNoticeThePreservedWalletCouldNotBeInspected,
                )}
              </p>
            </div>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2"
            disabled={loading}
            onClick={() => void inspect()}
          >
            {loading
              ? uiT(MESSAGE_KEYS.componentsLayoutLegacyWalletNoticeInspecting)
              : preview || failed
                ? uiT(
                    MESSAGE_KEYS.componentsLayoutLegacyWalletNoticeRetryPreview,
                  )
                : uiT(
                    MESSAGE_KEYS.componentsLayoutLegacyWalletNoticeInspectPreservedWallet,
                  )}
          </Button>
        </div>
      </div>
    </section>
  );
}
