import { dyteCreate, dyteLiveStatusRetrieve, dytePrivateCreate, dytePrivateCreate2 } from '$lib/api/dyte/dyte';
import { ApiError } from '$lib/api/mutator';
import type { StreamType } from '$lib/stores/liveStreamStore';
import { z } from 'zod';

export const streamInitResponseSchema = z.object({
    auth_token: z.string(),
    room_name: z.string().optional(),
    meeting_id: z.string().optional(),
});

export type StreamInitResponse = z.infer<typeof streamInitResponseSchema>;

export const privateStreamCreateResponseSchema = z.object({
    secret: z.string(),
});

export type PrivateStreamCreateResponse = z.infer<typeof privateStreamCreateResponseSchema>;

const streamTypeSchema = z.enum(['broadcast', 'subscribers-only', 'ppv', 'private']);

export const streamInfoSchema = z.object({
    type: streamTypeSchema,
    participant_count: z.number(),
    price_per_minute: z.number().optional(),
    meeting_id: z.string().optional(),
});

export type StreamInfo = z.infer<typeof streamInfoSchema>;

const normalizedLiveStatusResponseSchema = z.object({
    is_live: z.boolean(),
    participant_count: z.number().default(0),
    streams: z.array(streamInfoSchema).default([]),
});

const legacyStreamInfoSchema = z.object({
    meeting_type: streamTypeSchema,
    participants: z.number(),
    price_per_minute: z.number().nullable().optional(),
    meeting_id: z.string().optional(),
});

const legacyLiveStatusResponseSchema = z.record(streamTypeSchema, legacyStreamInfoSchema);

export const liveStatusResponseSchema = z.union([
    normalizedLiveStatusResponseSchema,
    legacyLiveStatusResponseSchema.transform((response) => {
        const streams: StreamInfo[] = Object.values(response).map((stream) => ({
            type: stream.meeting_type,
            participant_count: stream.participants,
            ...(stream.price_per_minute == null ? {} : { price_per_minute: stream.price_per_minute }),
            ...(stream.meeting_id == null ? {} : { meeting_id: stream.meeting_id }),
        }));

        return {
            is_live: streams.length > 0,
            participant_count: streams.reduce((total, stream) => total + stream.participant_count, 0),
            streams,
        };
    }),
]);

export type LiveStatusResponse = z.infer<typeof liveStatusResponseSchema>;

export const liveStatusQueryKey = (username: string) => ['live-status', username] as const;

export function shouldRetryLiveStatusRequest(failureCount: number, error: unknown) {
    if (failureCount >= 2 || error instanceof z.ZodError) {
        return false;
    }

    if (error instanceof ApiError) {
        return error.status === 408 || error.status === 429 || error.status >= 500;
    }

    return !(error instanceof Error && error.name === 'AbortError');
}

export class PaymentRequiredError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PaymentRequiredError';
    }
}

export class StreamService {
    /**
     * Initialize a stream (join or start)
     * @param username The username of the creator
     * @param type The type of stream (broadcast, subscribers-only, ppv)
     * @param pricePerMinute Optional price for PPV
     */
    static async initStream(
        username: string,
        type: StreamType,
        pricePerMinute?: number
    ): Promise<StreamInitResponse> {
        try {
            const body = pricePerMinute ? { price_per_minute: pricePerMinute } : {};
            // The generated type is void, but the API returns data
            const response = await dyteCreate(username, type, {
                body: JSON.stringify(body)
            }) as unknown;

            return streamInitResponseSchema.parse(response);
        } catch (error) {
            if (error instanceof z.ZodError) {
                console.error('Stream initialization response validation failed:', error.errors);
                throw new Error('Invalid response from server');
            }
            if (error instanceof ApiError) {
                switch (error.status) {
                    case 402:
                        throw new PaymentRequiredError(type === 'subscribers-only'
                            ? 'You must be a subscriber to join this stream.'
                            : error.data || 'Payment required to join this stream.');
                    case 403:
                        throw new Error('Creator not authorized to stream.');
                    case 404:
                        throw new Error('Creator not found or stream does not exist.');
                    case 412:
                        throw new Error('The creator is not currently live.');
                    default:
                        throw new Error(error.data?.detail || error.message || 'Failed to join stream.');
                }
            }
            throw error;
        }
    }

    /**
     * Fetch and validate a creator's live status.
     * Unlike checkLiveStatus, this lets request errors propagate so query clients
     * can retry, back off, and preserve the last known status.
     */
    static async fetchLiveStatus(username: string, signal?: AbortSignal): Promise<LiveStatusResponse> {
        const response = await dyteLiveStatusRetrieve(username, undefined, signal) as unknown;
        return liveStatusResponseSchema.parse(response);
    }

    /**
     * Check if a creator is currently live
     * @param username The username to check
     */
    static async checkLiveStatus(username: string): Promise<LiveStatusResponse> {
        try {
            return await this.fetchLiveStatus(username);
        } catch (error) {
            if (error instanceof z.ZodError) {
                console.error('Live status response validation failed:', error.errors);
            } else {
                console.error('Failed to check live status:', error);
            }
            // Default to not live on request or validation errors
            return { is_live: false, participant_count: 0, streams: [] };
        }
    }

    /**
     * Create a private meeting secret link
     * @param username The creator's username
     */
    static async createPrivateStream(username: string): Promise<PrivateStreamCreateResponse> {
        try {
            const response = await dytePrivateCreate(username) as unknown;
            return privateStreamCreateResponseSchema.parse(response);
        } catch (error) {
            if (error instanceof z.ZodError) {
                console.error('Private stream creation response validation failed:', error.errors);
                throw new Error('Invalid response from server');
            }
            throw error;
        }
    }

    /**
     * Join a private stream using a secret
     * @param username The creator's username
     * @param secret The secret UUID
     */
    static async joinPrivateStream(username: string, secret: string): Promise<StreamInitResponse> {
        try {
            const response = await dytePrivateCreate2(username, secret) as unknown;
            return streamInitResponseSchema.parse(response);
        } catch (error) {
            if (error instanceof z.ZodError) {
                console.error('Private stream response validation failed:', error.errors);
                throw new Error('Invalid response from server');
            }
            throw error;
        }
    }
}
