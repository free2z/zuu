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
  peerIdentityFingerprint:
    "2b8f60c1d4a739e50f2687bd4c319a0e9123a456b789c012d345e678f9012345",
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
    expect(container.textContent).toContain(
      "2B8F6 0C1D4 A739E 50F26 87BD4 C319A 0E912 3A456 B789C 012D3 45E67 8F901 2345",
    );
    expect(container.textContent).toContain("Unverified identity key claimed");
    expect(container.textContent).toContain(
      "Directory confirmation happens only if you accept",
    );
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
    await act(async () => root.render(
      <FirstContact
        engineRunning
        witnessThresholdMet
        onConversation={vi.fn()}
        onStateChanged={vi.fn(async () => {})}
      />,
    ));
    await act(async () => root.unmount());
    const late = [vi.fn(), vi.fn()];
    await act(async () => {
      resolvers.forEach((resolve, index) => resolve(late[index]));
      await Promise.resolve();
    });
    expect(late[0]).toHaveBeenCalledTimes(1);
    expect(late[1]).toHaveBeenCalledTimes(1);
  });

  it("attaches both event listeners before the initial authoritative read", async () => {
    const listenerResolvers: Array<(unlisten: () => void) => void> = [];
    controls.listen.mockImplementation(
      () =>
        new Promise((resolve) => {
          listenerResolvers.push(resolve);
        }),
    );
    controls.listContactRequests.mockClear();
    await act(async () => root.render(
      <FirstContact
        engineRunning
        witnessThresholdMet
        onConversation={vi.fn()}
        onStateChanged={vi.fn(async () => {})}
      />,
    ));
    expect(controls.listContactRequests).not.toHaveBeenCalled();
    controls.listContactRequests.mockResolvedValue([REQUEST]);
    await act(async () => {
      listenerResolvers.forEach((resolve) => resolve(vi.fn()));
      await Promise.resolve();
    });
    await vi.waitFor(() =>
      expect(controls.listContactRequests).toHaveBeenCalledTimes(1),
    );
    expect(container.textContent).toContain("@newcomer");
  });

  it("does not let an older contact-request read resurrect stale state", async () => {
    const reads: Array<(requests: ContactRequest[]) => void> = [];
    controls.listContactRequests.mockImplementation(
      () =>
        new Promise((resolve) => {
          reads.push(resolve);
        }),
    );
    await act(async () => root.render(
      <FirstContact
        engineRunning
        witnessThresholdMet
        onConversation={vi.fn()}
        onStateChanged={vi.fn(async () => {})}
      />,
    ));
    await vi.waitFor(() => expect(reads).toHaveLength(1));
    await act(async () =>
      window.dispatchEvent(new window.Event("focus")),
    );
    await vi.waitFor(() => expect(reads).toHaveLength(2));
    await act(async () => reads[1]([]));
    expect(container.textContent).not.toContain("@newcomer");
    await act(async () => reads[0]([REQUEST]));
    expect(container.textContent).not.toContain("@newcomer");
  });

  it.each([
    [
      "directory-proof-invalid",
      "Directory proof failed",
      "cryptographic verification failed",
    ],
    [
      "witness-threshold-unmet",
      "Independent witness threshold not met",
      "compare safety numbers",
    ],
    [
      "directory-protocol-violation",
      "Messaging defect",
      "report this error code",
    ],
    [
      "directory-unreachable",
      "First contact can be retried",
      "directory could not be reached",
    ],
  ])("renders the actionable security meaning of %s", async (code, title, copy) => {
    controls.startConversation.mockRejectedValue(code);
    await renderFirstContact();
    await enterHandle("alice");
    await act(async () => submit());
    await vi.waitFor(() => expect(container.textContent).toContain(title));
    expect(container.textContent?.toLowerCase()).toContain(copy.toLowerCase());
    expect(container.textContent).toContain(code);
  });

  it("clears a stale load refusal after a later authoritative read succeeds", async () => {
    controls.listContactRequests
      .mockRejectedValueOnce("directory-unreachable")
      .mockResolvedValueOnce([REQUEST]);
    await renderFirstContact();
    await vi.waitFor(() =>
      expect(container.textContent).toContain("directory-unreachable"),
    );
    await act(async () =>
      window.dispatchEvent(new window.Event("focus")),
    );
    await vi.waitFor(() => expect(container.textContent).toContain("@newcomer"));
    expect(container.textContent).not.toContain("directory-unreachable");
  });

  it("announces multi-second proof-of-work progress accessibly", async () => {
    controls.startConversation.mockReturnValue(new Promise(() => {}));
    await renderFirstContact();
    await enterHandle("alice");
    await act(async () => submit());
    const status = container.querySelector('[role="status"]');
    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(status?.textContent).toContain("Computing proof of work on this device");
    expect(container.querySelector("form")?.getAttribute("aria-busy")).toBe(
      "true",
    );
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
