import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DyteJoinTicket } from "@/lib/api/types";

const controls = vi.hoisted(() => ({
  initMeeting: vi.fn(),
}));

vi.mock("@cloudflare/realtimekit-react", () => ({
  RealtimeKitProvider: ({ children }: { children: unknown }) => children,
  useRealtimeKitClient: () => [null, controls.initMeeting],
}));
vi.mock("@cloudflare/realtimekit-react-ui", () => ({
  RtkMeeting: () => null,
}));

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
      .mockResolvedValueOnce({});
    const refresh = vi.fn().mockResolvedValue(freshTicket);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    function Harness() {
      const [ticket, setTicket] = useState(firstTicket);
      return (
        <Stage
          ticket={ticket}
          refreshTicket={refresh}
          onTicketRefreshed={setTicket}
        />
      );
    }

    await act(async () => root.render(<Harness />));
    await flush();
    expect(container.textContent).toContain("rejected this join ticket");
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
        <Stage
          ticket={firstTicket}
          refreshTicket={refresh}
          onTicketRefreshed={() => {}}
        />,
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
});
