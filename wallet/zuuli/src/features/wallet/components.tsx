// Composite wallet UI pieces: sync bar, address card, transaction row.
import { QRCodeSVG } from "qrcode.react";
import { Link } from "react-router-dom";
import { AlertTriangle, ArrowDownLeft, ArrowUpRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  formatDate,
  formatHeight,
  formatZecDisplay,
  truncateAddress,
} from "@/lib/format";
import type { SyncStatus, TransactionEntry } from "@/lib/wallet/types";
import { cn } from "@/lib/utils";
import { CopyButton } from "./shared";

/**
 * Passive sync status. Sync runs automatically and continuously (resumed on
 * launch by the wallet store), so there is no manual start/stop control — this
 * just quietly reflects state: "Syncing… N%" while catching up, "Synced" once
 * at the chain tip. The engine keeps reporting `syncing: true` even when caught
 * up (it watches for new blocks), so "caught up" is judged by height.
 *
 * When the engine surfaces a `lastError` (e.g. lightwalletd unreachable, or a
 * scan pass that keeps failing), we show a distinct "Sync trouble — retrying"
 * state instead of an eternal, silent "Syncing 0.0%". The engine keeps retrying
 * on its own (and rotates lightwalletd endpoints), so this is informational, not
 * a dead end; it clears automatically on the next successful pass.
 */
export function SyncBar({ sync }: { sync: SyncStatus | null }) {
  const pct = sync ? Math.min(100, Math.max(0, sync.progressPercent)) : 0;
  const connecting = sync === null || sync.chainTip === 0;
  const caughtUp =
    sync !== null && sync.chainTip > 0 && sync.syncedHeight >= sync.chainTip;
  // Only treat an error as active while not caught up — a successful pass clears
  // `lastError` on the backend, but guard here too so a stale value never sticks.
  const errorMsg = !caughtUp ? (sync?.lastError ?? null) : null;
  const hasError = errorMsg !== null && errorMsg !== "";

  return (
    <Card className="rounded-xl p-4" role="status" aria-live="polite">
      <div className="flex items-center gap-2 text-sm font-medium">
        {caughtUp ? (
          <>
            <span className="h-2 w-2 rounded-full bg-emerald-400" aria-hidden />
            <span>Synced</span>
          </>
        ) : hasError ? (
          <>
            <AlertTriangle className="h-3.5 w-3.5 text-amber-400" aria-hidden />
            <span className="text-amber-400">Sync trouble — retrying</span>
          </>
        ) : connecting ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
            <span className="text-muted-foreground">Connecting</span>
          </>
        ) : (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
            <span>Syncing</span>
            <span className="ml-auto text-xs tabular-nums text-muted-foreground">
              {pct.toFixed(1)}%
            </span>
          </>
        )}
      </div>

      <p
        className={cn(
          "mt-0.5 truncate text-xs tabular-nums text-muted-foreground",
          hasError && "text-amber-400/80",
        )}
        title={hasError ? errorMsg : undefined}
      >
        {hasError
          ? errorMsg
          : sync && !connecting
            ? `${formatHeight(sync.syncedHeight)} / ${formatHeight(sync.chainTip)}`
            : "Waiting for chain tip…"}
      </p>

      {!caughtUp ? (
        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-500 ease-out",
              hasError ? "bg-amber-400" : "bg-primary",
            )}
            style={{ width: `${hasError ? Math.max(pct, 4) : pct}%` }}
            role="progressbar"
            aria-valuenow={Math.round(pct)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Chain sync progress"
          />
        </div>
      ) : null}
    </Card>
  );
}

/** Unified-address card with QR, truncated address and copy. */
export function AddressCard({
  address,
  compact,
}: {
  address: string;
  compact?: boolean;
}) {
  return (
    <Card className="flex items-center gap-4 rounded-xl p-4">
      <div className="shrink-0 rounded-lg bg-white p-2">
        <QRCodeSVG
          value={address}
          size={compact ? 72 : 92}
          bgColor="#ffffff"
          fgColor="#1a1206"
          level="M"
          aria-label="Unified address QR code"
        />
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Your unified address
        </div>
        <div className="break-all font-mono text-sm text-foreground">
          {truncateAddress(address)}
        </div>
        <div className="pt-1">
          <CopyButton
            value={address}
            size="sm"
            label="Address copied"
            ariaLabel="Copy unified address"
          />
        </div>
      </div>
    </Card>
  );
}

/** A single transaction row. */
export function TxRow({ tx }: { tx: TransactionEntry }) {
  const incoming = tx.incoming;
  return (
    <div className="flex items-center gap-3 rounded-lg px-3 py-3 transition-colors hover:bg-secondary/40">
      <div
        className={cn(
          "grid h-9 w-9 shrink-0 place-items-center rounded-full",
          incoming
            ? "bg-emerald-500/15 text-emerald-400"
            : "bg-secondary text-muted-foreground",
        )}
        aria-hidden
      >
        {incoming ? (
          <ArrowDownLeft className="h-4 w-4" />
        ) : (
          <ArrowUpRight className="h-4 w-4" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">
            {incoming ? "Received" : "Sent"}
          </span>
          {tx.blockHeight === null ? (
            <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
              Pending
            </span>
          ) : null}
        </div>
        {tx.memo ? (
          <p className="truncate text-xs text-muted-foreground" title={tx.memo}>
            {tx.memo}
          </p>
        ) : (
          <p className="break-all font-mono text-xs text-muted-foreground/70">
            {truncateAddress(tx.txid)}
          </p>
        )}
      </div>

      <div className="shrink-0 text-right">
        <div
          className={cn(
            "text-sm font-semibold tabular-nums",
            incoming ? "text-emerald-400" : "text-foreground",
          )}
        >
          {incoming ? "+" : "−"}
          {formatZecDisplay(Math.abs(tx.value))}
        </div>
        <div className="text-xs tabular-nums text-muted-foreground">
          {formatDate(tx.timestamp)}
        </div>
      </div>
    </div>
  );
}

/** "See all" style link back to history. */
export function ViewAllLink() {
  return (
    <Button asChild variant="ghost" size="sm">
      <Link to="/wallet/history">View all</Link>
    </Button>
  );
}
