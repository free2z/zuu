import { useEffect, useMemo, useState } from "react";
import { Radio } from "lucide-react";
import { PageHeader } from "@/components/common/PageHeader";
import { EmptyState } from "@/components/common/EmptyState";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { live } from "@/lib/api/free2z";
import { useAsync } from "@/hooks/useAsync";
import type { StreamKind } from "@/lib/api/types";
import { StreamCard, StreamCardSkeleton } from "./StreamCard";
import { GoLiveDialog } from "./GoLiveDialog";

type Filter = "all" | StreamKind;

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "broadcast", label: "Broadcast" },
  { value: "subscriber", label: "Subscriber" },
  { value: "ppv", label: "PPV" },
];

export function Discovery() {
  const { data, loading, reload } = useAsync(() => live.listPublic(), []);
  const [filter, setFilter] = useState<Filter>("all");

  // Refresh the listing periodically, but never while the tab is hidden (no
  // point hammering the API in the background), and refresh once on return so
  // the grid is current the moment the user comes back. The API-layer TTL cache
  // collapses any overlap, so this can't stack into a retry storm.
  useEffect(() => {
    const interval = window.setInterval(() => {
      if (!document.hidden) reload();
    }, 15_000);
    const onVisible = () => {
      if (!document.hidden) reload();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [reload]);

  const streams = useMemo(() => {
    const all = data ?? [];
    const filtered =
      filter === "all" ? all : all.filter((s) => s.kind === filter);
    // Live first, then most-watched.
    return [...filtered].sort((a, b) => {
      if (a.live !== b.live) return a.live ? -1 : 1;
      return b.participants - a.participants;
    });
  }, [data, filter]);

  const liveCount = (data ?? []).filter((s) => s.live).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Livestreams"
        description={
          loading
            ? "Loading the room…"
            : liveCount > 0
              ? `${liveCount} creator${liveCount === 1 ? "" : "s"} live right now.`
              : "No one is live yet — be the first to go on air."
        }
        actions={<GoLiveDialog />}
      />

      <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)}>
        <TabsList>
          {FILTERS.map((f) => (
            <TabsTrigger key={f.value} value={f.value}>
              {f.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {loading ? (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <StreamCardSkeleton key={i} />
          ))}
        </div>
      ) : streams.length === 0 ? (
        <EmptyState
          icon={Radio}
          title="Nothing here yet"
          description={
            filter === "all"
              ? "When creators go live, their streams show up here."
              : `No ${filter} streams right now. Try another filter.`
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {streams.map((s) => (
            <StreamCard key={s.id} stream={s} />
          ))}
        </div>
      )}
    </div>
  );
}
