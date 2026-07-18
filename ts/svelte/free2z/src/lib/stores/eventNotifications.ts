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

interface EventNotificationsState {
    initialized: boolean;
    loadingInitial: boolean;
    loadingMore: boolean;
    markingAllRead: boolean;
    unreadCount: number;
    hasEvents: boolean;
    filter: EventFeedFilter;
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
    events: [],
    nextPageUrl: null,
    error: null,
};

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
    const { subscribe, update, set } = writable<EventNotificationsState>(initialState);

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
                error: null,
            };
        });

        if (!shouldLoad) {
            return;
        }

        try {
            let filter: EventFeedFilter = 'social';
            update((state) => {
                filter = state.filter;
                return state;
            });

            const response = await fetchEventsPage(1, filter);

            update((state) => ({
                ...state,
                events: response.results || [],
                nextPageUrl: response.next || null,
                initialized: true,
                loadingInitial: false,
                hasEvents: (response.count || 0) > 0,
            }));
        } catch (error: any) {
            update((state) => ({
                ...state,
                loadingInitial: false,
                initialized: true,
                error: error?.message || 'Failed to load notifications',
            }));
        }
    }

    async function setFilter(filter: EventFeedFilter) {
        update((state) => ({
            ...state,
            filter,
            initialized: false,
            events: [],
            nextPageUrl: null,
            error: null,
        }));

        await loadInitial({ force: true });
    }

    async function loadMore() {
        if (!browser) return;

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
            return;
        }

        try {
            const response = await fetchEventsPageByNextUrl(nextPageUrl);

            update((state) => ({
                ...state,
                events: dedupeById([...state.events, ...(response.results || [])]),
                nextPageUrl: response.next || null,
                loadingMore: false,
            }));
        } catch (error: any) {
            update((state) => ({
                ...state,
                loadingMore: false,
                error: error?.message || 'Failed to load more notifications',
            }));
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
                unreadCount: shouldUpdateUnread ? Math.max(0, state.unreadCount - 1) : state.unreadCount,
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

            return {
                ...state,
                events: [event, ...state.events],
                unreadCount: state.unreadCount + unreadIncrement,
                hasEvents: true,
            };
        });
    }

    function clearForLogout() {
        set(initialState);
    }

    return {
        subscribe,
        refreshMeta,
        loadInitial,
        loadMore,
        setFilter,
        markRead,
        markAllRead,
        addIncomingEvent,
        clearForLogout,
    };
}

export const eventNotifications = createEventNotificationsStore();
