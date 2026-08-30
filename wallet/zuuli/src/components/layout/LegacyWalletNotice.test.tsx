import { act } from "react";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupportedLocale } from "@/i18n/locale";
import { TestI18nProvider } from "@/i18n/test-provider";
import type { LegacyImportPreview } from "@/lib/wallet/types";

const controls = vi.hoisted(() => ({
  preview: vi.fn<() => Promise<LegacyImportPreview>>(),
  legacyState: "importPending" as "importPending" | "none",
}));

vi.mock("@/lib/wallet/bridge", () => ({
  wallet: { previewLegacyWalletImport: controls.preview },
}));
vi.mock("@/store/wallet", () => ({
  useWallet: (selector: (state: unknown) => unknown) =>
    selector({
      status: {
        legacyAppData: {
          state: controls.legacyState,
          legacyIdentifier: "com.2zinc.zuuli",
          diagnostic: "Preserved by the native wallet.",
        },
      },
    }),
}));

import { LegacyWalletNotice } from "./LegacyWalletNotice";

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

async function renderNotice(locale: SupportedLocale = "en") {
  await act(async () =>
    root.render(
      <TestI18nProvider locale={locale}>
        <LegacyWalletNotice />
      </TestI18nProvider>,
    ),
  );
}

async function clickPreview() {
  const button = container.querySelector("button");
  expect(button).not.toBeNull();
  await act(async () => {
    button?.dispatchEvent(new window.Event("click", { bubbles: true }));
    await Promise.resolve();
  });
}

function fixture(overrides: Partial<LegacyImportPreview> = {}): LegacyImportPreview {
  return {
    state: "ready",
    layout: "multi",
    wallets: [
      {
        walletId: "must-not-render-wallet-id",
        walletName: "must-not-render-wallet-name",
        dbFilename: "must-not-render.sqlite",
        accountCount: 2,
        ufvkFingerprints: ["must-not-render-fingerprint"],
        walPresent: true,
        shmPresent: false,
        encryptedCustodyPresent: true,
      },
    ],
    diagnostics: ["Safe native diagnostic."],
    ...overrides,
  };
}

beforeEach(async () => {
  controls.legacyState = "importPending";
  controls.preview.mockReset();
  await installDom();
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  restoreGlobals?.();
});

describe("legacy wallet preview notice", () => {
  it("stays absent without native import-pending authority", async () => {
    controls.legacyState = "none";
    await renderNotice();
    expect(container.innerHTML).toBe("");
    expect(controls.preview).not.toHaveBeenCalled();
  });

  it("does not inspect before the explicit user action", async () => {
    controls.preview.mockResolvedValue(fixture());
    await renderNotice();
    expect(container.textContent).toContain("Earlier wallet preserved");
    expect(container.textContent).toContain("Inspect preserved wallet");
    expect(controls.preview).not.toHaveBeenCalled();
    await clickPreview();
    expect(controls.preview).toHaveBeenCalledTimes(1);
    expect(controls.preview).toHaveBeenCalledWith();
  });

  it("renders the preserved-wallet authority from the selected catalog", async () => {
    controls.preview.mockResolvedValue(fixture());
    await renderNotice("es");
    expect(container.textContent).toContain("Billetera anterior conservada");
    expect(container.textContent).not.toContain("Earlier wallet preserved");
    expect(container.querySelector("section")?.getAttribute("aria-label")).toBe(
      "Billetera anterior conservada",
    );
  });

  it("keeps a pending inspection single-flight", async () => {
    let resolvePreview: (value: LegacyImportPreview) => void = () => {};
    controls.preview.mockReturnValue(
      new Promise((resolve) => {
        resolvePreview = resolve;
      }),
    );
    await renderNotice();
    const button = container.querySelector("button");
    await act(async () => {
      button?.dispatchEvent(new window.Event("click", { bubbles: true }));
      button?.dispatchEvent(new window.Event("click", { bubbles: true }));
    });
    expect(button?.disabled).toBe(true);
    expect(container.textContent).toContain("Inspecting…");
    expect(controls.preview).toHaveBeenCalledTimes(1);
    await act(async () => resolvePreview(fixture({ state: "absent", layout: null, wallets: [] })));
    expect(button?.disabled).toBe(false);
  });

  it("discards an in-flight result when native import authority disappears", async () => {
    let resolvePreview: (value: LegacyImportPreview) => void = () => {};
    controls.preview.mockReturnValue(
      new Promise((resolve) => {
        resolvePreview = resolve;
      }),
    );
    await renderNotice();
    await clickPreview();

    controls.legacyState = "none";
    await renderNotice();
    expect(container.innerHTML).toBe("");
    controls.legacyState = "importPending";
    await renderNotice();
    await act(async () => resolvePreview(fixture()));
    expect(container.textContent).toContain("Earlier wallet preserved");
    expect(container.textContent).toContain("Inspect preserved wallet");
    expect(container.textContent).not.toContain("preserved wallets inspected");
    expect(controls.preview).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["single", "Single-wallet", "1 preserved wallet"],
    ["multi", "Multi-wallet", "2 preserved wallets"],
  ] as const)("renders a hard-literal %s ready summary without identifiers", async (layout, label, count) => {
    const wallets = layout === "single" ? fixture().wallets : [fixture().wallets[0], { ...fixture().wallets[0], accountCount: 1, walPresent: false, encryptedCustodyPresent: false }];
    controls.preview.mockResolvedValue(fixture({ layout, wallets }));
    await renderNotice();
    await clickPreview();
    expect(container.textContent).toContain(label);
    expect(container.textContent).toContain(count);
    expect(container.textContent).toContain(layout === "single" ? "2 accounts" : "3 accounts");
    expect(container.textContent).toContain("encrypted custody present for 1");
    expect(container.textContent).toContain("SQLite sidecars present for 1");
    expect(container.textContent).not.toContain("must-not-render-wallet-id");
    expect(container.textContent).not.toContain("must-not-render-wallet-name");
    expect(container.textContent).not.toContain("must-not-render.sqlite");
    expect(container.textContent).not.toContain("must-not-render-fingerprint");
  });

  it.each([
    ["absent", "No earlier wallet data found"],
    ["unsupported", "Preview unavailable on this platform"],
  ] as const)("renders the exact %s state", async (state, label) => {
    controls.preview.mockResolvedValue(
      fixture({ state, layout: null, wallets: [], diagnostics: [`${state} diagnostic`] }),
    );
    await renderNotice();
    await clickPreview();
    expect(container.querySelector(`[data-preview-state='${state}']`)).not.toBeNull();
    expect(container.textContent).toContain(label);
    expect(container.textContent).toContain(`${state} diagnostic`);
  });

  it("renders blocked diagnostics and retries with one new exact call", async () => {
    controls.preview
      .mockResolvedValueOnce(fixture({ state: "blocked", layout: null, wallets: [], diagnostics: ["Snapshot changed safely."] }))
      .mockResolvedValueOnce(fixture({ state: "absent", layout: null, wallets: [] }));
    await renderNotice();
    await clickPreview();
    expect(container.textContent).toContain("Preview blocked");
    expect(container.textContent).toContain("Snapshot changed safely.");
    expect(container.textContent).toContain("Retry preview");
    await clickPreview();
    expect(controls.preview).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("No earlier wallet data found");
  });

  it("redacts a rejected native error and permits retry", async () => {
    controls.preview
      .mockRejectedValueOnce(new Error("/private/source/wallet.sqlite"))
      .mockResolvedValueOnce(fixture({ state: "unsupported", layout: null, wallets: [] }));
    await renderNotice();
    await clickPreview();
    expect(container.textContent).toContain("Preview could not be completed");
    expect(container.textContent).toContain("Nothing was changed");
    expect(container.textContent).not.toContain("/private/source/wallet.sqlite");
    await clickPreview();
    expect(controls.preview).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Preview unavailable on this platform");
  });
});
