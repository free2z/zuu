// Composite wallet UI pieces: sync bar, address card, transaction row.
import { QRCodeSVG } from "qrcode.react";
import { Link } from "react-router-dom";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Loader2,
  Play,
  Square,
} from "lucide-react";
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

/** Sync progress bar with a Start/Stop toggle. */
export function SyncBar({
  sync,
  busy,
  onToggle,
}: {
  sync: SyncStatus | null;
  busy: boolean;
  onToggle: () => void;
}) {
  const pct = sync ? Math.min(100, Math.max(0, sync.progressPercent)) : 0;
  const syncing = sync?.syncing ?? false;
  const synced = pct >= 99.995;

  return (
    <Card className="rounded-xl p-4">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 space-y-0.5">
          <div className="flex items-center gap-2 text-sm font-medium">
            {syncing ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                <span>Syncing blocks</span>
              </>
            ) : synced ? (
              <>
                <span
                  className="h-2 w-2 rounded-full bg-emerald-400"
                  aria-hidden
                />
                <span>Up to date</span>
              </>
            ) : (
              <>
                <span
                  className="h-2 w-2 rounded-full bg-muted-foreground"
                  aria-hidden
                />
                <span>Sync paused</span>
              </>
            )}
          </div>
          <p className="truncate text-xs tabular-nums text-muted-foreground">
            {sync
              ? `${formatHeight(sync.syncedHeight)} / ${formatHeight(sync.chainTip)} · ${pct.toFixed(1)}%`
              : "—"}
          </p>
        </div>

        <Button
          type="button"
          size="sm"
          variant={syncing ? "outline" : "secondary"}
          onClick={onToggle}
          disabled={busy}
          aria-label={syncing ? "Stop sync" : "Start sync"}
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : syncing ? (
            <Square className="h-4 w-4" />
          ) : (
            <Play className="h-4 w-4" />
          )}
          {syncing ? "Stop" : "Sync"}
        </Button>
      </div>

      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-500 ease-out",
            synced ? "bg-emerald-400" : "bg-primary",
          )}
          style={{ width: `${pct}%` }}
          role="progressbar"
          aria-valuenow={Math.round(pct)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Chain sync progress"
        />
      </div>
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
