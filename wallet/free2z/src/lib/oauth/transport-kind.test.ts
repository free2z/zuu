import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isTauri: false,
}));

vi.mock("../platform", () => ({
  isTauri: () => mocks.isTauri,
}));

async function resolveTransport() {
  const { oauthCallbackTransport } = await import("./transport");
  return oauthCallbackTransport();
}

describe("OAuth callback transport discriminator", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.isTauri = false;
  });

  it("uses the same-origin popup in a browser", async () => {
    await expect(resolveTransport()).resolves.toBe("web");
  });

  // Before #918 this asked the native `oauth_callback_transport` command, which
  // this binary does not register and never will: the commands behind it hand an
  // authorization code and its PKCE verifier back to the renderer, and #367
  // means the renderer asking might be a remote subframe. So a packaged shell
  // has NO transport — not a desktop one, not a mobile one — and says so.
  it("reports no transport at all inside a packaged Tauri shell", async () => {
    mocks.isTauri = true;
    await expect(resolveTransport()).resolves.toBe("unavailable");
  });

  it("never reaches the Tauri IPC bridge to decide", async () => {
    const invoke = vi.fn();
    vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
    mocks.isTauri = true;

    await expect(resolveTransport()).resolves.toBe("unavailable");
    expect(invoke).not.toHaveBeenCalled();
  });
});
