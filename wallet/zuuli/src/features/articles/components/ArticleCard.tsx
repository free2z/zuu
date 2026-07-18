import { Link } from "react-router-dom";
import { ArrowUp, Clock } from "lucide-react";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { initials, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Article } from "@/lib/api/types";
import { articleHref, coverGradient } from "../lib";

export function ArticleCard({
  article,
  className,
}: {
  article: Article;
  className?: string;
}) {
  const author = article.author;
  const name = author.display_name || author.username;

  return (
    <Card
      className={cn(
        "group flex flex-col overflow-hidden rounded-xl border-border/60 bg-card/60 transition-colors hover:border-primary/40",
        className,
      )}
    >
      <Link
        to={articleHref(article)}
        aria-label={`Read “${article.title}”`}
        className="flex flex-1 flex-col focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {/* Cover */}
        <div
          className="relative aspect-[16/9] w-full overflow-hidden"
          style={
            article.image
              ? undefined
              : { backgroundImage: coverGradient(article.title) }
          }
        >
          {article.image ? (
            <img
              src={article.image}
              alt=""
              className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
            />
          ) : (
            <div className="absolute inset-0 bg-gradient-to-t from-black/40 to-transparent" />
          )}
          {article.category ? (
            <Badge className="absolute left-3 top-3 backdrop-blur-sm">
              {article.category}
            </Badge>
          ) : null}
        </div>

        {/* Body */}
        <div className="flex flex-1 flex-col gap-2 p-5">
          <h3 className="text-lg font-semibold leading-snug tracking-tight text-foreground transition-colors group-hover:text-primary">
            {article.title}
          </h3>
          {article.subtitle ? (
            <p className="line-clamp-2 text-sm text-muted-foreground">
              {article.subtitle}
            </p>
          ) : null}

          <div className="mt-auto flex items-center gap-3 pt-3">
            <Avatar className="h-8 w-8">
              {author.image ? (
                <AvatarImage src={author.image} alt={name} />
              ) : null}
              <AvatarFallback className="text-xs">
                {initials(name)}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-foreground">
                {name}
              </div>
              <div className="text-xs text-muted-foreground">
                {article.published_at ? timeAgo(article.published_at) : ""}
              </div>
            </div>
          </div>
        </div>
      </Link>

      {/* Meta footer */}
      <div className="flex items-center gap-4 border-t border-border/50 px-5 py-3 text-xs text-muted-foreground">
        {typeof article.reading_minutes === "number" ? (
          <span className="inline-flex items-center gap-1.5">
            <Clock className="h-3.5 w-3.5" aria-hidden />
            {article.reading_minutes} min read
          </span>
        ) : null}
        <span className="inline-flex items-center gap-1.5">
          <ArrowUp className="h-3.5 w-3.5" aria-hidden />
          {article.votes ?? 0}
          <span className="sr-only">votes</span>
        </span>
      </div>
    </Card>
  );
}

export function ArticleCardSkeleton() {
  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-border/60 bg-card/40">
      <Skeleton className="aspect-[16/9] w-full rounded-none" />
      <div className="space-y-3 p-5">
        <Skeleton className="h-5 w-3/4" />
        <Skeleton className="h-4 w-full" />
        <div className="flex items-center gap-3 pt-2">
          <Skeleton className="h-8 w-8 rounded-full" />
          <Skeleton className="h-4 w-24" />
        </div>
      </div>
    </div>
  );
}
