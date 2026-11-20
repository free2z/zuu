import { expect, test } from "@playwright/test";
import { AUTH_STORE_LOADER } from "./dev-source-module";

const user = "fixtureowner";
const settings = `/${user}/dashboard/settings?lang=en`;
test.setTimeout(90_000);

async function setup(page: import("@playwright/test").Page) {
  await page.context().addCookies([
    {
      name: "sessionid",
      value: "billing-fixture-session",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  await page.route("**/api/auth/user/", (route) =>
    route.fulfill({
      json: { id: 8106, username: user, full_name: "Fixture Owner" },
    }),
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
}

async function openAccount(page: import("@playwright/test").Page) {
  const session = page.waitForResponse(
    (response) => response.url().endsWith("/api/auth/user/") && response.ok(),
  );
  await page.goto(settings);
  await session;
  const tab = page.getByRole("tab", { name: "Account", exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute("data-state", "active");
  return page.getByRole("switch", {
    name: "Low-balance notice for connected apps",
  });
}

test("no email is required; the user can opt in and disable with one switch", async ({
  page,
}) => {
  await setup(page);
  let enabled = false;
  const writes: boolean[] = [];
  await page.route(
    (url) => url.pathname === "/api/events/low-balance-preference/",
    (route) => {
      if (route.request().method() === "PATCH") {
        expect(route.request().postDataJSON().expected_actor_id).toBe(8106);
        enabled = route.request().postDataJSON().enabled;
        writes.push(enabled);
      }
      return route.fulfill({ json: { enabled, actor_id: 8106 } });
    },
  );
  const toggle = await openAccount(page);
  await expect(toggle).toBeEnabled();
  await expect(toggle).not.toBeChecked();
  await expect(
    page.getByText("No email is required.", { exact: false }),
  ).toBeVisible();
  await toggle.click();
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  expect(writes).toEqual([true, false]);
});

test("a late response cannot restore a previous session's preference", async ({
  page,
}) => {
  await setup(page);
  let release!: () => void;
  let requested!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    requested = resolve;
  });
  let reads = 0;
  await page.route(
    (url) => url.pathname === "/api/events/low-balance-preference/",
    async (route) => {
      reads++;
      if (reads === 1) {
        requested();
        await pending;
        await route.fulfill({ json: { enabled: true, actor_id: 8106 } });
      } else await route.fulfill({ json: { enabled: false, actor_id: 8106 } });
    },
  );
  const toggle = await openAccount(page);
  await started;
  await page.evaluate(async (loader) => {
    const { authStore } = await new Function(loader)();
    let current: any;
    authStore.subscribe((state: any) => {
      current = state.creator;
    })();
    authStore.updateCreator({ ...current, id: 9999, username: "another-user" });
    authStore.updateCreator(current);
  }, AUTH_STORE_LOADER);
  await page.getByRole("tab", { name: "Account", exact: true }).click();
  await expect(toggle).toBeEnabled();
  release();
  await expect(toggle).not.toBeChecked();
});

test("the in-site notice has neutral copy and a direct disable action", async ({
  page,
}) => {
  await setup(page);
  const creator = { id: 8106, username: user, full_name: "Fixture Owner" };
  await page.addInitScript((account) => {
    localStorage.setItem(
      "auth",
      JSON.stringify({
        status: "authenticated",
        isAuthenticated: true,
        creator: account,
        loading: false,
      }),
    );
  }, creator);
  let writes: boolean[] = [];
  await page.route(
    (url) => url.pathname.startsWith("/api/events/"),
    async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === "/api/events/low-balance-preference/") {
        expect(request.postDataJSON().expected_actor_id).toBe(8106);
        writes.push(request.postDataJSON().enabled);
        return route.fulfill({ json: { enabled: false, actor_id: 8106 } });
      }
      if (path === "/api/events/unread_count/")
        return route.fulfill({
          json: { unread_count: 1, recipient_username: user },
        });
      if (path === "/api/events/has/") return route.fulfill({ json: true });
      if (path === "/api/events/")
        return route.fulfill({
          json: {
            count: 1,
            next: null,
            results: [
              {
                id: "c9899d0e-5f49-4be3-a0b1-f4d1251a56f2",
                type: "LOW_BALANCE_NOTICE",
                amount: null,
                receiving_user: creator,
                contributor: null,
                payee: null,
                message: "unused",
                content_url: null,
                content_title: null,
                content_available: true,
                created_at: new Date().toISOString(),
                read: false,
              },
            ],
          },
        });
      return route.fulfill({ json: {} });
    },
  );
  await page.goto(`/${user}/dashboard/notifications?lang=en`);
  await expect(
    page.getByText(
      "A connected app could not use 2Z because your available balance was insufficient.",
    ),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Turn off low-balance notices" })
    .click();
  await expect.poll(() => writes).toEqual([false]);
});

for (const transition of ["different account", "same account session"]) {
  test(`held preference update cannot cross ${transition}`, async ({
    page,
  }) => {
    await setup(page);
    await page.route("**/api/auth/login/", (route) =>
      route.fulfill({ json: { key: "session" } }),
    );
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sent = new Promise<void>((resolve) => {
      started = resolve;
    });
    let writes = 0;
    await page.route(
      (url) => url.pathname === "/api/events/low-balance-preference/",
      async (route) => {
        if (route.request().method() === "PATCH") {
          expect(route.request().postDataJSON().expected_actor_id).toBe(8106);
          writes++;
          started();
          await pending;
          return route.fulfill({ json: { enabled: true, actor_id: 8106 } });
        }
        expect(
          new URL(route.request().url()).searchParams.get("expected_actor_id"),
        ).toBe("8106");
        return route.fulfill({ json: { enabled: false, actor_id: 8106 } });
      },
    );
    const toggle = await openAccount(page);
    await expect(toggle).toBeEnabled();
    await toggle.click();
    await sent;
    await page.evaluate(
      async ({ loader, transition }) => {
        const { authStore } = await new Function(loader)();
        if (transition === "same account session") {
          const result = await authStore.loginOnly("fixtureowner", "password");
          if (!result.success) throw new Error("session replacement failed");
        } else {
          let current: any;
          authStore.subscribe((state: any) => {
            current = state.creator;
          })();
          authStore.updateCreator({
            ...current,
            id: 9999,
            username: "another-user",
          });
          authStore.updateCreator(current);
        }
      },
      { loader: AUTH_STORE_LOADER, transition },
    );
    await page.getByRole("tab", { name: "Account", exact: true }).click();
    await expect(toggle).toBeEnabled();
    release();
    await expect(toggle).not.toBeChecked();
    expect(writes).toBe(1);
  });
}

test("latest preference read wins within one session", async ({ page }) => {
  await setup(page);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  await page.route(
    (url) => url.pathname === "/api/events/low-balance-preference/",
    async (route) => {
      reads++;
      if (reads === 1) return route.fulfill({ status: 503, json: {} });
      if (reads === 2) {
        await pending;
        return route.fulfill({ json: { enabled: true, actor_id: 8106 } });
      }
      return route.fulfill({ json: { enabled: false, actor_id: 8106 } });
    },
  );
  const toggle = await openAccount(page);
  const retry = page.getByRole("button", { name: "Retry" });
  await expect(retry).toBeVisible();
  await retry.click();
  await retry.click();
  await expect(toggle).toBeEnabled();
  release();
  await expect(toggle).not.toBeChecked();
  expect(reads).toBe(3);
});

test("a held notification disable cannot update a replacement account", async ({
  page,
}) => {
  await setup(page);
  const creator = { id: 8106, username: user, full_name: "Fixture Owner" };
  await page.addInitScript(
    (account) =>
      localStorage.setItem(
        "auth",
        JSON.stringify({
          status: "authenticated",
          isAuthenticated: true,
          creator: account,
          loading: false,
        }),
      ),
    creator,
  );
  let release!: () => void;
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sent = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route(
    (url) => url.pathname.startsWith("/api/events/"),
    async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === "/api/events/low-balance-preference/") {
        expect(request.postDataJSON()).toEqual({
          enabled: false,
          expected_actor_id: 8106,
        });
        started();
        await pending;
        return route.fulfill({ json: { enabled: false, actor_id: 8106 } });
      }
      if (path === "/api/events/unread_count/")
        return route.fulfill({
          json: { unread_count: 1, recipient_username: user },
        });
      if (path === "/api/events/has/") return route.fulfill({ json: true });
      if (path === "/api/events/")
        return route.fulfill({
          json: {
            count: 1,
            next: null,
            results: [
              {
                id: "c9899d0e-5f49-4be3-a0b1-f4d1251a56f2",
                type: "LOW_BALANCE_NOTICE",
                amount: null,
                receiving_user: creator,
                contributor: null,
                payee: null,
                message: "unused",
                content_url: null,
                content_title: null,
                content_available: true,
                created_at: new Date().toISOString(),
                read: false,
              },
            ],
          },
        });
      return route.fulfill({ json: {} });
    },
  );
  await page.goto(`/${user}/dashboard/notifications?lang=en`);
  await page
    .getByRole("button", { name: "Turn off low-balance notices" })
    .click();
  await sent;
  await page.evaluate(async (loader) => {
    const { authStore } = await new Function(loader)();
    let current: any;
    authStore.subscribe((state: any) => {
      current = state.creator;
    })();
    authStore.updateCreator({ ...current, id: 9999, username: "another-user" });
  }, AUTH_STORE_LOADER);
  release();
  await expect(page.getByText("Low-balance notices are off.")).toHaveCount(0);
});
