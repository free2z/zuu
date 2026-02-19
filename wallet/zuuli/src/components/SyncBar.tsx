import type { SyncStatus } from "../types";

interface Props {
  syncStatus: SyncStatus | null;
}

export function SyncBar({ syncStatus }: Props) {
  if (!syncStatus || syncStatus.chainTip === 0) {
    return null;
  }

  const percent = Math.min(syncStatus.progressPercent, 100);
  const synced = percent >= 99.9;
  const almostSynced = percent >= 95 && !synced;
  const activelySyncing = syncStatus.syncing && !synced;

  let barOpacity: string;
  let animation = "";

  if (synced) {
    barOpacity = "opacity-40";
    animation = "animate-sync-breathe";
  } else if (almostSynced) {
    barOpacity = "opacity-50";
  } else if (activelySyncing) {
    barOpacity = "opacity-60";
  } else {
    barOpacity = "opacity-25";
  }

  const widthPercent = synced ? 100 : percent;

  const statusLabel = synced
    ? `Synced at block ${syncStatus.syncedHeight.toLocaleString()}`
    : `Syncing: ${Math.round(percent)}% — block ${syncStatus.syncedHeight.toLocaleString()} of ${syncStatus.chainTip.toLocaleString()}`;

  return (
    <div className="fixed top-0 left-0 md:left-52 right-0 z-40 pointer-events-none">
      <div
        className="h-1 w-full"
        role="progressbar"
        aria-valuenow={syncStatus.syncedHeight}
        aria-valuemin={0}
        aria-valuemax={syncStatus.chainTip}
        aria-label={statusLabel}
      >
        <div
          className={`h-full bg-purple-500 ${barOpacity} ${animation} transition-all duration-[3000ms] ease-in-out`}
          style={{ width: `${widthPercent}%` }}
        />
      </div>
    </div>
  );
}
