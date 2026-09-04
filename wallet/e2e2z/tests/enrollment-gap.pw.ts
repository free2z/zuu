// The enrollment gap, proved where it actually exists.
//
// The mock run in `messaging.pw.ts` cannot see this: `VITE_MOCK=1` replaces the
// whole data layer with fixtures. So this file runs against the *default*
// build — the one a packaged e2e2z ships — and installs the Tauri IPC surface
// that build really talks to: `tauri-plugin-f2zmsg` is registered and answers,
// and the app-crate enrollment trio does not exist, exactly as
// `wallet/e2e2z/src-tauri/src/lib.rs` leaves it.
//
// What must hold:
//   1. The surface renders. A missing command must not leave the page on its
//      skeleton or throw into an empty screen.
//   2. It says enrollment happens in the wallet app.
//   3. There is no claim control, no conversation list, and nothing that reads
//      as enrolled.
//   4. The enrollment commands are never invoked at all — the refusal is a
//      designed boundary in `bridge.ts`, not a "command not found" that
//      happened to look like one.

import { expect, test } from "@playwright/test";

const ENGINE_STATUS = {
  state: "stopped",
  enrolled: false,
  handle: null,
  relaysConnected: 0,
  relaysConfigured: 1,
  witnessThresholdMet: false,
  independentWitnesses: 1,
  pendingInbound: 0,
  unacknowledgedAlarms: 0,
  lastError: null,
};

// `platform` still reads `zuuli-desktop`: it is the plugin's own enum, declared
// in CLIENT-CONTRACT.md §3.1 and in `models.rs`. Renaming it is a contract
// change, not part of moving a screen.
const DEVICE_INFO = {
  deviceId: "device-e2e2z",
  deviceFingerprint: "AAAA BBBB CCCC DDDD",
  identityFingerprint: "EEEE FFFF 0000 1111",
  createdAt: 0,
  platform: "zuuli-desktop",
  durability: "durable",
};

/** The port the second `webServer` in playwright.config.ts serves. */
function unmockedBaseUrl(baseURL: string | undefined): string {
  const url = new URL(baseURL ?? "http://127.0.0.1:1437");
  url.port = String(Number(url.port) + 1);
  return url.toString();
}

test.describe("enrollment gap", () => {
  test("fails closed and names the wallet app", async ({ page, baseURL }) => {
    await page.addInitScript(
      ({ status, device }) => {
        const invoked: string[] = [];
        let nextCallback = 1;
        (window as unknown as { __E2E2Z_INVOKED__: string[] }).__E2E2Z_INVOKED__ =
          invoked;
        (
          window as unknown as { __TAURI_INTERNALS__: Record<string, unknown> }
        ).__TAURI_INTERNALS__ = {
          transformCallback(callback: unknown, once: boolean) {
            const id = nextCallback++;
            const key = `_${id}`;
            Object.defineProperty(window, key, {
              value: (...args: unknown[]) => {
                if (once) Reflect.deleteProperty(window, key);
                return (callback as (...a: unknown[]) => unknown)(...args);
              },
              writable: false,
              configurable: true,
            });
            return id;
          },
          unregisterCallback(id: number) {
            Reflect.deleteProperty(window, `_${id}`);
          },
          async invoke(cmd: string) {
            invoked.push(cmd);
            if (cmd === "plugin:f2zmsg|get_engine_status") return status;
            if (cmd === "plugin:f2zmsg|get_device_info") return device;
            if (cmd === "plugin:event|listen") return nextCallback++;
            if (cmd === "plugin:event|unlisten") return null;
            // Everything else answers the way a Tauri host answers a command
            // the app never registered.
            throw new Error(`Command ${cmd} not found`);
          },
        };
      },
      { status: ENGINE_STATUS, device: DEVICE_INFO },
    );

    await page.goto(unmockedBaseUrl(baseURL));

    await expect(
      page.getByRole("heading", { name: "Messages", level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByText("Enrollment happens in the wallet app"),
    ).toBeVisible();

    // Nothing that reads as enrolled.
    await expect(page.getByText("Handle active")).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Claim your handle" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("navigation", { name: "Conversations" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Start a conversation" }),
    ).toHaveCount(0);

    // The engine summary still renders: the plugin half of the surface works,
    // and pretending otherwise would understate what this app can do.
    await expect(page.getByText("Engine", { exact: true })).toBeVisible();

    const invoked = await page.evaluate(
      () => (window as unknown as { __E2E2Z_INVOKED__: string[] }).__E2E2Z_INVOKED__,
    );
    expect(invoked).toContain("plugin:f2zmsg|get_engine_status");
    expect(
      invoked.filter((cmd) => cmd.startsWith("f2zmsg_")),
    ).toEqual([]);
  });
});
