import { useCallback, useEffect, useRef, useState } from "react";
import { discover } from "@/lib/api/free2z";
import type { Article, CreatorPagesPage } from "@/lib/api/types";
import { useModeration } from "@/store/moderation";
import { getTokenSnapshot } from "@/lib/api/http";

export interface CreatorCatalogSnapshot {
  items: Article[];
  next: number | null;
  /** Authoritative list count, unknown until page 1 succeeds. */
  count: number | null;
  initialized: boolean;
}

interface CreatorCatalogState extends CreatorCatalogSnapshot {
  error: unknown | null;
  loading: boolean;
}

const catalogCache = new Map<string, CreatorCatalogSnapshot>();
const MAX_CACHED_CREATORS = 20;

function cacheKey(username: string, ownerKey = "anonymous"): string {
  return `${ownerKey}:${username.toLowerCase()}`;
}

function remember(username: string, snapshot: CreatorCatalogSnapshot, ownerKey: string) {
  const key = cacheKey(username, ownerKey);
  catalogCache.delete(key);
  catalogCache.set(key, snapshot);
  if (catalogCache.size > MAX_CACHED_CREATORS) {
    catalogCache.delete(catalogCache.keys().next().value as string);
  }
}

function initialCatalog(username: string, ownerKey = "anonymous"): CreatorCatalogSnapshot {
  const cached = catalogCache.get(cacheKey(username, ownerKey));
  if (cached) return cached;
  return {
    items: [],
    next: 1,
    count: null,
    initialized: false,
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
  if (current.count !== null && response.count !== current.count) {
    throw new Error("Creator catalog count changed during the read.");
  }
  if (requestedPage !== current.next) {
    throw new Error("Creator catalog received an unexpected page.");
  }
  const count = current.count ?? response.count;

  const seen = new Set(current.items.map((item) => String(item.id)));
  const items = [...current.items];
  for (const item of response.items) {
    const identity = String(item.id);
    if (!seen.has(identity)) {
      seen.add(identity);
      items.push(item);
    }
  }

  if (items.length > count) {
    throw new Error("Creator catalog exceeded its authoritative count.");
  }
  if (response.next === null && items.length !== count) {
    throw new Error("Creator pagination returned an incomplete catalog.");
  }
  if (response.next !== null && items.length === current.items.length) {
    throw new Error("Creator pagination made no progress.");
  }
  if (response.next !== null && items.length >= count) {
    throw new Error(
      "Creator pagination continued past its authoritative count.",
    );
  }

  return {
    items,
    next: response.next,
    count,
    initialized: true,
  };
}

export function useCreatorCatalog(username: string) {
  const owner = useModeration(s => s.owner);
  const ownerKey = owner ? `${owner.username}:${owner.token.generation}` : "anonymous";
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const reload = () => {
      catalogCache.delete(cacheKey(username, ownerKey));
      setRefresh(value => value + 1);
    };
    window.addEventListener("free2z-moderation-refresh", reload);
    return () => window.removeEventListener("free2z-moderation-refresh", reload);
  }, [username, ownerKey]);
  const [state, setState] = useState<CreatorCatalogState>(() => ({
    ...initialCatalog(username, ownerKey),
    error: null,
    loading: false,
  }));
  const stateRef = useRef(state);
  const requestIdRef = useRef(0);
  const resourceRef = useRef(`${cacheKey(username, ownerKey)}:${refresh}`);
  stateRef.current = state;

  const load = useCallback(
    async (page: number) => {
      if (stateRef.current.loading) return;
      const requestId = ++requestIdRef.current;
      const sameOwner = () => {
        const owner = useModeration.getState().owner;
        return (owner ? `${owner.username}:${owner.token.generation}` : "anonymous") === ownerKey;
      };
      stateRef.current = { ...stateRef.current, error: null, loading: true };
      setState((current) => ({ ...current, error: null, loading: true }));
      try {
        const response = await discover.creatorPages(username, page);
        if (requestIdRef.current !== requestId || !sameOwner()) return;
        const merged = mergeCreatorCatalogPage(
          stateRef.current,
          response,
          page,
        );
        const nextState = { ...merged, error: null, loading: false };
        stateRef.current = nextState;
        remember(username, merged, ownerKey);
        setState(nextState);
      } catch (error) {
        if (requestIdRef.current !== requestId || !sameOwner()) return;
        const nextState = { ...stateRef.current, error, loading: false };
        stateRef.current = nextState;
        setState(nextState);
      }
    },
    [username, ownerKey],
  );

  useEffect(() => {
    const resource = `${cacheKey(username, ownerKey)}:${refresh}`;
    if (resourceRef.current !== resource) {
      resourceRef.current = resource;
      requestIdRef.current += 1;
      const initial = initialCatalog(username, ownerKey);
      setState({ ...initial, error: null, loading: false });
      stateRef.current = { ...initial, error: null, loading: false };
    }
    if (getTokenSnapshot().token && !owner) return;
    const current = stateRef.current;
    if (!current.initialized && current.next !== null && !current.loading) {
      void load(current.next);
    }
  }, [load, username, ownerKey, refresh, owner]);

  const loadMore = useCallback(() => {
    const next = stateRef.current.next;
    if (next !== null) void load(next);
  }, [load]);

  const retry = useCallback(() => {
    const next = stateRef.current.next;
    if (next !== null) void load(next);
  }, [load]);

  const visible = !(getTokenSnapshot().token && !owner) && resourceRef.current === `${cacheKey(username, ownerKey)}:${refresh}`
    ? state : { ...initialCatalog(username, ownerKey), error: null, loading: true };
  return { ...visible, loadMore, retry };
}
