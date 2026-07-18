import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Newspaper, PenLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/common/EmptyState";
import { PageHeader } from "@/components/common/PageHeader";
import { articles } from "@/lib/api/free2z";
import { cn } from "@/lib/utils";
import type { Article } from "@/lib/api/types";
import { ArticleCard, ArticleCardSkeleton } from "../components/ArticleCard";
import { categoriesFromFeed } from "../lib";

export function Feed() {
  const [items, setItems] = useState<Article[] | null>(null);
  const [error, setError] = useState(false);
  const [active, setActive] = useState("All");

  useEffect(() => {
    let alive = true;
    setItems(null);
    setError(false);
    articles
      .feed()
      .then((data) => {
        if (alive) setItems(data);
      })
      .catch(() => {
        if (alive) setError(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const categories = useMemo(
    () => (items ? categoriesFromFeed(items) : ["All"]),
    [items],
  );

  const visible = useMemo(() => {
    if (!items) return [];
    return active === "All"
      ? items
      : items.filter((a) => a.category === active);
  }, [items, active]);

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

      {/* Category chips */}
      {items && categories.length > 1 ? (
        <div className="mb-6 flex flex-wrap gap-2" role="tablist" aria-label="Filter by category">
          {categories.map((cat) => (
            <button
              key={cat}
              type="button"
              role="tab"
              aria-selected={active === cat}
              onClick={() => setActive(cat)}
              className={cn(
                "rounded-full border px-4 py-1.5 text-sm font-medium transition-colors",
                active === cat
                  ? "border-primary bg-primary/15 text-primary"
                  : "border-border bg-transparent text-muted-foreground hover:bg-secondary hover:text-foreground",
              )}
            >
              {cat}
            </button>
          ))}
        </div>
      ) : null}

      {/* Content */}
      {items === null && !error ? (
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
        />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={Newspaper}
          title={active === "All" ? "No articles yet" : `Nothing in ${active}`}
          description={
            active === "All"
              ? "Be the first to publish — share what you're building on Zcash."
              : "No articles in this category yet. Try another filter."
          }
          action={
            <Button asChild variant="outline">
              <Link to="/articles/new">
                <PenLine className="h-4 w-4" aria-hidden />
                Write the first one
              </Link>
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((a) => (
            <ArticleCard key={String(a.id)} article={a} />
          ))}
        </div>
      )}
    </div>
  );
}
