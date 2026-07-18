import { writable } from 'svelte/store';
import { browser } from '$app/environment';
import {
    fetchEventsPage,
    fetchEventsPageByNextUrl,
    fetchHasEvents,
    fetchUnreadCount,
    markAllEventsAsRead,
    markEventAsRead,
    type EventFeedFilter,
    type EventNotification,
} from '$lib/api/events/eventNotificationsApi';

export type EventReadFilter = 'all' | 'unread' | 'read';
export type EventSortOrder = 'newest' | 'oldest';

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
}

const initialState: EventNotificationsState = {
    initialized: false,
    loadingInitial: false,
    loadingMore: false,
    markingAllRead: false,
    unreadCount: 0,
    hasEvents: false,
    filter: 'social',
    readFilter: 'all',
    sortOrder: 'newest',
    events: [],
    nextPageUrl: null,
    error: null,
};

const SOCIAL_EVENT_TYPES = new Set([
    'VOTE_COMMENT_RECEIVED',
    'NEW_REPLY',
    'PAGE_UPDATE',
    'PAGE_VOTE',
    'DONATION_SENT',
    'DONATION_RECEIVED',
    'SUBSCRIPTION_SENT',
    'SUBSCRIPTION_RECEIVED',
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

function createEventNotificationsStore() {
    const { subscribe, update, set } =
        writable<EventNotificationsState>(initialState);
    let requestVersion = 0;
    let activeLoadMore: Promise<boolean> | null = null;

    function currentSortOrder(): EventSortOrder {
        let value: EventSortOrder = 'newest';
        update((state) => {
            value = state.sortOrder;
            return state;
        });
        return value;
    }

    async function refreshMeta() {
        if (!browser) return;

        try {
            const [hasEvents, unreadCount] = await Promise.all([
                fetchHasEvents(),
                fetchUnreadCount(),
            ]);

            update((state) => ({
                ...state,
                hasEvents,
                unreadCount,
            }));
        } catch {
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
            };
        });

        if (!shouldLoad) {
            return;
        }

        if (shouldForce) {
            requestVersion += 1;
            activeLoadMore = null;
        }

        const currentRequestVersion = requestVersion;

        try {
            let filter: EventFeedFilter = 'social';
            update((state) => {
                filter = state.filter;
                return state;
            });

            const response = await fetchEventsPage(1, filter);

            if (currentRequestVersion !== requestVersion) {
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

            if (currentSortOrder() === 'oldest') {
                await loadAll();
            }
        } catch (error: any) {
            if (currentRequestVersion !== requestVersion) {
                return;
            }

            update((state) => ({
                ...state,
                loadingInitial: false,
                initialized: true,
                error: error?.message || 'Failed to load notifications',
            }));
        }
    }

    async function setFilter(filter: EventFeedFilter) {
        requestVersion += 1;
        activeLoadMore = null;
        update((state) => ({
            ...state,
            filter,
            initialized: false,
            loadingInitial: false,
            loadingMore: false,
            events: [],
            nextPageUrl: null,
            error: null,
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
        update((state) => ({
            ...state,
            sortOrder,
        }));

        if (sortOrder === 'oldest') {
            await loadAll();
        }
    }

    async function performLoadMore(): Promise<boolean> {
        if (!browser) return false;

        let nextPageUrl: string | null = null;
        let canLoad = false;

        update((state) => {
            if (
                !state.nextPageUrl ||
                state.loadingMore ||
                state.loadingInitial
            ) {
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

        try {
            const response = await fetchEventsPageByNextUrl(nextPageUrl);

            if (currentRequestVersion !== requestVersion) {
                return false;
            }

            update((state) => ({
                ...state,
                events: dedupeById([
                    ...state.events,
                    ...(response.results || []),
                ]),
                nextPageUrl: response.next || null,
                loadingMore: false,
            }));
            return true;
        } catch (error: any) {
            if (currentRequestVersion !== requestVersion) {
                return false;
            }

            update((state) => ({
                ...state,
                loadingMore: false,
                error: error?.message || 'Failed to load more notifications',
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

    async function loadAll() {
        while (await loadMore()) {
            // Continue until the API reports that there is no next page.
        }
    }

    async function markRead(eventId: string) {
        let shouldUpdateUnread = false;

        update((state) => {
            const events = state.events.map((event) => {
                if (event.id !== eventId) {
                    return event;
                }

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
        } catch {
            await refreshMeta();
            await loadInitial({ force: true });
        }
    }

    async function markAllRead() {
        let previousEvents: EventNotification[] = [];
        let previousUnread = 0;

        update((state) => {
            previousEvents = state.events;
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
            update((state) => ({
                ...state,
                markingAllRead: false,
            }));
            await refreshMeta();
        } catch {
            update((state) => ({
                ...state,
                events: previousEvents,
                unreadCount: previousUnread,
                markingAllRead: false,
            }));
        }
    }

    function addIncomingEvent(event: EventNotification) {
        update((state) => {
            const existing = state.events.find((item) => item.id === event.id);
            if (existing) {
                return state;
            }

            const unreadIncrement = event.read ? 0 : 1;
            const matchesActivity =
                state.filter === 'all' || SOCIAL_EVENT_TYPES.has(event.type);

            return {
                ...state,
                events: matchesActivity
                    ? [event, ...state.events]
                    : state.events,
                unreadCount: state.unreadCount + unreadIncrement,
                hasEvents: true,
            };
        });
    }

    function clearForLogout() {
        requestVersion += 1;
        activeLoadMore = null;
        set(initialState);
    }

    return {
        subscribe,
        refreshMeta,
        loadInitial,
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
