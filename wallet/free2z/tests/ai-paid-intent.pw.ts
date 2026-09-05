import { expect, test, type Page } from "@playwright/test";

/**
 * The `/ai` half of ZUULI's `paid-actions.pw.ts`.
 *
 * ZUULI's spec covers `/wallet/fund`, `/buy`, creator tips and `/ai` in one
 * file. free2z mounts none of the wallet routes (#904), so the file cannot be
 * ported whole; the four AI tests are lifted into their own spec instead. What
 * they guard is a privacy property, not just a convenience one: a signed-out
 * draft is a private message the reader has not sent yet, and it must survive
 * an intentional login while being destroyed by every other exit.
 */

const PHONE = { width: 320, height: 568 };

async function setSession(page: Page, signedIn: boolean) {
  await page.addInitScript((authenticated) => {
    const key = "zuuli.knox.token";
    if (authenticated) localStorage.setItem(key, "mock-knox-token");
    else localStorage.removeItem(key);
    sessionStorage.removeItem("zuuli.auth.pending-paid-intent");
  }, signedIn);
}

async function openAi(page: Page, signedIn = false) {
  await page.setViewportSize(PHONE);
  await setSession(page, signedIn);
  await page.goto("/ai");
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

test("AI preserves its draft while authenticating before the paid conversation APIs", async ({
  page,
}) => {
  await openAi(page);

  const draft = "Explain shielded payments simply";
  await page.getByRole("textbox", { name: "Message" }).fill(draft);
  await expect(
    page.getByText("Sign in to use AI.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Buy 2Zs" })).toHaveCount(0);
  await expectNoAnonymousBalanceDiagnosis(page);
  await page.getByRole("button", { name: "Sign in to send message" }).click();

  await expectLoginReturn(page, "/ai");
  await expect.poll(() => storedIntent(page)).toMatchObject({
    returnTo: "/ai",
    intent: { kind: "ai", draft },
  });
});

test("abandoning login destroys the guest's private AI draft", async ({
  page,
}) => {
  await openAi(page);
  await page.getByRole("textbox", { name: "Message" }).fill("private draft");
  await page.getByRole("button", { name: "Sign in to send message" }).click();
  await expectLoginReturn(page, "/ai");
  await expect.poll(() => storedIntent(page)).not.toBeNull();

  await page.getByRole("link", { name: "Continue as guest" }).click();
  // ZUULI's guest exit lands on its Home feature. free2z has none, so the
  // index route forwards to /articles.
  await expect(page).toHaveURL(/\/articles$/);
  await expect.poll(() => storedIntent(page)).toBeNull();
});

test("reloading login destroys the guest's private AI draft", async ({
  page,
}) => {
  await openAi(page);
  await page.getByRole("textbox", { name: "Message" }).fill("private draft");
  await page.getByRole("button", { name: "Sign in to send message" }).click();
  await expectLoginReturn(page, "/ai");
  await expect.poll(() => storedIntent(page)).not.toBeNull();

  await page.reload();
  await expect(page).toHaveURL(/\/login$/);
  await expect.poll(() => storedIntent(page)).toBeNull();
});

test("browser Back cannot restore a private AI draft while signed out", async ({
  page,
}) => {
  await openAi(page);
  await page.getByRole("textbox", { name: "Message" }).fill("private draft");
  await page.getByRole("button", { name: "Sign in to send message" }).click();
  await expectLoginReturn(page, "/ai");

  await page.goBack();
  await expect(page).toHaveURL(/\/ai$/);
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("");
});
