import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ isTauri: false, openUrl: vi.fn() }));

vi.mock("@/lib/platform", () => ({ isTauri: () => mocks.isTauri }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }));

import { E2E2Z_INSTALL_URL, e2e2zChatLink, openE2e2z } from "./e2e2z-chat";

describe("Contract B link", () => {
  it("carries the handle in the fragment only", () => {
    const link = e2e2zChatLink("alice_1");
    expect(link).toBe("https://free2z.com/bridge/e2e2z/chat/#peer=alice_1");
    const url = new URL(link as string);
    expect(url.search).toBe("");
    expect(url.pathname).toBe("/bridge/e2e2z/chat/");
    expect(url.hash).toBe("#peer=alice_1");
  });

  it("builds nothing from a handle outside the pattern", () => {
    for (const handle of [
      null,
      "",
      "Alice",
      "a".repeat(31),
      "alice&res=1",
      "alice#x",
      "../x",
      "alice?x",
    ]) {
      expect(e2e2zChatLink(handle)).toBeNull();
    }
  });

  it("is not the intent reply route", () => {
    expect(e2e2zChatLink("alice")).not.toMatch(/\/bridge\/e2e2z\/#/);
    expect(e2e2zChatLink("alice")).not.toMatch(/res=|rid=/);
  });
});

describe("openE2e2z", () => {
  const open = vi.fn();

  beforeEach(() => {
    mocks.isTauri = false;
    mocks.openUrl.mockReset();
    open.mockReset();
    vi.stubGlobal("window", { open });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("hands a Contract B link to the OS opener in the app", async () => {
    mocks.isTauri = true;
    mocks.openUrl.mockResolvedValue(undefined);
    const link = e2e2zChatLink("alice") as string;
    await expect(openE2e2z(link)).resolves.toBe(true);
    await expect(openE2e2z(E2E2Z_INSTALL_URL)).resolves.toBe(true);
    expect(mocks.openUrl.mock.calls).toEqual([[link], [E2E2Z_INSTALL_URL]]);
    expect(open).not.toHaveBeenCalled();
  });

  it("reports an opener failure instead of throwing", async () => {
    mocks.isTauri = true;
    mocks.openUrl.mockRejectedValue(new Error("denied"));
    await expect(openE2e2z(E2E2Z_INSTALL_URL)).resolves.toBe(false);
  });

  it("opens a new browsing context outside the app", async () => {
    await expect(openE2e2z(E2E2Z_INSTALL_URL)).resolves.toBe(true);
    expect(open).toHaveBeenCalledWith(
      E2E2Z_INSTALL_URL,
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("refuses to open anything it did not build", async () => {
    mocks.isTauri = true;
    for (const url of [
      "https://evil.example/bridge/e2e2z/chat/#peer=alice",
      "https://free2z.com/bridge/e2e2z/chat/?peer=alice",
      "https://free2z.com/bridge/e2e2z/chat/#peer=Alice",
      "https://free2z.com/bridge/e2e2z/chat/#peer=alice&x=1",
      "https://free2z.com/bridge/e2e2z/#res=00&rid=00",
      "http://free2z.com/bridge/e2e2z/chat/",
      "javascript:alert(1)",
    ]) {
      await expect(openE2e2z(url)).resolves.toBe(false);
    }
    expect(mocks.openUrl).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
});
