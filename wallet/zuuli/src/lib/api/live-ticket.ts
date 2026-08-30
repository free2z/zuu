import type { DyteJoinTicket } from "./types";

export type LiveTicketFailureCode =
  | "malformed-ticket"
  | "expired-ticket"
  | "meeting-mismatch"
  | "environment-mismatch"
  | "replayed-ticket";

const SAFE_MESSAGES: Record<LiveTicketFailureCode, string> = {
  "malformed-ticket":
    "The stream server returned an invalid join ticket. Try again.",
  "expired-ticket":
    "The join ticket expired before the connection started. Try again for a fresh ticket.",
  "meeting-mismatch":
    "The stream changed while you were joining. Return to livestreams and open it again.",
  "environment-mismatch":
    "The stream service changed while you were joining. Return to livestreams and open it again.",
  "replayed-ticket":
    "The stream server did not issue a fresh join ticket. Try again in a moment.",
};

/**
 * A deliberately content-free failure. The raw response, token, decoded
 * claims, meeting identifiers, and participant identity must never cross this
 * boundary into UI copy or diagnostics.
 */
export class LiveTicketError extends Error {
  readonly code: LiveTicketFailureCode;

  constructor(code: LiveTicketFailureCode) {
    super(SAFE_MESSAGES[code]);
    this.name = "LiveTicketError";
    this.code = code;
  }
}

interface ParticipantTokenBinding {
  meetingId: string;
  environmentId: string;
  expiresAt?: number;
}

export interface JoinTicketConstraints {
  as: "host" | "participant";
  /** Public join/start responses are contractually required to carry this. */
  responseMeetingIdRequired: boolean;
  /** The listing/previous ticket the user explicitly chose to join. */
  expectedMeetingId?: string;
  /** A refresh must stay on the same provider tenant/environment. */
  expectedEnvironmentId?: string;
  /** A refresh must never silently replay the credential that just failed. */
  previousAuthToken?: string;
  nowMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function opaqueId(value: unknown): string | null {
  if (typeof value !== "string" || value !== value.trim()) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) return null;
  return value;
}

function decodeBase64UrlJson(segment: string): unknown {
  if (
    segment.length === 0 ||
    segment.length > 12_000 ||
    !/^[A-Za-z0-9_-]+$/.test(segment)
  ) {
    throw new LiveTicketError("malformed-ticket");
  }
  const padding = "=".repeat((4 - (segment.length % 4)) % 4);
  try {
    const binary = atob(segment.replace(/-/g, "+").replace(/_/g, "/") + padding);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    throw new LiveTicketError("malformed-ticket");
  }
}

/**
 * Decode only the provider binding and expiry claims required before handing a
 * credential to RealtimeKit. This does not verify JWT authenticity; TLS and
 * the authoritative Free2Z response provide that boundary. It only fails
 * closed when the response and provider token disagree.
 */
function participantTokenBinding(
  authToken: string,
  nowMs: number,
): ParticipantTokenBinding {
  if (
    authToken.length === 0 ||
    authToken.length > 16_384 ||
    authToken !== authToken.trim()
  ) {
    throw new LiveTicketError("malformed-ticket");
  }
  const segments = authToken.split(".");
  if (
    segments.length !== 3 ||
    segments.some(
      (segment) => segment.length === 0 || !/^[A-Za-z0-9_-]+$/.test(segment),
    )
  ) {
    throw new LiveTicketError("malformed-ticket");
  }

  const payload = decodeBase64UrlJson(segments[1]!);
  if (!isRecord(payload)) throw new LiveTicketError("malformed-ticket");

  // These are the exact camelCase claims consumed by RealtimeKit 1.x.
  const meetingId = opaqueId(payload.meetingId);
  const environmentId = opaqueId(payload.orgId);
  if (!meetingId || !environmentId || !opaqueId(payload.participantId)) {
    throw new LiveTicketError("malformed-ticket");
  }

  let expiresAt: number | undefined;
  if (payload.exp !== undefined) {
    if (
      typeof payload.exp !== "number" ||
      !Number.isSafeInteger(payload.exp) ||
      payload.exp <= 0 ||
      payload.exp > Math.floor(Number.MAX_SAFE_INTEGER / 1_000)
    ) {
      throw new LiveTicketError("malformed-ticket");
    }
    expiresAt = payload.exp;
    if (expiresAt * 1_000 <= nowMs) {
      throw new LiveTicketError("expired-ticket");
    }
  }

  return { meetingId, environmentId, expiresAt };
}

function optionalOpaqueId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const parsed = opaqueId(value);
  if (!parsed) throw new LiveTicketError("malformed-ticket");
  return parsed;
}

/** Strictly convert the untrusted HTTP response into the only ticket shape UI accepts. */
export function parseJoinTicketResponse(
  value: unknown,
  constraints: JoinTicketConstraints,
): DyteJoinTicket {
  if (!isRecord(value)) throw new LiveTicketError("malformed-ticket");
  if (typeof value.auth_token !== "string") {
    throw new LiveTicketError("malformed-ticket");
  }

  const binding = participantTokenBinding(
    value.auth_token,
    constraints.nowMs ?? Date.now(),
  );
  const responseMeetingId = optionalOpaqueId(value.meeting_id);
  if (constraints.responseMeetingIdRequired && !responseMeetingId) {
    throw new LiveTicketError("malformed-ticket");
  }
  if (responseMeetingId && responseMeetingId !== binding.meetingId) {
    throw new LiveTicketError("meeting-mismatch");
  }

  const meetingId = responseMeetingId ?? binding.meetingId;
  if (
    constraints.expectedMeetingId &&
    meetingId !== constraints.expectedMeetingId
  ) {
    throw new LiveTicketError("meeting-mismatch");
  }
  if (
    constraints.expectedEnvironmentId &&
    binding.environmentId !== constraints.expectedEnvironmentId
  ) {
    throw new LiveTicketError("environment-mismatch");
  }
  if (
    constraints.previousAuthToken &&
    value.auth_token === constraints.previousAuthToken
  ) {
    throw new LiveTicketError("replayed-ticket");
  }

  const roomName = optionalOpaqueId(value.room_name);
  return {
    authToken: value.auth_token,
    meetingId,
    environmentId: binding.environmentId,
    ...(binding.expiresAt === undefined
      ? {}
      : { expiresAt: binding.expiresAt }),
    ...(roomName === undefined ? {} : { roomName }),
    as: constraints.as,
  };
}
