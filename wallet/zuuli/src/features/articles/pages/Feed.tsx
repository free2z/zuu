import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, Newspaper, PenLine, Search, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/common/EmptyState";
import { PageHeader } from "@/components/common/PageHeader";
import { cn } from "@/lib/utils";
import type { ArticleSort } from "@/lib/api/types";
import { ArticleCard, ArticleCardSkeleton } from "../components/ArticleCard";
import { useArticleFeed } from "../useArticleFeed";

/** The user-facing ranking options (backend `homeSort` values). */
const SORTS: { value: ArticleSort; label: string }[] = [
  { value: "popular", label: "Fresh" },
  { value: "score", label: "Top" },
  { value: "updated", label: "Recent" },
];

export function Feed() {
  const [sort, setSort] = useState<ArticleSort>("popular");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  // Debounce the search box so we hit the (semantic) endpoint on a pause,
  // not on every keystroke.
  useEffect(() => {
    const id = setTimeout(() => setSearch(searchInput.trim()), 350);
    return () => clearTimeout(id);
  }, [searchInput]);

  const { items, count, loading, loadingMore, error, hasMore, loadMore, reload } =
    useArticleFeed({ sort, tags: selectedTags, search });

  // Accumulate tags seen across pages so the filter chips grow as you scroll,
  // and never drop a tag the user has already selected.
  const [knownTags, setKnownTags] = useState<string[]>([]);
  useEffect(() => {
    setKnownTags((prev) => {
      const set = new Set(prev);
      for (const a of items) for (const t of a.tags ?? []) set.add(t);
      for (const t of selectedTags) set.add(t);
      const merged = Array.from(set).sort();
      return merged.length === prev.length && merged.every((t, i) => t === prev[i])
        ? prev
        : merged;
    });
  }, [items, selectedTags]);

  const toggleTag = (tag: string) =>
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
    );

  // Infinite scroll: fire loadMore when the sentinel scrolls into view.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore();
      },
      { rootMargin: "600px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore]);

  const hasFilters = selectedTags.length > 0 || search.length > 0;
  const showTagBar = knownTags.length > 0;

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
        description="Long-form writing from the Zcash community — backed by free2z zpages."
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
              type="search"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search articles by meaning…"
              aria-label="Search articles"
              className="pl-9 pr-9"
            />
            {searchInput ? (
              <button
                type="button"
                onClick={() => setSearchInput("")}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-md text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            ) : null}
          </div>
          <p className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground">
            <Sparkles className="h-3 w-3 text-primary" aria-hidden />
            Semantic search — results ranked by meaning, not just keywords.
          </p>
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
                "rounded-full px-3 py-1 text-sm font-medium transition-colors",
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

      {/* Tag filter (AND semantics) */}
      {showTagBar ? (
        <div className="mb-6 flex flex-wrap items-center gap-2" aria-label="Filter by tag">
          {knownTags.map((tag) => {
            const on = selectedTags.includes(tag);
            return (
              <button
                key={tag}
                type="button"
                aria-pressed={on}
                onClick={() => toggleTag(tag)}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                  on
                    ? "border-primary bg-primary/15 text-primary"
                    : "border-border bg-transparent text-muted-foreground hover:bg-secondary hover:text-foreground",
                )}
              >
                {tag}
              </button>
            );
          })}
          {selectedTags.length > 0 ? (
            <button
              type="button"
              onClick={() => setSelectedTags([])}
              className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" aria-hidden />
              Clear tags
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Result count */}
      {!loading && !error && items.length > 0 ? (
        <p className="mb-4 text-sm text-muted-foreground tabular-nums">
          {count.toLocaleString()} {count === 1 ? "article" : "articles"}
          {selectedTags.length > 0
            ? ` tagged ${selectedTags.join(" + ")}`
            : ""}
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
          title={
            hasFilters ? "No matching articles" : "No articles yet"
          }
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
                  setSelectedTags([]);
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
          <div ref={sentinelRef} aria-hidden className="h-px w-full" />
          {loadingMore ? (
            <div className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <ArticleCardSkeleton key={i} />
              ))}
            </div>
          ) : hasMore ? (
            <div className="flex justify-center py-8 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" aria-label="Loading more" />
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
