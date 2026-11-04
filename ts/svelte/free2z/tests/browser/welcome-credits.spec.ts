import { expect, test } from "@playwright/test";
import { installSession } from "./posting-cost-session";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
});

for (const amount of ["10.000", "3.000", null]) {
  test(`confirmed signup grant ${amount}: welcome and dismissal`, async ({
    page,
  }) => {
    await installSession(page, amount ?? "0", undefined, amount);
    await page.goto("/converse");
    await expect(page.locator("#converse-content")).toBeVisible();
    const welcome = page.getByTestId("welcome-credits");
    if (amount === null) {
      await expect(welcome).toHaveCount(0);
      return;
    }
    await expect(welcome).toContainText(`You received ${Number(amount)} 2Z`);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            JSON.parse(localStorage.getItem("auth") ?? "{}").creator
              ?.welcome_grant,
        ),
      )
      .toBeUndefined();
    await expect(welcome).toContainText("1 2Z");
    await expect(welcome).toContainText("free of ads");
    await expect(welcome).toContainText("discourage spam");
    await expect(welcome.getByRole("link")).toHaveAttribute("href", "/credits");
    await expect(welcome.getByRole("link")).toHaveAttribute("target", "_blank");
    await welcome
      .getByRole("button", { name: "Dismiss welcome message" })
      .click();
    await expect(welcome).toHaveCount(0);
    await page.reload();
    await expect(page.locator("#converse-content")).toBeVisible();
    await expect(welcome).toHaveCount(0);
  });
}

test("credit explanation is reachable from both notices without losing the draft", async ({
  page,
  context,
}) => {
  await installSession(page, "0");
  await page.goto("/converse");
  const draft = page.locator("#converse-content");
  await draft.fill("My introduction draft");
  const opened = context.waitForEvent("page");
  await page
    .getByTestId("posting-cost-notice")
    .getByTestId("credits-explanation")
    .click();
  const explanation = await opened;
  await expect(explanation.getByRole("heading", { level: 1 })).toHaveText(
    "Why a penny a post?",
  );
  await expect(explanation.locator("article")).toContainText(
    "platform credits",
  );
  await expect(explanation.locator("article")).toContainText("welcome grant");
  await expect(explanation.locator("article")).toContainText(
    "gifts from members",
  );
  await expect(
    explanation
      .locator("article")
      .getByRole("link", { name: "Buy 2Z", exact: true }),
  ).toHaveAttribute("href", "/buy-2z");
  await explanation.close();
  await expect(draft).toHaveValue("My introduction draft");
  await page.getByRole("button", { name: "Post", exact: true }).click();
  await expect(
    page.getByTestId("insufficient-funds").getByTestId("credits-explanation"),
  ).toHaveAttribute("href", "/credits");
  await expect(draft).toHaveValue("My introduction draft");
});

for (const server of ["missing", "null", "expired"] as const) {
  test(`cached grant cannot welcome before or after delayed ${server} session`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      new MutationObserver(() => {
        if (document.querySelector('[data-testid="welcome-credits"]')) {
          document.documentElement.setAttribute("data-welcome-seen", "true");
        }
      }).observe(document, { subtree: true, childList: true });
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requested = false;
    await installSession(
      page,
      "10",
      undefined,
      server === "null" ? null : undefined,
      {
        cachedWelcomeGrant: "10.000",
        authStatus: server === "expired" ? 401 : 200,
        beforeAuthResponse: async () => {
          requested = true;
          await held;
        },
      },
    );
    await page.goto("/converse");
    await expect.poll(() => requested).toBe(true);
    await expect(page.getByTestId("welcome-credits")).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            JSON.parse(localStorage.getItem("auth") ?? "{}").creator
              ?.welcome_grant,
        ),
      )
      .toBeUndefined();
    const settled = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/auth/user/",
    );
    await expect(page.locator("html")).not.toHaveAttribute("data-welcome-seen");
    release();
    await settled;
    if (server === "expired") {
      await expect
        .poll(() => page.evaluate(() => localStorage.getItem("auth")))
        .toBeNull();
    } else {
      await expect(page.locator("#converse-content")).toBeVisible();
    }
    await expect(page.getByTestId("welcome-credits")).toHaveCount(0);
    await expect(page.locator("html")).not.toHaveAttribute("data-welcome-seen");
  });
}
