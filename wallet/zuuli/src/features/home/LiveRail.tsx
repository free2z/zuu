import { Link } from "react-router-dom";
import { Radio, Users, RadioTower } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/common/EmptyState";
import { formatTuzis } from "@/lib/format";
import { live } from "@/lib/api/free2z";
import { useAsync } from "@/hooks/useAsync";
import type { Livestream, StreamKind } from "@/lib/api/types";
import { cn } from "@/lib/utils";
import { SectionHeader, gradientFor } from "./parts";

const KIND_META: Record<
  StreamKind,
  { label: string; variant: "default" | "sub" | "ppv" | "secondary" }
> = {
  broadcast: { label: "Broadcast", variant: "default" },
  subscriber: { label: "Subscribers", variant: "sub" },
  ppv: { label: "Pay-per-view", variant: "ppv" },
  private: { label: "Private", variant: "secondary" },
};

function StreamCard({ stream }: { stream: Livestream }) {
  const kind = KIND_META[stream.kind] ?? KIND_META.broadcast;
  return (
    <Link
      to={`/live/${stream.username}`}
      aria-label={`${stream.title} — live now, ${stream.participants} watching`}
      className="group flex w-[280px] shrink-0 snap-start flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm transition-all hover:border-primary/40 hover:shadow-glow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-auto"
    >
      <div
        className="relative aspect-video w-full"
        style={{ background: gradientFor(stream.username + stream.title) }}
      >
        <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent" />
        <div className="absolute left-3 top-3 flex items-center gap-2">
          <Badge variant="live" className="gap-1.5">
            <span
              className="h-1.5 w-1.5 rounded-full bg-[#fb7185] animate-pulse-live"
              aria-hidden
            />
            LIVE
          </Badge>
          <Badge variant={kind.variant}>{kind.label}</Badge>
        </div>
        <div className="absolute bottom-3 right-3 flex items-center gap-1 rounded-full bg-black/55 px-2 py-1 text-xs font-medium text-white backdrop-blur">
          <Users className="h-3.5 w-3.5" aria-hidden />
          <span className="tabular-nums">
            {stream.participants.toLocaleString()}
          </span>
        </div>
        <div className="absolute inset-0 grid place-items-center opacity-70 transition-opacity group-hover:opacity-100">
          <RadioTower className="h-8 w-8 text-white/90" aria-hidden />
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-2 p-4">
        <h3 className="line-clamp-2 text-sm font-semibold leading-snug">
          {stream.title}
        </h3>
        <div className="mt-auto flex items-center justify-between gap-2 pt-1">
          <span className="truncate text-xs text-muted-foreground">
            @{stream.username}
          </span>
          {stream.kind === "ppv" && stream.price_tuzis > 0 ? (
            <span className="shrink-0 text-xs font-semibold tabular-nums text-amber-400">
              {formatTuzis(stream.price_tuzis)}
            </span>
          ) : (
            <span className="shrink-0 text-xs font-medium text-emerald-400">
              Free
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}

function StreamSkeleton() {
  return (
    <div className="w-[280px] shrink-0 overflow-hidden rounded-xl border border-border bg-card sm:w-auto">
      <Skeleton className="aspect-video w-full rounded-none" />
      <div className="space-y-2 p-4">
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-2/3" />
        <div className="flex justify-between pt-1">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-3 w-10" />
        </div>
      </div>
    </div>
  );
}

export function LiveRail() {
  const { data, loading } = useAsync(() => live.listPublic(), []);
  const streams = (data ?? []).filter((s) => s.live === true);

  return (
    <div>
      <SectionHeader
        icon={Radio}
        title="Live now"
        subtitle="Creators broadcasting this moment"
        to="/live"
        accent="text-[#fb7185]"
      />
      {loading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <StreamSkeleton key={i} />
          ))}
        </div>
      ) : streams.length === 0 ? (
        <EmptyState
          icon={Radio}
          title="No one is live right now"
          description="When creators go live, their streams show up here first."
        />
      ) : (
        <div
          className={cn(
            "-mx-1 flex snap-x snap-mandatory gap-4 overflow-x-auto px-1 pb-2",
            "sm:mx-0 sm:grid sm:snap-none sm:grid-cols-2 sm:overflow-visible sm:px-0 sm:pb-0 lg:grid-cols-3",
          )}
        >
          {streams.map((s) => (
            <StreamCard key={s.id} stream={s} />
          ))}
        </div>
      )}
    </div>
  );
}
