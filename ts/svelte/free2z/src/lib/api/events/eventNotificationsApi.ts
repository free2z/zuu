import { customInstance } from '$lib/api/mutator';
import type { Event, PaginatedEventList } from '$lib/api/f2z.schemas';

export type EventFeedFilter = 'all' | 'social';

type LegacyHasEventsResponse = boolean | { has_events?: boolean; hasEvents?: boolean };
type LegacyUnreadCountResponse = number | { unread_count?: number; unreadCount?: number; count?: number };

function asRelativeApiPath(urlOrPath: string): string {
    if (urlOrPath.startsWith('/')) {
        return urlOrPath;
    }

    if (urlOrPath.startsWith('?')) {
        return `/api/events/${urlOrPath}`;
    }

    const parsed = new URL(urlOrPath);
    return `${parsed.pathname}${parsed.search}`;
}

export async function fetchEventsPage(page = 1, filter: EventFeedFilter = 'social'): Promise<PaginatedEventList> {
    const params: Record<string, string | number> = { page };

    if (filter === 'social') {
        params.type = 'social';
    }

    return customInstance<PaginatedEventList>({
        url: '/api/events/',
        method: 'GET',
        params,
    });
}

export async function fetchEventsPageByNextUrl(nextUrl: string): Promise<PaginatedEventList> {
    const relativePath = asRelativeApiPath(nextUrl);
    return customInstance<PaginatedEventList>({
        url: relativePath,
        method: 'GET',
    });
}

export async function fetchHasEvents(): Promise<boolean> {
    const response = await customInstance<LegacyHasEventsResponse>({
        url: '/api/events/has/',
        method: 'GET',
    });

    if (typeof response === 'boolean') {
        return response;
    }

    return Boolean(response?.has_events ?? response?.hasEvents ?? false);
}

export async function fetchUnreadCount(): Promise<number> {
    const response = await customInstance<LegacyUnreadCountResponse>({
        url: '/api/events/unread_count/',
        method: 'GET',
    });

    if (typeof response === 'number') {
        return Math.max(0, response);
    }

    const count = response?.unread_count ?? response?.unreadCount ?? response?.count ?? 0;
    return Math.max(0, Number(count) || 0);
}

export async function markEventAsRead(eventId: string): Promise<void> {
    await customInstance<void>({
        url: `/api/events/read/${eventId}/`,
        method: 'POST',
    });
}

export async function markAllEventsAsRead(): Promise<void> {
    await customInstance<void>({
        url: '/api/events/read/all/',
        method: 'POST',
    });
}

export type EventNotification = Event;
