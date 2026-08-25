import { act } from "react";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const route = vi.hoisted(() => ({
  clear: vi.fn(async () => {}),
  editable: false,
  restore: vi.fn(async () => {}),
  setPage: vi.fn(),
  unlock: vi.fn(async () => {}),
  useEntry: vi.fn(),
  revealCalls: 0,
  revealEvents: [] as string[],
}));

vi.mock("../../../../zuuallet/src/lib/sensitive-entry", () => ({
  useSensitiveMnemonicEntry: route.useEntry,
}));
vi.mock("../../../../zuuallet/src/store/wallet", () => ({
  useWalletStore: () => ({
    setPage: route.setPage,
    error: null,
    walletStatus: { walletCount: 1 },
  }),
}));
vi.mock("../../../../zuuallet/src/hooks/useWallet", () => ({
  useWallet: () => ({ restoreWallet: route.restore }),
}));
vi.mock("../../../../zuuallet/src/lib/tauri", () => ({
  unlockWallet: route.unlock,
  getSeedPhrase: vi.fn(async () => "unused"),
}));
vi.mock("../../../../zuuallet/src/lib/sensitive-seed", () => ({
  sensitiveSeedAuthority: {},
  SensitiveSeedSession: class {
    constructor(
      _authority: unknown,
      private readonly publish: (phrase: string | null) => void,
    ) {}

    clear() {
      this.publish(null);
    }

    async reveal() {
      route.revealCalls += 1;
      route.revealEvents.push(`reveal:${route.revealCalls}`);
      if (route.revealCalls === 1) throw new Error("not linked");
      this.publish("linked phrase");
      return true;
    }
  },
}));

import { RestoreWallet } from "../../../../zuuallet/src/pages/RestoreWallet";
import { SeedPhraseSection } from "../../../../zuuallet/src/pages/Settings";

let root: Root;
let container: HTMLElement;
let restoreGlobals: () => void;

async function installDom() {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id='root'></div></body></html>",
  );
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { protocol: "http:" },
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

async function change(element: HTMLTextAreaElement, value: string) {
  const { Simulate } = await import("react-dom/test-utils");
  Simulate.change(element, { target: { value } } as never);
}

async function render(element: JSX.Element) {
  await act(async () => root.render(element));
}

function buttonNamed(name: string) {
  return Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === name,
  )!;
}

function expectPrivateTextServices(element: HTMLTextAreaElement) {
  expect(element.getAttribute("spellcheck")).toBe("false");
  expect(element.getAttribute("autoComplete")).toBe("off");
  expect(element.getAttribute("autoCapitalize")).toBe("none");
  expect(element.getAttribute("autoCorrect")).toBe("off");
}

beforeEach(async () => {
  route.clear.mockReset().mockResolvedValue(undefined);
  route.restore.mockReset().mockResolvedValue(undefined);
  route.setPage.mockReset();
  route.unlock.mockReset().mockResolvedValue(undefined);
  route.useEntry.mockReset().mockImplementation(
    (_purpose: string, _active: boolean, _clearRenderer: () => void) => ({
      editable: route.editable,
      error: null,
      retry: vi.fn(),
      clear: route.clear,
    }),
  );
  route.editable = false;
  route.revealCalls = 0;
  route.revealEvents.length = 0;
  await installDom();
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  restoreGlobals?.();
});

describe("Zuuallet typed-mnemonic production routes", () => {
  it("binds restore editing to the exact active restore purpose", async () => {
    await render(<RestoreWallet />);
    expect(route.useEntry).toHaveBeenCalledWith(
      "zuualletRestore",
      true,
      expect.any(Function),
    );
    expect(container.querySelector("textarea")?.disabled).toBe(true);
    expectPrivateTextServices(container.querySelector("textarea")!);
  });

  it("clears restore material before native restore and before cancel navigation", async () => {
    const events: string[] = [];
    route.editable = true;
    route.clear.mockImplementation(async () => {
      events.push("clear");
    });
    route.restore.mockImplementation(async () => {
      events.push("restore");
    });
    route.setPage.mockImplementation(() => events.push("exit"));
    await render(<RestoreWallet />);
    const textarea = container.querySelector("textarea")!;
    const phrase = Array.from({ length: 12 }, (_, i) => `word${i}`).join(" ");
    await act(async () => change(textarea, phrase));
    await act(async () => buttonNamed("Restore Wallet").click());
    await vi.waitFor(() => expect(route.restore).toHaveBeenCalledTimes(1));
    expect(events).toEqual(["clear", "restore"]);

    events.length = 0;
    await act(async () => buttonNamed("Cancel").click());
    expect(events).toEqual(["clear", "exit"]);
  });

  it("binds relink editing to its exact active purpose and clears before exit/reveal", async () => {
    const events: string[] = [];
    route.editable = false;
    route.clear.mockImplementation(async () => {
      events.push("clear");
    });
    route.unlock.mockImplementation(async () => {
      events.push("unlock");
    });
    route.revealEvents = events;
    await render(<SeedPhraseSection />);
    expect(route.useEntry).toHaveBeenLastCalledWith(
      "zuualletRelink",
      false,
      expect.any(Function),
    );

    await act(async () => buttonNamed("Reveal").click());
    await vi.waitFor(() => expect(container.querySelector("textarea")).not.toBeNull());
    expect(route.useEntry).toHaveBeenLastCalledWith(
      "zuualletRelink",
      true,
      expect.any(Function),
    );
    expect(container.querySelector("textarea")?.disabled).toBe(true);
    expectPrivateTextServices(container.querySelector("textarea")!);

    route.editable = true;
    await render(<SeedPhraseSection />);
    const textarea = container.querySelector("textarea")!;
    const phrase = Array.from({ length: 12 }, (_, i) => `word${i}`).join(" ");
    await act(async () => change(textarea, phrase));
    await act(async () => buttonNamed("Unlock").click());
    await vi.waitFor(() => expect(route.revealCalls).toBe(2));
    expect(events).toEqual(["reveal:1", "unlock", "clear", "reveal:2"]);
    expect(container.querySelector("textarea")).toBeNull();
  });
});
