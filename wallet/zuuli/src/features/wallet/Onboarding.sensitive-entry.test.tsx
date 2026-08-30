import { act } from "react";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const route = vi.hoisted(() => ({
  clear: vi.fn(async () => {}),
  restore: vi.fn(async () => ({ success: true, walletId: "wallet-restored" })),
  refreshIdentity: vi.fn(async (_walletId: string) => {}),
  useEntry: vi.fn(),
}));

vi.mock("@/lib/wallet/sensitive-entry", () => ({
  useSensitiveMnemonicEntry: route.useEntry,
}));
vi.mock("@/lib/wallet/bridge", () => ({
  wallet: {
    restoreWallet: route.restore,
  },
}));
vi.mock("@/store/wallet", () => ({
  useWallet: Object.assign(vi.fn(), {
    getState: () => ({ refreshWalletIdentity: route.refreshIdentity }),
  }),
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { RestorePane } from "./Onboarding";

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
  route.restore
    .mockReset()
    .mockResolvedValue({ success: true, walletId: "wallet-restored" });
  route.refreshIdentity.mockReset().mockResolvedValue(undefined);
  route.useEntry.mockReset();
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
