import {
  ApiError,
  getTokenSnapshot,
  onTokenChange,
  request,
  type TokenSnapshot,
} from "./http";

/** Safe to hand through route state; credentials stay in process memory. */
export interface HostSeat {
  session: string;
  username: string;
  actorId: number;
}

interface OwnedSeat {
  identity: HostSeat;
  auth: TokenSnapshot;
  closed: boolean;
  listeners: Set<() => void>;
  timer?: ReturnType<typeof setInterval>;
  disposal?: ReturnType<typeof setTimeout>;
  abort?: AbortController;
  unwatch?: () => void;
}
const owned = new Map<string, OwnedSeat>();

export function registerHostSeat(
  username: string,
  actorId: number,
  auth: TokenSnapshot
): HostSeat {
  const identity = { username, actorId, session: crypto.randomUUID() };
  owned.set(identity.session, {
    identity,
    auth,
    closed: false,
    listeners: new Set(),
  });
  return identity;
}

function sameActor(entry: OwnedSeat) {
  const current = getTokenSnapshot();
  return (
    !!entry.auth.token &&
    current.token === entry.auth.token &&
    current.generation === entry.auth.generation
  );
}

export function isCurrentHostSeat(seat: HostSeat) {
  const entry = owned.get(seat.session);
  return (
    !!entry &&
    !entry.closed &&
    entry.identity.username === seat.username &&
    entry.identity.actorId === seat.actorId &&
    sameActor(entry)
  );
}

async function send(
  entry: OwnedSeat,
  action: "heartbeat" | "release",
  signal: AbortSignal
) {
  if (!sameActor(entry)) return;
  return request(
    `/api/dyte/${encodeURIComponent(entry.identity.username)}/host-session`,
    {
      method: "POST",
      body: { host_session: entry.identity.session, action },
      authToken: entry.auth.token!,
      signal,
    }
  );
}

export function releaseHostSeat(seat: HostSeat, release = true) {
  const entry = owned.get(seat.session);
  if (!entry || entry.closed) return;
  entry.closed = true;
  clearInterval(entry.timer);
  clearTimeout(entry.disposal);
  entry.abort?.abort();
  entry.unwatch?.();
  owned.delete(seat.session);
  if (release && sameActor(entry)) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    void send(entry, "release", controller.signal)
      .catch(() => {})
      .finally(() => clearTimeout(timeout));
  }
}

/** One lease survives StrictMode replay and SDK reconnects with the same ticket. */
export function retainHostSeat(seat: HostSeat, onLost: () => void): () => void {
  const entry = owned.get(seat.session);
  if (!entry || !isCurrentHostSeat(seat)) {
    onLost();
    return () => {};
  }
  clearTimeout(entry.disposal);
  entry.listeners.add(onLost);
  const lose = () => {
    const listeners = [...entry.listeners];
    releaseHostSeat(seat, false);
    listeners.forEach((listener) => listener());
  };
  if (!entry.timer) {
    entry.unwatch = onTokenChange(lose);
    const beat = async () => {
      if (entry.closed || entry.abort) return;
      if (!sameActor(entry)) return lose();
      const controller = new AbortController();
      entry.abort = controller;
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        await send(entry, "heartbeat", controller.signal);
      } catch (error) {
        if (
          !entry.closed &&
          error instanceof ApiError &&
          error.status === 409 &&
          (error.body as { code?: string })?.code === "host_session_superseded"
        )
          lose();
      } finally {
        clearTimeout(timeout);
        if (entry.abort === controller) entry.abort = undefined;
      }
    };
    entry.timer = setInterval(() => void beat(), 15_000);
    void beat();
  }
  return () => {
    entry.listeners.delete(onLost);
    if (!entry.listeners.size)
      entry.disposal = setTimeout(() => releaseHostSeat(seat), 0);
  };
}
