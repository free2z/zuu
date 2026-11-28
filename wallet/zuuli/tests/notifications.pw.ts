import { expect, test } from "@playwright/test";
test("browser explains privacy and never offers remote delivery", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", request => { if (request.url().includes("/notify/")) requests.push(request.url()); });
  await page.goto("/wallet");
  const surface = page.getByRole("region", { name: "Private wake notifications" });
  await expect(surface).toContainText("Off by default");
  await expect(surface).toContainText("stable device token");
  await expect(surface).toContainText("do not prevent correlation");
  await expect(surface).toContainText("Silent wakes do not prove a payment");
  await expect(surface).toContainText("Remote push is unavailable");
  for (const button of ["Enable with this privacy cost", "Disable and revoke", "Test this device only"]) {
    await expect(surface.getByRole("button", { name: button, exact: true })).toBeDisabled();
  }
  expect(requests).toEqual([]);
});

test("native consent UI distinguishes denied, queued and offline revocation", async ({ page }) => {
  await page.addInitScript(() => {
    let state = "off";
    let enables = 0;
    const calls: string[] = [];
    Object.assign(window, {
      __notificationCalls: calls,
      __TAURI_INTERNALS__: {
        invoke: async (command: string) => {
          if (!command.startsWith("plugin:notify|")) return null;
          calls.push(command);
          if (command.endsWith("|enable")) state = ++enables === 1 ? "denied" : "enabled";
          if (command.endsWith("|test_wake")) state = "queued";
          if (command.endsWith("|disable")) state = "revocation-pending";
          return { state, wake: false };
        },
        transformCallback: () => 1,
      },
    });
  });
  await page.goto("/wallet");
  const surface = page.getByRole("region", { name: "Private wake notifications" });
  await expect(surface).toContainText("Notifications are off.");
  await surface.getByRole("button", { name: "Enable with this privacy cost" }).click();
  await expect(surface).toContainText("permission is denied or revoked");
  await surface.getByRole("button", { name: "Enable with this privacy cost" }).click();
  await expect(surface).toContainText("This is not payment detection");
  await surface.getByRole("button", { name: "Test this device only" }).click();
  await expect(surface).toContainText("Delivery has not been confirmed");
  await expect(surface).not.toContainText("A signed wake was verified");
  await surface.getByRole("button", { name: "Disable and revoke" }).click();
  await expect(surface).toContainText("Disabled locally. Server revocation is pending");
  await expect(surface.getByRole("button", { name: "Test this device only" })).toBeDisabled();
  const calls = await page.evaluate(() => (window as unknown as { __notificationCalls: string[] }).__notificationCalls);
  expect(calls.filter(command => command.endsWith("|test_wake"))).toHaveLength(1);
});

test("delayed native token completion updates consent UI without a second tap", async ({ page }) => {
  await page.addInitScript(() => {
    let state = "off";
    let enables = 0;
    let callback = 0;
    const callbacks: Record<number, (event: unknown) => void> = {};
    Object.assign(window, {
      __finishNotificationBootstrap: () => {
        state = "enabled";
        for (const fn of Object.values(callbacks)) fn({ event: "notify://changed", id: 1, payload: null });
      },
      __notificationEnableCount: () => enables,
      __TAURI_INTERNALS__: {
        transformCallback: (fn: (event: unknown) => void) => { callbacks[++callback] = fn; return callback; },
        invoke: async (command: string) => {
          if (command === "plugin:event|listen") return 1;
          if (!command.startsWith("plugin:notify|")) return null;
          if (command.endsWith("|enable")) { ++enables; state = "waiting-token"; }
          return { state, wake: false };
        },
      },
    });
  });
  await page.goto("/wallet");
  const surface = page.getByRole("region", { name: "Private wake notifications" });
  await expect(surface).toContainText("Notifications are off.");
  await surface.getByRole("button", { name: "Enable with this privacy cost" }).click();
  await expect(surface).toContainText("Registration will finish automatically");
  await page.evaluate(() => (window as unknown as { __finishNotificationBootstrap(): void }).__finishNotificationBootstrap());
  await expect(surface).toContainText("Private wake registration is enabled");
  expect(await page.evaluate(() => (window as unknown as { __notificationEnableCount(): number }).__notificationEnableCount())).toBe(1);
});
