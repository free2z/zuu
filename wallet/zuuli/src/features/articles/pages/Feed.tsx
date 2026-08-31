import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router-dom";
import { Loader2, Newspaper, PenLine, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/common/EmptyState";
import { PageHeader } from "@/components/common/PageHeader";
import { useRouteScroll } from "@/hooks/useRouteScroll";
import { cn } from "@/lib/utils";
import { MESSAGE_KEYS } from "@/i18n/messages";
import {
  isArticleTagFilterable,
  MAX_ARTICLE_TAGS,
  parseArticleTagsParam,
  sanitizeArticleTags,
} from "@/lib/article-tags";
import type { ArticleSort } from "@/lib/api/types";
import { ArticleCard, ArticleCardSkeleton } from "../components/ArticleCard";
import { TopicFilterAutocomplete } from "../components/TopicFilterAutocomplete";
import { useArticleFeed } from "../useArticleFeed";

/** The user-facing ranking options (backend `homeSort` values). */
const SORTS: { value: ArticleSort; label: string }[] = [
  { value: "popular", label: "Fresh" },
  { value: "score", label: "Top" },
  { value: "updated", label: "Recent" },
];

export function Feed() {
  const { t } = useTranslation();
  const { viewport } = useRouteScroll();
  const [params, setParams] = useSearchParams();
  const [sort, setSort] = useState<ArticleSort>("popular");
  const selectedTags = useMemo(
    () => parseArticleTagsParam(params.get("tags")),
    [params],
  );
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  // Debounce the search box so we hit the (semantic) endpoint on a pause,
  // not on every keystroke.
  useEffect(() => {
    const id = setTimeout(() => setSearch(searchInput.trim()), 350);
    return () => clearTimeout(id);
  }, [searchInput]);

  const {
    items,
    count,
    loading,
    loadingMore,
    error,
    hasMore,
    loadMore,
    reload,
  } = useArticleFeed({ sort, tags: selectedTags, search });

  function updateSelectedTags(tags: string[]) {
    const canonical = sanitizeArticleTags(tags)
      .filter(isArticleTagFilterable)
      .slice(0, MAX_ARTICLE_TAGS);
    const next = new URLSearchParams(params);
    if (canonical.length > 0) next.set("tags", canonical.join(","));
    else next.delete("tags");
    setParams(next);
  }

  // Infinite scroll: fire loadMore when the sentinel scrolls into view.
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!sentinel || !viewport) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore();
      },
      { root: viewport, rootMargin: "600px 0px" },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [loadMore, sentinel, viewport]);

  const hasFilters = selectedTags.length > 0 || search.length > 0;
  const grid = useMemo(
    () => (
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((a) => (
          <ArticleCard key={String(a.id)} article={a} />
        ))}
      </div>
    ),
    [items],
  );

  return (
    <div className="animate-slide-up">
      <PageHeader
        title="Articles"
        actions={
          <Button asChild>
            <Link to="/articles/new" aria-label="Write a new article">
              <PenLine className="h-4 w-4" aria-hidden />
              Write
            </Link>
          </Button>
        }
      />

      {/* Controls: search + sort */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="w-full sm:max-w-md">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              type="text"
              role="searchbox"
              inputMode="search"
              enterKeyHint="search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder={t(MESSAGE_KEYS.navSearchAction)}
              aria-label={t(MESSAGE_KEYS.articlesSearchAccessible)}
              data-custom-search-clear
              className="pl-9 pr-12"
            />
            {searchInput ? (
              <button
                type="button"
                onClick={() => setSearchInput("")}
                aria-label="Clear search"
                className="min-tap absolute right-0 top-1/2 grid -translate-y-1/2 place-items-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            ) : null}
          </div>
        </div>

        <div
          className="flex shrink-0 gap-1 rounded-full border border-border p-1"
          role="tablist"
          aria-label="Sort articles"
        >
          {SORTS.map((s) => (
            <button
              key={s.value}
              type="button"
              role="tab"
              aria-selected={sort === s.value}
              onClick={() => setSort(s.value)}
              className={cn(
                "min-tap rounded-full px-3 py-1 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                sort === s.value
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <TopicFilterAutocomplete
        selected={selectedTags}
        onChange={updateSelectedTags}
      />

      {/* Result count */}
      {!loading && !error && items.length > 0 ? (
        <p className="mb-4 text-sm text-muted-foreground tabular-nums">
          {count.toLocaleString()} {count === 1 ? "article" : "articles"}
          {selectedTags.length > 0 ? ` tagged ${selectedTags.join(" + ")}` : ""}
        </p>
      ) : null}

      {/* Content */}
      {loading ? (
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <ArticleCardSkeleton key={i} />
          ))}
        </div>
      ) : error ? (
        <EmptyState
          icon={Newspaper}
          title="Couldn't load articles"
          description="Something went wrong reaching the feed. Try again in a moment."
          action={
            <Button variant="outline" onClick={reload}>
              Try again
            </Button>
          }
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={search ? Search : Newspaper}
          title={hasFilters ? "No matching articles" : "No articles yet"}
          description={
            hasFilters
              ? "Nothing matched your search and filters. Try broadening them."
              : "Be the first to publish — share what you're building on Zcash."
          }
          action={
            hasFilters ? (
              <Button
                variant="outline"
                onClick={() => {
                  updateSelectedTags([]);
                  setSearchInput("");
                }}
              >
                Clear filters
              </Button>
            ) : (
              <Button asChild variant="outline">
                <Link to="/articles/new">
                  <PenLine className="h-4 w-4" aria-hidden />
                  Write the first one
                </Link>
              </Button>
            )
          }
        />
      ) : (
        <>
          {grid}

          {/* Infinite-scroll sentinel + loading / end states */}
          <div
            ref={setSentinel}
            aria-hidden
            className="h-px w-full"
            data-article-feed-sentinel
            data-observer-root-ready={viewport ? "true" : "false"}
          />
          {loadingMore ? (
            <div className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <ArticleCardSkeleton key={i} />
              ))}
            </div>
          ) : hasMore ? (
            <div className="flex justify-center py-8 text-muted-foreground">
              <Loader2
                className="h-5 w-5 animate-spin"
                aria-label="Loading more"
              />
            </div>
          ) : (
            <p className="py-8 text-center text-sm text-muted-foreground">
              You've reached the end.
            </p>
          )}
        </>
      )}
    </div>
  );
}
