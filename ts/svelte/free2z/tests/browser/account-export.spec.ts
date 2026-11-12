import { expect, test } from "@playwright/test";
import { devSourceModuleLoader } from "./dev-source-module";

const ready = {
  id: "11111111-1111-4111-8111-111111111111",
  status: "ready",
  complete: false,
  warnings: ["Partial archive"],
  error_message: "",
  file_name: "account.zip",
  file_size: 4,
  created_at: "2026-01-01T00:00:00Z",
  completed_at: "2026-01-01T00:00:00Z",
  expires_at: "2027-01-01T00:00:00Z",
  download_url:
    "/api/exports/account/11111111-1111-4111-8111-111111111111/download/",
  download_token: "old",
};
test("enabled in-session flow refreshes the same job after signature expiry", async ({
  page,
}) => {
  let posts = 0,
    reads = 0,
    downloads = 0;
  await page.route("**/api/exports/account/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === "POST") {
      posts++;
      return route.fulfill({ json: ready });
    }
    if (path.endsWith("latest/"))
      return route.fulfill({ json: { export: null } });
    if (path.endsWith("download/")) {
      downloads++;
      if (downloads === 1)
        return route.fulfill({ status: 404, json: { detail: "expired" } });
      expect(route.request().headers()["x-account-export-signature"]).toBe(
        "new",
      );
      return route.fulfill({ contentType: "application/zip", body: "PKxx" });
    }
    reads++;
    return route.fulfill({ json: { ...ready, download_token: "new" } });
  });
  await page.goto("/");
  await page.evaluate(
    async ({ fixtureLoader, storeLoader }) => {
      const runtime = "/tests/browser/svelte-runtime.ts";
      const [{ mount }, { default: Fixture }, { authStore }] =
        await Promise.all([
          import(/* @vite-ignore */ runtime),
          new Function(fixtureLoader)(),
          new Function(storeLoader)(),
        ]);
      const target = document.createElement("div");
      document.body.append(target);
      authStore.hydrateFromSession({ id: 1001, username: "burner", email: "" });
      mount(Fixture, { target });
    },
    {
      fixtureLoader: devSourceModuleLoader(
        "/tests/browser/account-export-fixture.svelte",
      ),
      storeLoader: devSourceModuleLoader("/src/lib/stores/auth.ts"),
    },
  );
  await expect(page.getByTestId("account-export")).toContainText(
    "No email is required",
  );
  await page.getByRole("button", { name: "Request export" }).click();
  await expect(page.getByTestId("account-export")).toContainText(
    "Partial archive",
  );
  await page.getByRole("button", { name: "Download archive" }).click();
  await expect.poll(() => downloads).toBe(2);
  expect(posts).toBe(1);
  expect(reads).toBe(1);
});

test("account switches discard delayed status", async ({ page }) => {
  let releaseStatus!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseStatus = resolve;
  });
  let latest = 0;
  await page.route("**/api/exports/account/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("latest/")) {
      latest++;
      if (latest === 1) {
        await held;
        return route.fulfill({ json: { export: ready } }).catch(() => {});
      }
      return route.fulfill({ json: { export: null } });
    }
    return route.fulfill({ status: 500 });
  });
  await page.goto("/");
  const storeLoader = devSourceModuleLoader("/src/lib/stores/auth.ts");
  await page.evaluate(
    async ({ fixtureLoader, storeLoader }) => {
      const runtime = "/tests/browser/svelte-runtime.ts";
      const [{ mount }, { default: Fixture }, { authStore }] =
        await Promise.all([
          import(/* @vite-ignore */ runtime),
          new Function(fixtureLoader)(),
          new Function(storeLoader)(),
        ]);
      authStore.hydrateFromSession({ id: 1001, username: "alice" });
      const target = document.createElement("div");
      document.body.append(target);
      mount(Fixture, { target });
    },
    {
      fixtureLoader: devSourceModuleLoader(
        "/tests/browser/account-export-fixture.svelte",
      ),
      storeLoader,
    },
  );
  await expect.poll(() => latest).toBe(1);
  await page.evaluate(async (loader) => {
    const { authStore } = await new Function(loader)();
    authStore.hydrateFromSession({ id: 1002, username: "bob" });
    authStore.hydrateFromSession({ id: 1001, username: "alice" });
  }, storeLoader);
  await expect.poll(() => latest).toBeGreaterThan(1);
  releaseStatus();
  await expect(page.getByTestId("account-export")).not.toContainText(
    "Partial archive",
  );
  await expect(
    page.getByRole("button", { name: "Download archive" }),
  ).toHaveCount(0);
});

test("account switch cancels a pending archive download", async ({ page }) => {
  let releaseDownload!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseDownload = resolve;
  });
  let requested = false;
  let saved = 0;
  page.on("download", () => saved++);
  await page.route("**/api/exports/account/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("latest/"))
      return route.fulfill({ json: { export: ready } });
    if (path.endsWith("download/")) {
      requested = true;
      await held;
      return route
        .fulfill({ contentType: "application/zip", body: "PKxx" })
        .catch(() => {});
    }
    return route.fulfill({ status: 500 });
  });
  await page.goto("/");
  const storeLoader = devSourceModuleLoader("/src/lib/stores/auth.ts");
  await page.evaluate(
    async ({ fixtureLoader, storeLoader }) => {
      const runtime = "/tests/browser/svelte-runtime.ts";
      const [{ mount }, { default: Fixture }, { authStore }] =
        await Promise.all([
          import(/* @vite-ignore */ runtime),
          new Function(fixtureLoader)(),
          new Function(storeLoader)(),
        ]);
      authStore.hydrateFromSession({ id: 1001, username: "alice" });
      const target = document.createElement("div");
      document.body.append(target);
      mount(Fixture, { target });
    },
    {
      fixtureLoader: devSourceModuleLoader(
        "/tests/browser/account-export-fixture.svelte",
      ),
      storeLoader,
    },
  );
  await page.getByRole("button", { name: "Download archive" }).click();
  await expect.poll(() => requested).toBe(true);
  await page.evaluate(async (loader) => {
    const { authStore } = await new Function(loader)();
    authStore.hydrateFromSession({ id: 1002, username: "bob" });
  }, storeLoader);
  releaseDownload();
  await expect(page.getByTestId("account-export")).toBeVisible();
  expect(saved).toBe(0);
});
