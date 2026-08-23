import { useEffect, useId, useMemo, useState } from "react";
import { Loader2, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { articles } from "@/lib/api/free2z";
import type { ArticleTagSuggestion } from "@/lib/api/types";
import {
  MAX_ARTICLE_TAG_LENGTH,
  MAX_ARTICLE_TAGS,
  validateArticleTag,
} from "@/lib/article-tags";

interface ArticleTagInputProps {
  value: string[];
  onChange: (tags: string[]) => void;
  disabled?: boolean;
}

export function ArticleTagInput({
  value,
  onChange,
  disabled = false,
}: ArticleTagInputProps) {
  const listId = useId();
  const helpId = useId();
  const errorId = useId();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<ArticleTagSuggestion[]>([]);
  const valueKey = value.join("\u0000");
  const full = value.length >= MAX_ARTICLE_TAGS;

  useEffect(() => {
    if (!focused || disabled || full) {
      setLoading(false);
      setSuggestions([]);
      return;
    }

    let active = true;
    const timer = window.setTimeout(() => {
      setLoading(true);
      void articles
        .suggestTags(draft, value)
        .then((next) => {
          if (active) setSuggestions(next);
        })
        .catch(() => {
          // The API boundary is already fail-soft, but retain that property if
          // its implementation changes: authors can always enter a valid tag.
          if (active) setSuggestions([]);
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 150);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
    // `valueKey` deliberately captures the selected set without retriggering
    // for a new array containing the same tags.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled, draft, focused, full, valueKey]);

  const describedBy = useMemo(
    () => (error ? `${helpId} ${errorId}` : helpId),
    [error, errorId, helpId],
  );

  function addTag(raw: string) {
    if (full) {
      setError(`Articles can have at most ${MAX_ARTICLE_TAGS} tags.`);
      return;
    }
    const result = validateArticleTag(raw);
    if (!result.tag || result.error) {
      setError(result.error ?? "Enter a valid tag.");
      return;
    }
    if (value.includes(result.tag)) {
      setError("That tag is already added.");
      return;
    }
    onChange([...value, result.tag]);
    setDraft("");
    setError(null);
    setSuggestions([]);
  }

  function removeTag(tag: string) {
    onChange(value.filter((candidate) => candidate !== tag));
    setError(null);
  }

  const showSuggestions =
    focused && !disabled && !full && suggestions.length > 0;

  return (
    <div
      className="space-y-2"
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setFocused(false);
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="art-tags">Tags</Label>
        <span className="text-xs tabular-nums text-muted-foreground">
          {value.length}/{MAX_ARTICLE_TAGS}
        </span>
      </div>

      {value.length > 0 ? (
        <div
          className="flex flex-wrap gap-2"
          aria-label="Selected article tags"
        >
          {value.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => removeTag(tag)}
              aria-label={`Remove tag ${tag}`}
              disabled={disabled}
              className="min-tap inline-flex max-w-full items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 px-3 py-1 text-left text-xs font-medium text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            >
              <span className="min-w-0 break-words">#{tag}</span>
              <X className="h-3.5 w-3.5 shrink-0" aria-hidden />
            </button>
          ))}
        </div>
      ) : null}

      <div className="relative">
        <Input
          id="art-tags"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === ",") {
              event.preventDefault();
              addTag(draft);
            } else if (
              event.key === "Backspace" &&
              !draft &&
              value.length > 0
            ) {
              removeTag(value[value.length - 1]);
            } else if (event.key === "Escape") {
              setFocused(false);
              event.currentTarget.blur();
            }
          }}
          placeholder={full ? "Maximum tags added" : "Add a topic"}
          autoComplete="off"
          maxLength={MAX_ARTICLE_TAG_LENGTH * 3}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={showSuggestions}
          aria-controls={showSuggestions ? listId : undefined}
          aria-describedby={describedBy}
          aria-invalid={Boolean(error)}
          disabled={disabled || full}
          className="pr-10"
        />
        {loading ? (
          <Loader2
            className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground"
            aria-label="Loading tag suggestions"
          />
        ) : null}
      </div>

      {showSuggestions ? (
        <div
          id={listId}
          role="listbox"
          aria-label="Existing article tags"
          className="overflow-hidden rounded-xl border border-border bg-card shadow-lg"
        >
          {suggestions.map((suggestion) => (
            <button
              key={suggestion.name}
              type="button"
              role="option"
              aria-selected="false"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => addTag(suggestion.name)}
              className="flex min-h-11 w-full items-center justify-between gap-3 border-b border-border px-3 py-2 text-left last:border-b-0 hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <span className="min-w-0 break-words text-sm">
                #{suggestion.name}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {suggestion.count.toLocaleString()}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      <p id={helpId} className="text-xs text-muted-foreground">
        Up to {MAX_ARTICLE_TAGS} topics. Press Enter or comma to add; names such
        as C++ and zero knowledge are welcome.
      </p>
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
