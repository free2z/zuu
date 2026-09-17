// @vitest-environment jsdom
//
// Contract B (#1022): the chat link, and the pending peer it leaves behind.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inboundAnswer } from "../enrollment/appLinkTransport";
import {
  CHAT_LINK_PATH,
  PENDING_PEER_STORAGE_KEY,
  PENDING_PEER_TTL_MS,
  chatLinkSnapshot,
  clearPendingPeer,
  deliverChatLink,
  dismissRejectedChatLink,
  installChatLinkListener,
  parseChatLink,
  resetChatLinksForTests,
  restorePendingPeer,
  subscribeChatLinks,
} from "./chatLink";

const deepLink = vi.hoisted(() => ({
  getCurrent: vi.fn<() => Promise<string[] | null>>(),
  onOpenUrl: vi.fn<(handler: (urls: string[]) => void) => Promise<() => void>>(),
}));
vi.mock("@tauri-apps/plugin-deep-link", () => deepLink);

const link = (fragment: string) =>
  `https://free2z.com/bridge/e2e2z/chat/${fragment}`;

beforeEach(() => {
  resetChatLinksForTests();
  sessionStorage.clear();
  deepLink.getCurrent.mockReset().mockResolvedValue(null);
  deepLink.onOpenUrl.mockReset().mockResolvedValue(() => undefined);
});

afterEach(() => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

describe("parseChatLink", () => {
  it("reads the one shape Contract B defines", () => {
    expect(CHAT_LINK_PATH).toBe("/bridge/e2e2z/chat/");
    for (const handle of ["a", "alice", "alice_123", "0", "a".repeat(30)]) {
      expect(parseChatLink(link(`#peer=${handle}`))).toEqual({
        kind: "peer",
        handle,
      });
    }
  });

  it("leaves every URL addressed elsewhere alone", () => {
    for (const other of [
      "not a url",
      "",
      // Another scheme: a custom scheme authenticates nobody.
      "http://free2z.com/bridge/e2e2z/chat/#peer=alice",
      "cash.free2z.e2e2z://bridge/e2e2z/chat/#peer=alice",
      // Another host.
      "https://free2z.cash/bridge/e2e2z/chat/#peer=alice",
      "https://evil.example/bridge/e2e2z/chat/#peer=alice",
      "https://free2z.com.evil.example/bridge/e2e2z/chat/#peer=alice",
      // Another path, including near misses.
      "https://free2z.com/bridge/e2e2z/chat#peer=alice",
      "https://free2z.com/bridge/e2e2z/chat/x#peer=alice",
      "https://free2z.com/bridge/e2e2z/Chat/#peer=alice",
      "https://free2z.com/bridge/zuuli/chat/#peer=alice",
      "https://free2z.com/bridge/free2z/chat/#peer=alice",
      // The intent reply route is not this route (and the reverse is pinned
      // below).
      "https://free2z.com/bridge/e2e2z/#res=dead&rid=00",
      "https://free2z.com/bridge/e2e2z/#peer=alice",
    ]) {
      expect(parseChatLink(other), other).toBeNull();
    }
  });

  it("refuses this route when anything about it is off", () => {
    for (const refused of [
      // No fragment, or an empty one.
      link(""),
      link("#"),
      // §4.1: fragment only, never the query.
      "https://free2z.com/bridge/e2e2z/chat/?peer=alice",
      "https://free2z.com/bridge/e2e2z/chat/?peer=alice#peer=alice",
      "https://free2z.com/bridge/e2e2z/chat/?#peer=alice",
      // Credentials or an explicit non-default port.
      "https://user@free2z.com/bridge/e2e2z/chat/#peer=alice",
      "https://free2z.com:8443/bridge/e2e2z/chat/#peer=alice",
      // Any other key, extra keys, repeated keys, no value.
      link("#handle=alice"),
      link("#peerx=alice"),
      link("#peer"),
      link("#peer="),
      link("#=alice"),
      link("#peer=alice&peer=bob"),
      link("#peer=alice&res=dead&rid=00"),
      link("#res=dead&rid=00"),
      link("#peer=alice&"),
      // A handle outside the pattern — never normalized into one.
      link("#peer=Alice"),
      link("#peer=@alice"),
      link("#peer=%40alice"),
      link("#peer=alice%5F1"),
      link("#peer=alice-bob"),
      link("#peer=alice.bob"),
      link("#peer=alice bob"),
      link("#peer=%20alice"),
      link("#peer=" + "a".repeat(31)),
      link("#peer=álîce"),
    ]) {
      expect(parseChatLink(refused), refused).toEqual({ kind: "invalid" });
    }
  });

  it("is never read as an intent reply, and a reply is never read as a chat link", () => {
    const chat = link("#peer=alice");
    expect(inboundAnswer(chat)).toBeNull();
    // A reply-shaped fragment on the chat path is still not a reply.
    expect(inboundAnswer(link("#res=dead&rid=00"))).toBeNull();
    const reply = "https://free2z.com/bridge/e2e2z/#res=dead&rid=00";
    expect(inboundAnswer(reply)).not.toBeNull();
    expect(parseChatLink(reply)).toBeNull();
  });
});

describe("the pending peer", () => {
  it("records a delivered handle, persists it, and announces it", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeChatLinks(listener);
    expect(deliverChatLink(link("#peer=alice"), 1_000)).toBe(true);
    expect(chatLinkSnapshot().pending).toEqual({
      handle: "alice",
      receivedAt: 1_000,
      sequence: 1,
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(PENDING_PEER_STORAGE_KEY)!)).toEqual({
      handle: "alice",
      receivedAt: 1_000,
    });
    unsubscribe();
  });

  it("counts the same link opened twice as two requests", () => {
    deliverChatLink(link("#peer=alice"));
    deliverChatLink(link("#peer=alice"));
    expect(chatLinkSnapshot().pending?.sequence).toBe(2);
  });

  it("ignores a URL for another route without touching state", () => {
    deliverChatLink(link("#peer=alice"));
    const before = chatLinkSnapshot();
    expect(
      deliverChatLink("https://free2z.com/bridge/e2e2z/#res=dead&rid=00"),
    ).toBe(false);
    expect(chatLinkSnapshot()).toBe(before);
  });

  it("flags a malformed link without dropping the pending handle", () => {
    deliverChatLink(link("#peer=alice"));
    expect(deliverChatLink(link("#peer=Bob"))).toBe(true);
    expect(chatLinkSnapshot().rejected).toBe(true);
    expect(chatLinkSnapshot().pending?.handle).toBe("alice");
    dismissRejectedChatLink();
    expect(chatLinkSnapshot().rejected).toBe(false);
  });

  it("clears from memory and from storage", () => {
    deliverChatLink(link("#peer=alice"));
    clearPendingPeer();
    expect(chatLinkSnapshot().pending).toBeNull();
    expect(localStorage.getItem(PENDING_PEER_STORAGE_KEY)).toBeNull();
  });

  it("survives a process that was ended, for a day", () => {
    const at = 5_000_000;
    localStorage.setItem(
      PENDING_PEER_STORAGE_KEY,
      JSON.stringify({ handle: "alice", receivedAt: at }),
    );
    restorePendingPeer(at + PENDING_PEER_TTL_MS - 1);
    expect(chatLinkSnapshot().pending?.handle).toBe("alice");
  });

  it.each([
    ["stale", JSON.stringify({ handle: "alice", receivedAt: 0 })],
    ["from the future", JSON.stringify({ handle: "alice", receivedAt: 9e15 })],
    ["an invalid handle", JSON.stringify({ handle: "Alice", receivedAt: 1 })],
    ["not JSON", "{"],
    ["the wrong shape", JSON.stringify(["alice"])],
  ])("drops a stored entry that is %s", (_label, stored) => {
    localStorage.setItem(PENDING_PEER_STORAGE_KEY, stored);
    restorePendingPeer(PENDING_PEER_TTL_MS + 10);
    expect(chatLinkSnapshot().pending).toBeNull();
    expect(localStorage.getItem(PENDING_PEER_STORAGE_KEY)).toBeNull();
  });
});

describe("the listener", () => {
  it("does nothing outside a native runtime", async () => {
    installChatLinkListener();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deepLink.onOpenUrl).not.toHaveBeenCalled();
  });

  it("reads the launch link and every later one", async () => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
    let deliver: (urls: string[]) => void = () => undefined;
    deepLink.onOpenUrl.mockImplementation(async (handler) => {
      deliver = handler;
      return () => undefined;
    });
    deepLink.getCurrent.mockResolvedValue([link("#peer=cold_start")]);

    installChatLinkListener();
    await vi.waitFor(() =>
      expect(chatLinkSnapshot().pending?.handle).toBe("cold_start"),
    );

    deliver([
      "https://free2z.com/bridge/e2e2z/#res=dead&rid=00",
      link("#peer=warm_start"),
    ]);
    expect(chatLinkSnapshot().pending?.handle).toBe("warm_start");
  });

  it("does not offer the launch link again after a webview reload", async () => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
    deepLink.getCurrent.mockResolvedValue([link("#peer=cold_start")]);
    installChatLinkListener();
    await vi.waitFor(() =>
      expect(chatLinkSnapshot().pending?.handle).toBe("cold_start"),
    );
    clearPendingPeer();

    installChatLinkListener();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(chatLinkSnapshot().pending).toBeNull();
  });

  it("survives a runtime whose deep-link plugin is missing", async () => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
    deepLink.onOpenUrl.mockRejectedValue(new Error("plugin not found"));
    expect(() => installChatLinkListener()).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(chatLinkSnapshot().pending).toBeNull();
  });
});
