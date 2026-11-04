import { customInstance } from '$lib/api/mutator';
import type { Event, PaginatedEventList } from '$lib/api/f2z.schemas';
import { CANONICAL_CONTENT_URL_HEADERS } from '$lib/api/canonical-content-url';

export type EventFeedFilter = 'all' | 'social';

type LegacyHasEventsResponse = boolean | { has_events?: boolean; hasEvents?: boolean };
type LegacyUnreadCountResponse = number | {
    unread_count?: number;
    unreadCount?: number;
    count?: number;
    recipient_username?: string;
};

export class UnreadCountRecipientEnvelopeUnavailableError extends Error {
    constructor() {
        super('Unread count recipient is missing');
        this.name = 'UnreadCountRecipientEnvelopeUnavailableError';
    }
}

export class UnreadCountRecipientMismatchError extends Error {
    constructor() {
        super('Unread count recipient changed');
        this.name = 'UnreadCountRecipientMismatchError';
    }
}

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

export async function fetchEventsPage(page = 1, filter: EventFeedFilter = 'social', signal?: AbortSignal): Promise<PaginatedEventList> {
    const params: Record<string, string | number> = { page };

    if (filter === 'social') {
        params.type = 'social';
    }

    return customInstance<PaginatedEventList>({
        url: '/api/events/',
        method: 'GET',
        signal,
        params,
        headers: CANONICAL_CONTENT_URL_HEADERS,
    });
}

export async function fetchEventsPageByNextUrl(nextUrl: string): Promise<PaginatedEventList> {
    const relativePath = asRelativeApiPath(nextUrl);
    return customInstance<PaginatedEventList>({
        url: relativePath,
        method: 'GET',
        headers: CANONICAL_CONTENT_URL_HEADERS,
    });
}

export async function fetchHasEvents(signal?: AbortSignal): Promise<boolean> {
    const response = await customInstance<LegacyHasEventsResponse>({
        url: '/api/events/has/',
        method: 'GET',
        signal,
    });

    if (typeof response === 'boolean') {
        return response;
    }

    return Boolean(response?.has_events ?? response?.hasEvents ?? false);
}

export async function fetchUnreadCount(
    signal: AbortSignal | undefined,
    expectedUsername: string,
): Promise<number> {
    if (!expectedUsername) {
        throw new UnreadCountRecipientEnvelopeUnavailableError();
    }
    const response = await customInstance<LegacyUnreadCountResponse>({
        url: '/api/events/unread_count/?include_recipient=1',
        method: 'GET',
        signal,
    });

    if (typeof response === 'number') {
        throw new UnreadCountRecipientEnvelopeUnavailableError();
    }

    if (!response?.recipient_username) {
        throw new UnreadCountRecipientEnvelopeUnavailableError();
    }
    if (response?.recipient_username !== expectedUsername) {
        throw new UnreadCountRecipientMismatchError();
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

/** Private receipt recovery has its own immutable keyset cursor. */
export type PaymentRecoveryPage = PaginatedEventList & {
    recovery_boundary: string;
};

export async function fetchPaymentRecoveryPage(nextUrl?: string, signal?: AbortSignal): Promise<PaymentRecoveryPage> {
    const url = nextUrl ? asRelativeApiPath(nextUrl) : '/api/events/?recovery=payments';
    const parsed = new URL(url, 'https://recovery.invalid');
    if (parsed.pathname !== '/api/events/' || parsed.searchParams.get('recovery') !== 'payments') {
        throw new Error('Invalid receipt recovery cursor');
    }
    return customInstance<PaymentRecoveryPage>({
        url,
        method: 'GET',
        signal,
        headers: CANONICAL_CONTENT_URL_HEADERS,
    });
}
