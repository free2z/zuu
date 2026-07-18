import { Link } from "react-router-dom";
import { Users, RadioTower, Lock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { formatTuzis, timeAgo, initials } from "@/lib/format";
import type { Livestream } from "@/lib/api/types";
import { cn } from "@/lib/utils";
import { KIND_META, gradientFor } from "./lib";

export function StreamCard({ stream }: { stream: Livestream }) {
  const kind = KIND_META[stream.kind] ?? KIND_META.broadcast;
  const creatorName = stream.creator.display_name ?? stream.creator.username;
  const isPaid = stream.kind === "ppv" && stream.price_tuzis > 0;

  return (
    <Link
      to={`/live/${stream.username}`}
      aria-label={
        stream.live
          ? `${stream.title} by ${creatorName} — live now, ${stream.participants} watching`
          : `${stream.title} by ${creatorName} — offline`
      }
      className={cn(
        "group flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        stream.live
          ? "hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-glow"
          : "opacity-70 hover:opacity-100",
      )}
    >
      <div
        className="relative aspect-video w-full"
        style={{ background: gradientFor(stream.username + stream.title) }}
      >
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-black/10" />
        {/* faint grid texture */}
        <div
          className="absolute inset-0 opacity-[0.14]"
          style={{
            backgroundImage:
              "linear-gradient(rgba(255,255,255,.6) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.6) 1px, transparent 1px)",
            backgroundSize: "28px 28px",
          }}
          aria-hidden
        />

        <div className="absolute left-3 top-3 flex flex-wrap items-center gap-2">
          {stream.live ? (
            <Badge variant="live" className="gap-1.5 shadow-sm">
              <span
                className="h-1.5 w-1.5 rounded-full bg-[#fb7185] animate-pulse-live"
                aria-hidden
              />
              LIVE
            </Badge>
          ) : (
            <Badge variant="secondary" className="gap-1.5">
              <span
                className="h-1.5 w-1.5 rounded-full bg-muted-foreground"
                aria-hidden
              />
              Offline
            </Badge>
          )}
          <Badge variant={kind.variant} className="gap-1">
            {stream.kind === "private" ? (
              <Lock className="h-3 w-3" aria-hidden />
            ) : null}
            {kind.short}
          </Badge>
        </div>

        {stream.live ? (
          <div className="absolute bottom-3 right-3 flex items-center gap-1 rounded-full bg-black/55 px-2 py-1 text-xs font-medium text-white backdrop-blur">
            <Users className="h-3.5 w-3.5" aria-hidden />
            <span className="tabular-nums">
              {stream.participants.toLocaleString()}
            </span>
          </div>
        ) : null}

        <div className="absolute inset-0 grid place-items-center opacity-60 transition-opacity group-hover:opacity-100">
          <RadioTower
            className={cn(
              "h-9 w-9 drop-shadow",
              stream.live ? "text-white/90" : "text-white/50",
            )}
            aria-hidden
          />
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-3 p-4">
        <h3 className="line-clamp-2 min-h-[2.5rem] text-sm font-semibold leading-snug">
          {stream.title}
        </h3>

        <div className="mt-auto flex items-center gap-2">
          <Avatar className="h-7 w-7">
            {stream.creator.image ? (
              <AvatarImage src={stream.creator.image} alt="" />
            ) : null}
            <AvatarFallback className="text-[10px]">
              {initials(creatorName)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium">{creatorName}</div>
            <div className="truncate text-[11px] text-muted-foreground">
              {stream.live
                ? stream.started_at
                  ? `Started ${timeAgo(stream.started_at)}`
                  : "Live now"
                : "Offline"}
            </div>
          </div>
          {isPaid ? (
            <span className="shrink-0 text-xs font-semibold tabular-nums text-amber-400">
              {formatTuzis(stream.price_tuzis)}
            </span>
          ) : stream.kind === "broadcast" ? (
            <span className="shrink-0 text-xs font-medium text-emerald-400">
              Free
            </span>
          ) : null}
        </div>
      </div>
    </Link>
  );
}

export function StreamCardSkeleton() {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <Skeleton className="aspect-video w-full rounded-none" />
      <div className="space-y-3 p-4">
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-2/3" />
        <div className="flex items-center gap-2 pt-1">
          <Skeleton className="h-7 w-7 rounded-full" />
          <Skeleton className="h-3 w-24" />
        </div>
      </div>
    </div>
  );
}
