// Typed event subscription — one interface over both runtime modes, so no
// screen branches on which engine it is talking to (§5.3).
//
// Events are notifications that state changed, not the state and not a log:
// they may be coalesced, and they may be missed. After every transition into
// `running`, and on window focus, the UI must re-read rather than trust its
// in-memory state (§5.2).

import { useMock } from "../platform";
import {
  AlarmSchema,
  ContactRequestSchema,
  ConversationSchema,
  DeliveryStatusSchema,
  EngineStatusSchema,
  GapSchema,
  MessageSchema,
  PurgeRequestStatusSchema,
  RelayConfigSchema,
} from "./types";
import { z } from "zod";

/**
 * Every event mapped to its payload schema. The parity test asserts the mock
 * emits each one at least once and that each payload parses, so an event added
 * without an entry here fails the build (§4.1).
 */
export const EVENTS = {
  "f2zmsg://engine-state": EngineStatusSchema,
  /** Emitted only after the durable write — the frontend half of §9 rule 1. */
  "f2zmsg://message-received": z.object({
    conversationId: z.string(),
    message: MessageSchema,
  }),
  "f2zmsg://message-state": DeliveryStatusSchema,
  "f2zmsg://conversation-updated": ConversationSchema,
  "f2zmsg://contact-request": ContactRequestSchema,
  /** Never silent: a gap is a certainty, not a suspicion. */
  "f2zmsg://gap-detected": GapSchema,
  "f2zmsg://gap-repaired": GapSchema,
  /** Critical alarms are non-dismissible by construction. */
  "f2zmsg://alarm": AlarmSchema,
  "f2zmsg://relay-state": RelayConfigSchema,
  "f2zmsg://retention-expired": z.object({
    conversationId: z.string(),
    msgIds: z.array(z.string()),
  }),
  "f2zmsg://purge-progress": PurgeRequestStatusSchema,
} as const;

export type EventName = keyof typeof EVENTS;
export type EventPayload<E extends EventName> = z.infer<(typeof EVENTS)[E]>;

type Handler<E extends EventName> = (payload: EventPayload<E>) => void;

export type Unlisten = () => void;

const mockHandlers = new Map<EventName, Set<(payload: unknown) => void>>();

/** For `mock.ts` and the parity test, not for feature code. */
export function emitMockEvent<E extends EventName>(
  name: E,
  payload: EventPayload<E>,
): void {
  const handlers = mockHandlers.get(name);
  if (!handlers) return;
  for (const handler of handlers) handler(payload);
}

export function resetMockEvents(): void {
  mockHandlers.clear();
}

/** Lets the parity test observe the emitter without forcing `useMock()`. */
export function subscribeMockEvent<E extends EventName>(
  name: E,
  handler: Handler<E>,
): Unlisten {
  return listenMock(name, handler);
}

function listenMock<E extends EventName>(
  name: E,
  handler: Handler<E>,
): Unlisten {
  const wrapped = handler as (payload: unknown) => void;
  let handlers = mockHandlers.get(name);
  if (!handlers) {
    handlers = new Set();
    mockHandlers.set(name, handlers);
  }
  handlers.add(wrapped);
  return () => {
    handlers.delete(wrapped);
  };
}

/**
 * Async because the Tauri path imports its API lazily; the mock resolves
 * immediately and takes the same shape so callers have one code path.
 */
export async function listenMessaging<E extends EventName>(
  name: E,
  handler: Handler<E>,
): Promise<Unlisten> {
  if (useMock()) return listenMock(name, handler);

  const { listen } = await import("@tauri-apps/api/event");
  // Parsed in every build: event payloads are small and infrequent, and a
  // renamed field here fails silently in exactly the way this module exists to
  // prevent.
  const unlisten = await listen(name, (event) => {
    const parsed = EVENTS[name].safeParse(event.payload);
    if (!parsed.success) {
      throw new Error(
        `f2zmsg event "${name}" payload does not match its declared schema: ${parsed.error.message}`,
      );
    }
    handler(parsed.data as EventPayload<E>);
  });
  return unlisten;
}
