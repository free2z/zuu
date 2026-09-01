import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Loader2, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { articles } from "@/lib/api/free2z";
import { rankTopicSuggestions } from "@/lib/discovery-autocomplete";
import type { ArticleTagSuggestion } from "@/lib/api/types";
import { MAX_ARTICLE_TAGS } from "@/lib/article-tags";

interface TopicFilterAutocompleteProps {
  selected: string[];
  onChange: (topics: string[]) => void;
}

const DEBOUNCE_MS = 180;

export function TopicFilterAutocomplete({
  selected,
  onChange,
}: TopicFilterAutocompleteProps) {
  const listId = useId();
  const statusId = useId();
  const requestRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("");
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [error, setError] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [rawSuggestions, setRawSuggestions] = useState<ArticleTagSuggestion[]>(
    [],
  );
  const selectedKey = selected.join("\u0000");
  const locale =
    typeof navigator === "undefined" ? undefined : navigator.language;
  const suggestions = useMemo(
    () => rankTopicSuggestions(rawSuggestions, draft, selected, locale),
    // selectedKey intentionally tracks semantic selection without treating a
    // newly allocated equivalent array as a changed request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draft, locale, rawSuggestions, selectedKey],
  );
  const hasDraft = draft.trim().length > 0;
  const full = selected.length >= MAX_ARTICLE_TAGS;
  const open = focused && !dismissed && hasDraft && !full;

  useEffect(() => {
    const request = ++requestRef.current;
    setActiveIndex(-1);
    if (!focused || !hasDraft || full) {
      setLoading(false);
      setInitialized(false);
      setRawSuggestions([]);
      return;
    }

    setLoading(true);
    setInitialized(false);
    setError(false);
    const timer = window.setTimeout(() => {
      void articles
        .suggestTags(draft, selected)
        .then((next) => {
          if (requestRef.current !== request) return;
          setRawSuggestions(next);
          setInitialized(true);
        })
        .catch(() => {
          if (requestRef.current !== request) return;
          setRawSuggestions([]);
          setError(true);
          setInitialized(true);
        })
        .finally(() => {
          if (requestRef.current === request) setLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      requestRef.current += 1;
      window.clearTimeout(timer);
    };
    // selectedKey captures selected without firing for an equivalent array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, focused, full, hasDraft, retryNonce, selectedKey]);

  useEffect(() => {
    setActiveIndex((current) =>
      current >= suggestions.length ? suggestions.length - 1 : current,
    );
  }, [suggestions.length]);

  function addTopic(name: string) {
    if (full) return;
    onChange([...selected, name]);
    setDraft("");
    setDismissed(false);
    setRawSuggestions([]);
    inputRef.current?.focus();
  }

  function removeTopic(name: string) {
    onChange(selected.filter((topic) => topic !== name));
    inputRef.current?.focus();
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
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
      addTopic(suggestions[activeIndex].name);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setDismissed(true);
      setActiveIndex(-1);
    } else if (event.key === "Backspace" && !draft && selected.length > 0) {
      removeTopic(selected[selected.length - 1]);
    }
  }

  const status = loading
    ? "Loading topics"
    : error
      ? "Topics unavailable"
      : initialized && suggestions.length === 0
        ? "No topics"
        : suggestions.length > 0
          ? `${suggestions.length} topics`
          : "";

  return (
    <div className="mb-6 max-w-md" data-topic-filter-autocomplete>
      {selected.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-2" aria-label="Selected topics">
          {selected.map((topic) => (
            <button
              key={topic}
              type="button"
              onClick={() => removeTopic(topic)}
              aria-label={`Remove topic ${topic}`}
              className="min-tap inline-flex max-w-full items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 px-3 py-1 text-start text-xs font-medium text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="min-w-0 break-words">#{topic}</span>
              <X className="h-3.5 w-3.5 shrink-0" aria-hidden />
            </button>
          ))}
          <button
            type="button"
            onClick={() => onChange([])}
            className="min-tap inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Clear topics
          </button>
        </div>
      ) : null}

      <div
        className="relative"
        onFocus={() => setFocused(true)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            setFocused(false);
            setActiveIndex(-1);
          }
        }}
      >
        <Search
          className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setDismissed(false);
          }}
          onKeyDown={onKeyDown}
          placeholder={full ? "Maximum topics selected" : "Filter by topic"}
          aria-label="Filter by topic"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open && suggestions.length > 0}
          aria-controls={open && suggestions.length > 0 ? listId : undefined}
          aria-activedescendant={
            open && activeIndex >= 0 && activeIndex < suggestions.length
              ? `${listId}-${activeIndex}`
              : undefined
          }
          aria-describedby={statusId}
          autoComplete="off"
          disabled={full}
          className="ps-9 pe-10"
        />
        {loading ? (
          <Loader2
            className="pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground"
            aria-hidden
          />
        ) : null}

        {open && suggestions.length > 0 ? (
          <div
            id={listId}
            role="listbox"
            aria-label="Topic suggestions"
            className="absolute inset-x-0 top-full z-30 mt-1 overflow-hidden rounded-xl border border-border bg-card shadow-lg"
          >
            {suggestions.map((suggestion, index) => (
              <button
                id={`${listId}-${index}`}
                key={suggestion.name}
                type="button"
                role="option"
                aria-selected={activeIndex === index}
                onPointerDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => addTopic(suggestion.name)}
                className="flex min-h-11 w-full items-center justify-between gap-3 border-b border-border px-3 py-2 text-start last:border-b-0 hover:bg-secondary aria-selected:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <span className="min-w-0 break-words text-sm">
                  #{suggestion.name}
                </span>
                <span className="shrink-0 text-xs bidi-number tabular-nums text-muted-foreground">
                  {suggestion.count.toLocaleString(locale)}
                </span>
              </button>
            ))}
          </div>
        ) : open && error ? (
          <div className="absolute inset-x-0 top-full z-30 mt-1 flex min-h-11 items-center justify-between gap-3 rounded-xl border border-border bg-card px-3 py-2 shadow-lg">
            <span className="text-sm text-muted-foreground">
              Topics unavailable
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setRetryNonce((current) => current + 1)}
            >
              Try again
            </Button>
          </div>
        ) : open && !loading && initialized ? (
          <p className="absolute inset-x-0 top-full z-30 mt-1 rounded-xl border border-border bg-card px-3 py-3 text-sm text-muted-foreground shadow-lg">
            No topics
          </p>
        ) : null}
      </div>
      <span id={statusId} className="sr-only" aria-live="polite">
        {status}
      </span>
    </div>
  );
}
