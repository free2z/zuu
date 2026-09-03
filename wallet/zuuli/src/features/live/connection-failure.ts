import { ApiError } from "@/lib/api/http";
import { LiveTicketError } from "@/lib/api/live-ticket";
import { MESSAGE_KEYS, type MessageKey } from "@/i18n/messages";

export type LiveFailureBoundary =
  | "ticket-request"
  | "ticket-refresh"
  | "sdk-init"
  | "room-session";

export type LiveFailureKind =
  | "policy"
  | "offline"
  | "transport"
  | "timeout"
  | "malformed-ticket"
  | "expired-ticket"
  | "replayed-ticket"
  | "token-rejected"
  | "ended-room"
  | "lifecycle-race"
  | "unknown";

export interface LiveConnectionFailure {
  kind: LiveFailureKind;
  boundary: LiveFailureBoundary;
  messageKey: MessageKey;
  retryable: boolean;
  /** Allowlisted provider code only; never the provider's raw message. */
  providerCode?: "ERR0001" | "ERR0004";
}

const COPY: Record<LiveFailureKind, { messageKey: MessageKey; retryable: boolean }> = {
  policy: {
    messageKey: MESSAGE_KEYS.liveFailurePolicy,
    retryable: true,
  },
  offline: {
    messageKey: MESSAGE_KEYS.liveFailureOffline,
    retryable: true,
  },
  transport: {
    messageKey: MESSAGE_KEYS.liveFailureTransport,
    retryable: true,
  },
  timeout: {
    messageKey: MESSAGE_KEYS.liveFailureTimeout,
    retryable: true,
  },
  "malformed-ticket": {
    messageKey: MESSAGE_KEYS.liveFailureMalformedTicket,
    retryable: true,
  },
  "expired-ticket": {
    messageKey: MESSAGE_KEYS.liveFailureExpiredTicket,
    retryable: true,
  },
  "replayed-ticket": {
    messageKey: MESSAGE_KEYS.liveFailureReplayedTicket,
    retryable: true,
  },
  "token-rejected": {
    messageKey: MESSAGE_KEYS.liveFailureTokenRejected,
    retryable: true,
  },
  "ended-room": {
    messageKey: MESSAGE_KEYS.liveFailureEndedRoom,
    retryable: false,
  },
  "lifecycle-race": {
    messageKey: MESSAGE_KEYS.liveFailureLifecycleRace,
    retryable: false,
  },
  unknown: {
    messageKey: MESSAGE_KEYS.liveFailureUnknown,
    retryable: true,
  },
};

function errorName(error: unknown): string {
  return error instanceof Error
    ? error.name
    : typeof error === "object" && error !== null && "name" in error
      ? String((error as { name?: unknown }).name ?? "")
      : "";
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message.toLowerCase();
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message?: unknown }).message ?? "").toLowerCase();
  }
  return "";
}

function providerCode(text: string): LiveConnectionFailure["providerCode"] {
  if (/\b(?:err)?0004\b/i.test(text)) return "ERR0004";
  if (/\b(?:err)?0001\b/i.test(text)) return "ERR0001";
  return undefined;
}

function makeFailure(
  kind: LiveFailureKind,
  boundary: LiveFailureBoundary,
  code?: LiveConnectionFailure["providerCode"],
): LiveConnectionFailure {
  return { kind, boundary, ...COPY[kind], ...(code ? { providerCode: code } : {}) };
}

/** Classify raw failures once, then discard their potentially sensitive text. */
export function classifyLiveFailure(
  error: unknown,
  boundary: LiveFailureBoundary,
  online = typeof navigator === "undefined" ? true : navigator.onLine !== false,
): LiveConnectionFailure {
  if (error instanceof LiveTicketError) {
    const kind: LiveFailureKind =
      error.code === "meeting-mismatch" ||
      error.code === "environment-mismatch"
        ? "lifecycle-race"
        : error.code === "malformed-ticket"
          ? "malformed-ticket"
          : error.code === "expired-ticket"
            ? "expired-ticket"
            : error.code === "replayed-ticket"
              ? "replayed-ticket"
            : "unknown";
    return makeFailure(kind, boundary);
  }

  if (error instanceof ApiError) {
    if ([404, 410, 412].includes(error.status)) {
      return makeFailure("ended-room", boundary);
    }
    if (error.status === 409) return makeFailure("lifecycle-race", boundary);
    if ([408, 504].includes(error.status)) return makeFailure("timeout", boundary);
    if ([401, 403].includes(error.status)) {
      return makeFailure("token-rejected", boundary);
    }
  }

  const name = errorName(error);
  const text = errorText(error);
  const code = providerCode(text);
  if (name === "PrivateRoomUnavailableError") {
    return makeFailure("ended-room", boundary, code);
  }
  if (
    name === "SecurityError" ||
    name === "NotAllowedError" ||
    /content security policy|blocked by (?:client|policy)|permission denied|not allowed/.test(
      text,
    )
  ) {
    return makeFailure("policy", boundary, code);
  }
  if (!online) return makeFailure("offline", boundary, code);
  if (
    name === "AbortError" ||
    name === "TimeoutError" ||
    /timed? out|timeout/.test(text)
  ) {
    return makeFailure("timeout", boundary, code);
  }
  if (
    code === "ERR0004" ||
    /auth(?:entication)? token|unauthori[sz]ed|token (?:expired|revoked|rejected)|wrong environment|invalid participant/.test(
      text,
    )
  ) {
    return makeFailure("token-rejected", boundary, code);
  }
  if (/meeting (?:ended|inactive)|room (?:ended|closed)/.test(text)) {
    return makeFailure("ended-room", boundary, code);
  }
  if (
    error instanceof TypeError ||
    /failed to fetch|networkerror|network request|websocket|unable to connect/.test(
      text,
    )
  ) {
    return makeFailure("transport", boundary, code);
  }
  return makeFailure("unknown", boundary, code);
}

/** Safe for telemetry/console/feedback: no raw error, credential, URL or ID. */
export function safeLiveDiagnostic(failure: LiveConnectionFailure): {
  boundary: LiveFailureBoundary;
  category: LiveFailureKind;
  providerCode?: "ERR0001" | "ERR0004";
} {
  return {
    boundary: failure.boundary,
    category: failure.kind,
    ...(failure.providerCode
      ? { providerCode: failure.providerCode }
      : {}),
  };
}
