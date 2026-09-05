import { expect, test, type Page } from "@playwright/test";

const PHONE = { width: 320, height: 568 };

async function setSession(page: Page, signedIn: boolean) {
  await page.addInitScript((authenticated) => {
    const key = "zuuli.knox.token";
    if (authenticated) localStorage.setItem(key, "mock-knox-token");
    else localStorage.removeItem(key);
    sessionStorage.removeItem("zuuli.auth.pending-paid-intent");
  }, signedIn);
}

async function openRoute(page: Page, path: string, signedIn = false) {
  await page.setViewportSize(PHONE);
  await setSession(page, signedIn);
  await page.goto(path);
  await page.locator("[data-app-frame]").waitFor();
  if (signedIn) {
    await expect(
      page.getByRole("button", { name: "Account menu" }),
    ).toBeVisible();
  } else {
    await expect(
      page.getByRole("button", { name: "Log in", exact: true }),
    ).toBeVisible();
  }
}

async function expectNoAnonymousBalanceDiagnosis(page: Page) {
  await expect(
    page.getByText(/^(?:Your |Current )?Balance(?: after)?:/i),
  ).toHaveCount(0);
  await expect(page.getByText(/Not enough (?:2Z|2Zs)/i)).toHaveCount(0);
  await expect(page.getByText(/You have .* need/i)).toHaveCount(0);
  await expect(page.getByRole("link", { name: /Buy more 2Z/i })).toHaveCount(0);
}

async function expectLoginReturn(page: Page, returnTo: string) {
  await expect(page).toHaveURL(/\/login$/);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = window.history.state as {
          usr?: { returnTo?: unknown };
        } | null;
        return state?.usr?.returnTo ?? null;
      }),
    )
    .toBe(returnTo);
}

async function storedIntent(page: Page) {
  return page.evaluate(() => {
    const raw = sessionStorage.getItem("zuuli.auth.pending-paid-intent");
    return raw ? JSON.parse(raw) : null;
  });
}

test("funding authenticates before balances, quotes, or either top-up method", async ({
  page,
}) => {
  await openRoute(page, "/wallet/fund");

  await expect(page.getByText("2Z balance", { exact: true })).toHaveCount(0);
  await expect(page.getByText("ZEC in wallet", { exact: true })).toHaveCount(0);
  await expect(
    page.getByText("Mock wallet spendable", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Log in to buy" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Log in to pay with ZEC" }),
  ).toBeVisible();
  await expectNoAnonymousBalanceDiagnosis(page);

  await page.getByRole("button", { name: "Log in to buy" }).click();
  await expectLoginReturn(page, "/wallet/fund");

  await openRoute(page, "/wallet/fund");
  await page.getByRole("tab", { name: "Activity" }).click();
  await expect(page).toHaveURL(/\/wallet\/fund\/activity$/);
  await expect(page.getByText("Sign in to view activity")).toBeVisible();
  await expect(
    page.getByText("Card purchase history belongs to your account."),
  ).toBeVisible();
  await expect(page.getByText(/tips|charges/i)).toHaveCount(0);
  await expect(page.getByText("Total bought")).toHaveCount(0);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expectLoginReturn(page, "/wallet/fund/activity");
});

test("send restores its bounded draft only after login and never diagnoses a guest balance", async ({
  page,
}) => {
  await openRoute(page, "/wallet/fund/send");

  await page
    .getByRole("combobox", { name: "Search for a 2Z recipient" })
    .fill("maya");
  await page.getByLabel("Custom tip amount in 2Z").fill("3,000");
  await expectNoAnonymousBalanceDiagnosis(page);
  await page.getByRole("button", { name: "Sign in to send 2Z" }).click();

  await expectLoginReturn(page, "/wallet/fund/send");
  await expect
    .poll(() => storedIntent(page))
    .toMatchObject({
      returnTo: "/wallet/fund/send",
      intent: { kind: "send", query: "maya", amount: 3000 },
    });
});

test.describe("locale-invariant Send drafts", () => {
  test.use({ locale: "de-DE" });

  test("formats a canonical amount in the locale active after login", async ({
    page,
  }) => {
    await page.setViewportSize(PHONE);
    await page.addInitScript(() => {
      localStorage.setItem("zuuli.knox.token", "mock-knox-token");
      sessionStorage.setItem(
        "zuuli.auth.pending-paid-intent",
        JSON.stringify({
          returnTo: "/wallet/fund/send",
          createdAt: Date.now(),
          intent: { kind: "send", query: "maya", amount: 3000 },
        }),
      );
    });

    await page.goto("/wallet/fund/send");
    await page.locator("[data-app-frame]").waitFor();

    await expect(page.getByLabel("Custom tip amount in 2Z")).toHaveValue(
      "3.000",
    );
  });
});

test("send keeps malformed restored money text invalid instead of coercing it to a preset", async ({
  page,
}) => {
  await page.setViewportSize(PHONE);
  await page.addInitScript(() => {
    localStorage.setItem("zuuli.knox.token", "mock-knox-token");
    sessionStorage.setItem(
      "zuuli.auth.pending-paid-intent",
      JSON.stringify({
        returnTo: "/wallet/fund/send",
        createdAt: Date.now(),
        intent: { kind: "send", query: "maya", amount: "0100" },
      }),
    );
  });
  await page.goto("/wallet/fund/send");
  await page.locator("[data-app-frame]").waitFor();

  await expect(page.getByLabel("Custom tip amount in 2Z")).toHaveValue("0100");
  // The example in the hint is rendered in the browser's own locale, so match
  // only the locale-independent prefix.
  await expect(
    page.getByText(/Enter a positive whole 2Z amount, e\.g\./),
  ).toBeVisible();
});

/**
 * These three are about the *intent*, not about the surface that issued it.
 * They ran on `/ai` until #904 phase 4 moved AI to free2z; Wallet Send & Tip
 * is the paid surface this app keeps, and it stores the same shape.
 */
async function stageGuestSendIntent(page: Page) {
  await openRoute(page, "/wallet/fund/send");
  await page
    .getByRole("combobox", { name: "Search for a 2Z recipient" })
    .fill("maya");
  await page.getByLabel("Custom tip amount in 2Z").fill("3,000");
  await page.getByRole("button", { name: "Sign in to send 2Z" }).click();
  await expectLoginReturn(page, "/wallet/fund/send");
}

test("abandoning login destroys the guest's private paid intent", async ({
  page,
}) => {
  await stageGuestSendIntent(page);
  await expect.poll(() => storedIntent(page)).not.toBeNull();

  await page.getByRole("link", { name: "Continue as guest" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect.poll(() => storedIntent(page)).toBeNull();
});

test("reloading login destroys the guest's private paid intent", async ({
  page,
}) => {
  await stageGuestSendIntent(page);
  await expect.poll(() => storedIntent(page)).not.toBeNull();

  await page.reload();
  await expect(page).toHaveURL(/\/login$/);
  await expect.poll(() => storedIntent(page)).toBeNull();
});

test("browser Back cannot restore a private paid intent while signed out", async ({
  page,
}) => {
  await stageGuestSendIntent(page);

  await page.goBack();
  await expect(page).toHaveURL(/\/wallet\/fund\/send$/);
  await expect(
    page.getByRole("combobox", { name: "Search for a 2Z recipient" }),
  ).toHaveValue("");
  await expect.poll(() => storedIntent(page)).toBeNull();
});

test("funding tabs and browser history stay synchronized with the send URL", async ({
  page,
}) => {
  await openRoute(page, "/wallet/fund");
  await page.getByRole("tab", { name: "Send & Tip" }).click();
  await expect(page).toHaveURL(/\/wallet\/fund\/send$/);
  await expect(page.getByRole("tab", { name: "Send & Tip" })).toHaveAttribute(
    "data-state",
    "active",
  );

  await page.getByRole("tab", { name: "Buy" }).click();
  await expect(page).toHaveURL(/\/wallet\/fund$/);
  await expect(page.getByRole("tab", { name: "Buy" })).toHaveAttribute(
    "data-state",
    "active",
  );

  await page.goBack();
  await expect(page).toHaveURL(/\/wallet\/fund\/send$/);
  await expect(page.getByRole("tab", { name: "Send & Tip" })).toHaveAttribute(
    "data-state",
    "active",
  );

  await page.goto("/wallet/fund/send/");
  await expect(page.getByRole("tab", { name: "Send & Tip" })).toHaveAttribute(
    "data-state",
    "active",
  );
});
