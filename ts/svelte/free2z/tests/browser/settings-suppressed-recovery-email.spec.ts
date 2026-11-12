import { expect, test } from "@playwright/test";

const USER = "fixtureowner";
const SETTINGS = `/${USER}/dashboard/settings`;
test.setTimeout(60_000);

test("an unmailed recovery address can be resent from settings", async ({
  page,
}) => {
  const resent: string[] = [];
  const added: string[] = [];
  await page.context().addCookies([
    {
      name: "sessionid",
      value: "billing-fixture-session",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  await page.route("**/api/emails/status", (route) =>
    route.fulfill({
      json: {
        email: "retry@example.com",
        confirmed: false,
        pending: false,
        is_public: false,
        get_notifications: false,
      },
    }),
  );
  await page.route("**/api/auth/user/", (route) =>
    route.fulfill({
      json: { id: 8106, username: USER, full_name: "Fixture Owner" },
    }),
  );
  await page.route("**/api/emails/resend", (route) => {
    resent.push(route.request().postDataJSON().email);
    return route.fulfill({ status: 204 });
  });
  await page.route("**/api/emails/add", (route) => {
    added.push(route.request().postDataJSON().email);
    return route.fulfill({ status: 201, json: {} });
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  const sessionLoaded = page.waitForResponse(
    (response) => response.url().endsWith("/api/auth/user/") && response.ok(),
  );
  await page.goto(SETTINGS);
  await sessionLoaded;
  const accountTab = page.getByRole("tab", { name: "Account", exact: true });
  await accountTab.click();
  await expect(accountTab).toHaveAttribute("data-state", "active");

  await page.getByRole("button", { name: "Resend Confirmation" }).click();
  await expect.poll(() => resent.length).toBe(1);
  expect(resent).toEqual(["retry@example.com"]);

  await page.getByRole("button", { name: "Update", exact: true }).click();
  await expect.poll(() => resent.length).toBe(2);
  expect(added).toEqual([]);
});

test("settings explain suppression only for the confirmed account address", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.context().addCookies([
    {
      name: "sessionid",
      value: "billing-fixture-session",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  await page.route("**/api/auth/user/", (route) =>
    route.fulfill({ json: { id: 8106, username: USER } }),
  );
  await page.route("**/api/emails/status", (route) =>
    route.fulfill({
      json: {
        email: "owner@example.com",
        confirmed: true,
        pending: false,
        is_public: false,
        get_notifications: false,
      },
    }),
  );
  await page.route("**/api/emails/recovery-status", (route) =>
    route.fulfill({ json: { email_confirmed: true, email_suppressed: true } }),
  );
  const sessionLoaded = page.waitForResponse(
    (response) => response.url().endsWith("/api/auth/user/") && response.ok(),
  );
  await page.goto(SETTINGS);
  await sessionLoaded;
  const accountTab = page.getByRole("tab", { name: "Account", exact: true });
  await accountTab.click();
  await expect(accountTab).toHaveAttribute("data-state", "active");
  const notice = page.getByTestId("recovery-suppressed");
  await expect(notice).toContainText("cannot receive mail");
  await expect(notice).toContainText("different address");
  await expect(
    notice.getByRole("link", { name: "Contact support" }),
  ).toHaveAttribute("href", "mailto:help@free2z.com");
  await expect(page.getByLabel("Email Address", { exact: true })).toHaveValue(
    "owner@example.com",
  );
});

test("settings show no-email guidance and allow retry after status failure", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  let requests = 0;
  await page.context().addCookies([
    {
      name: "sessionid",
      value: "billing-fixture-session",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  await page.route("**/api/auth/user/", (route) =>
    route.fulfill({ json: { id: 8106, username: USER } }),
  );
  await page.route("**/api/emails/status", (route) =>
    route.fulfill({
      json: {
        email: null,
        confirmed: false,
        pending: false,
        is_public: false,
        get_notifications: false,
      },
    }),
  );
  await page.route("**/api/emails/recovery-status", (route) => {
    requests++;
    return requests === 1
      ? route.fulfill({ status: 503 })
      : route.fulfill({
          json: { email_confirmed: false, email_suppressed: false },
        });
  });
  const sessionLoaded = page.waitForResponse(
    (response) => response.url().endsWith("/api/auth/user/") && response.ok(),
  );
  await page.goto(SETTINGS);
  await sessionLoaded;
  const accountTab = page.getByRole("tab", { name: "Account", exact: true });
  await accountTab.click();
  await expect(accountTab).toHaveAttribute("data-state", "active");
  await expect(page.getByTestId("recovery-no-email")).toContainText(
    "Add and confirm",
  );
  await expect(
    page.getByText("Could not check recovery status."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Retry email status" }).click();
  await expect(page.getByText("Could not check recovery status.")).toHaveCount(
    0,
  );
  await expect(page.getByTestId("recovery-suppressed")).toHaveCount(0);
});

test("a late recovery response is discarded after an account switch", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.context().addCookies([
    {
      name: "sessionid",
      value: "billing-fixture-session",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  await page.route("**/api/auth/user/", (route) =>
    route.fulfill({ json: { id: 8106, username: USER } }),
  );
  await page.route("**/api/emails/status", (route) =>
    route.fulfill({
      json: {
        email: "owner@example.com",
        confirmed: true,
        pending: false,
        is_public: false,
        get_notifications: false,
      },
    }),
  );
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route("**/api/emails/recovery-status", async (route) => {
    started();
    await wait;
    await route
      .fulfill({ json: { email_confirmed: true, email_suppressed: true } })
      .catch(() => {});
  });
  const sessionLoaded = page.waitForResponse(
    (response) => response.url().endsWith("/api/auth/user/") && response.ok(),
  );
  await page.goto(SETTINGS);
  await sessionLoaded;
  const accountTab = page.getByRole("tab", { name: "Account", exact: true });
  await accountTab.click();
  await expect(accountTab).toHaveAttribute("data-state", "active");
  await pending;
  await page.evaluate(async () => {
    const modulePath = "/src/lib/stores/auth.ts";
    const { authStore } = await import(/* @vite-ignore */ modulePath);
    authStore.hydrateFromSession({ id: 8107, username: "anotherowner" });
  });
  release();
  await expect(page.getByTestId("recovery-suppressed")).toHaveCount(0);
  await expect(
    page.getByLabel("Email Address", { exact: true }),
  ).not.toHaveValue("owner@example.com");
});

for (const [action, change, result] of [
  ["add", "other", 201],
  ["delete", "other", 204],
  ["add", "same", 201],
  ["resend", "same", 503],
] as const) {
  test(`late ${action} cannot affect ${change} session`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.context().addCookies([
      {
        name: "sessionid",
        value: "billing-fixture-session",
        domain: "127.0.0.1",
        path: "/",
      },
    ]);
    let user = { id: 8106, username: USER };
    await page.route("**/api/auth/user/", (route) =>
      route.fulfill({ json: user }),
    );
    await page.route("**/api/auth/login/", (route) =>
      route.fulfill({ json: { key: "new-session" } }),
    );
    await page.route("**/api/emails/status", (route) =>
      route.fulfill({
        json: {
          email: "owner@example.com",
          confirmed: action !== "resend",
          pending: action === "resend",
          is_public: false,
          get_notifications: false,
        },
      }),
    );
    await page.route("**/api/emails/recovery-status", (route) =>
      route.fulfill({
        json: { email_confirmed: action !== "resend", email_suppressed: false },
      }),
    );
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    let began!: () => void;
    const pending = new Promise<void>((resolve) => {
      began = resolve;
    });
    await page.route(`**/api/emails/${action}`, async (route) => {
      began();
      await wait;
      await route
        .fulfill({
          status: result,
          ...(result === 204
            ? {}
            : {
                json: result === 503 ? { detail: "private stale error" } : {},
              }),
        })
        .catch(() => {});
    });
    const sessionLoaded = page.waitForResponse(
      (response) => response.url().endsWith("/api/auth/user/") && response.ok(),
    );
    await page.goto(SETTINGS);
    await sessionLoaded;
    const tab = page.getByRole("tab", { name: "Account", exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute("data-state", "active");
    if (action === "add") {
      await page
        .getByLabel("Email Address", { exact: true })
        .fill("new@example.com");
      await page.getByRole("button", { name: "Update", exact: true }).click();
    } else if (action === "delete") {
      await page.getByRole("button", { name: "Remove Email" }).click();
    } else {
      await page.getByRole("button", { name: "Resend Confirmation" }).click();
    }
    await pending;
    if (change === "other") user = { id: 8107, username: "anotherowner" };
    await page.evaluate(
      async ({ username }) => {
        const path = "/src/lib/stores/auth.ts";
        const { authStore } = await import(/* @vite-ignore */ path);
        await authStore.loginOnly(username, "fixture-password");
      },
      { username: user.username },
    );
    release();
    await expect(page).not.toHaveURL(/\/login/);
    await expect(
      page
        .locator("[data-sonner-toast]")
        .filter({ hasText: "private stale error" }),
    ).toHaveCount(0);
    if (change === "same") {
      await expect(
        page.getByRole("button", { name: "Update", exact: true }),
      ).toBeEnabled();
      await expect(
        page.getByLabel("Email Address", { exact: true }),
      ).not.toHaveValue("new@example.com");
    }
  });
}

test("unmount discards a late email mutation", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.context().addCookies([
    {
      name: "sessionid",
      value: "billing-fixture-session",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  await page.route("**/api/auth/user/", (route) =>
    route.fulfill({ json: { id: 8106, username: USER } }),
  );
  await page.route("**/api/emails/status", (route) =>
    route.fulfill({
      json: {
        email: "owner@example.com",
        confirmed: true,
        pending: false,
        is_public: false,
        get_notifications: false,
      },
    }),
  );
  await page.route("**/api/emails/recovery-status", (route) =>
    route.fulfill({ json: { email_confirmed: true, email_suppressed: false } }),
  );
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let began!: () => void;
  const pending = new Promise<void>((resolve) => {
    began = resolve;
  });
  await page.route("**/api/emails/delete", async (route) => {
    began();
    await wait;
    await route.fulfill({ status: 204 }).catch(() => {});
  });
  const sessionLoaded = page.waitForResponse(
    (response) => response.url().endsWith("/api/auth/user/") && response.ok(),
  );
  await page.goto(SETTINGS);
  await sessionLoaded;
  const tab = page.getByRole("tab", { name: "Account", exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute("data-state", "active");
  await page.getByRole("button", { name: "Remove Email" }).click();
  await pending;
  await page.goto("/");
  release();
  await expect(page).not.toHaveURL(/\/login/);
});
