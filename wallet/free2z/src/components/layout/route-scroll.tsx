import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLocation, useNavigationType } from "react-router-dom";
import {
  RouteScrollContextProvider,
  type RouteScrollContextValue,
} from "@/hooks/useRouteScroll";

export const MAX_SAVED_SCROLL_ENTRIES = 64;
export const MAX_PENDING_RESTORE_MS = 30_000;

/** A small insertion-ordered history-entry cache with finite numeric offsets. */
export class ScrollPositionStore {
  readonly #limit: number;
  readonly #offsets = new Map<string, number>();

  constructor(limit = MAX_SAVED_SCROLL_ENTRIES) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("Scroll position limit must be a positive integer");
    }
    this.#limit = limit;
  }

  remember(key: string, offset: number) {
    if (!key) return;
    const finiteOffset = Number.isFinite(offset)
      ? Math.min(Math.max(0, offset), Number.MAX_SAFE_INTEGER)
      : 0;
    this.#offsets.delete(key);
    this.#offsets.set(key, finiteOffset);
    while (this.#offsets.size > this.#limit) {
      const oldest = this.#offsets.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#offsets.delete(oldest);
    }
  }

  recall(key: string) {
    const offset = this.#offsets.get(key);
    if (offset === undefined) return undefined;
    // A restored entry becomes the newest one without changing its value.
    this.#offsets.delete(key);
    this.#offsets.set(key, offset);
    return offset;
  }

  has(key: string) {
    return this.#offsets.has(key);
  }

  get size() {
    return this.#offsets.size;
  }
}

type CurrentEntry = {
  key: string;
  navigationType: ReturnType<typeof useNavigationType>;
};

function positionForEntry(store: ScrollPositionStore, entry: CurrentEntry) {
  // Initial loads are reported as POP, but have no saved entry and therefore
  // deliberately start at the top. Router hashes are retained in the URL but
  // do not invoke native window scrolling: in-page Markdown anchors own their
  // explicit scrollIntoView behavior, while cross-entry/deep-link navigation
  // follows the same top/POP contract as every other route.
  return entry.navigationType === "POP" ? (store.recall(entry.key) ?? 0) : 0;
}

export function browserHistoryEntryKey(state: unknown) {
  if (state === null || typeof state !== "object" || Array.isArray(state)) {
    return null;
  }
  const key = Reflect.get(state, "key");
  return typeof key === "string" && key.length > 0 ? key : null;
}

export function normalizedInitialHistoryState(
  state: unknown,
  locationKey: string,
) {
  // BrowserRouter's initial entry is the one deliberate exception to its
  // normal { usr, key, idx } state: it starts as { idx: 0 } while exposing the
  // location key "default". Normalize only that exact known shape. Unknown
  // history state remains untrusted and scroll recording stays fail-closed.
  if (
    locationKey !== "default" ||
    state === null ||
    typeof state !== "object" ||
    Array.isArray(state) ||
    Object.keys(state).length !== 1 ||
    Reflect.get(state, "idx") !== 0
  ) {
    return null;
  }
  return { idx: 0, key: locationKey };
}

export function RouteScrollProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigationType = useNavigationType();
  const storeRef = useRef(new ScrollPositionStore());
  const registeredViewportRef = useRef<HTMLDivElement | null>(null);
  const registeredViewportCleanupRef = useRef<(() => void) | null>(null);
  const recordingEntryKeyRef = useRef(location.key);
  const lastRecordedOffsetRef = useRef<{ key: string; offset: number } | null>(
    null,
  );
  const pendingRestoreCleanupRef = useRef<(() => void) | null>(null);
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const currentEntryRef = useRef<CurrentEntry>({
    key: location.key,
    navigationType,
  });
  currentEntryRef.current = { key: location.key, navigationType };

  const applyEntryPosition = useCallback(
    (node: HTMLDivElement, entry: CurrentEntry) => {
      pendingRestoreCleanupRef.current?.();
      pendingRestoreCleanupRef.current = null;

      const target = positionForEntry(storeRef.current, entry);
      const apply = () => {
        node.scrollTop = target;
        lastRecordedOffsetRef.current = {
          key: entry.key,
          offset: node.scrollTop,
        };
      };
      apply();

      // A POP can remount an async route while it still contains only a short
      // loading skeleton. It can also accept the target immediately and then
      // let browser scroll anchoring move it when late route content appears.
      // Keep the entry's real target through that bounded content-ready window,
      // unless the user starts interacting.
      if (entry.navigationType === "POP" && target > 0) {
        let animationFrame: number | null = null;
        const reapplyBeforePaint = () => {
          apply();
          if (animationFrame !== null)
            window.cancelAnimationFrame(animationFrame);
          // Scroll anchoring is resolved during layout. Reassert immediately
          // before paint as well as in the mutation microtask.
          animationFrame = window.requestAnimationFrame(() => {
            animationFrame = null;
            apply();
          });
        };
        let resizeObserver: ResizeObserver | null = new ResizeObserver(() => {
          reapplyBeforePaint();
        });
        let observedContentBoxes = new Set<Element>();
        const observeContentBoxes = () => {
          const nextContentBoxes = new Set<Element>([node]);
          for (const child of node.children) {
            if (child instanceof Element) nextContentBoxes.add(child);
          }
          for (const observed of observedContentBoxes) {
            if (!nextContentBoxes.has(observed))
              resizeObserver?.unobserve(observed);
          }
          for (const contentBox of nextContentBoxes) {
            if (!observedContentBoxes.has(contentBox)) {
              resizeObserver?.observe(contentBox, { box: "border-box" });
            }
          }
          observedContentBoxes = nextContentBoxes;
        };
        let mutationObserver: MutationObserver | null = new MutationObserver(
          () => {
            observeContentBoxes();
            reapplyBeforePaint();
          },
        );
        const cancelForUser = () => cleanup();
        const timeout = window.setTimeout(
          () => cleanup(),
          MAX_PENDING_RESTORE_MS,
        );
        const cleanup = () => {
          mutationObserver?.disconnect();
          mutationObserver = null;
          resizeObserver?.disconnect();
          resizeObserver = null;
          observedContentBoxes.clear();
          if (animationFrame !== null) {
            window.cancelAnimationFrame(animationFrame);
            animationFrame = null;
          }
          window.clearTimeout(timeout);
          window.removeEventListener("pointerdown", cancelForUser, true);
          window.removeEventListener("touchstart", cancelForUser, true);
          window.removeEventListener("wheel", cancelForUser, true);
          window.removeEventListener("keydown", cancelForUser, true);
          if (pendingRestoreCleanupRef.current === cleanup) {
            pendingRestoreCleanupRef.current = null;
          }
        };
        observeContentBoxes();
        mutationObserver.observe(node, { childList: true, subtree: true });
        // Do not end on a short quiet period: real route requests can remain
        // quiet for seconds before replacing their loading skeleton. The hard
        // deadline keeps the cost bounded, while callbacks run only for real
        // DOM or box-size changes (there is no polling).
        // Capture at the window boundary so touching a Radix scrollbar (which
        // is a viewport sibling) also yields immediately to the user.
        window.addEventListener("pointerdown", cancelForUser, {
          capture: true,
          passive: true,
        });
        window.addEventListener("touchstart", cancelForUser, {
          capture: true,
          passive: true,
        });
        window.addEventListener("wheel", cancelForUser, {
          capture: true,
          passive: true,
        });
        window.addEventListener("keydown", cancelForUser, true);
        pendingRestoreCleanupRef.current = cleanup;
      }
    },
    [],
  );

  const registerViewport = useCallback(
    (node: HTMLDivElement | null) => {
      registeredViewportCleanupRef.current?.();
      registeredViewportCleanupRef.current = null;
      if (!node) {
        pendingRestoreCleanupRef.current?.();
        pendingRestoreCleanupRef.current = null;
      }
      registeredViewportRef.current = node;
      setViewport((current) => (current === node ? current : node));
      // Callback refs run during the commit. Applying here covers a newly
      // mounted generic/full-bleed owner before the browser can paint it.
      if (node) {
        recordingEntryKeyRef.current = currentEntryRef.current.key;
        const recordActualOffset = () => {
          const key = recordingEntryKeyRef.current;
          // React Router installs the destination history state before React
          // commits its new route. During that boundary, browser anchoring can
          // emit clamp events from the departing DOM. Accept scroll events only
          // while the browser and installed React entry identities agree. This
          // freezes the last delivered current-entry offset symmetrically for
          // PUSH, REPLACE, back, and forward without relying on listener order.
          if (browserHistoryEntryKey(window.history.state) !== key) return;
          const offset = node.scrollTop;
          lastRecordedOffsetRef.current = { key, offset };
          storeRef.current.remember(key, offset);
        };
        node.addEventListener("scroll", recordActualOffset, { passive: true });
        registeredViewportCleanupRef.current = () => {
          node.removeEventListener("scroll", recordActualOffset);
        };
        applyEntryPosition(node, currentEntryRef.current);
      }
    },
    [applyEntryPosition],
  );

  useLayoutEffect(() => {
    if (browserHistoryEntryKey(window.history.state) !== null) return;
    const normalized = normalizedInitialHistoryState(
      window.history.state,
      location.key,
    );
    if (normalized) window.history.replaceState(normalized, "");
  }, [location.key]);

  useLayoutEffect(() => {
    const node = registeredViewportRef.current;
    const entry = { key: location.key, navigationType };
    if (node) {
      // Switch the scroll event's history-entry identity only after the old
      // layout cleanup has persisted its final offset. Programmatic resets
      // are then harmlessly recorded against the new entry, never the old one.
      recordingEntryKeyRef.current = entry.key;
      applyEntryPosition(node, entry);
    }
    return () => {
      pendingRestoreCleanupRef.current?.();
      pendingRestoreCleanupRef.current = null;
      // Capture the element itself. Across the generic/full-bleed boundary its
      // ref is detached during mutation before this layout cleanup runs, but
      // the detached element still carries the route's actual final offset.
      if (node) {
        const last = lastRecordedOffsetRef.current;
        if (last?.key === entry.key) {
          storeRef.current.remember(entry.key, last.offset);
        } else if (!storeRef.current.has(entry.key)) {
          // A replacement viewport may attach before this old owner's layout
          // cleanup. Never overwrite a live scroll-event value with a detached
          // element whose content has already been clamped by the mutation.
          storeRef.current.remember(entry.key, node.scrollTop);
        }
      }
    };
  }, [applyEntryPosition, location.key, navigationType]);

  useLayoutEffect(() => {
    const previous = window.history.scrollRestoration;
    window.history.scrollRestoration = "manual";
    return () => {
      window.history.scrollRestoration = previous;
    };
  }, []);

  const scrollToTop = useCallback(() => {
    pendingRestoreCleanupRef.current?.();
    pendingRestoreCleanupRef.current = null;
    const node = registeredViewportRef.current;
    if (node) node.scrollTop = 0;
    lastRecordedOffsetRef.current = {
      key: currentEntryRef.current.key,
      offset: 0,
    };
    storeRef.current.remember(currentEntryRef.current.key, 0);
  }, []);

  const value = useMemo<RouteScrollContextValue>(
    () => ({ registerViewport, scrollToTop, viewport }),
    [registerViewport, scrollToTop, viewport],
  );

  return (
    <RouteScrollContextProvider value={value}>
      {children}
    </RouteScrollContextProvider>
  );
}
