import type { Article, ArticleTagSuggestion, SimpleCreator } from "./api/types";
import { isArticleTagFilterable, sanitizeArticleTags } from "./article-tags";

export type DiscoverySuggestion =
  | {
      kind: "topic";
      key: string;
      label: string;
      count: number;
    }
  | {
      kind: "creator";
      key: string;
      label: string;
      detail: string;
      creator: SimpleCreator;
    }
  | {
      kind: "page";
      key: string;
      label: string;
      detail: string;
      article: Article;
    };

interface RankedSuggestion {
  suggestion: DiscoverySuggestion;
  match: number;
  sourceOrder: number;
}

/** A locale-aware comparison key for case, width, and accent variants. */
export function localeSearchKey(value: string, locale?: string): string {
  return value
    .toLocaleLowerCase(locale)
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function matchRank(value: string, query: string, locale?: string): number {
  const candidate = localeSearchKey(value, locale);
  const needle = localeSearchKey(query, locale);
  if (!needle) return 0;
  if (candidate === needle) return 0;
  if (candidate.startsWith(needle)) return 1;
  if (
    candidate.split(/[\s\p{P}\p{S}]+/u).some((word) => word.startsWith(needle))
  ) {
    return 2;
  }
  if (candidate.includes(needle)) return 3;
  return Number.POSITIVE_INFINITY;
}

function bestMatch(
  values: Array<string | null | undefined>,
  query: string,
  locale?: string,
) {
  return Math.min(
    ...values.filter(Boolean).map((value) => matchRank(value!, query, locale)),
  );
}

function collator(locale?: string) {
  return new Intl.Collator(locale, {
    sensitivity: "base",
    usage: "search",
    numeric: true,
  });
}

/**
 * Build a small, mixed discovery list from the already-requested result sets.
 * Backend order remains the relevance tiebreaker; local matching only promotes
 * direct textual matches and coalesces locale-equivalent labels.
 */
export function buildDiscoverySuggestions({
  query,
  creators,
  pages,
  selectedTopics = [],
  locale,
  limit = 8,
}: {
  query: string;
  creators: readonly SimpleCreator[];
  pages: readonly Article[];
  selectedTopics?: readonly string[];
  locale?: string;
  limit?: number;
}): DiscoverySuggestion[] {
  const needle = localeSearchKey(query, locale);
  if (!needle || limit < 1) return [];

  const selected = new Set(
    selectedTopics.map((topic) => localeSearchKey(topic, locale)),
  );
  const topicCounts = new Map<
    string,
    { label: string; count: number; sourceOrder: number }
  >();

  pages.forEach((page, pageIndex) => {
    for (const tag of sanitizeArticleTags(page.tags ?? [])) {
      // The feed API serializes selected topics as one comma-delimited value
      // and has no escaping. Stored legacy tags containing commas remain
      // displayable, but must never become selectable filters.
      if (!isArticleTagFilterable(tag)) continue;
      const key = localeSearchKey(tag, locale);
      if (!key || selected.has(key)) continue;
      const existing = topicCounts.get(key);
      if (existing) existing.count += 1;
      else
        topicCounts.set(key, { label: tag, count: 1, sourceOrder: pageIndex });
    }
  });

  const ranked: RankedSuggestion[] = [];
  for (const [key, topic] of topicCounts) {
    const match = matchRank(topic.label, query, locale);
    if (Number.isFinite(match)) {
      ranked.push({
        suggestion: {
          kind: "topic",
          key: `topic:${key}`,
          label: topic.label,
          count: topic.count,
        },
        match,
        sourceOrder: topic.sourceOrder,
      });
    }
  }

  const seenCreators = new Set<string>();
  creators.forEach((creator, sourceOrder) => {
    const displayName = creator.display_name || creator.username;
    const key = creator.free2zaddr;
    if (!key || seenCreators.has(key)) return;
    seenCreators.add(key);
    const match = bestMatch([displayName, creator.username], query, locale);
    // The server may return semantic/popularity matches whose visible text does
    // not contain the query. Keep them after direct local matches.
    ranked.push({
      suggestion: {
        kind: "creator",
        key: `creator:${key}`,
        label: displayName,
        detail: `@${creator.username}`,
        creator,
      },
      match: Number.isFinite(match) ? match : 10,
      sourceOrder,
    });
  });

  const seenPages = new Set<string>();
  pages.forEach((article, sourceOrder) => {
    const key = String(article.id);
    if (!key || seenPages.has(key)) return;
    seenPages.add(key);
    const author = article.author.display_name || article.author.username;
    const match = bestMatch(
      [
        article.title,
        article.subtitle,
        article.category,
        ...(article.tags ?? []),
      ],
      query,
      locale,
    );
    ranked.push({
      suggestion: {
        kind: "page",
        key: `page:${key}`,
        label: article.title,
        detail: author,
        article,
      },
      match: Number.isFinite(match) ? match : 10,
      sourceOrder,
    });
  });

  const kindOrder: Record<DiscoverySuggestion["kind"], number> = {
    topic: 0,
    creator: 1,
    page: 2,
  };
  const compare = collator(locale);
  const perKind = new Map<DiscoverySuggestion["kind"], number>();

  return ranked
    .sort(
      (a, b) =>
        a.match - b.match ||
        a.sourceOrder - b.sourceOrder ||
        kindOrder[a.suggestion.kind] - kindOrder[b.suggestion.kind] ||
        compare.compare(a.suggestion.label, b.suggestion.label),
    )
    .filter(({ suggestion }) => {
      const count = perKind.get(suggestion.kind) ?? 0;
      if (count >= 3) return false;
      perKind.set(suggestion.kind, count + 1);
      return true;
    })
    .slice(0, limit)
    .map(({ suggestion }) => suggestion);
}

/** Locale-aware ranking and dedupe for the standalone topic filter. */
export function rankTopicSuggestions(
  suggestions: readonly ArticleTagSuggestion[],
  query: string,
  selected: readonly string[],
  locale?: string,
  limit = 6,
): ArticleTagSuggestion[] {
  const selectedKeys = new Set(
    selected.map((tag) => localeSearchKey(tag, locale)),
  );
  const unique = new Map<string, ArticleTagSuggestion>();
  for (const suggestion of suggestions) {
    if (!isArticleTagFilterable(suggestion.name)) continue;
    const key = localeSearchKey(suggestion.name, locale);
    if (!key || selectedKeys.has(key)) continue;
    const previous = unique.get(key);
    if (!previous || suggestion.count > previous.count)
      unique.set(key, suggestion);
  }
  const compare = collator(locale);
  return [...unique.values()]
    .filter((suggestion) =>
      Number.isFinite(matchRank(suggestion.name, query, locale)),
    )
    .sort(
      (a, b) =>
        matchRank(a.name, query, locale) - matchRank(b.name, query, locale) ||
        b.count - a.count ||
        compare.compare(a.name, b.name),
    )
    .slice(0, Math.max(0, limit));
}
