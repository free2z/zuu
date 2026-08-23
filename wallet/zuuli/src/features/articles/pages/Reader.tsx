import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Clock, Newspaper } from "lucide-react";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/common/EmptyState";
import { Markdown } from "@/components/common/Markdown";
import { RemoteImage } from "@/components/common/RemoteMedia";
import { SectionLoadError } from "@/components/common/SectionLoadError";
import { useAsync } from "@/hooks/useAsync";
import { articles } from "@/lib/api/free2z";
import { initials } from "@/lib/format";
import {
  currentResourceData,
  isConfirmedNotFound,
  type KeyedRemoteData,
} from "@/lib/remote-data";
import type { Article } from "@/lib/api/types";
import { TipDialog } from "../components/TipDialog";
import { CommentsSection } from "../components/Comments";
import { ArticleScore } from "../components/ArticleScore";
import { coverTone } from "@/lib/cover";
import { formatPublished } from "../lib";

export function Reader() {
  const { slug } = useParams<{ slug: string }>();
  const key = slug ?? "";
  const { data, loading, error, reload } = useAsync<
    KeyedRemoteData<string, Article>
  >(
    async () => {
      if (!slug) throw new Error("The article link is missing a slug.");
      return { key: slug, value: await articles.get(slug) };
    },
    [slug],
  );
  const article = currentResourceData(data, key);

  if (loading && article === null && !error) {
    return <ReaderSkeleton />;
  }

  if (error && article === null) {
    if (!isConfirmedNotFound(error)) {
      return (
        <div className="animate-slide-up">
          <BackLink />
          <SectionLoadError
            className="mt-6"
            title="Couldn't load this article"
            description="The article may still be available. Check your connection and try again."
            retry={reload}
            retrying={loading}
          />
        </div>
      );
    }

    return (
      <div className="animate-slide-up">
        <BackLink />
        <EmptyState
          className="mt-6"
          icon={Newspaper}
          title="Article not found"
          description="This article may have been removed or the link is incorrect."
          action={
            <Button asChild variant="outline">
              <Link to="/articles">Back to articles</Link>
            </Button>
          }
        />
      </div>
    );
  }

  if (!article) {
    return (
      <div className="animate-slide-up">
        <BackLink />
        <SectionLoadError
          className="mt-6"
          title="Couldn't load this article"
          description="The server returned no article. Try again."
          retry={reload}
          retrying={loading}
        />
      </div>
    );
  }

  const author = article.author;
  const name = author.display_name || author.username;

  return (
    <article className="app-reader-content animate-slide-up w-full min-w-0 overflow-x-clip">
      <div className="mx-auto w-full min-w-0 max-w-3xl">
        <BackLink />

        {error ? (
          <SectionLoadError
            className="mt-6"
            title="Couldn't refresh this article"
            description="Showing the last version loaded on this device."
            retry={reload}
            retrying={loading}
            stale
          />
        ) : null}

        <header className="mt-6 min-w-0 space-y-4">
          {article.category ? <Badge>{article.category}</Badge> : null}
          <h1 className="break-words text-3xl font-bold leading-tight tracking-tight md:text-4xl">
            {article.title}
          </h1>
          {article.subtitle ? (
            <p className="break-words text-lg text-muted-foreground">
              {article.subtitle}
            </p>
          ) : null}

          <div className="flex items-center gap-3 pt-2">
            <Link
              to={`/creator/${author.username}`}
              aria-label={`View ${name}’s profile`}
              className="min-tap inline-flex shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Avatar>
                {author.image ? (
                  <AvatarImage src={author.image} alt={name} />
                ) : null}
                <AvatarFallback>{initials(name)}</AvatarFallback>
              </Avatar>
            </Link>
            <div className="text-sm">
              <Link
                to={`/creator/${author.username}`}
                className="min-tap inline-flex items-center rounded-md font-medium text-foreground transition-colors hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {name}
              </Link>
              <div className="flex items-center gap-2 text-muted-foreground">
                {article.published_at ? (
                  <span>{formatPublished(article.published_at)}</span>
                ) : null}
                {typeof article.reading_minutes === "number" ? (
                  <>
                    <span aria-hidden>·</span>
                    <span className="inline-flex items-center gap-1">
                      <Clock className="h-3.5 w-3.5" aria-hidden />
                      {article.reading_minutes} min read
                    </span>
                  </>
                ) : null}
              </div>
            </div>
          </div>
        </header>

        {/* Cover */}
        <div
          className="mt-8 aspect-[21/9] w-full overflow-hidden rounded-xl border border-border"
          style={
            article.image
              ? undefined
              : { backgroundImage: coverTone(article.title) }
          }
        >
          {article.image ? (
            <RemoteImage
              src={article.image}
              alt=""
              className="h-full w-full object-cover"
              containerClassName="h-full min-h-0 rounded-none border-0 p-0"
            />
          ) : null}
        </div>

        <div className="mt-10 min-w-0 max-w-full break-words">
          <Markdown>{article.content}</Markdown>
        </div>

        {article.free2zaddr ? (
          <CommentsSection uuid={article.free2zaddr} contentType="zpage" />
        ) : null}
      </div>

      {/* Sticky action bar */}
      <div className="app-reader-actions fixed inset-x-0 z-30 border-t border-border bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3">
          <ArticleScore score={article.votes ?? 0} />
          <TipDialog author={author} />
        </div>
      </div>
    </article>
  );
}

function BackLink() {
  return (
    <Link
      to="/articles"
      className="min-tap inline-flex items-center gap-2 rounded-md text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ArrowLeft className="h-4 w-4" aria-hidden />
      All articles
    </Link>
  );
}

function ReaderSkeleton() {
  return (
    <div className="mx-auto max-w-3xl">
      <Skeleton className="h-4 w-24" />
      <div className="mt-6 space-y-4">
        <Skeleton className="h-6 w-20 rounded-full" />
        <Skeleton className="h-10 w-3/4" />
        <Skeleton className="h-6 w-1/2" />
        <div className="flex items-center gap-3 pt-2">
          <Skeleton className="h-10 w-10 rounded-full" />
          <div className="space-y-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-40" />
          </div>
        </div>
      </div>
      <Skeleton className="mt-8 aspect-[21/9] w-full rounded-xl" />
      <div className="mt-10 space-y-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-4 w-full" />
        ))}
      </div>
    </div>
  );
}
