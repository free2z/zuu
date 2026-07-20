import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  BadgeCheck,
  BookOpen,
  Clock,
  FileText,
  Radio,
  Search as SearchIcon,
  Users,
  X,
} from "lucide-react";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/common/EmptyState";
import { PageHeader } from "@/components/common/PageHeader";
import { discover } from "@/lib/api/free2z";
import { formatTuzis, initials, timeAgo } from "@/lib/format";
import type { Article, SimpleCreator } from "@/lib/api/types";

const DEBOUNCE_MS = 300;

/** Excerpt from a zpage's markdown/plain content. */
function excerpt(text: string, max = 160): string {
  const clean = text
    .replace(/[#>*_`~[\]()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > max ? `${clean.slice(0, max).trimEnd()}…` : clean;
}

export default function SearchFeature() {
  const [params, setParams] = useSearchParams();
  const initial = params.get("q") ?? "";
  const [query, setQuery] = useState(initial);
  const debounced = useDebounced(query, DEBOUNCE_MS);
  const inputRef = useRef<HTMLInputElement>(null);

  const [creators, setCreators] = useState<SimpleCreator[] | null>(null);
  const [pages, setPages] = useState<Article[] | null>(null);
  const [error, setError] = useState(false);

  // Focus the box on mount for a keyboard-first feel.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Keep ?q= in the URL in sync with the debounced query (shareable results).
  useEffect(() => {
    const q = debounced.trim();
    setParams(q ? { q } : {}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  // Fetch both corpora in parallel whenever the debounced query changes.
  useEffect(() => {
    const q = debounced.trim();
    if (!q) {
      setCreators(null);
      setPages(null);
      setError(false);
      return;
    }
    let alive = true;
    setCreators(null);
    setPages(null);
    setError(false);
    Promise.allSettled([
      discover.searchCreators(q),
      discover.searchPages(q),
    ]).then(([c, p]) => {
      if (!alive) return;
      if (c.status === "fulfilled") setCreators(c.value);
      else setCreators([]);
      if (p.status === "fulfilled") setPages(p.value);
      else setPages([]);
      if (c.status === "rejected" && p.status === "rejected") setError(true);
    });
    return () => {
      alive = false;
    };
  }, [debounced]);

  const hasQuery = debounced.trim().length > 0;
  const loading = hasQuery && (creators === null || pages === null);
  const creatorCount = creators?.length ?? 0;
  const pageCount = pages?.length ?? 0;

  const defaultTab = useMemo(
    () => (creatorCount === 0 && pageCount > 0 ? "pages" : "creators"),
    [creatorCount, pageCount],
  );

  return (
    <div className="animate-slide-up">
      <PageHeader
        title="Search"
        description="Find every creator and every page across free2z — semantic page search included."
      />

      {/* Search box */}
      <div className="relative mb-6 max-w-2xl">
        <SearchIcon
          className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search creators and pages…"
          aria-label="Search creators and pages"
          className="h-12 pl-10 pr-10 text-base"
        />
        {query ? (
          <button
            type="button"
            onClick={() => {
              setQuery("");
              inputRef.current?.focus();
            }}
            aria-label="Clear search"
            className="min-tap absolute right-1.5 top-1/2 grid -translate-y-1/2 place-items-center rounded-md text-muted-foreground transition-colors hover:text-foreground"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        ) : null}
      </div>

      {!hasQuery ? (
        <EmptyState
          icon={SearchIcon}
          title="Search all of free2z"
          description="Start typing to find creators by name and pages by meaning — results update as you go."
        />
      ) : error ? (
        <EmptyState
          icon={SearchIcon}
          title="Search is unavailable"
          description="Something went wrong reaching search. Try again in a moment."
        />
      ) : (
        <Tabs defaultValue={defaultTab} key={defaultTab}>
          <TabsList>
            <TabsTrigger value="creators">
              <Users className="mr-1.5 h-4 w-4" aria-hidden />
              Creators
              <ResultCountBadge n={creatorCount} loading={loading} />
            </TabsTrigger>
            <TabsTrigger value="pages">
              <FileText className="mr-1.5 h-4 w-4" aria-hidden />
              Pages
              <ResultCountBadge n={pageCount} loading={loading} />
            </TabsTrigger>
          </TabsList>

          <TabsContent value="creators">
            {creators === null ? (
              <CreatorGridSkeleton />
            ) : creators.length === 0 ? (
              <EmptyState
                icon={Users}
                title="No creators found"
                description={`No creators match “${debounced.trim()}”. Creators are matched by username and name.`}
              />
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {creators.map((c) => (
                  <CreatorResultCard key={c.username} creator={c} />
                ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="pages">
            {pages === null ? (
              <PageListSkeleton />
            ) : pages.length === 0 ? (
              <EmptyState
                icon={BookOpen}
                title="No pages found"
                description={`No pages match “${debounced.trim()}”. Try different or broader terms.`}
              />
            ) : (
              <div className="flex flex-col gap-3">
                {pages.map((p) => (
                  <PageResultRow key={String(p.id)} article={p} />
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

function ResultCountBadge({ n, loading }: { n: number; loading: boolean }) {
  if (loading) return null;
  return (
    <span className="ml-2 rounded-full bg-muted px-1.5 text-[11px] font-semibold tabular-nums text-muted-foreground">
      {n}
    </span>
  );
}

function CreatorResultCard({ creator }: { creator: SimpleCreator }) {
  const name = creator.display_name || creator.username;
  return (
    <Link
      to={`/creator/${creator.username}`}
      aria-label={`View ${name}'s profile`}
      className="group flex w-full min-w-0 items-center gap-3 rounded-xl border border-border bg-card/60 p-4 transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Avatar className="h-12 w-12 shrink-0">
        {creator.image ? <AvatarImage src={creator.image} alt={name} /> : null}
        <AvatarFallback className="bg-primary/15 text-primary">
          {initials(name)}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-semibold group-hover:text-primary">
            {name}
          </span>
          {creator.is_verified ? (
            <BadgeCheck
              className="h-4 w-4 shrink-0 text-primary"
              aria-label="Verified"
            />
          ) : null}
          {/* Server-computed live flag on the creator list payload — renders
              only when the creator is actually broadcasting right now. Absent
              on older backends (`undefined`), so the badge just doesn't show. */}
          {creator.is_live ? (
            <span
              className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[#f43f5e]/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#f43f5e]"
              aria-label="Live now"
            >
              <Radio className="h-3 w-3" aria-hidden />
              Live
            </span>
          ) : null}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          @{creator.username}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          {typeof creator.zpages === "number" ? (
            <span className="tabular-nums">{creator.zpages} pages</span>
          ) : null}
          {creator.member_price ? (
            // "Membership": this is what it costs to SUBSCRIBE to this
            // creator, not the viewer's own spend — make that unmistakable
            // rather than showing a bare, ambiguous "200 2Z/mo".
            <Badge
              variant="sub"
              className="max-w-full tabular-nums"
              aria-label={`Membership price: ${formatTuzis(creator.member_price)} per month`}
            >
              Membership · {formatTuzis(creator.member_price)}/mo
            </Badge>
          ) : null}
        </div>
      </div>
    </Link>
  );
}

function PageResultRow({ article }: { article: Article }) {
  const author = article.author;
  const name = author.display_name || author.username;
  const body = article.subtitle || excerpt(article.content);
  return (
    <Link
      to={`/articles/${article.slug ?? article.id}`}
      aria-label={`Read “${article.title}”`}
      className="group flex w-full min-w-0 gap-4 rounded-xl border border-border bg-card/60 p-4 transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="hidden h-16 w-24 shrink-0 overflow-hidden rounded-lg bg-secondary sm:block">
        {article.image ? (
          <img
            src={article.image}
            alt=""
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="grid h-full w-full place-items-center text-muted-foreground">
            <FileText className="h-5 w-5" aria-hidden />
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <h3 className="min-w-0 truncate font-semibold leading-snug group-hover:text-primary">
            {article.title}
          </h3>
          {article.category ? (
            <Badge variant="secondary" className="max-w-[40%] shrink-0 truncate">
              {article.category}
            </Badge>
          ) : null}
        </div>
        {body ? (
          <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
            {body}
          </p>
        ) : null}
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span className="min-w-0 max-w-full truncate">by {name}</span>
          {article.published_at ? (
            <>
              <span aria-hidden>·</span>
              <span className="inline-flex shrink-0 items-center gap-1">
                <Clock className="h-3 w-3" aria-hidden />
                {timeAgo(article.published_at)}
              </span>
            </>
          ) : null}
        </div>
      </div>
    </Link>
  );
}

function CreatorGridSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-3 rounded-xl border border-border bg-card/40 p-4"
        >
          <Skeleton className="h-12 w-12 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-3 w-16" />
          </div>
        </div>
      ))}
    </div>
  );
}

function PageListSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      {Array.from({ length: 5 }).map((_, i) => (
        <div
          key={i}
          className="flex gap-4 rounded-xl border border-border bg-card/40 p-4"
        >
          <Skeleton className="hidden h-16 w-24 rounded-lg sm:block" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-24" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Debounce a rapidly-changing value. */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
