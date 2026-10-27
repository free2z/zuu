import { expect, test } from "@playwright/test";

test("routine successes expire and release the queue while important notices persist", async ({
  page,
}) => {
  await page.context().addCookies([
    {
      name: "sessionid",
      value: "stream-audience-owner-session",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  const auth = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/auth/user/",
  );
  await page.goto("/search");
  await auth;
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const path = "/src/lib/stores/auth.ts";
        const { authStore } = await import(path);
        let username: string | undefined;
        authStore.subscribe((state: any) => {
          username = state.creator?.username;
        })();
        return username;
      }),
    )
    .toBe("streamaudienceowner");
  await page.evaluate(async () => {
    const path = "/src/lib/toast.ts";
    const { toast } = await import(path);
    toast.dismiss();
    toast.error("Important failure");
    toast.success("Routine success");
    toast.info("Queued information");
  });
  await expect(
    page.getByText("Routine success", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Queued information", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("Routine success", { exact: true })).toHaveCount(
    0,
    { timeout: 8000 },
  );
  await expect(
    page.getByText("Queued information", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Important failure", { exact: true }),
  ).toBeVisible();
});

test("promise success expires after persistent loading; actionable successes persist", async ({
  page,
}) => {
  await page.context().addCookies([
    {
      name: "sessionid",
      value: "stream-audience-owner-session",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  const auth = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/auth/user/",
  );
  await page.goto("/search");
  await auth;
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const path = "/src/lib/stores/auth.ts";
        const { authStore } = await import(path);
        let username: string | undefined;
        authStore.subscribe((state: any) => {
          username = state.creator?.username;
        })();
        return username;
      }),
    )
    .toBe("streamaudienceowner");
  await page.evaluate(async () => {
    const path = "/src/lib/toast.ts";
    const { toast } = await import(path);
    toast.dismiss();
    toast.success("Action required", {
      action: { label: "Review", onClick: () => {} },
    });
    toast.promise(
      new Promise((resolve) => {
        (window as any).finishToast = resolve;
      }),
      {
        loading: "Working on request",
        success: "Request finished",
        error: "Request failed",
      },
    );
  });
  await expect(
    page.getByText("Working on request", { exact: true }),
  ).toBeVisible();
  await page.waitForTimeout(5500);
  await expect(
    page.getByText("Working on request", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => (window as any).finishToast());
  await expect(
    page.getByText("Request finished", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Request finished", { exact: true })).toHaveCount(
    0,
    { timeout: 8000 },
  );
  await expect(
    page.getByText("Action required", { exact: true }),
  ).toBeVisible();
});
