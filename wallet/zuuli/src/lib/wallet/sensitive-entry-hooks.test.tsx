import { act, type ReactElement } from "react";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SensitiveEntryPurpose } from "@free2z/wallet-shared";

const native = vi.hoisted(() => ({
  zuuliBegin: vi.fn(async () => ({ token: "zuuli-token" })),
  zuuliEnd: vi.fn(async () => {}),
}));

vi.mock("@/lib/wallet/bridge", () => ({
  wallet: {
    beginSensitiveEntry: native.zuuliBegin,
    endSensitiveDisplay: native.zuuliEnd,
  },
}));
import { useSensitiveMnemonicEntry as useZuuliEntry } from "./sensitive-entry";

type EntryHook = (
  purpose: SensitiveEntryPurpose,
  active: boolean,
  clearRenderer: () => void,
) => { editable: boolean };

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

function Probe({
  useEntry,
  purpose,
  clearRenderer,
}: {
  useEntry: EntryHook;
  purpose: SensitiveEntryPurpose;
  clearRenderer: () => void;
}): ReactElement {
  const entry = useEntry(purpose, true, clearRenderer);
  return <output data-editable={String(entry.editable)} />;
}

beforeEach(async () => {
  native.zuuliBegin.mockReset().mockResolvedValue({ token: "zuuli-token" });
  native.zuuliEnd.mockReset().mockResolvedValue(undefined);
  await installDom();
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  restoreGlobals?.();
});

async function provesLifecycleAttachment({
  useEntry,
  purpose,
  begin,
  end,
  token,
}: {
  useEntry: EntryHook;
  purpose: SensitiveEntryPurpose;
  begin: typeof native.zuuliBegin;
  end: typeof native.zuuliEnd;
  token: string;
}) {
  const clearRenderer = vi.fn();
  await act(async () =>
    root.render(
      <Probe
        useEntry={useEntry}
        purpose={purpose}
        clearRenderer={clearRenderer}
      />,
    ),
  );
  await act(async () => {
    await vi.waitFor(() => expect(begin).toHaveBeenCalledWith(purpose));
    await vi.waitFor(() =>
      expect(container.querySelector("output")?.dataset.editable).toBe("true"),
    );
  });

  clearRenderer.mockClear();
  await act(async () => window.dispatchEvent(new window.Event("blur")));
  expect(clearRenderer).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.waitFor(() => expect(end).toHaveBeenCalledWith(token, purpose));
  });

  begin.mockClear();
  await act(async () => window.dispatchEvent(new window.Event("focus")));
  await act(async () => {
    await vi.waitFor(() => expect(begin).toHaveBeenCalledWith(purpose));
  });
}

describe("production sensitive-entry hook lifecycle wiring", () => {
  it("attaches ZUULI blur/reacquire handling to its real native authority", async () => {
    await provesLifecycleAttachment({
      useEntry: useZuuliEntry,
      purpose: "zuuliRestore",
      begin: native.zuuliBegin,
      end: native.zuuliEnd,
      token: "zuuli-token",
    });
  });
});
