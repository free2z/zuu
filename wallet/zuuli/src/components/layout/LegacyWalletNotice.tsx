import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { wallet } from "@/lib/wallet/bridge";
import type { LegacyImportPreview } from "@/lib/wallet/types";
import { useWallet } from "@/store/wallet";

function Diagnostics({ messages }: { messages: string[] }) {
  if (messages.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
      {messages.map((message, index) => (
        <li key={`${index}:${message}`}>{message}</li>
      ))}
    </ul>
  );
}

function ReadyPreview({ preview }: { preview: LegacyImportPreview }) {
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
  const layout = preview.layout === "multi" ? "Multi-wallet" : "Single-wallet";

  return (
    <div data-preview-state="ready">
      <p className="text-sm font-medium text-foreground">
        {preview.wallets.length} preserved {preview.wallets.length === 1 ? "wallet" : "wallets"} inspected
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {layout} layout · {accounts} {accounts === 1 ? "account" : "accounts"} · encrypted custody present for {custody} · SQLite sidecars present for {sidecars}
      </p>
      <Diagnostics messages={preview.diagnostics} />
    </div>
  );
}

function PreviewResult({ preview }: { preview: LegacyImportPreview }) {
  if (preview.state === "ready") return <ReadyPreview preview={preview} />;
  if (preview.state === "blocked") {
    return (
      <div data-preview-state="blocked">
        <p className="text-sm font-medium text-foreground">Preview blocked</p>
        <Diagnostics messages={preview.diagnostics} />
      </div>
    );
  }
  if (preview.state === "absent") {
    return (
      <div data-preview-state="absent">
        <p className="text-sm font-medium text-foreground">No earlier wallet data found</p>
        <Diagnostics messages={preview.diagnostics} />
      </div>
    );
  }
  return (
    <div data-preview-state="unsupported">
      <p className="text-sm font-medium text-foreground">Preview unavailable on this platform</p>
      <Diagnostics messages={preview.diagnostics} />
    </div>
  );
}

export function LegacyWalletNotice() {
  const legacy = useWallet((state) => state.status?.legacyAppData);
  const [preview, setPreview] = useState<LegacyImportPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  if (legacy?.state !== "importPending") return null;

  const inspect = async () => {
    setLoading(true);
    setFailed(false);
    try {
      setPreview(await wallet.previewLegacyWalletImport());
    } catch {
      setPreview(null);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <section
      role="status"
      aria-label="Preserved legacy wallet"
      aria-live="polite"
      className="border-b border-warning/30 bg-warning/10 px-4 py-3 md:px-8"
    >
      <div className="mx-auto flex w-full max-w-6xl items-start gap-3">
        <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden />
        <div className="min-w-0 flex-1">
          {!preview && !failed ? (
            <>
              <p className="text-sm font-medium text-foreground">Earlier wallet preserved</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {legacy.diagnostic ??
                  "An earlier ZUULI wallet remains safely preserved. Nothing has been imported, moved, or deleted."}
              </p>
            </>
          ) : null}
          {preview ? <PreviewResult preview={preview} /> : null}
          {failed ? (
            <div data-preview-state="failed">
              <p className="text-sm font-medium text-foreground">Preview could not be completed</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                The preserved wallet could not be inspected. Nothing was changed.
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
            {loading ? "Inspecting…" : preview || failed ? "Retry preview" : "Inspect preserved wallet"}
          </Button>
        </div>
      </div>
    </section>
  );
}
