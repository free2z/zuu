// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  decodeIntentRequest,
  fromHex,
  toHex,
  IntentErrorCode,
} from "@free2z/wallet-shared";
import { TestI18nProvider } from "@/i18n/test-provider";
import type { CreatorDetail } from "@/lib/api/types";
import { TipButton } from "./TipButton";
import { acknowledgeZecTip } from "./zec-tip-session";
const mocks = vi.hoisted(() => ({ exchange: vi.fn(), open: vi.fn() }));
vi.mock("@/lib/bridge/intent-transport", async (original) => ({
  ...(await original<typeof import("@/lib/bridge/intent-transport")>()),
  installedIntentTransport: () => ({
    id: "controlled-fixture",
    exchange: mocks.exchange,
  }),
}));
vi.mock("@/lib/bridge/wallet-history", () => ({
  openWalletHistory: mocks.open,
}));
const creator = {
  username: "alice",
  display_name: "Alice",
  p2paddr: "u1alice",
} as CreatorDetail;
let root: ReturnType<typeof createRoot>;
function render(profile = creator, locale: "en" | "es" | "fr" = "en") {
  root.render(
    <MemoryRouter>
      <TestI18nProvider locale={locale}>
        <TipButton creator={profile} restored={null} />
      </TestI18nProvider>
    </MemoryRouter>,
  );
}
function button(text: string): HTMLButtonElement {
  const match = [...document.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === text,
  );
  if (!match) throw new Error(`Missing button ${text}`);
  return match;
}
async function click(text: string) {
  await act(async () => button(text).click());
}
function answer(bytes: Uint8Array, status = 0): Uint8Array {
  const decoded = decodeIntentRequest(bytes);
  if (!decoded.ok) throw new Error("unusable request");
  // Independently spelled wire fixture; no wallet/provider calls.
  const payload = status === 0 ? "ab".repeat(32) : "";
  const body =
    toHex(decoded.value.requestId) +
    "0003" +
    status.toString(16).padStart(4, "0") +
    (payload.length / 2).toString(16).padStart(6, "0") +
    payload;
  return fromHex(
    "0001" + (body.length / 2).toString(16).padStart(6, "0") + body,
  );
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  acknowledgeZecTip();
  mocks.exchange.mockReset();
  mocks.open.mockReset();
  root = createRoot(document.body.appendChild(document.createElement("div")));
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

it("refuses a late destination/identity change while retaining the loaded address", async () => {
  await act(async () => render());
  await click("Tip");
  await click("ZECZcash wallet");
  expect(document.body.textContent).toContain("u1alice");
  await act(async () =>
    render({ ...creator, display_name: "Mallory", p2paddr: "u1mallory" }),
  );
  expect(document.querySelector('[role="alert"]')?.textContent).toContain(
    "payment details changed",
  );
  expect(document.body.textContent).toContain("u1alice");
  expect(button("Continue with ZEC").disabled).toBe(true);
  await click("Continue with ZEC");
  expect(mocks.exchange).not.toHaveBeenCalled();
});

it.each(["en", "es", "fr"] as const)(
  "retains an attributed receipt and full durable transaction link in %s",
  async (locale) => {
    let finish!: (bytes: Uint8Array) => void;
    mocks.exchange.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await act(async () => render(creator, locale));
    await click("Tip");
    await click("ZECZcash wallet");
    await click("0.05");
    await click("Continue with ZEC");
    expect(
      (document.getElementById("creator-tip-zec-amount") as HTMLInputElement)
        .disabled,
    ).toBe(true);
    await click("Asking ZUULI");
    expect(mocks.exchange).toHaveBeenCalledTimes(1);
    const encoded = mocks.exchange.mock.calls[0][0] as Uint8Array;
    // Rerender another creator while ZUULI is considering the request.
    await act(async () => {
      render(
        { ...creator, username: "bob", display_name: "Bob", p2paddr: "u1bob" },
        locale,
      );
      finish(answer(encoded));
    });
    const receipt = document.querySelector("[data-zec-tip-outcome]")!;
    expect(receipt.textContent).toContain("0.05 ZEC");
    expect(receipt.textContent).toContain("Alice (@alice)");
    expect(receipt.textContent).not.toContain("Bob");
    expect(receipt.textContent).toContain("u1alice");
    expect(receipt.textContent).toContain("ab".repeat(32));
    await act(async () =>
      (receipt.querySelector("button") as HTMLButtonElement).click(),
    );
    expect(mocks.open).toHaveBeenCalledExactlyOnceWith("ab".repeat(32));
  },
);

it("blocks an ambiguous outcome until an explicit wallet check and new-payment action", async () => {
  mocks.exchange.mockImplementation(async (bytes) =>
    answer(bytes, IntentErrorCode.Unavailable),
  );
  await act(async () => render());
  await click("Tip");
  await click("ZECZcash wallet");
  await click("Continue with ZEC");
  expect(button("Continue with ZEC").disabled).toBe(true);
  expect(button("Start a new payment").disabled).toBe(true);
  await click("Start a new payment");
  expect(mocks.exchange).toHaveBeenCalledTimes(1);
  await act(async () =>
    (
      document.querySelector('input[type="checkbox"]') as HTMLInputElement
    ).click(),
  );
  await click("Start a new payment");
  expect(button("Continue with ZEC").disabled).toBe(false);
  expect(mocks.exchange).toHaveBeenCalledTimes(1); // acknowledgement itself never pays
});
