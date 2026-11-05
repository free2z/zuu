// Infinite-scroll driver for the Articles feed. Self-contained to the feature
// (imports only the api contract). Resets to page 1 whenever the sort, tags or
// search change, and appends de-duplicated pages via `loadMore`, guarding
// against duplicate/racey loads so a fast scroll can't double-fetch a page.

import { useCallback, useEffect, useRef, useState } from "react";
import { articles } from "@/lib/api/free2z";
import type { Article, ArticleSort } from "@/lib/api/types";
import { useModeration } from "@/store/moderation";
import { getTokenSnapshot } from "@/lib/api/http";

export interface UseArticleFeedArgs {
  sort: ArticleSort;
  tags: string[];
  search: string;
  pageSize?: number;
}

export interface ArticleFeedState {
  items: Article[];
  count: number;
  loading: boolean; // initial page for the current filters
  loadingMore: boolean; // a subsequent page is in flight
  error: boolean;
  hasMore: boolean;
  loadMore: () => void;
  reload: () => void;
}

export function useArticleFeed({
  sort,
  tags,
  search,
  pageSize = 24,
}: UseArticleFeedArgs): ArticleFeedState {
  const [items, setItems] = useState<Article[]>([]);
  const [count, setCount] = useState(0);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const owner = useModeration(s => s.owner);
  const ownerKey = owner ? `${owner.username}:${owner.token.generation}` : "anonymous";
  const isCurrentOwner = () => {
    const current = useModeration.getState().owner;
    return (current ? `${current.username}:${current.token.generation}` : "anonymous") === ownerKey;
  };
  const loadedOwner = useRef(ownerKey);
  useEffect(() => {
    const refresh = () => setReloadNonce(n => n + 1);
    window.addEventListener("free2z-moderation-refresh", refresh);
    return () => window.removeEventListener("free2z-moderation-refresh", refresh);
  }, []);

  // Monotonic generation id: bumped on every filter change so results from a
  // superseded query are dropped. `busy` blocks overlapping fetches.
  const genRef = useRef(0);
  const busyRef = useRef(false);
  const tagsKey = tags.join(",");

  // Reset + load the first page whenever the filters (or a manual reload) change.
  useEffect(() => {
    const gen = ++genRef.current;
    loadedOwner.current = ownerKey;
    if (getTokenSnapshot().token && !owner) {
      setItems([]);
      setLoading(true);
      return () => { genRef.current += 1; };
    }
    busyRef.current = true;
    setLoading(true);
    setError(false);
    setItems([]);
    setPage(1);
    setHasMore(true);

    articles
      .feed({ sort, tags, search, page: 1, pageSize })
      .then((res) => {
        if (genRef.current !== gen || !isCurrentOwner()) return;
        setItems(res.items);
        setCount(res.count);
        setHasMore(res.next !== null);
        setLoading(false);
        busyRef.current = false;
      })
      .catch(() => {
        if (genRef.current !== gen || !isCurrentOwner()) return;
        setError(true);
        setHasMore(false);
        setLoading(false);
        busyRef.current = false;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { genRef.current += 1; };
  }, [sort, tagsKey, search, pageSize, reloadNonce, ownerKey]);

  const loadMore = useCallback(() => {
    if (busyRef.current || !hasMore) return;
    const gen = genRef.current;
    const nextPage = page + 1;
    busyRef.current = true;
    setLoadingMore(true);

    articles
      .feed({ sort, tags, search, page: nextPage, pageSize })
      .then((res) => {
        if (genRef.current !== gen || !isCurrentOwner()) return; // filters or session changed
        setItems((prev) => {
          const seen = new Set(prev.map((a) => String(a.id)));
          return [...prev, ...res.items.filter((a) => !seen.has(String(a.id)))];
        });
        setPage(nextPage);
        setHasMore(res.next !== null);
        setLoadingMore(false);
        busyRef.current = false;
      })
      .catch(() => {
        if (genRef.current !== gen || !isCurrentOwner()) return;
        setLoadingMore(false);
        busyRef.current = false;
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMore, page, sort, tagsKey, search, pageSize, ownerKey]);

  const reload = useCallback(() => setReloadNonce((n) => n + 1), []);

  return {
    items: loadedOwner.current === ownerKey && !(getTokenSnapshot().token && !owner) ? items : [],
    count: loadedOwner.current === ownerKey && !(getTokenSnapshot().token && !owner) ? count : 0,
    loading,
    loadingMore,
    error,
    hasMore,
    loadMore,
    reload,
  };
}
