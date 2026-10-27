import {
  dyteCreate,
  dyteHostSessionCreate,
  dyteHostSessionRetrieve,
  dyteLiveStatusRetrieve,
  dytePrivateCreate,
  dytePrivateCreate2,
  dytePrivateRetrieve,
} from "$lib/api/dyte/dyte";
import type {
  HostSessionStatus,
  MeetingJoinRequestSchema,
} from "$lib/api/f2z.schemas";
import { get } from "svelte/store";
import { authStore, authStatus, currentUser } from "$lib/stores/auth";
import { hostSeatConflict } from "$lib/utils/host-seat.js";
import { ApiError } from "$lib/api/mutator";
import {
  insufficientFundsFromError,
  type InsufficientFundsDetails,
} from "$lib/insufficient-funds";
import {
  defineMessage,
  LocalizedError,
  localizedError,
  type MessageDescriptor,
} from "$lib/i18n-message";
import { PUBLIC_STREAM_TYPES, STREAM_TYPES } from "$lib/streamTypes.js";
import { z } from "zod";

/**
 * The stream types `/api/dyte/{username}/{type}` actually serves. The generated
 * client narrowed this from `string` to a union once f2z.yaml documented the
 * enum, which is what exposed `private` as never having belonged here.
 */
export type PublicStreamType = (typeof PUBLIC_STREAM_TYPES)[number];

const STREAM_MESSAGES = {
  actorChanged: defineMessage(
    "economy.signInAgain",
    "Sign in again before continuing.",
  ),
  verificationUnavailable: defineMessage(
    "stream.errors.verificationUnavailable",
    "We couldn't verify your account just now. Please retry.",
  ),
  invalidResponse: defineMessage(
    "stream.errors.invalidResponse",
    "The server returned an invalid stream response.",
  ),
  subscriberRequired: defineMessage(
    "stream.errors.subscriberRequired",
    "You must be a subscriber to join this stream.",
  ),
  paymentRequired: defineMessage(
    "stream.errors.paymentRequired",
    "Payment is required to join this stream.",
  ),
  creatorNotAuthorized: defineMessage(
    "stream.errors.creatorNotAuthorized",
    "This creator is not authorized to stream.",
  ),
  creatorNotFound: defineMessage(
    "stream.errors.creatorNotFound",
    "The creator or stream could not be found.",
  ),
  creatorNotLive: defineMessage(
    "stream.errors.creatorNotLive",
    "This creator is not currently live.",
  ),
  joinFailed: defineMessage(
    "stream.errors.joinFailed",
    "Failed to join stream.",
  ),
  privateStreamCreateFailed: defineMessage(
    "stream.errors.privateStreamCreateFailed",
    "Could not create the private stream.",
  ),
  privateStreamJoinFailed: defineMessage(
    "stream.errors.privateStreamJoinFailed",
    "Could not join the private stream.",
  ),
  alreadyLiveElsewhere: defineMessage(
    "stream.errors.alreadyLiveElsewhere",
    "You are already live in another tab or on another device.",
  ),
};

export const streamInitResponseSchema = z.object({
  e2ee: z.boolean().optional(),
  auth_token: z.string(),
  room_name: z.string().optional(),
  meeting_id: z.string().optional(),
  // Host starts only: the broadcaster seat this tab now holds.
  host_session: z.string().optional(),
  meeting_type: z.enum(PUBLIC_STREAM_TYPES).optional(),
  resumed: z.boolean().optional(),
});

export type StreamInitResponse = z.infer<typeof streamInitResponseSchema>;

export const privateStreamCreateResponseSchema = z.object({
  secret: z.string(),
});

export type PrivateStreamCreateResponse = z.infer<
  typeof privateStreamCreateResponseSchema
>;

// A creator's live-status payload may legitimately mention a private room, so
// this stays the full enum — unlike the join argument below.
const streamTypeSchema = z.enum(STREAM_TYPES);

export const streamInfoSchema = z.object({
  type: streamTypeSchema,
  // Public discovery (the bounded live rail) omits the viewer count, so this
  // stays optional rather than becoming a false zero in the UI.
  participant_count: z.number().optional(),
  // Django DecimalField values arrive as strings. Keep numbers accepted for
  // the legacy stream payload, but never coerce the authoritative price with
  // Number() at the payment boundary.
  price_per_minute: z.union([z.string(), z.number()]).optional(),
  meeting_id: z.string().optional(),
});

export type StreamInfo = z.infer<typeof streamInfoSchema>;

const normalizedLiveStatusResponseSchema = z.object({
  is_live: z.boolean(),
  // Public discovery cannot provide a viewer count. Preserve an omitted count
  // as unavailable instead of turning it into a false zero in the UI.
  participant_count: z.number().optional(),
  streams: z.array(streamInfoSchema).default([]),
});

const legacyStreamInfoSchema = z.object({
  meeting_type: streamTypeSchema,
  participants: z.number(),
  price_per_minute: z.union([z.string(), z.number()]).nullable().optional(),
  meeting_id: z.string().optional(),
});

const legacyLiveStatusResponseSchema = z.partialRecord(
  streamTypeSchema,
  legacyStreamInfoSchema,
);

export const liveStatusResponseSchema = z.union([
  normalizedLiveStatusResponseSchema,
  legacyLiveStatusResponseSchema.transform((response) => {
    const streams: StreamInfo[] = Object.values(response).map((stream) => ({
      type: stream.meeting_type,
      participant_count: stream.participants,
      ...(stream.price_per_minute == null
        ? {}
        : { price_per_minute: stream.price_per_minute }),
      ...(stream.meeting_id == null ? {} : { meeting_id: stream.meeting_id }),
    }));

    return {
      is_live: streams.length > 0,
      participant_count: streams.reduce(
        (total, stream) => total + (stream.participant_count ?? 0),
        0,
      ),
      streams,
    };
  }),
]);

export type LiveStatusResponse = z.infer<typeof liveStatusResponseSchema>;

export const liveStatusQueryKey = (username: string) =>
  ["live-status", username] as const;

export function shouldRetryLiveStatusRequest(
  failureCount: number,
  error: unknown,
) {
  if (failureCount >= 2 || error instanceof z.ZodError) {
    return false;
  }

  if (error instanceof ApiError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }

  return !(error instanceof Error && error.name === "AbortError");
}

export class PaymentRequiredError extends LocalizedError {
  funds: InsufficientFundsDetails | null;

  constructor(
    descriptor: MessageDescriptor = STREAM_MESSAGES.paymentRequired,
    funds: InsufficientFundsDetails | null = null,
  ) {
    super(descriptor);
    this.name = "PaymentRequiredError";
    this.funds = funds;
  }
}

/**
 * The creator already broadcasts from another tab or device. The
 * server created, joined and rotated nothing; the caller shows the "live
 * elsewhere" state and may retry with `takeover: true`.
 */
export class AlreadyLiveElsewhereError extends LocalizedError {
  meetingType: PublicStreamType | null;

  constructor(meetingType: PublicStreamType | null) {
    super(STREAM_MESSAGES.alreadyLiveElsewhere);
    this.name = "AlreadyLiveElsewhereError";
    this.meetingType = meetingType;
  }
}

export interface InitStreamOptions {
  pricePerMinute?: number;
  /** Original displayed viewer; automatic retries must never replace it. */
  expectedActorId?: number;
  /** Cancel admission when the original viewer leaves this page. */
  signal?: AbortSignal;
  /**
   * `host` from the broadcaster dashboard, `viewer` from every public stream
   * page -- including the creator's own, which must never publish.
   */
  role?: "host" | "viewer";
  hostSession?: string;
  takeover?: boolean;
}

export function isSubscriptionEntitlementError(value: unknown): boolean {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    (value as { code?: unknown }).code === "subscription_required"
  );
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
    type: PublicStreamType,
    options: InitStreamOptions = {},
  ): Promise<StreamInitResponse> {
    const {
      pricePerMinute,
      role,
      hostSession,
      takeover,
      expectedActorId,
      signal,
    } = options;
    const originalViewerId =
      type === "ppv" && role !== "host"
        ? (expectedActorId ?? get(currentUser)?.id)
        : undefined;
    try {
      signal?.throwIfAborted();
      if (type === "ppv" && role !== "host") {
        const authenticated = await authStore.checkAuth({
          fresh: true,
          force: true,
          silent: true,
        });
        signal?.throwIfAborted();
        const actual = get(currentUser);
        if (
          !originalViewerId ||
          !Number.isSafeInteger(originalViewerId) ||
          originalViewerId <= 0 ||
          (actual && actual.id !== originalViewerId) ||
          get(authStatus) === "anonymous"
        )
          throw localizedError(STREAM_MESSAGES.actorChanged);
        if (authenticated !== true)
          throw localizedError(STREAM_MESSAGES.verificationUnavailable);
        if (actual?.id !== originalViewerId)
          throw localizedError(STREAM_MESSAGES.actorChanged);
      }
      const instruction = {
        ...(role ? { role } : {}),
        ...(hostSession ? { host_session: hostSession } : {}),
        ...(takeover ? { takeover: true } : {}),
        ...(pricePerMinute ? { price_per_minute: String(pricePerMinute) } : {}),
        ...(originalViewerId ? { expected_actor_id: originalViewerId } : {}),
      };
      const body: MeetingJoinRequestSchema = instruction;
      // `/api/dyte/{username}/{type}` is a CLOSED enum in the contract — its
      // URL pattern matches only the three public types. The argument is typed
      // as that same enum now rather than cast to it: a private room is not
      // joined here at all, it is joined at `/{username}/private/{secret}`
      // through `joinPrivateStream` below.
      const response = (await dyteCreate(
        username,
        type,
        body,
        undefined,
        signal,
      )) as unknown;
      signal?.throwIfAborted();

      return streamInitResponseSchema.parse(response);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof z.ZodError) {
        console.error(
          "Stream initialization response validation failed:",
          error.issues,
        );
        throw localizedError(STREAM_MESSAGES.invalidResponse, undefined, error);
      }
      if (error instanceof ApiError) {
        switch (error.status) {
          case 402:
            throw new PaymentRequiredError(
              isSubscriptionEntitlementError(error.data) ||
                type === "subscribers-only"
                ? STREAM_MESSAGES.subscriberRequired
                : STREAM_MESSAGES.paymentRequired,
              insufficientFundsFromError(error),
            );
          case 403:
            throw localizedError(STREAM_MESSAGES.creatorNotAuthorized);
          case 404:
            throw localizedError(STREAM_MESSAGES.creatorNotFound);
          case 409: {
            if (error.data?.code === "actor_changed")
              throw localizedError(STREAM_MESSAGES.actorChanged);
            const conflict = hostSeatConflict(error);
            if (conflict) {
              throw new AlreadyLiveElsewhereError(
                (PUBLIC_STREAM_TYPES as readonly string[]).includes(
                  conflict.meetingType ?? "",
                )
                  ? (conflict.meetingType as PublicStreamType)
                  : null,
              );
            }
            throw localizedError(STREAM_MESSAGES.joinFailed, undefined, error);
          }
          case 412:
            throw localizedError(STREAM_MESSAGES.creatorNotLive);
          default:
            throw localizedError(STREAM_MESSAGES.joinFailed, undefined, error);
        }
      }
      if (error instanceof LocalizedError) throw error;
      throw localizedError(STREAM_MESSAGES.joinFailed, undefined, error);
    }
  }

  /**
   * Fetch and validate a creator's live status.
   * Unlike checkLiveStatus, this lets request errors propagate so query clients
   * can retry, back off, and preserve the last known status.
   */
  static async fetchLiveStatus(
    username: string,
    signal?: AbortSignal,
  ): Promise<LiveStatusResponse> {
    const response = (await dyteLiveStatusRetrieve(
      username,
      undefined,
      signal,
    )) as unknown;
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
        console.error("Live status response validation failed:", error.issues);
      } else {
        console.error("Failed to check live status:", error);
      }
      // Default to not live on request or validation errors
      return { is_live: false, participant_count: 0, streams: [] };
    }
  }

  /** Who holds the caller's broadcaster seat. Owner only. */
  static async fetchHostSeat(username: string): Promise<HostSessionStatus> {
    return (await dyteHostSessionRetrieve(username)) as HostSessionStatus;
  }

  /**
   * Renew this tab's broadcaster seat. Rejects with the server's 409
   * (`host_session_superseded`) once another tab or device took it over.
   */
  static async heartbeatHostSeat(
    username: string,
    hostSession: string,
  ): Promise<HostSessionStatus> {
    return (await dyteHostSessionCreate(username, {
      host_session: hostSession,
      action: "heartbeat",
    })) as HostSessionStatus;
  }

  /**
   * Give the seat back when this tab stops broadcasting. Best effort and
   * idempotent: a seat that is not renewed lapses on its own, and releasing
   * one this tab no longer holds is a no-op on the server. `keepalive` lets
   * the request outlive a page that is being unloaded.
   */
  static async releaseHostSeat(
    username: string,
    hostSession: string,
    { keepalive = false }: { keepalive?: boolean } = {},
  ): Promise<void> {
    try {
      await dyteHostSessionCreate(
        username,
        { host_session: hostSession, action: "release" },
        keepalive ? { keepalive: true } : undefined,
      );
    } catch (error) {
      console.warn("Could not release the broadcaster seat:", error);
    }
  }

  /**
   * Create a private meeting secret link
   * @param username The creator's username
   */
  static async currentPrivateStream(
    username: string,
  ): Promise<PrivateStreamCreateResponse> {
    return privateStreamCreateResponseSchema.parse(
      await dytePrivateRetrieve(username),
    );
  }

  static async createPrivateStream(
    username: string,
  ): Promise<PrivateStreamCreateResponse> {
    try {
      const response = (await dytePrivateCreate(username)) as unknown;
      return privateStreamCreateResponseSchema.parse(response);
    } catch (error) {
      if (error instanceof z.ZodError) {
        console.error(
          "Private stream creation response validation failed:",
          error.issues,
        );
        throw localizedError(STREAM_MESSAGES.invalidResponse, undefined, error);
      }
      if (error instanceof ApiError) {
        const recordingMessages: Record<string, MessageDescriptor> = {
          recording_active: defineMessage(
            "privateCall.recordingActive",
            "Stop recording before creating another private link.",
          ),
          recording_delivery_failed: defineMessage(
            "privateCall.recordingDeliveryFailed",
            "The recording could not be saved. Return to the current call or contact support before replacing its private link.",
          ),
          recording_delivery_pending: defineMessage(
            "privateCall.recordingDeliveryPending",
            "The recording is processing. Wait for it to appear in your uploads, then retry creating the private link.",
          ),
          recording_status_unknown: defineMessage(
            "privateCall.recordingStatusUnknown",
            "Recording status could not be confirmed. Retry before creating another private link.",
          ),
        };
        const message = recordingMessages[error.data?.code];
        if (message) throw localizedError(message, undefined, error);
      }
      if (error instanceof LocalizedError) throw error;
      throw localizedError(
        STREAM_MESSAGES.privateStreamCreateFailed,
        undefined,
        error,
      );
    }
  }

  /**
   * Join a private stream using a secret
   * @param username The creator's username
   * @param secret The secret UUID
   */
  static async joinPrivateStream(
    username: string,
    secret: string,
    signal?: AbortSignal,
  ): Promise<StreamInitResponse> {
    try {
      const response = (await dytePrivateCreate2(
        username,
        secret,
        undefined,
        signal,
      )) as unknown;
      return streamInitResponseSchema.parse(response);
    } catch (error) {
      if (error instanceof z.ZodError) {
        console.error(
          "Private stream response validation failed:",
          error.issues,
        );
        throw localizedError(STREAM_MESSAGES.invalidResponse, undefined, error);
      }
      if (error instanceof LocalizedError) throw error;
      throw localizedError(
        STREAM_MESSAGES.privateStreamJoinFailed,
        undefined,
        error,
      );
    }
  }
}
