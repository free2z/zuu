import { act, StrictMode, useState } from "react";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TestI18nProvider } from "@/i18n/test-provider";
import es from "@/i18n/locales/es.json";
import type { DyteJoinTicket } from "@/lib/api/types";

const controls = vi.hoisted(() => ({
  initMeeting: vi.fn(),
  rendered: [] as unknown[],
}));

vi.mock("@cloudflare/realtimekit", () => ({
  default: { init: controls.initMeeting },
}));
vi.mock("@cloudflare/realtimekit-react", () => ({
  RealtimeKitProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock("@cloudflare/realtimekit-react-ui", () => ({
  RtkMeeting: ({ meeting }: { meeting: unknown }) => {
    controls.rendered.push(meeting);
    return null;
  },
}));

type Listener = (payload?: unknown) => void;

const lastRendered = () => controls.rendered[controls.rendered.length - 1];

/** An event-emitter double with Core's on/off/removeListener surface. */
function emitter() {
  const listeners = new Map<string, Set<Listener>>();
  return {
    on(event: string, fn: Listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(fn);
    },
    off(event: string, fn: Listener) {
      listeners.get(event)?.delete(fn);
    },
    removeListener(event: string, fn: Listener) {
      listeners.get(event)?.delete(fn);
    },
    emit(event: string, payload?: unknown) {
      listeners.get(event)?.forEach((fn) => fn(payload));
    },
  };
}

/** A Core client double: `self` and `connectedMeetings` emitters, counted `leave()`. */
function fakeClient() {
  const self = emitter();
  const connectedMeetings = emitter();
  return {
    leave: vi.fn().mockResolvedValue(undefined),
    self,
    connectedMeetings,
    emit: self.emit,
  };
}

/**
 * Core's `init` lock: an overlapping call for the same token is REJECTED
 * (`UnsupportedConcurrentMethodExecution`), not queued.
 */
function lockedInit(clients: ReturnType<typeof fakeClient>[]) {
  const inFlight = new Set<string>();
  return vi.fn(async ({ authToken }: { authToken: string }) => {
    if (inFlight.has(authToken)) {
      const error = new Error("Unsupported concurrent calls on method: init.");
      error.name = "UnsupportedConcurrentMethodExecution";
      throw error;
    }
    inFlight.add(authToken);
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const next = clients.shift();
      if (!next) throw new Error("no client left");
      return next;
    } finally {
      inFlight.delete(authToken);
    }
  });
}

import { Stage } from "./Stage";

let root: Root;
let container: HTMLElement;
let restoreGlobals: () => void;

const firstTicket: DyteJoinTicket = {
  authToken: "first-private-token",
  meetingId: "selected-meeting",
  environmentId: "production-org",
  as: "participant",
};
const freshTicket: DyteJoinTicket = {
  ...firstTicket,
  authToken: "fresh-private-token",
};
const hostTicket: DyteJoinTicket = {
  ...firstTicket,
  authToken: "existing-host-token",
  as: "host",
};

async function installDom(online: boolean) {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id='root'></div></body></html>",
  );
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { protocol: "http:" },
  });
  Object.defineProperty(window.navigator, "onLine", {
    configurable: true,
    writable: true,
    value: online,
  });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    writable: true,
    value: "visible",
  });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window,
    document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  }
  restoreGlobals = () => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  };
  container = document.getElementById("root") as unknown as HTMLElement;
  const { createRoot } = await import("react-dom/client");
  root = createRoot(container);
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(async () => {
  controls.initMeeting.mockReset();
  controls.rendered.length = 0;
  await installDom(true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (root) await act(async () => root.unmount());
  restoreGlobals?.();
});

describe("RealtimeKit stage retry lifecycle", () => {
  it("discards raw provider errors and retries only with a fresh authoritative ticket", async () => {
    const rawSecret = "eyJ.private-identity.signature";
    controls.initMeeting
      .mockRejectedValueOnce(
        new Error(`[ERR0004] rejected ${rawSecret} at https://private.invalid/join`),
      )
      .mockResolvedValueOnce(fakeClient());
    const refresh = vi.fn().mockResolvedValue(freshTicket);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    function Harness() {
      const [ticket, setTicket] = useState(firstTicket);
      return (
        <TestI18nProvider>
          <Stage
            ticket={ticket}
            refreshTicket={refresh}
            onTicketRefreshed={setTicket}
          />
        </TestI18nProvider>
      );
    }

    await act(async () => root.render(<Harness />));
    await flush();
    expect(container.textContent).toContain("rejected this connection");
    expect(container.textContent).not.toContain(rawSecret);

    const button = container.querySelector("button");
    expect(button?.textContent).toBe("Try again");
    await act(async () => {
      button?.dispatchEvent(new window.Event("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(refresh).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledWith(firstTicket);
    expect(controls.initMeeting.mock.calls.map(([options]) => options.authToken)).toEqual([
      "first-private-token",
      "fresh-private-token",
    ]);
    const diagnostics = JSON.stringify(warn.mock.calls);
    expect(diagnostics).not.toContain(rawSecret);
    expect(diagnostics).not.toContain("private.invalid");
  });

  it("waits through an offline background and enables fresh-ticket retry after resume", async () => {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      writable: true,
      value: false,
    });
    controls.initMeeting.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const refresh = vi.fn().mockResolvedValue(freshTicket);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await act(async () =>
      root.render(
        <TestI18nProvider>
          <Stage
            ticket={firstTicket}
            refreshTicket={refresh}
            onTicketRefreshed={() => {}}
          />
        </TestI18nProvider>,
      ),
    );
    await flush();
    const button = container.querySelector("button");
    expect(button?.textContent).toBe("Waiting for connection");
    expect(button?.disabled).toBe(true);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      writable: true,
      value: "hidden",
    });
    document.dispatchEvent(new window.Event("visibilitychange"));
    expect(refresh).not.toHaveBeenCalled();

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      writable: true,
      value: "visible",
    });
    document.dispatchEvent(new window.Event("visibilitychange"));
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      writable: true,
      value: true,
    });
    await act(async () => window.dispatchEvent(new window.Event("online")));
    expect(button?.disabled).toBe(false);
    expect(button?.textContent).toBe("Try again");

    await act(async () => {
      button?.dispatchEvent(new window.Event("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(refresh).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledWith(firstTicket);
  });

  it("reconnects a host locally without refreshing or replacing the live room", async () => {
    controls.initMeeting
      .mockRejectedValueOnce(new Error("ERR0004 host connection rejected"))
      .mockResolvedValueOnce(fakeClient());
    const refresh = vi.fn().mockResolvedValue(freshTicket);
    const replaceTicket = vi.fn();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const catalog = {
      ...es,
      live: {
        ...es.live,
        failure: {
          ...es.live.failure,
          tokenRejected: "FALLO DE CONEXIÓN DEL ANFITRIÓN",
        },
        stage: {
          ...es.live.stage,
          hostRecoveryHint: "RECUPERACIÓN SEGURA DE LA SALA EXISTENTE",
          reconnect: "RECONECTAR SALA EXISTENTE",
        },
      },
    };

    await act(async () =>
      root.render(
        <TestI18nProvider catalog={catalog} locale="es">
          <Stage
            ticket={hostTicket}
            refreshTicket={refresh}
            onTicketRefreshed={replaceTicket}
          />
        </TestI18nProvider>,
      ),
    );
    await flush();

    expect(container.textContent).toContain(
      "FALLO DE CONEXIÓN DEL ANFITRIÓN",
    );
    expect(container.textContent).toContain(
      "RECUPERACIÓN SEGURA DE LA SALA EXISTENTE",
    );
    const button = container.querySelector("button");
    expect(button?.textContent).toBe("RECONECTAR SALA EXISTENTE");

    await act(async () => {
      button?.dispatchEvent(new window.Event("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(refresh).not.toHaveBeenCalled();
    expect(replaceTicket).not.toHaveBeenCalled();
    expect(
      controls.initMeeting.mock.calls.map(([options]) => options.authToken),
    ).toEqual(["existing-host-token", "existing-host-token"]);
  });

  it("leaves a client whose init resolves after the stage is gone", async () => {
    let resolveInit!: (client: ReturnType<typeof fakeClient>) => void;
    controls.initMeeting.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveInit = resolve;
      }),
    );
    await act(async () =>
      root.render(
        <TestI18nProvider>
          <Stage ticket={hostTicket} />
        </TestI18nProvider>,
      ),
    );
    await flush();
    await act(async () => root.unmount());

    const late = fakeClient();
    await act(async () => resolveInit(late));
    await flush();

    // The host was initialized with camera and microphone on; an abandoned
    // client that is never left keeps both captured.
    expect(late.leave).toHaveBeenCalledOnce();
    expect(controls.rendered).not.toContain(late);
  });

  it("does not report StrictMode's effect replay as a connection failure", async () => {
    const client = fakeClient();
    controls.initMeeting.mockImplementation(lockedInit([client]));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await act(async () =>
      root.render(
        <StrictMode>
          <TestI18nProvider>
            <Stage ticket={hostTicket} />
          </TestI18nProvider>
        </StrictMode>,
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    await flush();

    // The replayed (cancelled) attempt never reaches Core, so Core's per-token
    // init lock is never contended and the surviving attempt connects.
    expect(warn).not.toHaveBeenCalled();
    expect(container.querySelector("button")).toBeNull();
    expect(controls.initMeeting).toHaveBeenCalledOnce();
    expect(lastRendered()).toBe(client);
    expect(client.leave).not.toHaveBeenCalled();
  });

  it("waits for an in-flight init with the same token, but never for another token", async () => {
    let resolveFirst!: (client: ReturnType<typeof fakeClient>) => void;
    const order: string[] = [];
    const first = fakeClient();
    const other = fakeClient();
    const again = fakeClient();
    controls.initMeeting
      .mockImplementationOnce(({ authToken }: { authToken: string }) => {
        order.push(`start:${authToken}`);
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
      })
      .mockImplementationOnce(async ({ authToken }: { authToken: string }) => {
        order.push(`start:${authToken}`);
        return other;
      })
      .mockImplementationOnce(async ({ authToken }: { authToken: string }) => {
        order.push(`start:${authToken}`);
        return again;
      });

    function Harness({ ticket }: { ticket: DyteJoinTicket }) {
      return (
        <TestI18nProvider>
          <Stage ticket={ticket} />
        </TestI18nProvider>
      );
    }
    await act(async () => root.render(<Harness ticket={firstTicket} />));
    await flush();
    // A different token is a different Core lock: no waiting.
    await act(async () => root.render(<Harness ticket={freshTicket} />));
    await flush();
    expect(order).toEqual([
      "start:first-private-token",
      "start:fresh-private-token",
    ]);
    // Back to the first token while its init is still running: wait for it.
    await act(async () => root.render(<Harness ticket={firstTicket} />));
    await flush();
    expect(order).toHaveLength(2);

    await act(async () => resolveFirst(first));
    await flush();
    await flush();
    expect(order).toEqual([
      "start:first-private-token",
      "start:fresh-private-token",
      "start:first-private-token",
    ]);
    expect(first.leave).toHaveBeenCalledOnce();
    expect(other.leave).toHaveBeenCalledOnce();
    expect(lastRendered()).toBe(again);
  });

  it("does not let a never-settling init block the same token past Core's lock", async () => {
    vi.useFakeTimers();
    try {
      const recovered = fakeClient();
      controls.initMeeting
        .mockImplementationOnce(() => new Promise(() => {}))
        .mockResolvedValueOnce(recovered);
      function Harness({ attempt }: { attempt: number }) {
        return (
          <TestI18nProvider>
            <Stage key={attempt} ticket={hostTicket} />
          </TestI18nProvider>
        );
      }
      await act(async () => root.render(<Harness attempt={1} />));
      await flush();
      // A remount (navigate away and back) with the hung init still pending.
      await act(async () => root.render(<Harness attempt={2} />));
      await flush();
      expect(controls.initMeeting).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_100);
      });
      expect(controls.initMeeting).toHaveBeenCalledTimes(2);
      await flush();
      expect(lastRendered()).toBe(recovered);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps retrying a rejected leave until Core's 3s media lock has expired", async () => {
    vi.useFakeTimers();
    try {
      const client = fakeClient();
      const lockError = new Error("Unsupported concurrent calls on method: meeting.self.disableAudio.");
      client.leave
        .mockRejectedValueOnce(lockError)
        .mockRejectedValueOnce(lockError)
        .mockRejectedValueOnce(lockError)
        .mockResolvedValueOnce(undefined);
      controls.initMeeting.mockResolvedValueOnce(client);
      vi.spyOn(console, "warn").mockImplementation(() => {});
      await act(async () =>
        root.render(
          <TestI18nProvider>
            <Stage ticket={hostTicket} />
          </TestI18nProvider>,
        ),
      );
      await flush();
      // Departure while a mic toggle holds the lock: the room UI goes away.
      await act(async () => root.unmount());
      await flush();
      expect(client.leave).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_999);
      });
      // Still inside the lock window: not given up yet.
      expect(client.leave).toHaveBeenCalledTimes(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_100);
      });
      // An attempt after the lock expired (t >= 3 s) succeeds; then it stops.
      expect(client.leave).toHaveBeenCalledTimes(4);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(client.leave).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not leave a confirmed-left client again", async () => {
    vi.useFakeTimers();
    try {
      const client = fakeClient();
      client.leave
        .mockRejectedValueOnce(new Error("disableAudio lock held"))
        .mockResolvedValueOnce(undefined);
      controls.initMeeting.mockResolvedValueOnce(client);
      vi.spyOn(console, "warn").mockImplementation(() => {});
      await act(async () =>
        root.render(
          <TestI18nProvider>
            <Stage ticket={hostTicket} />
          </TestI18nProvider>,
        ),
      );
      await flush();
      await act(async () => client.emit("roomLeft", { state: "failed" }));
      await flush();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(client.leave).toHaveBeenCalledTimes(2);
      await act(async () => root.unmount());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(client.leave).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("adopts a breakout replacement client and moves teardown to it", async () => {
    const parent = fakeClient();
    const breakout = fakeClient();
    controls.initMeeting.mockResolvedValueOnce(parent);
    await act(async () =>
      root.render(
        <TestI18nProvider>
          <Stage ticket={firstTicket} />
        </TestI18nProvider>,
      ),
    );
    await flush();
    expect(lastRendered()).toBe(parent);

    await act(async () =>
      parent.emit("roomLeft", { state: "connected-meeting" }),
    );
    await act(async () =>
      parent.connectedMeetings.emit("meetingChanged", breakout),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(lastRendered()).toBe(breakout);
    expect(container.querySelector("button")).toBeNull();

    await act(async () => root.unmount());
    await flush();
    // Core already left the parent for the handoff; the replacement is ours.
    expect(breakout.leave).toHaveBeenCalledOnce();
    expect(parent.leave).not.toHaveBeenCalled();
  });

  it("leaves a failed room once and never remounts it on host reconnect", async () => {
    const failed = fakeClient();
    const fresh = fakeClient();
    controls.initMeeting
      .mockResolvedValueOnce(failed)
      .mockResolvedValueOnce(fresh);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await act(async () =>
      root.render(
        <TestI18nProvider>
          <Stage ticket={hostTicket} />
        </TestI18nProvider>,
      ),
    );
    await flush();
    expect(lastRendered()).toBe(failed);

    await act(async () => failed.emit("roomJoined"));
    await act(async () => failed.emit("roomLeft", { state: "disconnected" }));
    // Transient: Core reconnects by itself; the room stays mounted.
    expect(failed.leave).not.toHaveBeenCalled();
    expect(container.querySelector("button")).toBeNull();

    await act(async () => failed.emit("roomLeft", { state: "failed" }));
    await flush();
    expect(failed.leave).toHaveBeenCalledOnce();
    const renderedBeforeRetry = controls.rendered.length;

    const button = container.querySelector("button");
    expect(button?.textContent).toBe("Reconnect");
    await act(async () => {
      button?.dispatchEvent(new window.Event("click", { bubbles: true }));
    });
    await flush();

    // Mounting <RtkMeeting> with the setup screen off calls join(); the failed
    // client must never be handed to it again.
    expect(controls.rendered.slice(renderedBeforeRetry)).not.toContain(failed);
    expect(lastRendered()).toBe(fresh);
    expect(failed.leave).toHaveBeenCalledOnce();

    await act(async () => root.unmount());
    await flush();
    expect(fresh.leave).toHaveBeenCalledOnce();
  });

  it("does not leave again after the provider ended the room", async () => {
    const client = fakeClient();
    controls.initMeeting.mockResolvedValueOnce(client);
    await act(async () =>
      root.render(
        <TestI18nProvider>
          <Stage ticket={firstTicket} />
        </TestI18nProvider>,
      ),
    );
    await flush();
    await act(async () => client.emit("roomLeft", { state: "ended" }));
    expect(container.textContent).toContain("ended");
    await act(async () => root.unmount());
    await flush();
    expect(client.leave).not.toHaveBeenCalled();
  });
});
