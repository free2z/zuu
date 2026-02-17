import { formatHeight } from "../lib/format";
import type { SyncStatus } from "../types";

interface Props {
  syncStatus: SyncStatus | null;
}

export function SyncProgress({ syncStatus }: Props) {
  if (!syncStatus || (!syncStatus.syncing && syncStatus.chainTip === 0)) {
    return null;
  }

  const synced = syncStatus.progressPercent >= 99.9 && !syncStatus.syncing;

  return (
    <div className="flex items-center justify-center gap-2 text-xs">
      {synced ? (
        <>
          <span className="w-2 h-2 rounded-full bg-emerald-400" />
          <span className="text-zinc-500">Synced</span>
          <span className="text-zinc-600">{formatHeight(syncStatus.syncedHeight)}</span>
        </>
      ) : syncStatus.syncing ? (
        <>
          <span className="w-2 h-2 rounded-full bg-purple-400 animate-pulse-dot" />
          <span className="text-zinc-400">Syncing {syncStatus.progressPercent.toFixed(1)}%</span>
          <span className="text-zinc-600">
            {formatHeight(syncStatus.syncedHeight)} / {formatHeight(syncStatus.chainTip)}
          </span>
        </>
      ) : (
        <>
          <span className="w-2 h-2 rounded-full bg-zinc-600" />
          <span className="text-zinc-500">
            {formatHeight(syncStatus.syncedHeight)} / {formatHeight(syncStatus.chainTip)}
          </span>
        </>
      )}
    </div>
  );
}
