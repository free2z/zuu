import { Link } from "react-router-dom";
import { Users, BadgeCheck, ArrowUpRight } from "lucide-react";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/common/EmptyState";
import { initials } from "@/lib/format";
import { discover } from "@/lib/api/free2z";
import { parseBioFrontmatter } from "@/lib/utils/bio";
import { useAsync } from "@/hooks/useAsync";
import type { SimpleCreator } from "@/lib/api/types";
import { SectionHeader, gradientFor } from "./parts";

function CreatorCard({ creator }: { creator: SimpleCreator }) {
  const name = creator.display_name || creator.username;
  // Bios may lead with a socials frontmatter block (see lib/utils/bio) — never
  // show that raw in a plain-text snippet.
  const { body: bio } = parseBioFrontmatter(creator.bio);
  return (
    <Link
      to={`/creator/${creator.username}`}
      aria-label={`View ${name}'s profile`}
      className="group relative flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div
        className="h-16 w-full"
        style={{ background: gradientFor(creator.username) }}
        aria-hidden
      />
      <div className="flex flex-1 flex-col items-center px-4 pb-4 text-center">
        <Avatar className="-mt-8 h-16 w-16 border-4 border-card">
          {creator.image ? <AvatarImage src={creator.image} alt={name} /> : null}
          <AvatarFallback className="bg-primary/15 text-base text-primary">
            {initials(name)}
          </AvatarFallback>
        </Avatar>
        <div className="mt-2 flex items-center gap-1 truncate text-sm font-semibold">
          {name}
          {creator.is_verified ? (
            <BadgeCheck
              className="h-4 w-4 shrink-0 text-primary"
              aria-label="Verified"
            />
          ) : null}
        </div>
        {bio ? (
          <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
            {bio}
          </p>
        ) : null}
        <span className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 px-4 py-1.5 text-xs font-semibold text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
          View profile
          <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
        </span>
      </div>
    </Link>
  );
}

function CreatorSkeleton() {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <Skeleton className="h-16 w-full rounded-none" />
      <div className="flex flex-col items-center px-4 pb-4">
        <Skeleton className="-mt-8 h-16 w-16 rounded-full border-4 border-card" />
        <Skeleton className="mt-2 h-4 w-20" />
        <Skeleton className="mt-2 h-3 w-28" />
        <Skeleton className="mt-3 h-7 w-24 rounded-full" />
      </div>
    </div>
  );
}

export function CreatorsRow() {
  const { data, loading } = useAsync(() => discover.creators(), []);
  const creators = data ?? [];

  return (
    <div>
      <SectionHeader
        icon={Users}
        title="Creators to watch"
        subtitle="Voices worth following on ZUULI"
      />
      {loading ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <CreatorSkeleton key={i} />
          ))}
        </div>
      ) : creators.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No creators to show"
          description="Recommended creators will appear here as the network grows."
        />
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {creators.map((c) => (
            <CreatorCard key={c.username} creator={c} />
          ))}
        </div>
      )}
    </div>
  );
}
