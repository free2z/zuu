import { useCallback, useEffect, useRef, useState } from "react";
import { discover } from "@/lib/api/free2z";
import type { Article, CreatorPagesPage } from "@/lib/api/types";

export interface CreatorCatalogSnapshot {
  items: Article[];
  next: number | null;
  count: number;
  initialized: boolean;
}

interface CreatorCatalogState extends CreatorCatalogSnapshot {
  error: unknown | null;
  loading: boolean;
}

const catalogCache = new Map<string, CreatorCatalogSnapshot>();
const MAX_CACHED_CREATORS = 20;

function cacheKey(username: string): string {
  return username.toLowerCase();
}

function remember(username: string, snapshot: CreatorCatalogSnapshot) {
  const key = cacheKey(username);
  catalogCache.delete(key);
  catalogCache.set(key, snapshot);
  if (catalogCache.size > MAX_CACHED_CREATORS) {
    catalogCache.delete(catalogCache.keys().next().value as string);
  }
}

function initialCatalog(
  username: string,
  expectedCount: number,
): CreatorCatalogSnapshot {
  const cached = catalogCache.get(cacheKey(username));
  if (cached?.count === expectedCount) return cached;
  return {
    items: [],
    next: expectedCount === 0 ? null : 1,
    count: expectedCount,
    initialized: expectedCount === 0,
  };
}

/**
 * Append one API page without allowing count drift or duplicate cards.
 * A terminal cursor is accepted only when every authoritative row is present.
 */
export function mergeCreatorCatalogPage(
  current: CreatorCatalogSnapshot,
  response: CreatorPagesPage,
  requestedPage: number,
): CreatorCatalogSnapshot {
  if (response.count !== current.count) {
    throw new Error("Creator catalog count changed during the read.");
  }
  if (requestedPage !== current.next) {
    throw new Error("Creator catalog received an unexpected page.");
  }

  const seen = new Set(current.items.map((item) => String(item.id)));
  const items = [...current.items];
  for (const item of response.items) {
    const identity = String(item.id);
    if (!seen.has(identity)) {
      seen.add(identity);
      items.push(item);
    }
  }

  if (items.length > current.count) {
    throw new Error("Creator catalog exceeded its authoritative count.");
  }
  if (response.next === null && items.length !== current.count) {
    throw new Error("Creator pagination returned an incomplete catalog.");
  }
  if (response.next !== null && items.length >= current.count) {
    throw new Error(
      "Creator pagination continued past its authoritative count.",
    );
  }

  return {
    items,
    next: response.next,
    count: current.count,
    initialized: true,
  };
}

export function useCreatorCatalog(username: string, expectedCount: number) {
  const [state, setState] = useState<CreatorCatalogState>(() => ({
    ...initialCatalog(username, expectedCount),
    error: null,
    loading: false,
  }));
  const stateRef = useRef(state);
  const requestIdRef = useRef(0);
  const resourceRef = useRef(`${cacheKey(username)}:${expectedCount}`);
  stateRef.current = state;

  const load = useCallback(
    async (page: number) => {
      if (stateRef.current.loading) return;
      const requestId = ++requestIdRef.current;
      stateRef.current = { ...stateRef.current, error: null, loading: true };
      setState((current) => ({ ...current, error: null, loading: true }));
      try {
        const response = await discover.creatorPages(username, page);
        if (requestIdRef.current !== requestId) return;
        const merged = mergeCreatorCatalogPage(
          stateRef.current,
          response,
          page,
        );
        const nextState = { ...merged, error: null, loading: false };
        stateRef.current = nextState;
        remember(username, merged);
        setState(nextState);
      } catch (error) {
        if (requestIdRef.current !== requestId) return;
        const nextState = { ...stateRef.current, error, loading: false };
        stateRef.current = nextState;
        setState(nextState);
      }
    },
    [username],
  );

  useEffect(() => {
    const resource = `${cacheKey(username)}:${expectedCount}`;
    if (resourceRef.current !== resource) {
      resourceRef.current = resource;
      requestIdRef.current += 1;
      const initial = initialCatalog(username, expectedCount);
      setState({ ...initial, error: null, loading: false });
      stateRef.current = { ...initial, error: null, loading: false };
    }
    const current = stateRef.current;
    if (!current.initialized && current.next !== null && !current.loading) {
      void load(current.next);
    }
  }, [expectedCount, load, username]);

  const loadMore = useCallback(() => {
    const next = stateRef.current.next;
    if (next !== null) void load(next);
  }, [load]);

  const retry = useCallback(() => {
    const next = stateRef.current.next;
    if (next !== null) void load(next);
  }, [load]);

  return { ...state, loadMore, retry };
}
