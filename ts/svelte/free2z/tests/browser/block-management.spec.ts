import { expect, test, type Page } from "@playwright/test";

test.setTimeout(90_000);
const alice = { id: 1, username: "alice", tuzis: "10" };
const bob = { id: 2, username: "bob", tuzis: "10" };

async function signIn(page: Page, cookie = "block-manage-fixture") {
  await page.addInitScript(
    (creator) =>
      localStorage.setItem(
        "auth",
        JSON.stringify({ isAuthenticated: true, creator, loading: false }),
      ),
    alice,
  );
  await page.route("**/api/**", (route) =>
    new URL(route.request().url()).pathname.startsWith("/api/")
      ? route.fulfill({ json: { count: 0, next: null, results: [] } })
      : route.continue(),
  );
  await page
    .context()
    .addCookies([
      { name: "sessionid", value: cookie, domain: "127.0.0.1", path: "/" },
    ]);
  await page.route("**/api/auth/user/", (route) =>
    route.fulfill({ json: alice }),
  );
}
async function switchUser(page: Page, user: typeof alice | null) {
  await page.evaluate(async (value) => {
    const path = "/src/lib/stores/auth.ts";
    const { authStore } = await import(/* @vite-ignore */ path);
    authStore.hydrateFromSession(value);
  }, user);
}

test("account navigation lists and unblocks with failure and retry", async ({
  page,
}) => {
  await signIn(page);
  let failLoad = true;
  let failUnblock = true;
  let blocked = true;
  await page.route("**/api/g12f/blocks/mine/**", (route) => {
    if (failLoad)
      return route.fulfill({ status: 503, json: { detail: "offline" } });
    return route.fulfill({
      json: {
        count: blocked ? 1 : 0,
        next: null,
        results: blocked ? [{ username: "spam" }] : [],
      },
    });
  });
  await page.route("**/api/creator/spam/block/**", (route) => {
    if (failUnblock)
      return route.fulfill({ status: 503, json: { detail: "offline" } });
    blocked = false;
    return route.fulfill({ json: { username: "spam", active: false } });
  });
  await page.goto("/");
  await switchUser(page, alice);
  await expect(async () => {
    await page.getByTestId("navbar-mobile-menu").click();
    await expect(
      page.getByRole("link", { name: "Blocked accounts" }),
    ).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
  await page.getByRole("link", { name: "Blocked accounts" }).click();
  await expect(page).toHaveURL(/\/account\/blocks/);
  await expect(page.getByRole("alert")).toContainText(
    "Could not load the full block list.",
  );
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Could not load the full block list.",
  );
  failLoad = false;
  await page.getByRole("button", { name: "Retry" }).click();
  const unblock = page.getByRole("button", { name: "Unblock @spam" });
  await expect(unblock).toBeVisible();
  await expect(unblock).toHaveCSS("cursor", "pointer");
  await unblock.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert")).toContainText(
    "Could not unblock this account",
  );
  failUnblock = false;
  await unblock.click();
  await expect(
    page.getByText("You have not blocked any accounts."),
  ).toBeVisible();
});

test("late list and unblock responses cannot cross an account switch", async ({
  page,
}) => {
  await signIn(page);
  let releaseList: (() => void) | undefined;
  let releaseMutation: (() => void) | undefined;
  let stage = "first";
  await page.route("**/api/auth/user/", (route) =>
    route.fulfill({ json: stage === "bob" ? bob : alice }),
  );
  await page.route("**/api/g12f/blocks/mine/**", async (route) => {
    if (stage === "first") {
      await new Promise<void>((resolve) => {
        releaseList = resolve;
      });
      return route.fulfill({
        json: { count: 1, next: null, results: [{ username: "old-list" }] },
      });
    }
    return route.fulfill({
      json: {
        count: 1,
        next: null,
        results: [{ username: stage === "alice" ? "old-block" : "new-block" }],
      },
    });
  });
  await page.route("**/api/creator/old-block/block/**", async (route) => {
    await new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    return route.fulfill({ json: { username: "old-block", active: false } });
  });
  await page.goto("/account/blocks");
  await switchUser(page, alice);
  await expect.poll(() => !!releaseList).toBe(true);
  stage = "bob";
  await switchUser(page, bob);
  releaseList?.();
  await expect(
    page.getByRole("link", { name: "@new-block", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "@old-list", exact: true }),
  ).toHaveCount(0);
  stage = "alice";
  await switchUser(page, alice);
  await expect(
    page.getByRole("link", { name: "@old-block", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Unblock @old-block" }).click();
  await expect.poll(() => !!releaseMutation).toBe(true);
  stage = "bob";
  await switchUser(page, bob);
  releaseMutation?.();
  await expect(
    page.getByRole("link", { name: "@new-block", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "@old-block", exact: true }),
  ).toHaveCount(0);
});

test("homepage keeps blocked hero and popular rows as placeholders", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page, "block-home-fixture");
  let names: string[] = [];
  await page.route("**/api/g12f/blocks/mine/**", (route) =>
    route.fulfill({
      json: {
        count: names.length,
        next: null,
        results: names.map((username) => ({ username })),
      },
    }),
  );
  await page.goto("/");
  await switchUser(page, alice);
  await expect(page.getByText("Visible hero-blocked").last()).toBeVisible();
  await expect(page.getByText("Visible popular-blocked").last()).toBeVisible();
  names = ["hero-blocked", "popular-blocked"];
  await page.evaluate(async () => {
    const path = "/src/lib/stores/blocks.ts";
    const blocks = await import(/* @vite-ignore */ path);
    blocks.setLocallyBlocked("hero-blocked", true, "alice");
    blocks.setLocallyBlocked("popular-blocked", true, "alice");
  });
  await expect(page.getByTestId("homepage-hero-blocked")).toBeVisible();
  await expect(page.getByTestId("homepage-popular-blocked")).toBeVisible();
  await expect(page.getByText("Visible hero-blocked")).toHaveCount(0);
  await expect(page.getByText("Visible popular-blocked")).toHaveCount(0);
});
