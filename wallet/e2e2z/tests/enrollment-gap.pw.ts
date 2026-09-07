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
//
// # Why this file shipped #973 anyway
//
// It used to stub `plugin:f2zmsg|get_device_info` with a `DeviceInfo`, which is
// a shape a packaged e2e2z **cannot ever produce**. `Engine::device_info`
// (`engine.rs`) reads the stored identity and answers §8 `not-enrolled` when
// there is none, and the only writer of that record is `install_identity`,
// whose only production caller is ZUULI's app crate. e2e2z holds no seed and
// has no transport for the `issue-device-credential` intent (#905, blocked on
// #461), so it never installs one and `get_device_info` rejects on every
// install, forever. `engine_lifecycle.rs`'s
// `an_unenrolled_engine_refuses_to_start_and_says_which_way_to_go` already
// asserts exactly that on the Rust side.
//
// So the stub now refuses the way the plugin really refuses. That is the whole
// reproduction: with it, the pre-fix screen sits on its skeleton the way the
// TestFlight build did on the device.

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

/**
 * What `get_device_info` answers on a device that has never enrolled: the bare
 * §8 code, because `tauri-plugin-f2zmsg`'s `Error` serializes as
 * `serializer.serialize_str(self.code.as_str())` and nothing else.
 *
 * This is not a pessimistic choice. It is the *only* answer a packaged e2e2z
 * can get — see the file header.
 */
const NOT_ENROLLED = "not-enrolled";

/** The port the second `webServer` in playwright.config.ts serves. */
function unmockedBaseUrl(baseURL: string | undefined): string {
  const url = new URL(baseURL ?? "http://127.0.0.1:1437");
  url.port = String(Number(url.port) + 1);
  return url.toString();
}

test.describe("enrollment gap", () => {
  test("fails closed and names the wallet app", async ({ page, baseURL }) => {
    await page.addInitScript(
      ({ status, notEnrolled }) => {
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
            // The real refusal, as a bare code string — see the file header.
            // Tauri rejects an `invoke` with the serialized error, and this
            // plugin's serialized error *is* the code.
            if (cmd === "plugin:f2zmsg|get_device_info") throw notEnrolled;
            if (cmd === "plugin:event|listen") return nextCallback++;
            if (cmd === "plugin:event|unlisten") return null;
            // Everything else answers the way a Tauri host answers a command
            // the app never registered.
            throw new Error(`Command ${cmd} not found`);
          },
        };
      },
      { status: ENGINE_STATUS, notEnrolled: NOT_ENROLLED },
    );

    await page.goto(unmockedBaseUrl(baseURL));

    await expect(
      page.getByRole("heading", { name: "Messages", level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByText("Enrollment happens in the wallet app"),
    ).toBeVisible();

    // #973 itself: the skeleton must be gone. Asserting the gap copy alone was
    // not enough, because the skeleton renders the same `PageHeader` above it —
    // a stranded screen still passes a "heading is visible" check.
    await expect(page.locator("[data-messages-loading]")).toHaveCount(0);

    // And a refusal that is the *expected* standing state must not be dressed
    // up as a fault. `get_device_info` answering `not-enrolled` is what this
    // app is, not something that broke.
    await expect(page.locator("[data-messages-failure]")).toHaveCount(0);
    await expect(page.getByText("not-enrolled")).toHaveCount(0);

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

  // The other half of #973. `get_device_info` refusing is a standing state, so
  // the screen absorbs it; `get_engine_status` refusing is a real fault, and
  // the screen has to *say so*. Both must clear the skeleton — that is the
  // property the shipped build lacked, and neither branch of it was tested.
  test("names a failing engine status instead of sitting on the skeleton", async ({
    page,
    baseURL,
  }) => {
    await page.addInitScript(() => {
      let nextCallback = 1;
      (
        window as unknown as { __TAURI_INTERNALS__: Record<string, unknown> }
      ).__TAURI_INTERNALS__ = {
        transformCallback: () => nextCallback++,
        unregisterCallback: () => undefined,
        async invoke(cmd: string) {
          if (cmd === "plugin:event|listen") return nextCallback++;
          if (cmd === "plugin:event|unlisten") return null;
          // §8 `durability-unavailable`: the messaging store would not open, so
          // even the status command — the one that answers a *faulted* engine
          // rather than refusing — cannot be reached. A device with a full or
          // read-only data directory reaches this.
          throw "durability-unavailable";
        },
      };
    });

    await page.goto(unmockedBaseUrl(baseURL));

    await expect(page.locator("[data-messages-failure]")).toBeVisible();
    await expect(page.locator("[data-messages-loading]")).toHaveCount(0);
    // Naming the call and the code is the point: "something went wrong" would
    // have left this bug exactly as hard to diagnose as it was.
    await expect(page.getByText("get_engine_status")).toBeVisible();
    await expect(page.getByText("durability-unavailable")).toBeVisible();

    // And it must not be mistaken for the enrollment gap, which says something
    // specific and true that this situation does not support.
    await expect(
      page.getByText("Enrollment happens in the wallet app"),
    ).toHaveCount(0);
  });
});
