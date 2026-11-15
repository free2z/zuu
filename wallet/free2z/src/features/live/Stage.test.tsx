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

/** A Core client double: listeners on `self`, and a counted `leave()`. */
function fakeClient() {
  const listeners = new Map<string, Set<Listener>>();
  return {
    leave: vi.fn().mockResolvedValue(undefined),
    self: {
      on(event: string, fn: Listener) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(fn);
      },
      off(event: string, fn: Listener) {
        listeners.get(event)?.delete(fn);
      },
    },
    emit(event: string, payload?: unknown) {
      listeners.get(event)?.forEach((fn) => fn(payload));
    },
  };
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
    const clients = [fakeClient(), fakeClient()];
    controls.initMeeting
      .mockResolvedValueOnce(clients[0])
      .mockResolvedValueOnce(clients[1]);
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
    await flush();

    expect(warn).not.toHaveBeenCalled();
    expect(container.querySelector("button")).toBeNull();
    // The replayed attempt's client is left; only the surviving one renders.
    expect(clients[0].leave).toHaveBeenCalledOnce();
    expect(clients[1].leave).not.toHaveBeenCalled();
    expect(lastRendered()).toBe(clients[1]);
    expect(controls.rendered).not.toContain(clients[0]);
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
