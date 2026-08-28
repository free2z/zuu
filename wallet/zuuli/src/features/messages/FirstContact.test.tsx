import { act } from "react";
import type { Root } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ContactRequest,
  Conversation,
} from "@/lib/messaging/types";

const controls = vi.hoisted(() => ({
  startConversation: vi.fn(),
  listContactRequests: vi.fn(),
  acceptContactRequest: vi.fn(),
  rejectContactRequest: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@/lib/messaging/bridge", () => ({
  messaging: {
    startConversation: controls.startConversation,
    listContactRequests: controls.listContactRequests,
    acceptContactRequest: controls.acceptContactRequest,
    rejectContactRequest: controls.rejectContactRequest,
  },
}));
vi.mock("@/lib/messaging/events", () => ({
  listenMessaging: controls.listen,
}));

import { FirstContact } from "./FirstContact";

const REQUEST: ContactRequest = {
  requestId: "req-1",
  peerHandle: "newcomer",
  peerIdentityFingerprint: "2B8F 60C1 D4A7 39E5",
  receivedAt: 1,
  bodyPreview: null,
};

const CONVERSATION: Conversation = {
  conversationId: "conv-newcomer",
  peerHandle: "newcomer",
  peerIdentityFingerprint: REQUEST.peerIdentityFingerprint,
  verification: { state: "unverified" },
  epoch: 1,
  createdAt: 1,
  lastMessageAt: null,
  unreadCount: 0,
  retention: {
    scope: "global",
    mode: "keep",
    ttlSeconds: null,
    effectiveFrom: 1,
  },
  ephemeralHint: null,
  receiptPolicy: { deliveryReceipts: true, readReceipts: false },
  hasGaps: false,
  transportHealth: "ok",
};

let root: Root;
let container: HTMLElement;
let restoreGlobals: () => void;
let listeners: Map<string, () => void>;
let unlisteners: Map<string, ReturnType<typeof vi.fn>>;

async function installDom() {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id='root'></div></body></html>",
  );
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

function button(label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`button not found: ${label}`);
  return found;
}

async function enterHandle(value: string) {
  const input = container.querySelector("input")!;
  await act(async () => {
    Simulate.change(input, { target: { value } } as never);
  });
}

function submit() {
  container
    .querySelector("form")!
    .dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
}

async function renderFirstContact(
  overrides: Partial<React.ComponentProps<typeof FirstContact>> = {},
) {
  const props: React.ComponentProps<typeof FirstContact> = {
    engineRunning: true,
    witnessThresholdMet: true,
    onConversation: vi.fn(),
    onStateChanged: vi.fn(async () => {}),
    ...overrides,
  };
  await act(async () => root.render(<FirstContact {...props} />));
  await vi.waitFor(() =>
    expect(controls.listContactRequests).toHaveBeenCalled(),
  );
  return props;
}

beforeEach(async () => {
  listeners = new Map();
  unlisteners = new Map();
  controls.startConversation.mockReset().mockResolvedValue(CONVERSATION);
  controls.listContactRequests.mockReset().mockResolvedValue([]);
  controls.acceptContactRequest.mockReset().mockResolvedValue(CONVERSATION);
  controls.rejectContactRequest.mockReset().mockResolvedValue(undefined);
  controls.listen.mockReset().mockImplementation(async (event, handler) => {
    const unlisten = vi.fn();
    listeners.set(event, handler);
    unlisteners.set(event, unlisten);
    return unlisten;
  });
  await installDom();
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  restoreGlobals?.();
});

describe("ZUULI first contact", () => {
  it.each([
    "",
    "Alice",
    " alice",
    "alice ",
    "@alice",
    "álîce",
    "a".repeat(31),
    "alice-bob",
  ])("rejects %j locally without rewriting or invoking it", async (value) => {
    await renderFirstContact();
    await enterHandle(value);
    expect(button("Start chat").disabled).toBe(true);
    await act(async () => button("Start chat").click());
    expect(controls.startConversation).not.toHaveBeenCalled();
  });

  it("passes an exact valid handle once and selects the returned conversation", async () => {
    const onConversation = vi.fn();
    const onStateChanged = vi.fn(async () => {});
    await renderFirstContact({ onConversation, onStateChanged });
    await enterHandle("alice_123");
    await act(async () => submit());
    await vi.waitFor(() =>
      expect(controls.startConversation).toHaveBeenCalledWith("alice_123"),
    );
    expect(controls.startConversation).toHaveBeenCalledTimes(1);
    expect(onConversation).toHaveBeenCalledWith(CONVERSATION);
    expect(onStateChanged).toHaveBeenCalled();
  });

  it("keeps proof-of-work single-flight even across two clicks in one turn", async () => {
    let resolveStart: (conversation: Conversation) => void = () => {};
    controls.startConversation.mockReturnValue(
      new Promise((resolve) => {
        resolveStart = resolve;
      }),
    );
    await renderFirstContact();
    await enterHandle("alice");
    await act(async () => {
      submit();
      submit();
    });
    expect(controls.startConversation).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Computing on this device…");
    expect(container.textContent).toContain("proof of work on this device");
    await act(async () => resolveStart(CONVERSATION));
  });

  it("fails closed below the witness threshold while preserving local rejection", async () => {
    controls.listContactRequests.mockResolvedValue([REQUEST]);
    await renderFirstContact({ witnessThresholdMet: false });
    await enterHandle("alice");
    expect(button("Start chat").disabled).toBe(true);
    expect(button("Accept").disabled).toBe(true);
    expect(button("Reject").disabled).toBe(false);
    expect(container.textContent).toContain(
      "Existing conversations remain available.",
    );
    await act(async () => {
      button("Start chat").click();
      button("Accept").click();
    });
    expect(controls.startConversation).not.toHaveBeenCalled();
    expect(controls.acceptContactRequest).not.toHaveBeenCalled();
  });

  it("shows request identity, accepts it, and selects only the command result", async () => {
    controls.listContactRequests.mockResolvedValue([REQUEST]);
    const onConversation = vi.fn();
    await renderFirstContact({ onConversation });
    expect(container.textContent).toContain("@newcomer");
    expect(container.textContent).toContain(REQUEST.peerIdentityFingerprint);
    await act(async () => button("Accept").click());
    await vi.waitFor(() =>
      expect(controls.acceptContactRequest).toHaveBeenCalledWith("req-1"),
    );
    expect(onConversation).toHaveBeenCalledWith(CONVERSATION);
  });

  it("keeps rejection and device-local blocking as distinct bridge calls", async () => {
    controls.listContactRequests.mockResolvedValue([REQUEST]);
    await renderFirstContact();
    expect(container.textContent).toContain("Block on this device");
    await act(async () => button("Reject").click());
    await vi.waitFor(() =>
      expect(controls.rejectContactRequest).toHaveBeenCalledWith("req-1", false),
    );
    await act(async () => button("Block on this device").click());
    await vi.waitFor(() =>
      expect(controls.rejectContactRequest).toHaveBeenCalledWith("req-1", true),
    );
  });

  it.each(["f2zmsg://contact-request", "f2zmsg://conversation-updated"])(
    "treats %s as a signal and re-reads both authoritative views",
    async (event) => {
      const onStateChanged = vi.fn(async () => {});
      await renderFirstContact({ onStateChanged });
      controls.listContactRequests.mockClear().mockResolvedValue([REQUEST]);
      onStateChanged.mockClear();

      await act(async () => listeners.get(event)?.());
      await vi.waitFor(() =>
        expect(controls.listContactRequests).toHaveBeenCalledTimes(1),
      );
      expect(onStateChanged).toHaveBeenCalledTimes(1);
      expect(container.textContent).toContain("@newcomer");
    },
  );

  it("cleans up listeners that finish attaching after unmount", async () => {
    const resolvers: Array<(unlisten: () => void) => void> = [];
    controls.listen.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    await renderFirstContact();
    await act(async () => root.unmount());
    const late = [vi.fn(), vi.fn()];
    await act(async () => {
      resolvers.forEach((resolve, index) => resolve(late[index]));
      await Promise.resolve();
    });
    expect(late[0]).toHaveBeenCalledTimes(1);
    expect(late[1]).toHaveBeenCalledTimes(1);
  });

  it("keeps request state visible when a bare bridge error is refused", async () => {
    controls.listContactRequests.mockResolvedValue([REQUEST]);
    controls.startConversation.mockRejectedValue("directory-unreachable");
    await renderFirstContact();
    await enterHandle("alice");
    await act(async () => submit());
    await vi.waitFor(() =>
      expect(container.textContent).toContain("directory-unreachable"),
    );
    expect(container.textContent).toContain("@newcomer");
  });
});
