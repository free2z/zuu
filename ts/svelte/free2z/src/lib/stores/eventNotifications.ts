import { newerVote, voteRevision } from "$lib/ws/accountEvents";
import { writable } from "svelte/store";
import { browser } from "$app/env";
import { defineMessage, translateMessage } from "$lib/i18n-message";
import {
  fetchEventsPage,
  fetchEventsPageByNextUrl,
  fetchPaymentRecoveryPage,
  fetchHasEvents,
  fetchUnreadCount,
  markAllEventsAsRead,
  markEventAsRead,
  UnreadCountRecipientEnvelopeUnavailableError,
  UnreadCountRecipientMismatchError,
  type EventFeedFilter,
  type EventNotification,
} from "$lib/api/events/eventNotificationsApi";

export type EventReadFilter = "all" | "unread" | "read";
export type EventSortOrder = "newest" | "oldest";

const NOTIFICATION_MESSAGES = {
  loadFailed: defineMessage(
    "notifications.errors.loadFailed",
    "Could not load notifications.",
  ),
  loadMoreFailed: defineMessage(
    "notifications.errors.loadMoreFailed",
    "Could not load more notifications.",
  ),
};

interface EventNotificationsState {
  initialized: boolean;
  loadingInitial: boolean;
  loadingMore: boolean;
  markingAllRead: boolean;
  unreadCount: number;
  hasEvents: boolean;
  filter: EventFeedFilter;
  readFilter: EventReadFilter;
  sortOrder: EventSortOrder;
  events: EventNotification[];
  nextPageUrl: string | null;
  error: string | null;
  errorCode: string | null;
}

const initialState: EventNotificationsState = {
  initialized: false,
  loadingInitial: false,
  loadingMore: false,
  markingAllRead: false,
  unreadCount: 0,
  hasEvents: false,
  filter: "social",
  readFilter: "all",
  sortOrder: "newest",
  events: [],
  nextPageUrl: null,
  error: null,
  errorCode: null,
};

const SOCIAL_EVENT_TYPES = new Set([
  "BOUGHT_TUZI",
  "ZEC_PENDING",
  "VOTE_COMMENT_RECEIVED",
  "NEW_REPLY",
  "PAGE_UPDATE",
  "PAGE_VOTE",
  "PAGE_MENTION",
  "DONATION_SENT",
  "DONATION_RECEIVED",
  "SUBSCRIPTION_SENT",
  "SUBSCRIPTION_RECEIVED",
  "ENCRYPTED_CHAT_REQUEST",
]);

function dedupeById(events: EventNotification[]): EventNotification[] {
  const seen = new Set<string>();
  const deduped: EventNotification[] = [];

  for (const event of events) {
    if (seen.has(event.id)) {
      continue;
    }
    seen.add(event.id);
    deduped.push(event);
  }

  return deduped;
}

function assertRecoveryActive(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason;
}

async function settleRecoveryRequests(
  requests: Promise<unknown>[],
  signal?: AbortSignal,
): Promise<PromiseSettledResult<unknown>[]> {
  const settled = Promise.allSettled(requests);
  if (!signal) return settled;

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () =>
      reject(
        signal.reason ??
          new DOMException("Notification recovery aborted", "AbortError"),
      );
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([settled, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function createEventNotificationsStore() {
  const { subscribe, update, set } =
    writable<EventNotificationsState>(initialState);
  let requestVersion = 0;
  let accountResetVersion = 0;
  let activeUsername = "";
  let localMutationVersion = 0;
  let metadataRequestVersion = 0;
  let metadataGeneration = 0;
  let reconciliationSequence = 0;
  let activeReconciliations = 0;
  let reconciliationMetadataSafe = true;
  let reconciliationUsernameConsistent = true;
  let reconciliationUsername: string | null = null;
  let deferredMetadataRefresh = false;
  let metadataRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingReconciliationMetadata: {
    hasEvents: boolean;
    unreadCount: number;
    requestVersion: number;
    accountResetVersion: number;
    mutationVersion: number;
    sequence: number;
  } | null = null;
  const pendingReadIds = new Map<string, number>();
  let pendingAllReads = 0;
  let readHeadTimer: ReturnType<typeof setTimeout> | null = null;
  let unreadEnvelopeRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let unreadEnvelopeRetryUsername = "";
  let unreadEnvelopeRetryEpoch = 0;
  let unreadEnvelopeRetryAttempts = 0;
  // Keep retrying through a mixed-version backend rollout that lasts longer
  // than the initial burst. Each retry remains bound to the captured account
  // and auth epoch, and a foreign envelope still cancels the retry chain.
  const unreadEnvelopeRetryDelays = [1_000, 5_000, 15_000, 30_000, 60_000];

  function clearUnreadEnvelopeRetry() {
    if (unreadEnvelopeRetryTimer) clearTimeout(unreadEnvelopeRetryTimer);
    unreadEnvelopeRetryTimer = null;
    unreadEnvelopeRetryUsername = "";
    unreadEnvelopeRetryEpoch = 0;
    unreadEnvelopeRetryAttempts = 0;
  }

  function retryMissingUnreadEnvelope(username: string, epoch: number) {
    if (
      unreadEnvelopeRetryUsername !== username ||
      unreadEnvelopeRetryEpoch !== epoch
    ) {
      clearUnreadEnvelopeRetry();
      unreadEnvelopeRetryUsername = username;
      unreadEnvelopeRetryEpoch = epoch;
    }
    if (
      unreadEnvelopeRetryTimer ||
      unreadEnvelopeRetryAttempts >= unreadEnvelopeRetryDelays.length
    )
      return;

    const delay = unreadEnvelopeRetryDelays[unreadEnvelopeRetryAttempts++];
    unreadEnvelopeRetryTimer = setTimeout(() => {
      unreadEnvelopeRetryTimer = null;
      if (
        epoch !== accountResetVersion ||
        username !== activeUsername ||
        unreadEnvelopeRetryEpoch !== epoch
      ) {
        clearUnreadEnvelopeRetry();
        return;
      }
      void refreshMeta(username);
    }, delay);
  }

  function refreshReadHead(username: string) {
    if (!browser || !username || readHeadTimer) return;
    const epoch = accountResetVersion;
    readHeadTimer = setTimeout(() => {
      readHeadTimer = null;
      if (epoch !== accountResetVersion) return;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      void reconcile(username, undefined, controller.signal)
        .catch(() => {})
        .finally(() => clearTimeout(timeout));
    }, 100);
  }
  let activeLoadMore: Promise<boolean> | null = null;
  let activeLoadAll: { promise: Promise<void> } | null = null;
  let paginationVersion = 0;
  let notificationsView: { username: string } | null = null;
  // Account-owned pacing survives recovery replacing an offset traversal.
  let nextOldestPageAt = 0;

  function retireViewPages() {
    paginationVersion += 1;
    activeLoadMore = null;
    activeLoadAll = null;
    update((state) => ({
      ...state,
      loadingInitial: false,
      loadingMore: false,
    }));
  }

  function enterNotificationsView(username: string) {
    const view = { username };
    activeUsername = username;
    notificationsView = view;
    retireViewPages();
    return {
      isCurrent: () => notificationsView === view,
      resume: () =>
        notificationsView === view ? loadAll() : Promise.resolve(),
      release: () => {
        if (notificationsView !== view) return;
        notificationsView = null;
        retireViewPages();
      },
    };
  }
  let paymentScan: {
    username: string;
    version: number;
    boundary: string | null;
    nextUrl: string | undefined;
    completed: boolean;
    visited: Set<string>;
    records: Map<string, EventNotification>;
  } | null = null;

  function currentSortOrder(): EventSortOrder {
    let value: EventSortOrder = "newest";
    update((state) => {
      value = state.sortOrder;
      return state;
    });
    return value;
  }

  async function refreshMeta(expectedUsername?: string) {
    if (!browser) return;
    const recipient = expectedUsername || activeUsername;
    if (!recipient || (activeUsername && recipient !== activeUsername)) return;
    if (!activeUsername) activeUsername = recipient;
    if (activeReconciliations > 0) {
      deferredMetadataRefresh = true;
      return;
    }
    const metadataVersion = ++metadataRequestVersion;
    const version = requestVersion;
    const accountVersion = accountResetVersion;
    const mutationVersion = localMutationVersion;

    try {
      const [hasEvents, unreadCount] = await Promise.all([
        fetchHasEvents(),
        fetchUnreadCount(undefined, recipient),
      ]);

      if (
        metadataVersion !== metadataRequestVersion ||
        version !== requestVersion ||
        accountVersion !== accountResetVersion ||
        activeReconciliations > 0 ||
        mutationVersion !== localMutationVersion ||
        recipient !== activeUsername
      )
        return;
      clearUnreadEnvelopeRetry();
      update((state) => ({
        ...state,
        hasEvents,
        unreadCount,
      }));
    } catch (error) {
      if (
        error instanceof UnreadCountRecipientEnvelopeUnavailableError &&
        accountVersion === accountResetVersion &&
        recipient === activeUsername
      ) {
        // Old Django pods keep the legacy scalar response during a rolling
        // backend update. Never apply it without recipient provenance; retry
        // a bounded number of times while the new endpoint becomes available.
        retryMissingUnreadEnvelope(recipient, accountVersion);
      } else if (
        error instanceof UnreadCountRecipientMismatchError &&
        accountVersion === accountResetVersion &&
        recipient === activeUsername
      ) {
        // A foreign response is an identity failure, not a deploy race.
        clearUnreadEnvelopeRetry();
      }
      // keep previous state when endpoint is temporarily unavailable
    }
  }

  async function loadInitial(options?: { force?: boolean }) {
    if (!browser) return;

    const shouldForce = options?.force === true;

    let shouldLoad = true;
    update((state) => {
      if (state.loadingInitial) {
        shouldLoad = false;
        return state;
      }

      if (state.initialized && !shouldForce) {
        shouldLoad = false;
        return state;
      }

      return {
        ...state,
        loadingInitial: true,
        loadingMore: shouldForce ? false : state.loadingMore,
        error: null,
        errorCode: null,
      };
    });

    if (!shouldLoad) {
      return;
    }

    if (shouldForce) {
      requestVersion += 1;
      activeLoadMore = null;
      activeLoadAll = null;
    }

    const currentRequestVersion = requestVersion;
    const currentPaginationVersion = paginationVersion;

    try {
      let filter: EventFeedFilter = "social";
      update((state) => {
        filter = state.filter;
        return state;
      });

      const response = await fetchEventsPage(1, filter);

      if (
        currentRequestVersion !== requestVersion ||
        currentPaginationVersion !== paginationVersion
      ) {
        return;
      }

      update((state) => ({
        ...state,
        events: response.results || [],
        nextPageUrl: response.next || null,
        initialized: true,
        loadingInitial: false,
        hasEvents: (response.count || 0) > 0,
      }));

      if (currentSortOrder() === "oldest") {
        void loadAll().catch(() => {});
      }
    } catch {
      if (
        currentRequestVersion !== requestVersion ||
        currentPaginationVersion !== paginationVersion
      ) {
        return;
      }

      update((state) => ({
        ...state,
        loadingInitial: false,
        initialized: true,
        error: translateMessage(NOTIFICATION_MESSAGES.loadFailed),
        errorCode: NOTIFICATION_MESSAGES.loadFailed.key,
      }));
    }
  }

  async function setFilter(filter: EventFeedFilter) {
    requestVersion += 1;
    activeLoadMore = null;
    activeLoadAll = null;
    update((state) => ({
      ...state,
      filter,
      initialized: false,
      loadingInitial: false,
      loadingMore: false,
      events: [],
      nextPageUrl: null,
      error: null,
      errorCode: null,
    }));

    await loadInitial({ force: true });
  }

  async function setReadFilter(readFilter: EventReadFilter) {
    update((state) => ({
      ...state,
      readFilter,
    }));
  }

  async function setSortOrder(sortOrder: EventSortOrder) {
    if (sortOrder !== currentSortOrder()) activeLoadAll = null;
    update((state) => ({
      ...state,
      sortOrder,
    }));

    if (sortOrder === "oldest") {
      await loadAll();
    }
  }

  async function performLoadMore(): Promise<boolean> {
    if (!browser) return false;

    let nextPageUrl: string | null = null;
    let canLoad = false;

    update((state) => {
      if (!state.nextPageUrl || state.loadingMore || state.loadingInitial) {
        return state;
      }

      canLoad = true;
      nextPageUrl = state.nextPageUrl;

      return {
        ...state,
        loadingMore: true,
      };
    });

    if (!canLoad || !nextPageUrl) {
      return false;
    }

    const currentRequestVersion = requestVersion;
    const currentPaginationVersion = paginationVersion;

    try {
      const response = await fetchEventsPageByNextUrl(nextPageUrl);

      if (
        currentRequestVersion !== requestVersion ||
        currentPaginationVersion !== paginationVersion
      ) {
        return false;
      }

      update((state) => ({
        ...state,
        events: dedupeById([...state.events, ...(response.results || [])]),
        nextPageUrl: response.next || null,
        loadingMore: false,
      }));
      return true;
    } catch {
      if (
        currentRequestVersion !== requestVersion ||
        currentPaginationVersion !== paginationVersion
      ) {
        return false;
      }

      update((state) => ({
        ...state,
        loadingMore: false,
        error: translateMessage(NOTIFICATION_MESSAGES.loadMoreFailed),
        errorCode: NOTIFICATION_MESSAGES.loadMoreFailed.key,
      }));
      return false;
    }
  }

  function loadMore(): Promise<boolean> {
    if (activeLoadMore) {
      return activeLoadMore;
    }

    const loadPromise = performLoadMore();
    activeLoadMore = loadPromise;
    void loadPromise.finally(() => {
      if (activeLoadMore === loadPromise) {
        activeLoadMore = null;
      }
    });
    return loadPromise;
  }

  function loadAll(): Promise<void> {
    const view = notificationsView;
    if (!view || currentSortOrder() !== "oldest") return Promise.resolve();
    if (activeLoadAll) return activeLoadAll.promise;
    const operation = { promise: Promise.resolve() };
    const version = requestVersion;
    const pages = paginationVersion;
    activeLoadAll = operation;
    const ownsTraversal = () =>
      activeLoadAll === operation &&
      notificationsView === view &&
      version === requestVersion &&
      pages === paginationVersion &&
      currentSortOrder() === "oldest";
    operation.promise = Promise.resolve().then(async () => {
      while (ownsTraversal()) {
        let hasNext = false;
        update((state) => {
          hasNext = state.nextPageUrl !== null;
          return state;
        });
        if (!hasNext) break;
        const delay = nextOldestPageAt - performance.now();
        if (delay > 0)
          await new Promise((resolve) => setTimeout(resolve, delay));
        // Recovery, navigation, filtering and account changes can retire this
        // loop during the wait. Only the current view may spend the shared pace.
        if (!ownsTraversal()) break;
        nextOldestPageAt = performance.now() + 250;
        if (!(await loadMore())) break;
      }
    });
    const settle = () => {
      if (activeLoadAll === operation) activeLoadAll = null;
    };
    void operation.promise.then(settle, settle);
    return operation.promise;
  }

  async function markRead(eventId: string) {
    const version = accountResetVersion;
    localMutationVersion += 1;
    let shouldUpdateUnread = false;
    let username = "";
    pendingReadIds.set(eventId, (pendingReadIds.get(eventId) ?? 0) + 1);

    update((state) => {
      const events = state.events.map((event) => {
        if (event.id !== eventId) {
          return event;
        }

        username =
          voteRevision(event) !== undefined
            ? (event.receiving_user?.username ?? "")
            : "";
        if (!event.read) {
          shouldUpdateUnread = true;
        }

        return { ...event, read: true };
      });

      return {
        ...state,
        events,
        unreadCount: shouldUpdateUnread
          ? Math.max(0, state.unreadCount - 1)
          : state.unreadCount,
      };
    });

    try {
      await markEventAsRead(eventId);
      if (version !== accountResetVersion) return;
      localMutationVersion += 1;
      void refreshMeta();
    } catch {
      if (version !== accountResetVersion) return;
      await refreshMeta();
      await loadInitial({ force: true });
    } finally {
      if (version === accountResetVersion) {
        const remaining = (pendingReadIds.get(eventId) ?? 1) - 1;
        if (remaining) pendingReadIds.set(eventId, remaining);
        else pendingReadIds.delete(eventId);
        refreshReadHead(username);
      }
    }
  }

  async function markAllRead() {
    const version = accountResetVersion;
    localMutationVersion += 1;
    let previousEvents: EventNotification[] = [];
    let previousUnread = 0;
    let username = "";
    pendingAllReads += 1;

    update((state) => {
      previousEvents = state.events;
      username =
        state.events.find((event) => voteRevision(event) !== undefined)
          ?.receiving_user?.username ?? "";
      previousUnread = state.unreadCount;
      return {
        ...state,
        events: state.events.map((event) => ({ ...event, read: true })),
        unreadCount: 0,
        markingAllRead: true,
      };
    });

    try {
      await markAllEventsAsRead();
      if (version !== accountResetVersion) return;
      localMutationVersion += 1;
      update((state) => ({
        ...state,
        markingAllRead: false,
      }));
      await refreshMeta();
    } catch (error) {
      if (version !== accountResetVersion) throw error;
      //this used to put the whole `previousEvents` snapshot back —
      // silently, and discarding every event the websocket delivered while
      // the request was in flight. Undo only OUR optimistic flip instead:
      // events that were unread before go back to unread, arrivals are kept
      // as they are, and the counter is the old one plus the unread events
      // that arrived. Arrivals are COUNTED from the list, not read off
      // `state.unreadCount`: a `refreshMeta()` that landed mid-request may
      // already have put the authoritative total back, and adding that to
      // `previousUnread` would double it (codex review).
      const wasUnread = new Set(
        previousEvents.filter((event) => !event.read).map((event) => event.id),
      );
      const previousIds = new Set(previousEvents.map((event) => event.id));
      update((state) => {
        const arrivedUnread = state.events.filter(
          (event) => !previousIds.has(event.id) && !event.read,
        ).length;
        return {
          ...state,
          events: state.events.map((event) =>
            wasUnread.has(event.id) ? { ...event, read: false } : event,
          ),
          unreadCount: previousUnread + arrivedUnread,
          markingAllRead: false,
        };
      });
      // Then ask the server what is actually true, as `markRead` does — in
      // the BACKGROUND. Those reads have no browser bound, and on the same
      // stalled connection awaiting them here would hide the failure the
      // caller is about to report (codex review). A failure of the re-read
      // leaves the restored state above standing until the next refresh.
      void (async () => {
        await refreshMeta();
        await loadInitial({ force: true });
      })().catch(() => {});
      // Re-throw so the caller can SAY it failed; the store has no toast.
      throw error;
    } finally {
      if (version === accountResetVersion) {
        pendingAllReads -= 1;
        refreshReadHead(username);
      }
    }
  }

  function addIncomingEvent(event: EventNotification, countUnread = true) {
    let accepted = false;
    update((state) => {
      const existing = state.events.find((item) => item.id === event.id);
      if (existing) {
        if (!newerVote(event, existing)) return state;
        accepted = true;
        localMutationVersion += 1;
        // A vote revision proves growth, but its publication may precede a
        // completed read write. Resolve read chronology from a fresh head.
        refreshReadHead(event.receiving_user?.username ?? "");
        const replacement = {
          ...event,
          read:
            event.read ||
            Boolean(pendingAllReads || pendingReadIds.has(event.id)),
        };
        return {
          ...state,
          events: state.events.map((item) =>
            item.id === event.id ? replacement : item,
          ),
          unreadCount:
            state.unreadCount +
            Number(!replacement.read) -
            Number(!existing.read),
        };
      }

      accepted = true;
      // Recovered display rows are already represented by server metadata.
      // This projection must not count them twice or retire that meta read.
      if (countUnread) localMutationVersion += 1;
      const unreadIncrement = event.read || !countUnread ? 0 : 1;
      const matchesActivity =
        state.filter === "all" || SOCIAL_EVENT_TYPES.has(event.type);

      return {
        ...state,
        events: matchesActivity ? [event, ...state.events] : state.events,
        unreadCount: state.unreadCount + unreadIncrement,
        hasEvents: true,
      };
    });
    return accepted;
  }

  async function reconcile(
    username: string,
    recoveredPayments?: EventNotification[],
    signal?: AbortSignal,
  ) {
    assertRecoveryActive(signal);
    if (!username) throw new Error("Notification recipient is missing");
    if (activeUsername && activeUsername !== username)
      throw new Error("Notification recovery recipient changed");
    if (!activeUsername) activeUsername = username;
    const transactionGeneration = metadataGeneration;
    const sequence = ++reconciliationSequence;
    if (activeReconciliations === 0) {
      reconciliationMetadataSafe = true;
      reconciliationUsernameConsistent = true;
      reconciliationUsername = username;
      deferredMetadataRefresh = false;
      pendingReconciliationMetadata = null;
    } else if (reconciliationUsername !== username) {
      reconciliationMetadataSafe = false;
      reconciliationUsernameConsistent = false;
    }
    activeReconciliations += 1;
    // Invalidate metadata-only reads started before this recipient-checked
    // generation. Their responses carry no identity of their own.
    metadataRequestVersion += 1;
    let recipientValidated = false;
    let refreshMetadataAfter = false;
    try {
      const version = requestVersion;
      const accountVersion = accountResetVersion;
      const mutationVersion = localMutationVersion;
      let filter: EventFeedFilter = "social";
      update((state) => {
        filter = state.filter;
        return state;
      });
      const [historyResult, hasEventsResult, unreadCountResult] =
        await settleRecoveryRequests(
          [
            fetchEventsPage(1, filter, signal),
            fetchHasEvents(signal),
            fetchUnreadCount(signal, username),
          ],
          signal,
        );
      // A fast failure must not retire this generation before the history
      // response has had a chance to prove its recipient.
      if (historyResult.status === "rejected") throw historyResult.reason;
      if (hasEventsResult.status === "rejected") throw hasEventsResult.reason;
      if (
        unreadCountResult.status === "rejected" &&
        recoveredPayments === undefined
      )
        throw unreadCountResult.reason;
      const response = historyResult.value as Awaited<
        ReturnType<typeof fetchEventsPage>
      >;
      const hasEvents = hasEventsResult.value as boolean;
      // Validated payment receipts can recover while older backend pods lack
      // the recipient envelope. A missing or foreign count is never applied.
      const unreadCount =
        unreadCountResult.status === "fulfilled"
          ? (unreadCountResult.value as number)
          : undefined;
      assertRecoveryActive(signal);
      if (version !== requestVersion)
        throw new Error("Notification recovery superseded");
      if (accountVersion !== accountResetVersion)
        throw new Error("Notification account changed");
      let records = dedupeById(response.results || []);
      const receipts = new Map(
        (recoveredPayments || []).map((event) => [event.id, event]),
      );
      let receiptEvidence = recoveredPayments || [];
      if (
        !username ||
        [...records, ...receiptEvidence].some(
          (event) => event.receiving_user?.username !== username,
        )
      )
        throw new Error("Notification recipient changed");
      recipientValidated = unreadCount !== undefined;
      if (unreadCount === undefined) refreshMetadataAfter = true;
      // A recovered head owns pagination. Older pending pages must not replace
      // its offset cursor and skip receipts that arrived during disconnection.
      let resumeOldest = false;
      update((state) => {
        resumeOldest =
          notificationsView?.username === username &&
          state.sortOrder === "oldest" &&
          (recoveredPayments !== undefined ||
            (activeLoadAll !== null && state.nextPageUrl !== null));
        return state;
      });
      paginationVersion += 1;
      activeLoadMore = null;
      activeLoadAll = null;
      let keptLocalRead = false;
      update((state) => {
        const existing = new Map(
          state.events.map((event) => [event.id, event]),
        );
        const mergeRead = (event: EventNotification) => {
          const previous = existing.get(event.id);
          const nextRevision = voteRevision(event),
            priorRevision = previous && voteRevision(previous);
          if (
            previous &&
            nextRevision !== undefined &&
            priorRevision !== undefined &&
            nextRevision < priorRevision
          )
            return previous;
          const localReadPending =
            pendingAllReads > 0 ||
            pendingReadIds.has(event.id) ||
            mutationVersion !== localMutationVersion;
          // Vote UUIDs represent increasing activity. A fresh head after a read
          // commits may resolve a provisional read; an older/pending head may not.
          const read =
            event.read ||
            Boolean(
              previous?.read &&
              (nextRevision === undefined || localReadPending),
            );
          if (read && !event.read) keptLocalRead = true;
          return { ...event, read };
        };
        records = records.map(mergeRead);
        const retained = state.events.map((event) => {
          const receipt = receipts.get(event.id);
          return receipt ? mergeRead(receipt) : event;
        });
        // Receipt membership is acknowledgement evidence, not an instruction to
        // expand the paginated UI with the account's entire financial history.
        const visible = new Map(
          [...retained, ...records].map((event) => [event.id, event]),
        );
        receiptEvidence = receiptEvidence.map(
          (event) => visible.get(event.id) || event,
        );
        return {
          ...state,
          events: dedupeById([...records, ...retained]),
          initialized: true,
          loadingInitial: false,
          loadingMore: false,
          // Offset boundaries move as events arrive, are read, or are filtered.
          // Resume at the recovered head's cursor and dedupe retained older rows.
          nextPageUrl: response.next || null,
          error: null,
          errorCode: null,
        };
      });
      if (mutationVersion !== localMutationVersion || keptLocalRead) {
        refreshMetadataAfter = true;
        if (
          mutationVersion !== localMutationVersion &&
          records.some((event) => voteRevision(event) !== undefined)
        )
          refreshReadHead(username);
      }
      // Concurrent reconciliations share a recipient-validation generation.
      // Preserve metadata from the most recently requested participant even
      // when an older response happens to finish later.
      if (
        unreadCount !== undefined &&
        (!pendingReconciliationMetadata ||
          sequence > pendingReconciliationMetadata.sequence)
      ) {
        pendingReconciliationMetadata = {
          hasEvents,
          unreadCount,
          requestVersion: version,
          accountResetVersion: accountVersion,
          mutationVersion,
          sequence,
        };
      }
      // Recovery retires old offset pages but must preserve the user's oldest
      // intent on genuine reconnect, or when a routine read head interrupts an
      // active traversal. Completed histories do not rescan on every vote/read.
      // Start its paced replacement independently of the balance queue;
      // an ignored old request must not delay or settle its replacement.
      if (resumeOldest) void loadAll().catch(() => {});
      return recoveredPayments ? receiptEvidence : records;
    } finally {
      if (transactionGeneration === metadataGeneration) {
        if (!recipientValidated) reconciliationMetadataSafe = false;
        if (refreshMetadataAfter) deferredMetadataRefresh = true;
        activeReconciliations -= 1;
        if (activeReconciliations === 0) {
          const safe = reconciliationMetadataSafe;
          const usernameConsistent = reconciliationUsernameConsistent;
          const retryUsername = reconciliationUsername;
          const retryAccountVersion = accountResetVersion;
          const retryGeneration = metadataGeneration;
          const metadata = pendingReconciliationMetadata;
          let shouldRefresh = deferredMetadataRefresh;
          reconciliationMetadataSafe = true;
          reconciliationUsernameConsistent = true;
          reconciliationUsername = null;
          deferredMetadataRefresh = false;
          pendingReconciliationMetadata = null;

          if (safe && metadata) {
            if (
              metadata.requestVersion === requestVersion &&
              metadata.accountResetVersion === accountResetVersion &&
              metadata.mutationVersion === localMutationVersion
            ) {
              update((state) => ({
                ...state,
                hasEvents: metadata.hasEvents || state.hasEvents,
                unreadCount: metadata.unreadCount,
              }));
            } else if (metadata.requestVersion === requestVersion) {
              shouldRefresh = true;
            }
          }
          if (safe && shouldRefresh && retryUsername)
            void refreshMeta(retryUsername);
          // On any participant failure or recipient mismatch, discard every
          // staged value. If another valid participant had requested metadata,
          // retry through a fresh recipient-bearing history read.
          if (
            !safe &&
            usernameConsistent &&
            retryUsername &&
            (metadata || shouldRefresh)
          ) {
            if (metadataRetryTimer) clearTimeout(metadataRetryTimer);
            metadataRetryTimer = setTimeout(() => {
              metadataRetryTimer = null;
              if (
                retryGeneration === metadataGeneration &&
                retryAccountVersion === accountResetVersion &&
                retryUsername === activeUsername
              ) {
                const controller = new AbortController();
                const timeout = setTimeout(
                  () =>
                    controller.abort(
                      new DOMException(
                        "Notification metadata retry timed out",
                        "TimeoutError",
                      ),
                    ),
                  15_000,
                );
                void reconcile(retryUsername, undefined, controller.signal)
                  .catch(() => {})
                  .finally(() => clearTimeout(timeout));
              }
            }, 0);
          }
        }
      }
    }
  }

  async function reconcilePayments(username: string, signal?: AbortSignal) {
    assertRecoveryActive(signal);
    if (
      !paymentScan ||
      paymentScan.username !== username ||
      paymentScan.version !== requestVersion
    ) {
      paymentScan = {
        username,
        version: requestVersion,
        boundary: null,
        nextUrl: undefined,
        completed: false,
        visited: new Set(),
        records: new Map(),
      };
    }
    const scan = paymentScan;
    const abortScan = () => {
      // Cancellation must retire ownership before a replacement batch starts,
      // even when the old transport ignores abort and settles much later.
      if (paymentScan === scan) {
        paymentScan = {
          ...scan,
          records: new Map(scan.records),
          visited: new Set(scan.visited),
        };
      }
    };
    signal?.addEventListener("abort", abortScan, { once: true });
    try {
      // Bound each batch. The delivery policy resumes valid continuations;
      // only a completed scan may seed the quiet initial receipt baseline.
      // One validated receipt page per batch yields before another slow read
      // can consume the deadline. Healthy progress never spends error retries.
      if (!scan.completed) {
        const response = await fetchPaymentRecoveryPage(scan.nextUrl, signal);
        assertRecoveryActive(signal);
        if (scan !== paymentScan || scan.version !== requestVersion)
          throw new Error("Receipt recovery superseded");
        if (
          !username ||
          !response.recovery_boundary ||
          typeof response.recovery_boundary !== "string" ||
          (scan.boundary && scan.boundary !== response.recovery_boundary)
        )
          throw new Error("Receipt recovery boundary changed");
        scan.boundary = response.recovery_boundary;
        for (const event of response.results || []) {
          if (
            event.receiving_user?.username !== username ||
            (event.type !== "BOUGHT_TUZI" && event.type !== "ZEC_PENDING")
          )
            throw new Error("Receipt recovery recipient changed");
          const previous = scan.records.get(event.id);
          scan.records.set(event.id, {
            ...event,
            read: event.read || Boolean(previous?.read),
          });
        }
        if (response.next) {
          if (scan.visited.has(response.next))
            throw new Error("Receipt recovery cursor repeated");
          scan.visited.add(response.next);
          scan.nextUrl = response.next;
        } else {
          scan.completed = true;
        }
      }
      if (!scan.completed) return null;
      const records = await reconcile(
        username,
        [...scan.records.values()],
        signal,
      );
      assertRecoveryActive(signal);
      if (scan !== paymentScan || scan.version !== requestVersion)
        throw new Error("Receipt recovery superseded");
      paymentScan = null;
      return records;
    } catch (error) {
      // Restart malformed, expired or interrupted scans without acknowledging
      // their partial membership. Ordinary transient reads may resume the keyset.
      if (
        scan === paymentScan &&
        (scan.version !== requestVersion ||
          !(error && typeof error === "object" && "status" in error) ||
          (error as { status?: number }).status === 400)
      )
        paymentScan = null;
      throw error;
    } finally {
      signal?.removeEventListener("abort", abortScan);
    }
  }

  function clearForLogout() {
    metadataGeneration += 1;
    metadataRequestVersion += 1;
    activeReconciliations = 0;
    reconciliationMetadataSafe = true;
    reconciliationUsernameConsistent = true;
    reconciliationUsername = null;
    deferredMetadataRefresh = false;
    pendingReconciliationMetadata = null;
    if (metadataRetryTimer) clearTimeout(metadataRetryTimer);
    metadataRetryTimer = null;
    if (readHeadTimer) clearTimeout(readHeadTimer);
    readHeadTimer = null;
    clearUnreadEnvelopeRetry();
    pendingReadIds.clear();
    pendingAllReads = 0;
    paymentScan = null;
    activeUsername = "";
    accountResetVersion += 1;
    requestVersion += 1;
    activeLoadMore = null;
    activeLoadAll = null;
    notificationsView = null;
    nextOldestPageAt = 0;
    set(initialState);
  }

  return {
    subscribe,
    enterNotificationsView,
    refreshMeta,
    loadInitial,
    reconcile,
    reconcilePayments,
    loadMore,
    setFilter,
    setReadFilter,
    setSortOrder,
    markRead,
    markAllRead,
    addIncomingEvent,
    clearForLogout,
  };
}

export const eventNotifications = createEventNotificationsStore();
