import { Link } from "react-router-dom";
import { BookOpen, Clock, ChevronUp } from "lucide-react";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/common/EmptyState";
import { initials, timeAgo } from "@/lib/format";
import { articles } from "@/lib/api/free2z";
import { useAsync } from "@/hooks/useAsync";
import type { Article } from "@/lib/api/types";
import { SectionHeader } from "./parts";

function AuthorAvatar({ author }: { author: Article["author"] }) {
  const name = author.display_name || author.username;
  return (
    <Avatar className="h-6 w-6">
      {author.image ? <AvatarImage src={author.image} alt={name} /> : null}
      <AvatarFallback className="bg-primary/15 text-[10px] text-primary">
        {initials(name)}
      </AvatarFallback>
    </Avatar>
  );
}

function ArticleCard({ article }: { article: Article }) {
  const name = article.author.display_name || article.author.username;
  const to = `/articles/${article.slug ?? article.id}`;
  return (
    <Link
      to={to}
      aria-label={`Read: ${article.title}`}
      className="group flex flex-col gap-3 rounded-xl border border-border bg-card p-5 shadow-sm transition-all hover:border-primary/40 hover:shadow-glow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {article.category ? (
        <span className="text-[11px] font-medium uppercase tracking-wide text-primary">
          {article.category}
        </span>
      ) : null}
      <h3 className="line-clamp-2 text-base font-semibold leading-snug transition-colors group-hover:text-primary">
        {article.title}
      </h3>
      {article.subtitle ? (
        <p className="line-clamp-2 text-sm text-muted-foreground">
          {article.subtitle}
        </p>
      ) : null}
      <div className="mt-auto flex items-center gap-2 pt-2 text-xs text-muted-foreground">
        <AuthorAvatar author={article.author} />
        <span className="truncate font-medium text-foreground/90">{name}</span>
        {article.published_at ? (
          <>
            <span aria-hidden>·</span>
            <span className="shrink-0">{timeAgo(article.published_at)}</span>
          </>
        ) : null}
      </div>
      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        {typeof article.reading_minutes === "number" ? (
          <span className="inline-flex items-center gap-1">
            <Clock className="h-3.5 w-3.5" aria-hidden />
            {article.reading_minutes} min read
          </span>
        ) : null}
        {typeof article.votes === "number" ? (
          <span className="inline-flex items-center gap-1 tabular-nums">
            <ChevronUp className="h-3.5 w-3.5" aria-hidden />
            {article.votes.toLocaleString()}
          </span>
        ) : null}
      </div>
    </Link>
  );
}

function ArticleSkeleton() {
  return (
    <div className="space-y-3 rounded-xl border border-border bg-card p-5">
      <Skeleton className="h-3 w-16" />
      <Skeleton className="h-5 w-11/12" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-3/4" />
      <div className="flex items-center gap-2 pt-2">
        <Skeleton className="h-6 w-6 rounded-full" />
        <Skeleton className="h-3 w-24" />
      </div>
    </div>
  );
}

export function ArticlesGrid() {
  // Fresh (recency-decayed) — just the first few for the home rail.
  const { data, loading } = useAsync(
    () => articles.feed({ sort: "popular", pageSize: 3 }),
    [],
  );
  const top = (data?.items ?? []).slice(0, 3);

  return (
    <div>
      <SectionHeader
        icon={BookOpen}
        title="Fresh articles"
        subtitle="Long-form writing from the community"
        to="/articles"
      />
      {loading ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <ArticleSkeleton key={i} />
          ))}
        </div>
      ) : top.length === 0 ? (
        <EmptyState
          icon={BookOpen}
          title="No articles yet"
          description="Fresh writing from creators will appear here."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {top.map((a) => (
            <ArticleCard key={a.id} article={a} />
          ))}
        </div>
      )}
    </div>
  );
}
