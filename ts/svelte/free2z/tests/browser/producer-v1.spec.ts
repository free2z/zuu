import { test, expect } from "@playwright/test";
const path = "/streamaudienceowner/dashboard/producer";
const id = "49aa6f7c-d27e-47f4-a28e-8685af4ea4e9";
test.beforeEach(async ({ page }) => {
  page.on("pageerror", (error) =>
    console.error("Producer page error:", error.message),
  );
  await page.context().addCookies([
    {
      name: "sessionid",
      value: "stream-audience-owner-session",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  await page.route("**/api/dyte/producer/v1**", (route) =>
    route.fulfill({
      json: route.request().url().endsWith("history")
        ? []
        : { ready: false, eligible: true },
    }),
  );
});
test("producer refuses unconfigured, paid and private paths before provisioning", async ({
  page,
}) => {
  const writes: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().includes("/producer/v1"))
      writes.push(r.url());
  });
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".f2z-producer")).toBeVisible({ timeout: 20000 });
  await expect(
    page.getByRole("heading", { name: "Producer controls" }),
  ).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Backend unavailable");
  await page.getByLabel("Title", { exact: true }).fill("An honest stream");
  await page.getByLabel("Audience", { exact: true }).selectOption("private");
  await expect(page.getByRole("alert")).toContainText("unavailable");
  await expect(
    page.getByRole("button", { name: "Prepare stream", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("Audience", { exact: true }).selectOption("public");
  await page.getByLabel("Access", { exact: true }).selectOption("paid");
  await expect(
    page.getByRole("button", { name: "Prepare stream", exact: true }),
  ).toBeDisabled();
  expect(writes).toEqual([]);
});
test("producer recovers authoritative interrupted state without creating another room", async ({
  page,
}) => {
  const writes: unknown[] = [];
  await page.route("**/api/dyte/producer/v1**", (route) => {
    if (route.request().method() === "POST")
      writes.push(route.request().postDataJSON());
    return route.fulfill({
      json: route.request().url().endsWith("history")
        ? [
            {
              id,
              owner: id,
              state: "interrupted",
              version: 8,
              title: "Recovered stream",
              description: "Original metadata",
              audience: "public",
              access: "free",
              room_id: id,
              participants: null,
              error_code: "",
              ended_at: null,
            },
          ]
        : { ready: true, eligible: true },
    });
  });
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".f2z-producer")).toBeVisible({ timeout: 20000 });
  await expect(page.getByRole("status")).toContainText("Interrupted");
  await expect(page.getByRole("status")).toContainText(
    "Participants: Unavailable",
  );
  await expect(
    page.getByRole("button", { name: "Take over here" }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Prepare stream", exact: true }),
  ).toBeDisabled();
  await expect(page.getByLabel("Title", { exact: true })).toBeDisabled();
  expect(writes).toEqual([]);
});
test("producer controls are touch sized and fit at 320 pixels", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 820 });
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".f2z-producer")).toBeVisible({ timeout: 20000 });
  const buttons = page.locator(".f2z-producer button");
  await expect(buttons).toHaveCount(10);
  for (const b of await buttons.all())
    expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await expect(page.getByLabel("Audience", { exact: true })).toHaveCSS(
    "cursor",
    "pointer",
  );
  await expect(
    page.getByRole("button", { name: "Prepare stream", exact: true }),
  ).toHaveCSS("cursor", "default");
  await page.getByLabel("Title", { exact: true }).focus();
  await expect(page.getByLabel("Title", { exact: true })).toBeFocused();
});

test("capture refusal and missing hardware explain recovery without creating a room", async ({
  page,
}) => {
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/producer/v1"))
      writes.push(request.url());
  });
  await page.route("**/api/dyte/producer/v1**", (route) =>
    route.fulfill({
      json: route.request().url().endsWith("history")
        ? []
        : { ready: true, eligible: true },
    }),
  );
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".f2z-producer")).toBeVisible({ timeout: 20000 });
  await expect(page.getByRole("status")).toContainText("Backend ready");
  await page.getByLabel("Title", { exact: true }).fill("No capture yet");
  for (const [name, guidance] of [
    ["NotAllowedError", "Allow camera and microphone access in settings"],
    ["NotFoundError", "Connect a camera and microphone"],
  ]) {
    await page.evaluate((name) => {
      navigator.mediaDevices.getUserMedia = async () => {
        throw new DOMException("Controlled capture refusal", name);
      };
    }, name);
    await page
      .getByRole("button", { name: "Set up camera and microphone" })
      .click();
    await expect(page.getByRole("alert")).toContainText(guidance);
    await expect(
      page.getByRole("button", { name: "Prepare stream", exact: true }),
    ).toBeDisabled();
    await expect(page.getByRole("status")).toContainText("No stream");
  }
  expect(writes).toEqual([]);
});

test("same-owner live reload offers reconnect without another room or automatic SDK connection", async ({
  page,
}) => {
  await page.addInitScript(
    ({ id }) =>
      sessionStorage.setItem(
        "free2z.producer.v1.784",
        JSON.stringify({ owner: id, pending: null }),
      ),
    { id },
  );
  const posts: unknown[] = [];
  await page.route("**/api/dyte/producer/v1**", (route) => {
    if (route.request().method() === "POST")
      posts.push(route.request().postDataJSON());
    return route.fulfill({
      json: route.request().url().endsWith("history")
        ? [
            {
              id,
              owner: id,
              state: "live",
              version: 8,
              title: "Persisted title",
              description: "Persisted description",
              audience: "public",
              access: "free",
              room_id: id,
              participants: 1,
              error_code: "",
              ended_at: null,
            },
          ]
        : { ready: true, eligible: true },
    });
  });
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".f2z-producer")).toBeVisible({ timeout: 20000 });
  await expect(
    page.getByRole("button", { name: "Reconnect", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Take over here", exact: true }),
  ).toBeDisabled();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue(
    "Persisted title",
  );
  expect(posts).toEqual([]);
});

test("a read-only tab expires presence and observes the other host ending without writes", async ({
  page,
}) => {
  await page.clock.install();
  let mode: "live" | "unreachable" | "ended" = "live";
  const writes: unknown[] = [];
  await page.route("**/api/dyte/producer/v1**", (route) => {
    if (route.request().method() === "POST")
      writes.push(route.request().postDataJSON());
    if (route.request().url().endsWith("history")) {
      if (mode === "unreachable")
        return route.fulfill({
          status: 503,
          json: { code: "provider_unavailable" },
        });
      return route.fulfill({
        json: [
          {
            id,
            owner: id,
            state: mode === "ended" ? "cleaned_up" : "live",
            version: 8,
            title: "Other host",
            description: "Persisted metadata",
            audience: "public",
            access: "free",
            room_id: id,
            participants: mode === "ended" ? null : 3,
            error_code: "",
            ended_at: mode === "ended" ? new Date().toISOString() : null,
          },
        ],
      });
    }
    return route.fulfill({ json: { ready: true, eligible: true } });
  });
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".f2z-producer")).toBeVisible({ timeout: 20000 });
  await expect(page.getByRole("status")).toContainText("Participants: 3");
  mode = "unreachable";
  await page.clock.runFor(65000);
  await expect(page.getByRole("alert")).toContainText("could not be confirmed");
  await expect(page.getByRole("status")).toContainText(
    "Participants: Unavailable",
  );
  await expect(page.getByRole("status")).not.toContainText(
    "Live (server confirmed)",
  );
  mode = "ended";
  await page.clock.runFor(15001);
  await expect(page.getByRole("status")).toContainText(
    "Ended — cleanup confirmed",
  );
  expect(writes).toEqual([]);
});
