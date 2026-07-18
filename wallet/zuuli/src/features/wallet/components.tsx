// Composite wallet UI pieces: sync bar, address card, transaction row.
import { QRCodeSVG } from "qrcode.react";
import { Link } from "react-router-dom";
import { ArrowDownLeft, ArrowUpRight, Loader2 } from "lucide-react";
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
 */
export function SyncBar({ sync }: { sync: SyncStatus | null }) {
  const pct = sync ? Math.min(100, Math.max(0, sync.progressPercent)) : 0;
  const connecting = sync === null || sync.chainTip === 0;
  const caughtUp =
    sync !== null && sync.chainTip > 0 && sync.syncedHeight >= sync.chainTip;

  return (
    <Card className="rounded-xl p-4" role="status" aria-live="polite">
      <div className="flex items-center gap-2 text-sm font-medium">
        {caughtUp ? (
          <>
            <span className="h-2 w-2 rounded-full bg-emerald-400" aria-hidden />
            <span>Synced</span>
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

      <p className="mt-0.5 truncate text-xs tabular-nums text-muted-foreground">
        {sync && !connecting
          ? `${formatHeight(sync.syncedHeight)} / ${formatHeight(sync.chainTip)}`
          : "Waiting for chain tip…"}
      </p>

      {!caughtUp ? (
        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out"
            style={{ width: `${pct}%` }}
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
        <div className="truncate font-mono text-sm text-foreground">
          {truncateAddress(address, 14)}
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
          <p className="truncate font-mono text-xs text-muted-foreground/70">
            {truncateAddress(tx.txid, 10)}
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
