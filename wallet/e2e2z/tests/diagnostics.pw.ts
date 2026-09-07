// Diagnostics capture, in a real browser.
//
// The vitest suite dispatches a synthetic `unhandledrejection` event, because
// jsdom does not raise one for an actually-rejected promise. That proves the
// listener is wired; it does not prove the engine ever calls it. #973 shipped
// precisely because every test passed against a mocked bridge while the real
// one rejected on a device, so the capture path is proven here against a real
// engine raising a real rejection from a real `void promise`.

import { expect, test } from "@playwright/test";

test.describe("diagnostics", () => {
  test("records a promise nobody handled and shows it to the user", async ({
    page,
  }) => {
    await page.goto("/");

    // The exact shape of #973: a promise is started, its rejection is
    // discarded by `void`, and nothing in the app awaits it.
    await page.evaluate(() => {
      void Promise.reject(new Error("getEngineStatus is not a function"));
    });
    // The engine raises `unhandledrejection` on a later turn of the microtask
    // queue, so the assertion below is what waits for it rather than a sleep.

    await page.getByRole("button", { name: /^Diagnostics/ }).click();

    await expect(
      page.getByRole("heading", { name: "Diagnostics", level: 2 }),
    ).toBeVisible();
    await expect(
      page.getByText("getEngineStatus is not a function"),
    ).toBeVisible();
    await expect(page.getByText("unhandled-rejection")).toBeVisible();
  });

  test("survives a reload, because a crash report the user lost is no report", async ({
    page,
  }) => {
    await page.goto("/");
    await page.evaluate(() => {
      void Promise.reject(new Error("engine unreachable"));
    });
    await page.getByRole("button", { name: /^Diagnostics/ }).click();
    await expect(page.getByText("engine unreachable")).toBeVisible();

    await page.reload();
    await page.getByRole("button", { name: /^Diagnostics/ }).click();
    await expect(page.getByText("engine unreachable")).toBeVisible();

    await page.getByRole("button", { name: "Clear" }).click();
    await expect(
      page.getByText("No failures have been recorded on this device."),
    ).toBeVisible();
  });

  test("says what it knows about the build, and that nothing was sent", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /^Diagnostics/ }).click();

    await expect(
      page.getByText(
        "Recorded on this device only. Nothing is sent anywhere. Copy the report into a GitHub issue if you want us to see it.",
      ),
    ).toBeVisible();
    await expect(page.getByText("Engine", { exact: true }).last()).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy report" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Share report" })).toBeVisible();
  });

  test("captures no network request of any kind", async ({ page }) => {
    // The whole product claim is that this never phones home. A promise not to
    // is worth less than a browser watching every request the page makes.
    const external: string[] = [];
    page.on("request", (request) => {
      const url = request.url();
      // Anything not served by this app's own dev server is, by definition,
      // this page reaching outside the device.
      if (!url.startsWith("http://127.0.0.1:")) external.push(url);
    });

    await page.goto("/");
    await page.evaluate(() => {
      void Promise.reject(new Error("engine unreachable"));
    });
    await page.getByRole("button", { name: /^Diagnostics/ }).click();
    await expect(page.getByText("engine unreachable")).toBeVisible();
    await page.getByRole("button", { name: "Share report" }).click();

    expect(external).toEqual([]);
  });
});
