import { expect, test, type Page } from "@playwright/test";

// Run against the real API adapter, with every API response intercepted below:
// npm run test:e2e -- --project=account-billing
// The normal demo suite continues exercising its explicit local-only UI.

async function nativeOpener(page: Page) {
  await page.evaluate(() => {
    const fixture = window as any;
    fixture.billingInvokes = [];
    fixture.failBillingOpen = false;
    fixture.holdBillingOpen = false;
    fixture.__TAURI_INTERNALS__ = {
      invoke: async (command: string, args: unknown) => {
        fixture.billingInvokes.push({ command, args });
        if (command !== "plugin:opener|open_url") throw new Error("Unexpected native authority");
        if (fixture.failBillingOpen) throw new Error("Opener refused");
        if (fixture.holdBillingOpen) await new Promise<void>((resolve) => { fixture.finishBillingOpen = resolve; });
      },
    };
  });
}
async function balances(page: Page) {
  return page.evaluate(async () => {
    const sessionPath = "/src/store/session.ts";
    const walletPath = "/src/store/wallet.ts";
    const { useSession } = await import(/* @vite-ignore */ sessionPath);
    const { useWallet } = await import(/* @vite-ignore */ walletPath);
    return { tuzis: useSession.getState().tuzis, zec: useWallet.getState().balance };
  });
}

test("native billing uses account instructions; browser return, duplicate taps, retry and restart never mint credit", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.addInitScript(() => localStorage.setItem("zuuli.knox.token", "billing-fixture-token"));
  let credit = "12.345";
  let unavailable = false;
  let holdRead: Promise<void> | undefined;
  const apiCalls: { path: string; method: string }[] = [];
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    apiCalls.push({ path, method: request.method() });
    if (path !== "/api/auth/user/") return route.fulfill({ status: 503, json: { detail: "Not available in this fixture" } });
    expect(request.headers().authorization).toBe("Token billing-fixture-token");
    if (holdRead) await holdRead;
    return route.fulfill(unavailable
      ? { status: 503, json: { detail: "Temporary failure" } }
      : { json: { username: "billing-fixture", tuzis: credit } });
  });
  await page.goto("/wallet/fund?credited=true&amount=999&client_id=untrusted&next=https://other.test");
  const open = page.getByRole("button", { name: "Open Free2Z billing" });
  await expect(open).toBeVisible();
  await expect(page.getByText("12.345", { exact: true })).toBeVisible();
  await expect(page.getByText("12.345 2Z", { exact: true })).toBeVisible();
  await expect(page.getByText("ZEC in wallet", { exact: true })).toBeVisible();
  await expect(page.getByText("2Z after payment processing", { exact: true })).toBeVisible();
  await expect(page.getByText(/Your browser may be signed in to a different account/)).toBeVisible();
  await expect(page.getByText(/Estimates do not lock a rate/)).toBeVisible();
  await expect(page.getByText(/do not send again because confirmation or credit is delayed/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Pay with ZEC|Pay with card|Run demo/ })).toHaveCount(0);
  await expect(page.getByLabel("Custom amount (2Z)")).toHaveCount(0);
  await expect(page.locator("iframe")).toHaveCount(0);
  expect(await open.evaluate((el) => getComputedStyle(el).cursor)).toBe("pointer");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await nativeOpener(page);
  const original = await balances(page);

  await page.evaluate(() => { (window as any).holdBillingOpen = true; });
  await open.evaluate((el) => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await expect(open).toBeDisabled();
  expect(await open.evaluate((el) => getComputedStyle(el).cursor)).not.toBe("pointer");
  expect(await page.evaluate(() => (window as any).billingInvokes)).toEqual([
    { command: "plugin:opener|open_url", args: { url: "https://stage.free2z.cash/buy-2z" } },
  ]);
  await page.evaluate(() => { (window as any).finishBillingOpen(); (window as any).holdBillingOpen = false; window.dispatchEvent(new Event("focus")); });
  await expect(open).toBeEnabled();
  await expect(page.getByRole("status").filter({ hasText: "Account balance refreshed" })).toBeVisible();
  expect(await balances(page)).toEqual(original);
  await expect(page.getByText("2Z added", { exact: true })).toHaveCount(0);

  await page.evaluate(() => { (window as any).failBillingOpen = true; });
  await open.click();
  await expect(page.getByRole("alert")).toContainText("Couldn't open Free2Z billing");
  expect(await balances(page)).toEqual(original);
  await page.evaluate(() => { (window as any).failBillingOpen = false; });
  await open.click();
  await expect(page.getByRole("alert")).toHaveCount(0);

  const refresh = page.getByRole("button", { name: "Refresh account balance" });
  unavailable = true;
  await refresh.click();
  await expect(page.getByRole("status").filter({ hasText: "Couldn't refresh" })).toBeVisible();
  expect(await balances(page)).toEqual(original);
  unavailable = false;
  let release!: () => void;
  holdRead = new Promise<void>((resolve) => { release = resolve; });
  const before = apiCalls.length;
  await refresh.evaluate((el) => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); el.dispatchEvent(new MouseEvent("click", { bubbles: true })); window.dispatchEvent(new Event("focus")); });
  await expect(page.getByRole("button", { name: "Checking account balance…" })).toBeDisabled();
  await expect.poll(() => apiCalls.length).toBe(before + 1);
  release();
  holdRead = undefined;
  await expect(refresh).toBeEnabled();
  expect(await balances(page)).toEqual(original);

  // Only a later authenticated account response changes the credit readout.
  credit = "45.678";
  await refresh.click();
  await expect(page.getByText("45.678", { exact: true })).toBeVisible();
  await expect(page.getByText("45.678 2Z", { exact: true })).toBeVisible();
  await refresh.click();
  await expect(refresh).toBeEnabled();
  expect((await balances(page)).tuzis).toBe(45.678);
  expect((await balances(page)).zec).toEqual(original.zec);
  await page.reload();
  await expect(page.getByText("45.678", { exact: true })).toBeVisible();
  expect((await balances(page)).tuzis).toBe(45.678);
  expect(apiCalls.every(({ path, method }) => path === "/api/auth/user/" && method === "GET")).toBe(true);
});

test("real signed-out funding returns from login without showing an in-app purchase", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.route(/^https?:\/\/[^/]+\/api\//, (route) => route.fulfill({ status: 503, json: {} }));
  await page.goto("/wallet/fund");
  const login = page.getByRole("button", { name: "Log in to get 2Z" });
  await expect(login).toBeEnabled();
  await expect(page.getByText("2Z balance", { exact: true })).toHaveCount(0);
  await login.click();
  await expect(page).toHaveURL(/\/login$/);
  expect(await page.evaluate(() => window.history.state.usr.returnTo)).toBe("/wallet/fund");
});

test("a plain browser navigates to canonical account billing without carrying local return parameters", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("zuuli.knox.token", "billing-fixture-token"));
  await page.route(/^https?:\/\/[^/]+\/api\//, (route) => route.fulfill({
    json: { username: "billing-fixture", tuzis: "12.345" },
  }));
  await page.route("https://stage.free2z.cash/buy-2z", (route) => {
    expect(route.request().headers().authorization).toBeUndefined();
    return route.fulfill({ contentType: "text/html", body: "<main>Account billing fixture</main>" });
  });
  await page.goto("/wallet/fund?amount=999&next=https://other.test&client_id=untrusted");
  await page.getByRole("button", { name: "Open Free2Z billing" }).click();
  await expect(page).toHaveURL("https://stage.free2z.cash/buy-2z");
  await expect(page.getByRole("main")).toHaveText("Account billing fixture");
});

test("a stalled balance check times out and can be retried without another payment", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("zuuli.knox.token", "billing-fixture-token"));
  let stalled = false;
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
    if (stalled) await pending;
    await route.fulfill({ json: { username: "billing-fixture", tuzis: "12.345" } }).catch(() => undefined);
  });
  await page.goto("/wallet/fund");
  const refresh = page.getByRole("button", { name: "Refresh account balance" });
  await expect(refresh).toBeEnabled();
  await page.clock.install();
  stalled = true;
  await refresh.click();
  await expect(page.getByRole("button", { name: "Checking account balance…" })).toBeDisabled();
  await page.clock.fastForward(15_001);
  await expect(page.getByRole("status").filter({ hasText: "Couldn't refresh" })).toBeVisible();
  await expect(refresh).toBeEnabled();
  await expect(page.getByText("12.345", { exact: true })).toBeVisible();
  stalled = false;
  finish();
  await refresh.click();
  await expect(page.getByRole("status").filter({ hasText: "Account balance refreshed" })).toBeVisible();
  await expect(page.getByText("12.345", { exact: true })).toBeVisible();
});
