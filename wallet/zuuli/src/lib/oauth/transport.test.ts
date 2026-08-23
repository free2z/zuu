import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isTauri: false,
  invoke: vi.fn(),
  getCurrent: vi.fn(),
  onOpenUrl: vi.fn(),
  openUrl: vi.fn(),
}));

vi.mock("../platform", () => ({
  isTauri: () => mocks.isTauri,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

vi.mock("@tauri-apps/plugin-deep-link", () => ({
  getCurrent: mocks.getCurrent,
  onOpenUrl: mocks.onOpenUrl,
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: mocks.openUrl,
}));

const STATE = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const CHALLENGE = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";

function startResponse(redirectUri: string) {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", STATE);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("code_challenge", CHALLENGE);
  url.searchParams.set("code_challenge_method", "S256");
  return { authorize_url: url.toString(), state: STATE };
}

function installBrowser(open: (url?: string | URL) => unknown = () => null) {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  vi.stubGlobal("window", {
    location: { origin: "https://app.example" },
    open,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
  });
}

beforeEach(() => {
  vi.resetModules();
  mocks.isTauri = false;
  mocks.invoke.mockReset();
  mocks.getCurrent.mockReset();
  mocks.onOpenUrl.mockReset();
  mocks.openUrl.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OAuth session lifecycle", () => {
  it("closes and rejects a web popup when the initiating token changes", async () => {
    let opened!: () => void;
    const didOpen = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const popup = {
      closed: false,
      close: vi.fn(),
      get location(): Location {
        throw new DOMException("cross origin");
      },
    };
    installBrowser(() => {
      opened();
      return popup;
    });
    const [{ captureOAuthCode }, { setToken }] = await Promise.all([
      import("./transport"),
      import("../api/http"),
    ]);
    setToken(null);

    const capture = captureOAuthCode("google", false, async (redirectUri) =>
      startResponse(redirectUri),
    );
    await didOpen;
    setToken("another-account");

    await expect(capture).rejects.toThrow(/session changed/i);
    expect(popup.close).toHaveBeenCalledOnce();
  });

  it("cancels persisted mobile recovery when its session changes", async () => {
    installBrowser();
    mocks.isTauri = true;
    let listening!: () => void;
    const didListen = new Promise<void>((resolve) => {
      listening = resolve;
    });
    let installListener!: (stop: () => void) => void;
    const listenerInstall = new Promise<() => void>((resolve) => {
      installListener = resolve;
    });
    const stopListening = vi.fn();
    mocks.onOpenUrl.mockImplementation(() => {
      listening();
      return listenerInstall;
    });
    mocks.getCurrent.mockResolvedValue(null);
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "oauth_callback_transport") return "mobile";
      if (command === "oauth_mobile_pending") {
        return {
          provider: "google",
          associate: true,
          phase: "armed",
          state: STATE,
        };
      }
      if (command === "oauth_mobile_resume") return { status: "ignored" };
      if (command === "oauth_mobile_cancel") return undefined;
      throw new Error(`unexpected command: ${command}`);
    });
    const [{ recoverMobileOAuth }, { setToken }] = await Promise.all([
      import("./transport"),
      import("../api/http"),
    ]);
    setToken("account-a");

    const recovery = recoverMobileOAuth();
    await didListen;
    setToken("account-b");
    installListener(stopListening);

    await expect(recovery).resolves.toBeNull();
    expect(stopListening).toHaveBeenCalledOnce();
    expect(mocks.invoke).toHaveBeenCalledWith("oauth_mobile_cancel", {
      args: { state: STATE },
    });
  });

  it("rejects a token change while completion is awaiting backend work", async () => {
    installBrowser();
    const [{ withOAuthSession }, { buildSessionBinding }, http] = await Promise.all([
      import("./transport"),
      import("./protocol"),
      import("../api/http"),
    ]);
    http.setToken("account-a");
    const snapshot = http.getTokenSnapshot();
    const capture = {
      provider: "google" as const,
      associate: true,
      code: "provider-code",
      state: STATE,
      redirectUri: "https://app.example",
      sessionBinding: await buildSessionBinding(true, snapshot.token),
      sessionGeneration: snapshot.generation,
      transport: "web" as const,
    };
    let finishWork!: () => void;
    const backendWork = new Promise<void>((resolve) => {
      finishWork = resolve;
    });
    const completion = withOAuthSession(capture, async () => {
      await backendWork;
      return "should-not-publish";
    });

    http.setToken("account-b");
    finishWork();

    await expect(completion).rejects.toThrow(/session changed/i);
  });

  it("rejects logout/relogin to the same token before completion", async () => {
    installBrowser();
    const [{ withOAuthSession }, { buildSessionBinding }, http] = await Promise.all([
      import("./transport"),
      import("./protocol"),
      import("../api/http"),
    ]);
    http.setToken("account-a");
    const snapshot = http.getTokenSnapshot();
    const capture = {
      provider: "google" as const,
      associate: true,
      code: "provider-code",
      state: STATE,
      redirectUri: "https://app.example",
      sessionBinding: await buildSessionBinding(true, snapshot.token),
      sessionGeneration: snapshot.generation,
      transport: "web" as const,
    };
    http.setToken(null);
    http.setToken("account-a");
    const exchange = vi.fn(async () => "must-not-run");

    await expect(withOAuthSession(capture, exchange)).rejects.toThrow(/session changed/i);
    expect(exchange).not.toHaveBeenCalled();
  });
});
