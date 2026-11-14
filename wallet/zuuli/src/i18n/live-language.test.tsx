import { act } from "react";
import type { Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { I18nextProvider } from "react-i18next";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestI18n } from "./test-provider";
import en from "./locales/en.json";
import es from "./locales/es.json";
import fr from "./locales/fr.json";
import { MESSAGE_KEYS } from "./messages";

const controls = vi.hoisted(() => ({
  login: vi.fn(),
  pending: vi.fn(async () => null),
  refresh: vi.fn(),
}));
vi.mock("@/lib/api/free2z", () => ({ auth: { login: controls.login } }));
vi.mock("@/lib/wallet/bridge", () => ({
  wallet: { getPendingSend: controls.pending },
}));
vi.mock("@/store/session", () => ({
  useSession: (selector: (state: unknown) => unknown) =>
    selector({
      user: { username: "alice", display_name: "Alice" },
      tuzis: 500,
      loading: false,
      setUser: vi.fn(),
    }),
}));
vi.mock("@/store/wallet", () => ({
  useWallet: (selector: (state: unknown) => unknown) =>
    selector({
      balance: { spendable: 123456789 },
      loading: false,
      refreshBalance: controls.refresh,
    }),
}));
import { Hero } from "@/features/home/Hero";
import { VaultActions } from "@/features/home/VaultActions";
import { ClassicLoginForm } from "@/features/auth/ClassicLoginForm";
import { Send } from "@/features/wallet/Send";

let root: Root;
let container: HTMLElement;
let restore: () => void;
beforeEach(async () => {
  const { window, document } = parseHTML(
    "<html><body><div id='root'></div></body></html>",
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
      value,
      configurable: true,
      writable: true,
    });
  }
  restore = () => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  };
  container = document.getElementById("root") as unknown as HTMLElement;
  const { createRoot } = await import("react-dom/client");
  root = createRoot(container);
  controls.login.mockReset();
  controls.pending.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  restore();
});

describe("mounted shipping locale changes", () => {
  it("updates Hero, descriptor getters, Auth, an existing error, and Wallet markup without remounting", async () => {
    const instance = createTestI18n("en");
    for (const [locale, catalog] of Object.entries({ en, es, fr }))
      instance.addResourceBundle(locale, "translation", catalog);
    await act(async () =>
      root.render(
        <I18nextProvider i18n={instance}>
          <MemoryRouter>
            <Hero />
            <VaultActions />
            <ClassicLoginForm />
            <Send />
          </MemoryRouter>
        </I18nextProvider>,
      ),
    );
    const amount = container.querySelector<HTMLInputElement>("#amount")!;
    const username =
      container.querySelector<HTMLInputElement>("#f2z-username")!;
    const password =
      container.querySelector<HTMLInputElement>("#f2z-password")!;
    const { Simulate } = await import("react-dom/test-utils");
    await act(async () => {
      Simulate.change(username, { target: { value: "alice" } } as never);
      Simulate.change(password, {
        target: { value: "not-a-real-password" },
      } as never);
    });
    controls.login.mockRejectedValueOnce(
      new Error("private server diagnostic"),
    );
    await act(async () => {
      Simulate.submit(container.querySelector("form")!);
      await Promise.resolve();
    });
    expect(container.textContent).toContain(
      instance.t(
        MESSAGE_KEYS.featuresAuthClassicLoginFormSignInFailedCheckYourDetails,
      ),
    );
    for (const language of ["es", "fr", "en"] as const) {
      await act(async () => {
        await instance.changeLanguage(language);
      });
      for (const key of [
        MESSAGE_KEYS.featuresHomeHeroYourVault,
        MESSAGE_KEYS.featuresHomeVaultActionsSend,
        MESSAGE_KEYS.featuresAuthClassicLoginFormEmailOrUsername,
        MESSAGE_KEYS.featuresWalletSendRecipientAddress,
        MESSAGE_KEYS.featuresAuthClassicLoginFormSignInFailedCheckYourDetails,
      ]) {
        expect(container.textContent).toContain(instance.t(key));
      }
      expect(container.querySelector("label[for='memo']")?.textContent).toBe(
        instance
          .t(MESSAGE_KEYS.featuresWalletSendMemoOptional)
          .replace(/<[^>]*>/g, ""),
      );
      expect(container.querySelector("label[for='memo'] span")).not.toBeNull();
      expect(container.querySelector("#amount")).toBe(amount);
      expect(container.querySelector("#f2z-username")).toBe(username);
      expect(username.value).toBe("alice");
      expect(container.textContent).not.toContain("private server diagnostic");
      expect(controls.login).toHaveBeenCalledTimes(1);
      expect(controls.pending).toHaveBeenCalledTimes(1);
    }
  });
  it("updates the mounted OTP sentence and markup while retaining entered data", async () => {
    const instance = createTestI18n("en");
    for (const [locale, catalog] of Object.entries({ en, es, fr }))
      instance.addResourceBundle(locale, "translation", catalog);
    await act(async () =>
      root.render(
        <I18nextProvider i18n={instance}>
          <MemoryRouter>
            <ClassicLoginForm />
          </MemoryRouter>
        </I18nextProvider>,
      ),
    );
    const { Simulate } = await import("react-dom/test-utils");
    const username = "<part1>literal-user</part1>";
    await act(async () => {
      Simulate.change(container.querySelector("#f2z-username")!, {
        target: { value: username },
      } as never);
      Simulate.change(container.querySelector("#f2z-password")!, {
        target: { value: "not-a-real-password" },
      } as never);
    });
    controls.login.mockResolvedValueOnce({ status: "otp_required" });
    await act(async () => {
      Simulate.submit(container.querySelector("form")!);
      await Promise.resolve();
    });
    const otp = container.querySelector<HTMLInputElement>("#f2z-otp")!;
    await act(async () =>
      Simulate.change(otp, { target: { value: "123456" } } as never),
    );
    for (const language of ["es", "fr"] as const) {
      await act(async () => {
        await instance.changeLanguage(language);
      });
      expect(container.textContent).toContain(
        instance
          .t(
            MESSAGE_KEYS.featuresAuthClassicLoginFormEnterThe6DigitCodeFromYour,
          )
          .replace("<part1/>", username),
      );
      expect(container.querySelector("part1")).toBeNull();
      expect(container.querySelector("#f2z-otp")).toBe(otp);
      expect(otp.value).toBe("123456");
    }
  });
});
