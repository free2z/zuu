import { useCallback, useEffect, useRef, useState } from "react";
import { discover } from "@/lib/api/free2z";
import type { Article, SearchResultPage, SimpleCreator } from "@/lib/api/types";

export interface SearchSnapshot<T> {
  key: string;
  items: T[];
  next: number | null;
  count: number | null;
  initialized: boolean;
}

interface SearchState<T> extends SearchSnapshot<T> {
  error: unknown | null;
  loading: boolean;
}

export class SearchSnapshotCache<T> {
  private readonly snapshots = new Map<string, SearchSnapshot<T>>();

  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error("Search cache limit must be a positive integer.");
    }
  }

  restore(key: string): SearchSnapshot<T> | null {
    const snapshot = this.snapshots.get(key);
    if (!snapshot) return null;
    this.snapshots.delete(key);
    this.snapshots.set(key, snapshot);
    return snapshot;
  }

  remember(snapshot: SearchSnapshot<T>) {
    this.snapshots.delete(snapshot.key);
    this.snapshots.set(snapshot.key, snapshot);
    if (this.snapshots.size > this.limit) {
      this.snapshots.delete(this.snapshots.keys().next().value as string);
    }
  }
}

function emptySnapshot<T>(key: string): SearchSnapshot<T> {
  return {
    key,
    items: [],
    next: key ? 1 : null,
    count: key ? null : 0,
    initialized: !key,
  };
}

/** Append a validated page while preserving backend order and unique rows. */
export function mergeSearchPage<T>(
  current: SearchSnapshot<T>,
  response: SearchResultPage<T>,
  requestedPage: number,
  identity: (item: T) => string,
): SearchSnapshot<T> {
  if (requestedPage !== current.next) {
    throw new Error("Search received an unexpected page.");
  }
  if (response.next !== null && response.next !== requestedPage + 1) {
    throw new Error("Search returned an unexpected next page.");
  }

  const seen = new Set(current.items.map(identity));
  const items = [...current.items];
  for (const item of response.items) {
    const key = identity(item);
    if (!seen.has(key)) {
      seen.add(key);
      items.push(item);
    }
  }

  if (response.next !== null && items.length === current.items.length) {
    // Offset pagination over tied, mutable rows can return a page made wholly
    // of records already seen. The backend cursor still advanced, so retaining
    // it is the only way to reach later unique rows; retrying the old cursor
    // would loop forever.
    console.warn("Search page contained no new rows; advancing its cursor.", {
      requestedPage,
      next: response.next,
    });
  }

  // DRF recomputes count for every offset page, while rows can be published or
  // removed between clicks. Search ordering also contains ties, so deduped row
  // length cannot be required to equal that moving display hint. The cursor is
  // the traversal authority; retain strict cursor validation above
  // and surface count drift diagnostically without discarding valid rows.
  if (
    (current.count !== null && response.count !== current.count) ||
    items.length > response.count ||
    (response.next === null && items.length !== response.count) ||
    (response.next !== null && items.length >= response.count)
  ) {
    console.warn("Search result count changed during pagination.", {
      previousCount: current.count,
      responseCount: response.count,
      loadedCount: items.length,
      next: response.next,
    });
  }

  return {
    key: current.key,
    items,
    next: response.next,
    count: response.count,
    initialized: true,
  };
}

const creatorCache = new SearchSnapshotCache<SimpleCreator>(20);
const pageCache = new SearchSnapshotCache<Article>(20);

function usePaginatedSearch<T>(
  query: string,
  cache: SearchSnapshotCache<T>,
  loadPage: (query: string, page: number) => Promise<SearchResultPage<T>>,
  identity: (item: T) => string,
) {
  const initial = () => cache.restore(query) ?? emptySnapshot<T>(query);
  const [state, setState] = useState<SearchState<T>>(() => ({
    ...initial(),
    error: null,
    loading: false,
  }));
  const stateRef = useRef(state);
  const requestIdRef = useRef(0);
  stateRef.current = state;

  const load = useCallback(
    async (page: number, rebaselineCount = false) => {
      if (stateRef.current.loading || stateRef.current.key !== query) return;
      const requestId = ++requestIdRef.current;
      const loadingState = {
        ...stateRef.current,
        count: rebaselineCount ? null : stateRef.current.count,
        error: null,
        loading: true,
      };
      stateRef.current = loadingState;
      setState(loadingState);
      try {
        const response = await loadPage(query, page);
        if (requestIdRef.current !== requestId) return;
        const merged = mergeSearchPage(
          stateRef.current,
          response,
          page,
          identity,
        );
        const nextState = { ...merged, error: null, loading: false };
        stateRef.current = nextState;
        cache.remember(merged);
        setState(nextState);
      } catch (error) {
        if (requestIdRef.current !== requestId) return;
        const nextState = { ...stateRef.current, error, loading: false };
        stateRef.current = nextState;
        setState(nextState);
      }
    },
    [cache, identity, loadPage, query],
  );

  useEffect(() => {
    requestIdRef.current += 1;
    const snapshot = cache.restore(query) ?? emptySnapshot<T>(query);
    const nextState = { ...snapshot, error: null, loading: false };
    stateRef.current = nextState;
    setState(nextState);
    if (!snapshot.initialized && snapshot.next !== null) {
      void load(snapshot.next);
    }
    return () => {
      requestIdRef.current += 1;
    };
  }, [cache, load, query]);

  const loadMore = useCallback(() => {
    const next = stateRef.current.next;
    if (next !== null) void load(next);
  }, [load]);

  const retry = useCallback(() => {
    const next = stateRef.current.next;
    if (next !== null) void load(next, true);
  }, [load]);

  if (state.key !== query) {
    return {
      ...emptySnapshot<T>(query),
      error: null,
      loading: Boolean(query),
      loadMore,
      retry,
    };
  }
  return { ...state, loadMore, retry };
}

const loadCreatorPage = (query: string, page: number) =>
  discover.searchCreatorPage(query, page);
const loadPagePage = (query: string, page: number) =>
  discover.searchPagePage(query, page);
/** The immutable creator address, not a locale/case-folded display handle. */
export const creatorSearchIdentity = (creator: SimpleCreator) =>
  creator.free2zaddr;
const pageIdentity = (article: Article) => String(article.id);

export function useCreatorSearch(query: string) {
  return usePaginatedSearch(
    query,
    creatorCache,
    loadCreatorPage,
    creatorSearchIdentity,
  );
}

export function usePageSearch(query: string) {
  return usePaginatedSearch(query, pageCache, loadPagePage, pageIdentity);
}
