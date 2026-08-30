import { act } from "react";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const route = vi.hoisted(() => ({
  clear: vi.fn(async () => {}),
  create: vi.fn(async () => ({
    walletId: "wallet-created",
    birthdayHeight: 123,
  })),
  restore: vi.fn(async () => ({ success: true, walletId: "wallet-restored" })),
  refreshIdentity: vi.fn(async (_walletId: string) => {}),
  bootstrap: vi.fn(async () => {}),
  useEntry: vi.fn(),
  walletState: {
    status: null as {
      activeWalletId: string | null;
      backupRequired: boolean;
    } | null,
    activeWallet: null as {
      id: string;
      birthdayHeight: number | null;
    } | null,
  },
}));

vi.mock("@/lib/wallet/sensitive-entry", () => ({
  useSensitiveMnemonicEntry: route.useEntry,
}));
vi.mock("@/lib/wallet/bridge", () => ({
  wallet: {
    createWallet: route.create,
    restoreWallet: route.restore,
  },
}));
vi.mock("@/store/wallet", () => ({
  useWallet: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({ ...route.walletState, bootstrap: route.bootstrap }),
    {
      getState: () => ({ refreshWalletIdentity: route.refreshIdentity }),
    },
  ),
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { Onboarding, RestorePane } from "./Onboarding";

let root: Root;
let container: HTMLElement;
let restoreGlobals: () => void;

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
    getComputedStyle:
      window.getComputedStyle?.bind(window) ??
      (() => ({ animationName: "none", display: "block" })),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      return window.setTimeout(() => callback(Date.now()), 0);
    },
    cancelAnimationFrame: (handle: number) => window.clearTimeout(handle),
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

async function render(editable: boolean, onRestored = vi.fn()) {
  route.useEntry.mockReturnValue({
    editable,
    error: null,
    retry: vi.fn(),
    clear: route.clear,
  });
  await act(async () => root.render(<RestorePane onRestored={onRestored} />));
  return onRestored;
}

async function input(element: HTMLTextAreaElement, value: string) {
  const { Simulate } = await import("react-dom/test-utils");
  Simulate.change(element, { target: { value } } as never);
}

function expectPrivateTextServices(element: HTMLTextAreaElement) {
  expect(element.getAttribute("spellcheck")).toBe("false");
  expect(element.getAttribute("autoComplete")).toBe("off");
  expect(element.getAttribute("autoCapitalize")).toBe("none");
  expect(element.getAttribute("autoCorrect")).toBe("off");
}

beforeEach(async () => {
  route.clear.mockReset().mockResolvedValue(undefined);
  route.create.mockReset().mockResolvedValue({
    walletId: "wallet-created",
    birthdayHeight: 123,
  });
  route.restore
    .mockReset()
    .mockResolvedValue({ success: true, walletId: "wallet-restored" });
  route.refreshIdentity.mockReset().mockResolvedValue(undefined);
  route.bootstrap.mockReset().mockResolvedValue(undefined);
  route.useEntry.mockReset();
  route.walletState.status = null;
  route.walletState.activeWallet = null;
  await installDom();
});

afterEach(async () => {
  await act(async () => root.unmount());
  restoreGlobals();
});

describe("ZUULI restore sensitive-entry route", () => {
  it("requests the exact purpose and keeps mnemonic editing disabled without a lease", async () => {
    await render(false);
    expect(route.useEntry).toHaveBeenCalledWith(
      "zuuliRestore",
      true,
      expect.any(Function),
    );
    expect(container.querySelector("textarea")?.disabled).toBe(true);
  });

  it("disables browser text services on the mounted recovery phrase field", async () => {
    await render(true);
    expectPrivateTextServices(container.querySelector("textarea")!);
  });

  it("clears the renderer lease before leaving a successful restore", async () => {
    const events: string[] = [];
    route.restore.mockImplementation(async () => {
      events.push("restore");
      return { success: true, walletId: "wallet-restored" };
    });
    route.clear.mockImplementation(async () => {
      events.push("clear");
    });
    route.refreshIdentity.mockImplementation(async (walletId: string) => {
      events.push(`refresh:${walletId}`);
    });
    const onRestored = vi.fn(() => events.push("exit"));
    await render(true, onRestored);
    const textarea = container.querySelector("textarea")!;
    const phrase = Array.from({ length: 12 }, (_, i) => `word${i}`).join(" ");
    await act(async () => input(textarea, phrase));
    const submit = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Restore wallet"),
    )!;
    expect(submit.disabled).toBe(false);
    await act(async () => submit.click());
    await vi.waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
    expect(events).toEqual([
      "restore",
      "clear",
      "refresh:wallet-restored",
      "exit",
    ]);
  });
});

describe("ZUULI create backup lifecycle", () => {
  it("refreshes the exact created identity immediately and keeps seed reveal mounted", async () => {
    const events: string[] = [];
    route.create.mockImplementation(async () => {
      events.push("create");
      return { walletId: "wallet-created", birthdayHeight: 123 };
    });
    route.refreshIdentity.mockImplementation(async (walletId: string) => {
      events.push(`refresh:${walletId}`);
    });
    await act(async () => root.render(<Onboarding />));

    const create = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Create wallet"),
    )!;
    await act(async () => create.click());

    await vi.waitFor(() =>
      expect(container.textContent).toContain("Back up your recovery phrase"),
    );
    expect(events).toEqual(["create", "refresh:wallet-created"]);
  });

  it("resumes backup only from a coherent active inventory identity", async () => {
    route.walletState.status = {
      activeWalletId: "wallet-resume",
      backupRequired: true,
    };
    route.walletState.activeWallet = {
      id: "wallet-resume",
      birthdayHeight: 456,
    };
    await act(async () => root.render(<Onboarding />));
    expect(container.textContent).toContain("Back up your recovery phrase");

    route.walletState.activeWallet = {
      id: "wallet-resume",
      birthdayHeight: null,
    };
    await act(async () => root.render(<Onboarding />));
    expect(container.textContent).toContain("Wallet backup unavailable");
    expect(container.textContent).not.toContain("Create a new wallet");
  });
});
