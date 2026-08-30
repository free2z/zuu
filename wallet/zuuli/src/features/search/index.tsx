import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  BadgeCheck,
  BookOpen,
  Clock,
  FileText,
  Hash,
  Loader2,
  Radio,
  Search as SearchIcon,
  Users,
  X,
} from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/common/EmptyState";
import { PageHeader } from "@/components/common/PageHeader";
import { SectionLoadError } from "@/components/common/SectionLoadError";
import { RemoteMedia } from "@/components/common/RemoteMedia";
import { formatTuzis, initials, timeAgo } from "@/lib/format";
import type { Article, SimpleCreator } from "@/lib/api/types";
import {
  buildDiscoverySuggestions,
  type DiscoverySuggestion,
} from "@/lib/discovery-autocomplete";
import { MAX_ARTICLE_TAGS, sanitizeArticleTags } from "@/lib/article-tags";
import { SEARCH_INPUT_LABEL, withSearchQuery } from "@/lib/search-route";
import { MESSAGE_KEYS } from "@/i18n/messages";
import { useCreatorSearch, usePageSearch } from "./pagination";

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
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const query = params.get("q") ?? "";
  const debounced = useDebounced(query, DEBOUNCE_MS);
  const inputRef = useRef<HTMLInputElement>(null);
  const autocompleteRef = useRef<HTMLDivElement>(null);
  const pointerInteractionRef = useRef(false);
  const pointerReleaseTimerRef = useRef<number | null>(null);
  const listId = useId();
  const statusId = useId();
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const selectedTopics = useMemo(
    () =>
      sanitizeArticleTags(params.getAll("topic")).slice(0, MAX_ARTICLE_TAGS),
    [params],
  );
  const debouncedInput = debounced.trim();
  const inputSettled = query.trim() === debouncedInput;
  const searchKey = [debouncedInput, ...selectedTopics]
    .filter(Boolean)
    .join(" ");
  const creators = useCreatorSearch(searchKey);
  const pages = usePageSearch(searchKey);
  const locale =
    typeof navigator === "undefined" ? undefined : navigator.language;
  const suggestions = useMemo(() => {
    if (!inputSettled) return [];
    const next = buildDiscoverySuggestions({
      query,
      creators: creators.items,
      pages: pages.items,
      selectedTopics,
      locale,
    });
    return selectedTopics.length >= MAX_ARTICLE_TAGS
      ? next.filter((suggestion) => suggestion.kind !== "topic")
      : next;
  }, [
    creators.items,
    inputSettled,
    locale,
    pages.items,
    query,
    selectedTopics,
  ]);

  // Focus the box on mount for a keyboard-first feel.
  useEffect(() => {
    inputRef.current?.focus();
    const finishReleasedPointer = (event: PointerEvent) => {
      if (!pointerInteractionRef.current) return;
      if (pointerReleaseTimerRef.current !== null) {
        window.clearTimeout(pointerReleaseTimerRef.current);
      }
      const target = event.target;
      pointerReleaseTimerRef.current = window.setTimeout(() => {
        pointerReleaseTimerRef.current = null;
        if (!pointerInteractionRef.current) return;
        pointerInteractionRef.current = false;
        if (
          target instanceof Node &&
          autocompleteRef.current?.contains(target)
        ) {
          return;
        }
        setFocused(false);
        setActiveIndex(-1);
      }, 0);
    };
    const cancelPointer = () => {
      if (!pointerInteractionRef.current) return;
      pointerInteractionRef.current = false;
      if (pointerReleaseTimerRef.current !== null) {
        window.clearTimeout(pointerReleaseTimerRef.current);
        pointerReleaseTimerRef.current = null;
      }
      setFocused(false);
      setActiveIndex(-1);
    };
    window.addEventListener("pointerup", finishReleasedPointer);
    window.addEventListener("pointercancel", cancelPointer);
    return () => {
      window.removeEventListener("pointerup", finishReleasedPointer);
      window.removeEventListener("pointercancel", cancelPointer);
      if (pointerReleaseTimerRef.current !== null) {
        window.clearTimeout(pointerReleaseTimerRef.current);
      }
    };
  }, []);

  // The route, not the debounce timer, owns visible empty-vs-results state.
  // Clearing `?q=` must clear the screen in the same render.
  const hasQuery = query.trim().length > 0 || selectedTopics.length > 0;
  const loadingSuggestions =
    !inputSettled ||
    creators.loading ||
    pages.loading ||
    (!creators.initialized && !creators.error) ||
    (!pages.initialized && !pages.error);
  const suggestionsInitialized =
    inputSettled &&
    (creators.initialized || Boolean(creators.error)) &&
    (pages.initialized || Boolean(pages.error));
  const suggestionError = Boolean(
    (creators.error || pages.error) && suggestions.length === 0,
  );
  const popupOpen =
    focused &&
    !dismissed &&
    query.trim().length > 0 &&
    (loadingSuggestions ||
      suggestionsInitialized ||
      suggestionError ||
      suggestions.length > 0);
  const creatorCount = creators.count ?? 0;
  const pageCount = pages.count ?? 0;

  const selectedTab = useMemo(() => {
    const requested = params.get("tab");
    if (requested === "creators" || requested === "pages") return requested;
    return creators.initialized &&
      pages.initialized &&
      creatorCount === 0 &&
      pageCount > 0
      ? "pages"
      : "creators";
  }, [
    creatorCount,
    creators.initialized,
    pageCount,
    pages.initialized,
    params,
  ]);

  useEffect(() => {
    setActiveIndex(-1);
  }, [query, searchKey]);

  useEffect(() => {
    setActiveIndex((current) =>
      current >= suggestions.length ? suggestions.length - 1 : current,
    );
  }, [suggestions.length]);

  function updateTopics(topics: string[]) {
    setParams(
      (current) => {
        return withSelectedTopics(current, topics);
      },
      { replace: true },
    );
  }

  function withSelectedTopics(current: URLSearchParams, topics: string[]) {
    const next = new URLSearchParams(current);
    next.delete("topic");
    for (const topic of sanitizeArticleTags(topics).slice(
      0,
      MAX_ARTICLE_TAGS,
    )) {
      next.append("topic", topic);
    }
    return next;
  }

  function chooseSuggestion(suggestion: DiscoverySuggestion) {
    if (suggestion.kind === "topic") {
      setParams(
        (current) => {
          return withSelectedTopics(withSearchQuery(current, ""), [
            ...selectedTopics,
            suggestion.label,
          ]);
        },
        { replace: true },
      );
      setDismissed(false);
      inputRef.current?.focus();
      return;
    }
    if (suggestion.kind === "creator") {
      navigate(`/creator/${suggestion.creator.username}`);
      return;
    }
    navigate(`/articles/${suggestion.article.slug ?? suggestion.article.id}`);
  }

  function onSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setDismissed(false);
      setActiveIndex((current) =>
        suggestions.length === 0
          ? -1
          : Math.min(current + 1, suggestions.length - 1),
      );
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setDismissed(false);
      setActiveIndex((current) =>
        suggestions.length === 0
          ? -1
          : current <= 0
            ? suggestions.length - 1
            : current - 1,
      );
    } else if (
      event.key === "Enter" &&
      activeIndex >= 0 &&
      activeIndex < suggestions.length
    ) {
      event.preventDefault();
      chooseSuggestion(suggestions[activeIndex]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setDismissed(true);
      setActiveIndex(-1);
    }
  }

  function dismissAutocomplete() {
    setFocused(false);
    setActiveIndex(-1);
  }

  function finishPointerInteraction(target: EventTarget | null) {
    pointerInteractionRef.current = false;
    if (pointerReleaseTimerRef.current !== null) {
      window.clearTimeout(pointerReleaseTimerRef.current);
      pointerReleaseTimerRef.current = null;
    }
    if (target instanceof Node && autocompleteRef.current?.contains(target)) {
      return;
    }
    dismissAutocomplete();
  }

  return (
    <div
      className="animate-slide-up"
      onPointerDownCapture={() => {
        pointerInteractionRef.current = true;
        if (pointerReleaseTimerRef.current !== null) {
          window.clearTimeout(pointerReleaseTimerRef.current);
          pointerReleaseTimerRef.current = null;
        }
      }}
      onClickCapture={(event) => {
        finishPointerInteraction(event.target);
      }}
    >
      <PageHeader title={t(MESSAGE_KEYS.navSearchAction)} />

      <div className="mb-6 max-w-2xl">
        {selectedTopics.length > 0 ? (
          <div
            className="mb-2 flex flex-wrap gap-2"
            aria-label="Selected topics"
          >
            {selectedTopics.map((topic) => (
              <button
                key={topic}
                type="button"
                onClick={() =>
                  updateTopics(
                    selectedTopics.filter((candidate) => candidate !== topic),
                  )
                }
                aria-label={`Remove topic ${topic}`}
                className="min-tap inline-flex max-w-full items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 px-3 py-1 text-left text-xs font-medium text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="min-w-0 break-words">#{topic}</span>
                <X className="h-3.5 w-3.5 shrink-0" aria-hidden />
              </button>
            ))}
          </div>
        ) : null}

        <div
          ref={autocompleteRef}
          className="relative"
          onFocus={() => setFocused(true)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) {
              // A pointer click elsewhere in Search must finish against a
              // stable target before this in-flow panel is removed. Otherwise
              // blur shifts cards and tabs between pointer-down and click.
              if (!pointerInteractionRef.current) dismissAutocomplete();
            }
          }}
        >
          <SearchIcon
            className="pointer-events-none absolute left-3.5 top-6 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            ref={inputRef}
            type="text"
            role="combobox"
            inputMode="search"
            enterKeyHint="search"
            value={query}
            onChange={(event) => {
              setDismissed(false);
              setParams(
                (current) => withSearchQuery(current, event.target.value),
                { replace: true },
              );
            }}
            onKeyDown={onSearchKeyDown}
            placeholder="Search"
            aria-label={SEARCH_INPUT_LABEL}
            aria-autocomplete="list"
            aria-expanded={popupOpen && suggestions.length > 0}
            aria-controls={
              popupOpen && suggestions.length > 0 ? listId : undefined
            }
            aria-activedescendant={
              popupOpen && activeIndex >= 0 && activeIndex < suggestions.length
                ? `${listId}-${activeIndex}`
                : undefined
            }
            aria-describedby={statusId}
            autoComplete="off"
            data-custom-search-clear
            className="h-12 pl-10 pr-14 text-base"
          />
          {query ? (
            <button
              type="button"
              onClick={() => {
                setParams((current) => withSearchQuery(current, ""), {
                  replace: true,
                });
                setDismissed(false);
                inputRef.current?.focus();
              }}
              aria-label={t(MESSAGE_KEYS.searchClear)}
              className="min-tap absolute right-1.5 top-6 grid h-12 w-12 min-h-12 min-w-12 -translate-y-1/2 place-items-center rounded-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          ) : null}

          {popupOpen ? (
            suggestions.length > 0 ? (
              <div
                id={listId}
                role="listbox"
                aria-label="Search suggestions"
                className="mt-1 overflow-hidden rounded-xl border border-border bg-card shadow-lg"
              >
                {suggestions.map((suggestion, index) => (
                  <button
                    id={`${listId}-${index}`}
                    key={suggestion.key}
                    type="button"
                    role="option"
                    data-suggestion-kind={suggestion.kind}
                    aria-selected={activeIndex === index}
                    onPointerDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => chooseSuggestion(suggestion)}
                    className="flex min-h-11 w-full items-center gap-3 border-b border-border px-3 py-2 text-left last:border-b-0 hover:bg-secondary aria-selected:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    {suggestion.kind === "topic" ? (
                      <Hash
                        className="h-4 w-4 shrink-0 text-muted-foreground"
                        aria-hidden
                      />
                    ) : suggestion.kind === "creator" ? (
                      <Users
                        className="h-4 w-4 shrink-0 text-muted-foreground"
                        aria-hidden
                      />
                    ) : (
                      <FileText
                        className="h-4 w-4 shrink-0 text-muted-foreground"
                        aria-hidden
                      />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block break-words text-sm font-medium">
                        {suggestion.kind === "topic" ? "#" : ""}
                        {suggestion.label}
                      </span>
                      <span className="block break-words text-xs text-muted-foreground">
                        {suggestion.kind === "topic"
                          ? "Topic"
                          : suggestion.kind === "creator"
                            ? suggestion.detail
                            : `Page · ${suggestion.detail}`}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            ) : suggestionError ? (
              <div className="mt-1 flex min-h-11 items-center justify-between gap-3 rounded-xl border border-border bg-card px-3 py-2 shadow-lg">
                <span className="text-sm text-muted-foreground">
                  Search unavailable
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    creators.retry();
                    pages.retry();
                  }}
                >
                  Try again
                </Button>
              </div>
            ) : suggestionsInitialized && !loadingSuggestions ? (
              <p className="mt-1 rounded-xl border border-border bg-card px-3 py-3 text-sm text-muted-foreground shadow-lg">
                No matches
              </p>
            ) : (
              <p className="mt-1 flex min-h-11 items-center gap-2 rounded-xl border border-border bg-card px-3 py-3 text-sm text-muted-foreground shadow-lg">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                Searching
              </p>
            )
          ) : null}
          <span id={statusId} className="sr-only" aria-live="polite">
            {loadingSuggestions && query.trim()
              ? "Searching"
              : suggestionError
                ? "Search unavailable"
                : suggestionsInitialized && query.trim()
                  ? `${suggestions.length} suggestions`
                  : ""}
          </span>
        </div>
      </div>

      {!hasQuery ? (
        <p className="text-sm text-muted-foreground">
          {t(MESSAGE_KEYS.searchAll)}
        </p>
      ) : !inputSettled ? null : (
        <Tabs
          value={selectedTab}
          onValueChange={(tab) => {
            setDismissed(true);
            setActiveIndex(-1);
            setParams(
              (current) => {
                const next = new URLSearchParams(current);
                next.set("tab", tab);
                return next;
              },
              { replace: true },
            );
          }}
        >
          <TabsList>
            <TabsTrigger value="creators">
              <Users className="mr-1.5 h-4 w-4" aria-hidden />
              Creators
              <ResultCountBadge
                n={creatorCount}
                loading={creators.loading && creators.count === null}
                available={creators.count !== null}
              />
            </TabsTrigger>
            <TabsTrigger value="pages">
              <FileText className="mr-1.5 h-4 w-4" aria-hidden />
              Pages
              <ResultCountBadge
                n={pageCount}
                loading={pages.loading && pages.count === null}
                available={pages.count !== null}
              />
            </TabsTrigger>
          </TabsList>

          <TabsContent value="creators">
            {creators.error ? (
              <SectionLoadError
                className="mb-4"
                title={
                  creators.items.length === 0
                    ? "Creator search is unavailable"
                    : "Couldn't load more creator results"
                }
                description={
                  creators.items.length === 0
                    ? "Pages may still be available in the other tab."
                    : "Showing the last creator results loaded on this device."
                }
                retry={creators.retry}
                retrying={creators.loading}
                stale={creators.items.length > 0}
              />
            ) : null}
            {creators.loading && !creators.initialized ? (
              <CreatorGridSkeleton />
            ) : creators.error &&
              creators.items.length === 0 ? null : creators.initialized &&
              creatorCount === 0 ? (
              <EmptyState
                icon={Users}
                title="No creators found"
                description={`No creators match “${searchKey}”.`}
              />
            ) : creators.items.length > 0 ? (
              <>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {creators.items.map((c) => (
                    <CreatorResultCard key={c.username} creator={c} />
                  ))}
                </div>
                <SearchLoadMore
                  corpus="creators"
                  loaded={creators.items.length}
                  total={creatorCount}
                  next={creators.next}
                  loading={creators.loading}
                  blocked={Boolean(creators.error)}
                  loadMore={creators.loadMore}
                />
              </>
            ) : null}
          </TabsContent>

          <TabsContent value="pages">
            {pages.error ? (
              <SectionLoadError
                className="mb-4"
                title={
                  pages.items.length === 0
                    ? "Page search is unavailable"
                    : "Couldn't load more page results"
                }
                description={
                  pages.items.length === 0
                    ? "Creators may still be available in the other tab."
                    : "Showing the last page results loaded on this device."
                }
                retry={pages.retry}
                retrying={pages.loading}
                stale={pages.items.length > 0}
              />
            ) : null}
            {pages.loading && !pages.initialized ? (
              <PageListSkeleton />
            ) : pages.error &&
              pages.items.length === 0 ? null : pages.initialized &&
              pageCount === 0 ? (
              <EmptyState
                icon={BookOpen}
                title="No pages found"
                description={`No pages match “${searchKey}”. Try different or broader terms.`}
              />
            ) : pages.items.length > 0 ? (
              <>
                <div className="flex flex-col gap-3">
                  {pages.items.map((p) => (
                    <PageResultRow key={String(p.id)} article={p} />
                  ))}
                </div>
                <SearchLoadMore
                  corpus="pages"
                  loaded={pages.items.length}
                  total={pageCount}
                  next={pages.next}
                  loading={pages.loading}
                  blocked={Boolean(pages.error)}
                  loadMore={pages.loadMore}
                />
              </>
            ) : null}
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

function ResultCountBadge({
  n,
  loading,
  available,
}: {
  n: number;
  loading: boolean;
  available: boolean;
}) {
  if (loading || !available) return null;
  return (
    <span className="ml-2 rounded-full bg-muted px-1.5 text-xs font-semibold tabular-nums text-muted-foreground">
      {n}
    </span>
  );
}

function SearchLoadMore({
  corpus,
  loaded,
  total,
  next,
  loading,
  blocked,
  loadMore,
}: {
  corpus: "creators" | "pages";
  loaded: number;
  total: number;
  next: number | null;
  loading: boolean;
  blocked: boolean;
  loadMore: () => void;
}) {
  return (
    <div className="mt-5 flex flex-col items-center gap-2">
      <span
        className="text-sm tabular-nums text-muted-foreground"
        aria-live="polite"
      >
        {loaded} of {total} {corpus}
      </span>
      {next !== null && !blocked ? (
        <Button
          type="button"
          variant="outline"
          onClick={loadMore}
          disabled={loading}
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : null}
          {loading ? `Loading ${corpus}` : `Load more ${corpus}`}
        </Button>
      ) : null}
    </div>
  );
}

function CreatorResultCard({ creator }: { creator: SimpleCreator }) {
  const name = creator.display_name || creator.username;
  return (
    <Link
      to={`/creator/${creator.username}`}
      aria-label={`View ${name}'s profile`}
      data-search-creator-result
      className="group flex w-full min-w-0 items-center gap-3 rounded-xl border border-border bg-card/60 p-4 transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Avatar className="h-12 w-12 shrink-0">
        {creator.image ? <AvatarImage src={creator.image} alt={name} /> : null}
        <AvatarFallback className="bg-secondary text-muted-foreground">
          {initials(name)}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 break-words font-semibold group-hover:text-primary">
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
              className="inline-flex shrink-0 items-center gap-1 rounded-full bg-live/10 px-1.5 py-0.5 eyebrow text-live"
              aria-label="Live now"
            >
              <Radio className="h-3 w-3" aria-hidden />
              Live
            </span>
          ) : null}
        </div>
        <div className="break-words text-xs text-muted-foreground">
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
    <div
      className="group flex w-full min-w-0 gap-4 rounded-xl border border-border bg-card/60 p-4 transition-colors hover:border-primary/40"
      data-search-page-result
    >
      <div className="hidden h-28 w-32 shrink-0 overflow-hidden rounded-lg bg-secondary sm:block">
        {article.image ? (
          <RemoteMedia
            source={article.image}
            kind="image"
            className="h-full min-h-0 rounded-none border-0 px-2 py-1"
          >
            {({ url }) => (
              <Link
                to={`/articles/${article.slug ?? article.id}`}
                aria-label={`Read “${article.title}”`}
                className="block h-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <img
                  src={url}
                  alt=""
                  referrerPolicy="no-referrer"
                  className="h-full w-full object-cover"
                />
              </Link>
            )}
          </RemoteMedia>
        ) : (
          <div className="grid h-full w-full place-items-center text-muted-foreground">
            <FileText className="h-5 w-5" aria-hidden />
          </div>
        )}
      </div>
      <Link
        to={`/articles/${article.slug ?? article.id}`}
        aria-label={`Read “${article.title}”`}
        className="min-w-0 flex-1 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="flex items-start justify-between gap-3">
          <h3
            className="min-w-0 flex-1 line-clamp-2 font-semibold leading-snug group-hover:text-primary"
            data-user-content
          >
            {article.title}
          </h3>
          {/* Category is UI copy from a small controlled vocabulary, so it
              keeps its own words intact and the title — user-authored, and
              already clamped — absorbs the width instead. */}
          {article.category ? (
            <Badge variant="secondary" className="shrink-0 whitespace-nowrap">
              {article.category}
            </Badge>
          ) : null}
        </div>
        {body ? (
          <p
            className="mt-1 line-clamp-2 text-sm text-muted-foreground"
            data-user-content
          >
            {body}
          </p>
        ) : null}
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span className="min-w-0 max-w-full break-words">by {name}</span>
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
      </Link>
    </div>
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
