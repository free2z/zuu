import { expect, test, type Page } from "@playwright/test";

const creator = {
  id: 8106,
  username: "fixtureowner",
  full_name: "Fixture Owner",
};

type Outcome =
  | "success"
  | "existing"
  | "signup-refused"
  | "login-refused"
  | "identity-refused";

async function signupFixture(page: Page, outcome: Outcome = "success") {
  const calls: string[] = [];
  let logins = 0;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith("/api/")) return route.continue();
    const json = (status: number, body: unknown) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (path === "/api/start/") {
      calls.push("signup");
      if (outcome === "existing")
        return json(400, {
          username: ["A user with that username already exists."],
        });
      if (outcome === "signup-refused")
        return json(400, { detail: "Signup refused" });
      return json(201, creator);
    }
    if (path === "/api/auth/login/") {
      calls.push("login");
      logins++;
      if (outcome === "login-refused")
        return json(400, { detail: "Invalid credentials" });
      return route.fulfill({ status: 204 });
    }
    if (path === "/api/auth/user/") {
      if (!logins) return json(403, { detail: "Not authenticated" });
      calls.push("identity");
      // A second exchange invalidates this fixture session. Signup must finish
      // with the first authenticated result, without risking another exchange.
      if (logins > 1 || outcome === "identity-refused")
        return json(403, { detail: "Not authenticated" });
      return json(200, creator);
    }
    if (path.includes("email") && route.request().method() === "POST")
      calls.push("email");
    return json(200, { count: 0, results: [] });
  });
  await page.goto("/login?view=signup");
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator("#signup-username")).toBeVisible();
  await dialog.locator("#signup-username").fill(creator.username);
  await dialog.locator("#signup-password").fill("Correct-password-123!");
  await dialog.locator("#confirm-password").fill("Correct-password-123!");
  return { calls, dialog };
}

test("signup completes with one login and its authenticated identity", async ({
  page,
}) => {
  const { calls, dialog } = await signupFixture(page);
  await dialog.getByRole("button", { name: /^Sign up$/i }).click();
  await expect(page).toHaveURL("/");
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("navbar-profile-trigger")).toBeVisible();
  expect(calls).toEqual(["signup", "login", "identity"]);
});

test("signup with email keeps the verification step without another login", async ({
  page,
}) => {
  const { calls, dialog } = await signupFixture(page);
  await dialog.locator("#email").fill("signup@example.test");
  await dialog.getByRole("button", { name: /^Sign up$/i }).click();
  await expect(dialog).toContainText("signup@example.test");
  await expect(dialog.locator("#signup-username")).toBeHidden();
  await expect
    .poll(() => calls)
    .toEqual(["signup", "login", "identity", "email"]);
  await expect(page).toHaveURL("/login?view=signup");
});

test("an existing username falls back to one login", async ({ page }) => {
  const { calls, dialog } = await signupFixture(page, "existing");
  await dialog.getByRole("button", { name: /^Sign up$/i }).click();
  await expect(page).toHaveURL("/");
  expect(calls).toEqual(["signup", "login", "identity"]);
});

for (const outcome of [
  "signup-refused",
  "login-refused",
  "identity-refused",
] as const) {
  test(`${outcome} leaves signup open without an authenticated creator`, async ({
    page,
  }) => {
    const { calls, dialog } = await signupFixture(page, outcome);
    await dialog.getByRole("button", { name: /^Sign up$/i }).click();
    await expect(
      dialog.getByText("Sign-up failed", { exact: true }),
    ).toBeVisible();
    await expect(page).toHaveURL("/login?view=signup");
    await expect(page.getByTestId("navbar-profile-trigger")).toBeHidden();
    expect(calls).toEqual(
      outcome === "signup-refused"
        ? ["signup"]
        : outcome === "login-refused"
          ? ["signup", "login"]
          : ["signup", "login", "identity"],
    );
  });
}
